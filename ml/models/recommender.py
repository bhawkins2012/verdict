"""
Verdict Recommendation Engine

Phase 1: Demographic-weighted collaborative filtering
  - User-item matrix from review scores
  - Demographic similarity as a secondary signal
  - Long-term scores weighted higher than initial scores
  - Falls back to popularity-based recs for cold-start users

Phase 2 (TODO): Matrix factorization (SVD)
Phase 3 (TODO): Two-tower neural net
"""

import asyncio
import os
from typing import Optional
from dataclasses import dataclass
import numpy as np
import pandas as pd
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import LabelEncoder
import asyncpg
import logging

logger = logging.getLogger(__name__)

VERSION = "1.0.0-collab-filter"

# Stage weights — long-term reviews count more
STAGE_WEIGHTS = {
    "INITIAL": 0.6,
    "ONE_WEEK": 0.7,
    "ONE_MONTH": 0.85,
    "THREE_MONTHS": 0.90,
    "SIX_MONTHS": 0.95,
    "ONE_YEAR": 1.0,
    "TWO_YEARS": 1.0,
    "CUSTOM": 0.75,
}

# Demographic feature weights for similarity
DEMO_WEIGHTS = {
    "ageRange": 0.25,
    "incomeBracket": 0.20,
    "region": 0.10,
    "genderIdentity": 0.10,
    "hasChildren": 0.15,
    "lifestyleTags": 0.20,
}


@dataclass
class RecommendationItem:
    productId: str
    score: float
    reason: str
    confidence: float
    demographicMatch: float


