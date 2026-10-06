import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture()
def client():
    main.recommender._load_demo_data()
    return TestClient(main.app)


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_recommend_returns_schema_valid_items(client):
    # Regression: this endpoint returned 500 for every request (dataclasses fed to pydantic).
    res = client.post("/recommend", json={"userId": "brand-new", "excludeProductIds": [], "limit": 4})

    assert res.status_code == 200
    body = res.json()
    assert body["userId"] == "brand-new"
    assert body["modelVersion"]
    assert 0 < len(body["recommendations"]) <= 4
    for item in body["recommendations"]:
        assert set(item) == {"productId", "score", "reason", "confidence", "demographicMatch"}


def test_recommend_known_user_and_exclusions(client):
    first = client.post("/recommend", json={"userId": "user_0", "limit": 100}).json()["recommendations"]
    assert first
    excluded = first[0]["productId"]

    second = client.post("/recommend", json={"userId": "user_0", "excludeProductIds": [excluded], "limit": 100}).json()["recommendations"]

    assert excluded not in {r["productId"] for r in second}


def test_recommend_accepts_the_payload_the_backend_sends(client):
    payload = {
        "userId": "u1",
        "demographics": {"ageRange": "AGE_25_34", "region": "US-CA", "lifestyleTags": ["tech"], "hasChildren": False},
        "excludeProductIds": [],
        "limit": 10,
    }
    assert client.post("/recommend", json=payload).status_code == 200
    assert client.post("/recommend", json={**payload, "demographics": None}).status_code == 200


def test_nlp_enrich_positive_and_negative(client):
    pos = client.post("/nlp/enrich", json={"text": "Absolutely love this, fantastic quality and great value."}).json()
    neg = client.post("/nlp/enrich", json={"text": "Terrible product, broke after a week and awful support."}).json()

    assert -1.0 <= pos["sentimentScore"] <= 1.0
    assert pos["sentimentScore"] > neg["sentimentScore"]
    assert isinstance(pos["keyTopics"], list)


def test_nlp_enrich_rejects_short_text(client):
    assert client.post("/nlp/enrich", json={"text": "ok"}).status_code == 400


def test_drift_analyze(client):
    reviews = [
        {"stage": "ONE_YEAR", "scoreOverall": 4, "capturedAt": "2026-01-01"},
        {"stage": "INITIAL", "scoreOverall": 9, "capturedAt": "2025-01-01"},
    ]
    res = client.post("/drift/analyze", json={"reviews": reviews})

    assert res.status_code == 200
    body = res.json()
    assert body["driftScore"] == -5
    assert body["driftDirection"] == "declining"
    assert body["driftMagnitude"] == "significant"


def test_drift_analyze_needs_two_reviews(client):
    assert client.post("/drift/analyze", json={"reviews": [{"stage": "INITIAL", "scoreOverall": 5}]}).status_code == 400
