"""
Drift Analyzer

Quantifies how a user's opinion of a product has changed over time.
"""

from dataclasses import dataclass

STAGE_ORDER = ["INITIAL", "ONE_WEEK", "ONE_MONTH", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR", "TWO_YEARS", "CUSTOM"]


@dataclass
class DriftResult:
    driftScore: float
    driftDirection: str
    driftMagnitude: str
    stageScores: dict


class DriftAnalyzer:
    def analyze(self, reviews: list[dict]) -> DriftResult:
        # Sort by stage order
        sorted_reviews = sorted(
            reviews,
            key=lambda r: STAGE_ORDER.index(r["stage"]) if r["stage"] in STAGE_ORDER else 99
        )

        stage_scores = {r["stage"]: r["scoreOverall"] for r in sorted_reviews}

        initial = sorted_reviews[0]["scoreOverall"]
        latest = sorted_reviews[-1]["scoreOverall"]
        drift_score = float(latest - initial)

        # Direction
        if drift_score > 0.5:
            direction = "improving"
        elif drift_score < -0.5:
            direction = "declining"
        else:
            direction = "stable"

        # Magnitude
        abs_drift = abs(drift_score)
        if abs_drift < 1:
            magnitude = "slight"
        elif abs_drift < 2.5:
            magnitude = "moderate"
        else:
            magnitude = "significant"

        return DriftResult(
            driftScore=round(drift_score, 2),
            driftDirection=direction,
            driftMagnitude=magnitude,
            stageScores=stage_scores,
        )
