import pytest
from models.recommender import RecommendationEngine, STAGE_WEIGHTS


def reviewed_by(engine: RecommendationEngine, user_id: str) -> set[str]:
    row = engine._user_item_matrix.loc[user_id]
    return set(row[row > 0].index)


async def test_cold_start_returns_ranked_popular_products(engine):
    recs = await engine.recommend("brand-new-user", None, [], None, 5)

    assert 0 < len(recs) <= 5
    scores = [r.score for r in recs]
    assert scores == sorted(scores, reverse=True)
    for r in recs:
        assert r.productId in engine._user_item_matrix.columns
        assert r.reason
        assert 0.0 <= r.confidence <= 1.0
        assert 0.0 <= r.demographicMatch <= 1.0


async def test_cold_start_honors_exclusions(engine):
    all_recs = await engine.recommend("brand-new-user", None, [], None, 100)
    excluded = [all_recs[0].productId, all_recs[1].productId]

    recs = await engine.recommend("brand-new-user", None, excluded, None, 100)

    assert not {r.productId for r in recs} & set(excluded)
    assert len(recs) == len(all_recs) - 2


async def test_known_user_never_gets_products_they_already_reviewed(engine):
    user = "user_0"
    assert user in engine._user_index
    already = reviewed_by(engine, user)
    assert already, "demo data should give user_0 at least one review"

    recs = await engine.recommend(user, None, [], None, 100)

    assert recs
    assert not {r.productId for r in recs} & already
    scores = [r.score for r in recs]
    assert scores == sorted(scores, reverse=True)


async def test_known_user_path_differs_from_cold_start(engine):
    known = await engine.recommend("user_0", None, [], None, 5)
    cold = await engine.recommend("someone-else", None, [], None, 5)

    assert [r.productId for r in known] != [r.productId for r in cold]


async def test_limit_is_respected(engine):
    assert len(await engine.recommend("user_3", None, [], None, 2)) <= 2
    assert len(await engine.recommend("nobody", None, [], None, 1)) == 1


async def test_everything_excluded_returns_empty(engine):
    every_product = list(engine._user_item_matrix.columns)
    assert await engine.recommend("nobody", None, every_product, None, 10) == []


async def test_loads_lazily_when_untrained():
    engine = RecommendationEngine()  # DATABASE_URL is empty in tests -> demo data
    assert not engine.is_trained

    recs = await engine.recommend("nobody", None, [], None, 3)

    assert engine.is_trained
    assert len(recs) == 3


def test_build_matrices_weights_long_term_reviews_more():
    engine = RecommendationEngine()
    rows = [
        {"user_id": "u1", "product_id": "p1", "stage": "INITIAL", "score_overall": 10},
        {"user_id": "u1", "product_id": "p2", "stage": "ONE_YEAR", "score_overall": 10},
        {"user_id": "u2", "product_id": "p1", "stage": "ONE_YEAR", "score_overall": 8},
    ]

    engine._build_matrices(rows)

    assert engine.is_trained
    assert (engine.user_count, engine.product_count) == (2, 2)
    m = engine._user_item_matrix
    assert m.loc["u1", "p1"] == pytest.approx(10 * STAGE_WEIGHTS["INITIAL"])
    assert m.loc["u1", "p2"] == pytest.approx(10 * STAGE_WEIGHTS["ONE_YEAR"])
    assert m.loc["u1", "p2"] > m.loc["u1", "p1"]


def test_build_matrices_keeps_best_weighted_score_per_user_product():
    engine = RecommendationEngine()
    rows = [
        {"user_id": "u1", "product_id": "p1", "stage": "INITIAL", "score_overall": 9},   # 5.4
        {"user_id": "u1", "product_id": "p1", "stage": "ONE_YEAR", "score_overall": 6},  # 6.0
    ]

    engine._build_matrices(rows)

    assert engine._user_item_matrix.loc["u1", "p1"] == pytest.approx(6.0)


def test_build_matrices_with_no_rows_stays_untrained():
    engine = RecommendationEngine()
    engine._build_matrices([])
    assert not engine.is_trained
