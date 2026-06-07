"""
Verdict ML Service
FastAPI application providing:
  - Collaborative filtering recommendations
  - NLP enrichment (sentiment, topics)
  - Drift analysis utilities
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uvicorn

from models.recommender import RecommendationEngine
from models.nlp import NLPEnricher
from models.drift import DriftAnalyzer

app = FastAPI(
    title="Verdict ML Service",
    description="Recommendation engine and NLP enrichment for Verdict",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize models (lazy-loaded)
recommender = RecommendationEngine()
nlp_enricher = NLPEnricher()
drift_analyzer = DriftAnalyzer()


# ── Request / Response Models ─────────────────────────────

class Demographics(BaseModel):
    ageRange: Optional[str] = None
    genderIdentity: Optional[str] = None
    region: Optional[str] = None
    incomeBracket: Optional[str] = None
    lifestyleTags: list[str] = []
    householdSize: Optional[int] = None
    hasChildren: Optional[bool] = None

class RecommendRequest(BaseModel):
    userId: str
    demographics: Optional[Demographics] = None
    excludeProductIds: list[str] = []
    category: Optional[str] = None
    limit: int = 10

class RecommendationItem(BaseModel):
    productId: str
    score: float
    reason: str
    confidence: float
    demographicMatch: float

class RecommendResponse(BaseModel):
    recommendations: list[RecommendationItem]
    modelVersion: str
    userId: str

class NLPRequest(BaseModel):
    text: str

class NLPResponse(BaseModel):
    sentimentScore: float
    keyTopics: list[str]
    summaryAuto: Optional[str] = None

class DriftRequest(BaseModel):
    reviews: list[dict]  # [{stage, scoreOverall, capturedAt}]

class DriftResponse(BaseModel):
    driftScore: float
    driftDirection: str  # "improving", "declining", "stable"
    driftMagnitude: str  # "slight", "moderate", "significant"
    stageScores: dict


# ── Endpoints ─────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "models": ["recommender", "nlp", "drift"]}


@app.post("/recommend", response_model=RecommendResponse)
async def recommend(req: RecommendRequest):
    """
    Generate personalized product recommendations using collaborative
    filtering weighted by demographic similarity.
    """
    try:
        recs = await recommender.recommend(
            user_id=req.userId,
            demographics=req.demographics.dict() if req.demographics else None,
            exclude_ids=req.excludeProductIds,
            category=req.category,
            limit=req.limit,
        )
        return RecommendResponse(
            recommendations=recs,
            modelVersion=recommender.version,
            userId=req.userId,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/nlp/enrich", response_model=NLPResponse)
async def enrich_review(req: NLPRequest):
    """
    Enrich a review with sentiment score, key topics, and auto-summary.
    """
    if not req.text or len(req.text.strip()) < 10:
        raise HTTPException(status_code=400, detail="Text too short for NLP analysis")

    result = await nlp_enricher.enrich(req.text)
    return result


@app.post("/drift/analyze", response_model=DriftResponse)
async def analyze_drift(req: DriftRequest):
    """
    Analyze opinion drift across a series of staged reviews.
    """
    if len(req.reviews) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 reviews to analyze drift")

    result = drift_analyzer.analyze(req.reviews)
    return result


@app.get("/model/status")
def model_status():
    return {
        "recommender": {
            "version": recommender.version,
            "trained": recommender.is_trained,
            "userCount": recommender.user_count,
            "productCount": recommender.product_count,
        },
        "nlp": {
            "backend": nlp_enricher.backend,
        }
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
