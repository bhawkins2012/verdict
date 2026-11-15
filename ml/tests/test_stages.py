"""ML stage lists must agree with the backend's ReviewStage enum (the source of truth is the database
schema and backend/src/stages.ts; the ML service is separate Python, so this test enforces agreement)."""
import re
from pathlib import Path

import pytest

from models.drift import STAGE_ORDER, DriftAnalyzer
from models.recommender import STAGE_WEIGHTS

SCHEMA = Path(__file__).resolve().parents[2] / "backend" / "prisma" / "schema.prisma"


def schema_review_stages() -> list[str]:
    text = SCHEMA.read_text()
    block = re.search(r"enum ReviewStage \{(.*?)\}", text, re.S)
    assert block, "ReviewStage enum not found in schema.prisma"
    return [line.split("//")[0].strip() for line in block.group(1).splitlines() if line.split("//")[0].strip()]


def test_drift_order_matches_the_schema_enum_order():
    # The enum is declared chronologically with CUSTOM last; drift ordering must be identical.
    assert STAGE_ORDER == schema_review_stages()


def test_every_stage_has_a_weight():
    assert set(STAGE_WEIGHTS) == set(schema_review_stages())


def test_weights_never_decrease_over_time():
    timeline = [s for s in STAGE_ORDER if s != "CUSTOM"]
    weights = [STAGE_WEIGHTS[s] for s in timeline]
    assert weights == sorted(weights), dict(zip(timeline, weights))
    assert STAGE_WEIGHTS["ONE_WEEK"] < STAGE_WEIGHTS["TWO_WEEKS"] < STAGE_WEIGHTS["ONE_MONTH"]


def test_drift_orders_two_weeks_between_one_week_and_one_month():
    result = DriftAnalyzer().analyze([
        {"stage": "ONE_MONTH", "scoreOverall": 4},
        {"stage": "TWO_WEEKS", "scoreOverall": 6},
        {"stage": "INITIAL", "scoreOverall": 8},
    ])
    assert list(result.stageScores) == ["INITIAL", "TWO_WEEKS", "ONE_MONTH"]
    assert result.driftScore == pytest.approx(-4.0)