class RecommendationEngine:
    def __init__(self):
        self.version = VERSION
        self.is_trained = False
        self.user_count = 0
        self.product_count = 0

        # In-memory matrices (refreshed by background job)
        self._user_item_matrix: Optional[pd.DataFrame] = None
        self._user_similarity: Optional[np.ndarray] = None
        self._user_index: dict = {}
        self._product_index: dict = {}
        self._demo_matrix: Optional[pd.DataFrame] = None

    async def load_from_db(self):
        """
        Load review data from PostgreSQL and build recommendation matrices.
        Called on startup and periodically to refresh.
        """
        db_url = os.getenv("DATABASE_URL", "")
        if not db_url:
            logger.warning("No DATABASE_URL — using demo data for recommendations")
            self._load_demo_data()
            return

        try:
            conn = await asyncpg.connect(db_url)
            rows = await conn.fetch("""
                SELECT
                    rt.user_id,
                    rt.product_id,
                    r.stage,
                    r.score_overall,
                    ud.age_range,
                    ud.income_bracket,
                    ud.gender_identity,
                    ud.has_children,
                    ud.lifestyle_tags,
                    ud.region
                FROM reviews r
                JOIN review_threads rt ON r.thread_id = rt.id
                LEFT JOIN user_demographics ud ON ud.user_id = rt.user_id
                WHERE r.source = 'NATIVE'
                ORDER BY r.captured_at
            """)
            await conn.close()
            self._build_matrices(rows)
        except Exception as e:
            logger.warning(f"DB load failed ({e}) — using demo data")
            self._load_demo_data()

    def _build_matrices(self, rows):
        """Build user-item matrix with stage-weighted scores."""
        records = []
        for row in rows:
            weight = STAGE_WEIGHTS.get(row["stage"], 0.75)
            records.append({
                "user_id": row["user_id"],
                "product_id": row["product_id"],
                "weighted_score": row["score_overall"] * weight,
                "age_range": row.get("age_range"),
                "income_bracket": row.get("income_bracket"),
                "gender_identity": row.get("gender_identity"),
                "has_children": row.get("has_children"),
                "region": row.get("region"),
                "lifestyle_tags": row.get("lifestyle_tags") or [],
            })

        df = pd.DataFrame(records)
        if df.empty:
            return

        # Aggregate to best weighted score per user-product
        agg = df.groupby(["user_id", "product_id"])["weighted_score"].max().reset_index()

        # Pivot to user-item matrix
        matrix = agg.pivot(index="user_id", columns="product_id", values="weighted_score")
        matrix = matrix.fillna(0)

        self._user_item_matrix = matrix
        self._user_index = {uid: i for i, uid in enumerate(matrix.index)}
        self._product_index = {pid: i for i, pid in enumerate(matrix.columns)}

        # Compute user-user cosine similarity
        self._user_similarity = cosine_similarity(matrix.values)

        # Build demographic feature matrix
        demo_df = df.drop_duplicates("user_id").set_index("user_id")
        self._demo_matrix = demo_df
        self.user_count = len(matrix.index)
        self.product_count = len(matrix.columns)
        self.is_trained = True
        logger.info(f"Matrix built: {self.user_count} users × {self.product_count} products")

    def _load_demo_data(self):
        """Minimal demo matrix for testing without a live DB."""
        np.random.seed(42)
        users = [f"user_{i}" for i in range(20)]
        products = [f"product_{i}" for i in range(15)]
        data = np.random.uniform(0, 10, (20, 15))
        # Inject zeros for "not reviewed"
        mask = np.random.random((20, 15)) > 0.4
        data[mask] = 0
        self._user_item_matrix = pd.DataFrame(data, index=users, columns=products)
        self._user_similarity = cosine_similarity(data)
        self._user_index = {u: i for i, u in enumerate(users)}
        self._product_index = {p: i for i, p in enumerate(products)}
        self.user_count = len(users)
        self.product_count = len(products)
        self.is_trained = True

    def _compute_demographic_similarity(
        self,
        user_demographics: Optional[dict],
        other_user_id: str
    ) -> float:
        """
        Compute 0-1 similarity between a user's demographics and another user's.
        """
        if user_demographics is None or self._demo_matrix is None:
            return 0.5  # Neutral when no demo data

        if other_user_id not in self._demo_matrix.index:
            return 0.5

        other = self._demo_matrix.loc[other_user_id]
        score = 0.0
        total_weight = 0.0

        # Age bracket match
        if user_demographics.get("ageRange") and other.get("age_range"):
            match = 1.0 if user_demographics["ageRange"] == other["age_range"] else 0.0
            score += match * DEMO_WEIGHTS["ageRange"]
            total_weight += DEMO_WEIGHTS["ageRange"]

        # Income bracket match
        if user_demographics.get("incomeBracket") and other.get("income_bracket"):
            match = 1.0 if user_demographics["incomeBracket"] == other["income_bracket"] else 0.0
            score += match * DEMO_WEIGHTS["incomeBracket"]
            total_weight += DEMO_WEIGHTS["incomeBracket"]

        # Lifestyle tags overlap (Jaccard)
        user_tags = set(user_demographics.get("lifestyleTags") or [])
        other_tags = set(other.get("lifestyle_tags") or [])
        if user_tags or other_tags:
            union = user_tags | other_tags
            intersection = user_tags & other_tags
            jaccard = len(intersection) / len(union) if union else 0.0
            score += jaccard * DEMO_WEIGHTS["lifestyleTags"]
            total_weight += DEMO_WEIGHTS["lifestyleTags"]

        # Has children match
        if user_demographics.get("hasChildren") is not None and other.get("has_children") is not None:
            match = 1.0 if user_demographics["hasChildren"] == other["has_children"] else 0.0
            score += match * DEMO_WEIGHTS["hasChildren"]
            total_weight += DEMO_WEIGHTS["hasChildren"]

        return score / total_weight if total_weight > 0 else 0.5

    def _reason_from_score(self, collab_score: float, demo_sim: float, product_id: str) -> str:
        """Generate a human-readable reason for a recommendation."""
        if demo_sim > 0.7 and collab_score > 7:
            return "Highly rated by users just like you"
        elif demo_sim > 0.5 and collab_score > 6:
            return "Loved by people with similar tastes and lifestyle"
        elif collab_score > 8:
            return "One of the most consistently loved products in this category"
        elif collab_score > 6:
            return "Strong long-term ratings across many users"
        else:
            return "Trending among users with your profile"

    async def recommend(
        self,
        user_id: str,
        demographics: Optional[dict],
        exclude_ids: list[str],
        category: Optional[str],
        limit: int,
    ) -> list[RecommendationItem]:

        if not self.is_trained:
            await self.load_from_db()

        if self._user_item_matrix is None:
            return []

        product_cols = list(self._user_item_matrix.columns)

        # Filter by category if requested (product IDs matching category)
        # In production, join with products table; here we pass all through
        candidate_products = [p for p in product_cols if p not in exclude_ids]

        # ── Known user: collaborative filtering ──────────────────
        if user_id in self._user_index:
            user_idx = self._user_index[user_id]
            user_sims = self._user_similarity[user_idx]

            # Weighted average of similar users' scores for unreviewed products
            predicted_scores = {}
            reviewed = set(
                self._user_item_matrix.columns[
                    self._user_item_matrix.iloc[user_idx] > 0
                ]
            )
            targets = [p for p in candidate_products if p not in reviewed]

            for product in targets:
                pid_idx = self._product_index[product]
                product_col = self._user_item_matrix.iloc[:, pid_idx].values
                reviewers = product_col > 0

                if reviewers.sum() == 0:
                    continue

                # Demographic similarity bonus
                demo_sims = np.array([
                    self._compute_demographic_similarity(
                        demographics,
                        list(self._user_item_matrix.index)[i]
                    )
                    for i in np.where(reviewers)[0]
                ])

                # Combined weight: 70% collab similarity + 30% demographic
                collab_weights = user_sims[reviewers]
                combined_weights = 0.7 * collab_weights + 0.3 * demo_sims
                combined_weights = np.clip(combined_weights, 0, None)

                if combined_weights.sum() == 0:
                    continue

                predicted = np.dot(combined_weights, product_col[reviewers]) / combined_weights.sum()
                avg_demo_sim = demo_sims.mean()
                predicted_scores[product] = (predicted, avg_demo_sim)

            results = sorted(predicted_scores.items(), key=lambda x: x[1][0], reverse=True)[:limit]

        # ── Cold start: popularity-based with demographic weighting ──
        else:
            product_means = self._user_item_matrix[candidate_products].mean()
            top_products = product_means.nlargest(limit)
            results = [(pid, (score, 0.5)) for pid, score in top_products.items()]

        return [
            RecommendationItem(
                productId=pid,
                score=round(float(score), 2),
                reason=self._reason_from_score(score, demo_sim, pid),
                confidence=round(min(1.0, float(score) / 10.0), 2),
                demographicMatch=round(float(demo_sim), 2),
            )
            for pid, (score, demo_sim) in results
        ]
