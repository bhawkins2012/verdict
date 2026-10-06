import os
import sys
from pathlib import Path

# Tests must never hit a real database or inherit backend/.env: an empty (but present)
# DATABASE_URL stops load_dotenv(override=False) and selects the in-memory demo matrix.
os.environ["DATABASE_URL"] = ""
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from models.recommender import RecommendationEngine


@pytest.fixture()
def engine() -> RecommendationEngine:
    """Engine loaded with the deterministic demo matrix (20 users x 15 products, seeded)."""
    e = RecommendationEngine()
    e._load_demo_data()
    return e
