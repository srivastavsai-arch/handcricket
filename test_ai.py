"""Prototype 2 tests: adaptive AI difficulty system (§22 of the spec).

Covers the six required tests plus difficulty-lock, role-separation and
API integration checks. All randomness is seeded — fully deterministic.
"""
import inspect
import random
from collections import Counter

import pytest

from backend import ai_engine
from backend.ai_engine import get_ai_move, predict_distribution
from backend.game_engine import HandCricketEngine


# ---------- helpers ----------
def batting_history(moves):
    """Completed-ball records where the PLAYER batted (AI was bowling)."""
    return [{"batting_side": "player", "player_move": m, "computer_move": 1} for m in moves]


def bowling_history(moves):
    """Completed-ball records where the COMPUTER batted (player was bowling)."""
    return [{"batting_side": "computer", "player_move": m, "computer_move": 1} for m in moves]


def batting_engine(seed=5, difficulty="hard"):
    e = HandCricketEngine(random.Random(seed), difficulty=difficulty)
    e.start_toss()
    e.state.toss_winner = "player"
    e.state.toss_call = "heads"
    e.state.toss_result = "heads"
    e.state.phase = "TOSS_RESULT"
    e.decide_after_toss("bat")  # player bats -> AI bowls
    return e


# ---------- Test 1: frequency dominance ----------
def test_1_dominant_number_gets_hunted():
    seq = [7, 4, 7, 2, 7, 5, 7, 3, 7, 6, 7, 7]  # seven 7s in twelve balls
    hist = batting_history(seq)
    for diff, floor in (("medium", 0.20), ("hard", 0.25)):
        dist = predict_distribution([r["player_move"] for r in hist], diff)
        assert dist[6] > floor, f"{diff}: P(7)={dist[6]:.3f} not significant"
        assert dist.index(max(dist)) == 6, f"{diff}: 7 is not the argmax"
    # ...and the committed bowling move hunts 7 by plurality (seeded sample)
    rng = random.Random(1234)
    picks = Counter(get_ai_move(hist, "hard", True, rng)["move"] for _ in range(400))
    assert picks.most_common(1)[0][0] == 7


# ---------- Test 2: recency outweighs stale history ----------
def test_2_recent_streak_outweighs_old_moves():
    seq = [7] * 10 + [9] * 4  # ancient 7-habit, but the player moved to 9s
    hard = predict_distribution(seq, "hard")
    assert hard[8] > hard[6], f"hard: P(9)={hard[8]:.3f} should beat P(7)={hard[6]:.3f}"
    assert hard[8] > 0.25
    med = predict_distribution(seq, "medium")
    assert med[8] > 0.15, "medium should still notice the recent 9s"


# ---------- Test 3: transition 7 -> 4 is learned ----------
def test_3_transition_pattern_learned():
    seq = [4, 7, 4, 7, 4, 7]  # every 7 is followed by 4
    hard = predict_distribution(seq, "hard")
    assert hard[3] > 0.15, f"P(4 after 7)={hard[3]:.3f} too low"
    assert hard[3] > hard[4] + 0.05, "predicted 4 must clearly beat unseen 5"


# ---------- Test 4: no history -> approximately random ----------
def test_4_no_history_is_uniform():
    for diff in ("easy", "medium", "hard"):
        dist = predict_distribution([], diff)
        assert dist == pytest.approx([0.1] * 10), f"{diff} with no history must be uniform"
        rng = random.Random(7)
        picks = Counter(get_ai_move([], diff, True, rng)["move"] for _ in range(300))
        # every number should appear at least a handful of times
        assert min(picks.values()) >= 10, f"{diff}: cold-start sampling looks skewed: {picks}"


# ---------- Test 5: random player -> no magic prediction ----------
def test_5_random_play_is_not_predicted():
    data_rng = random.Random(999)
    seq = [1 + int(data_rng.random() * 10) for _ in range(200)]
    hard = predict_distribution(seq, "hard")
    assert max(hard) < 0.30, f"peak {max(hard):.3f} too sharp for uniform noise"
    import math
    entropy = -sum(p * math.log2(p) for p in hard)
    assert entropy > 3.0, f"entropy {entropy:.2f} bits too low — overconfident on noise"

    ai_rng = random.Random(31337)
    play_rng = random.Random(424242)
    history = []
    outs = 0
    balls = 600
    for _ in range(balls):
        ai = get_ai_move(history, "hard", True, ai_rng)  # AI bowls, commits first
        player = 1 + int(play_rng.random() * 10)          # uniform random batsman
        outs += ai["move"] == player
        history.append({"batting_side": "player", "player_move": player, "computer_move": ai["move"]})
    rate = outs / balls
    assert 0.03 <= rate <= 0.22, f"OUT rate {rate:.3f} vs random play looks rigged"


# ---------- Test 6: current-move leakage is impossible ----------
def test_6_ai_cannot_access_current_move():
    # (a) static: the decision function has no current-move parameter at all
    params = set(inspect.signature(get_ai_move).parameters)
    assert params <= {"history", "difficulty", "ai_is_bowling", "rng"}, params
    assert not any("current" in p or "pending" in p or "player_move" in p for p in params)
    # (b) the return value carries no prediction details for the UI to leak
    out = get_ai_move(batting_history([7, 7, 4]), "hard", True, random.Random(1))
    assert set(out) == {"move", "pattern_detected", "history_len"}
    assert 1 <= out["move"] <= 10
    # (c) behavioural audit: the AI always committed from pre-ball history.
    # history_len counts the role-relevant completed balls, so while the
    # player bats it must equal (new ball_no - 1) — the current ball can
    # never have been in the AI's knowledge.
    e = batting_engine()
    for i, pm in enumerate([7, 7, 4, 9, 2], start=1):
        res = e.play_ball_with_ai(pm)
        if e.state.phase != "INNINGS_1":
            break  # an OUT ended innings 1 — audit still holds for balls played
        assert e.last_ai_info["history_len"] == res["record"]["ball_no"] - 1
    # (d) identical completed history -> identical analysis, no matter what
    # the player is *about* to do next
    snap = batting_history([7, 7, 4, 9])
    d1 = predict_distribution([r["player_move"] for r in snap], "hard")
    d2 = predict_distribution([r["player_move"] for r in snap], "hard")
    assert d1 == d2


# ---------- supporting behaviour ----------
def test_difficulty_lock_and_validation():
    e = batting_engine()
    with pytest.raises(ValueError):
        e.set_difficulty("nightmare")
    e.play_ball_with_ai(3, 4)  # first ball bowled...
    with pytest.raises(RuntimeError):
        e.set_difficulty("easy")  # ...lock engaged
    fresh = HandCricketEngine(random.Random(0), difficulty="easy")
    assert fresh.state.difficulty == "easy"
    assert predict_distribution([7] * 6, "easy")[6] < 0.25, "easy must stay near-random"


def test_role_specific_memory():
    # player bats 7s but bowls 3s — the AI must model the roles separately
    hist = batting_history([7] * 8) + bowling_history([3] * 8)
    bowl_ctx = get_ai_move(hist, "hard", True, random.Random(11))   # AI bowling -> reads batting seq
    bat_ctx = get_ai_move(hist, "hard", False, random.Random(11))   # AI batting  -> reads bowling seq
    assert bowl_ctx["history_len"] == 8 and bat_ctx["history_len"] == 8
    assert predict_distribution([7] * 8, "hard").index(max(predict_distribution([7] * 8, "hard"))) == 6
    assert predict_distribution([3] * 8, "hard").index(max(predict_distribution([3] * 8, "hard"))) == 2
    # AI batting dodges rather than matches: vs a 3-bowler it should rarely bat 3
    rng = random.Random(2024)
    bats = Counter(get_ai_move(bowling_history([3] * 8), "hard", False, rng)["move"] for _ in range(300))
    assert bats[3] < 60, f"AI batting into the predicted bowler number too often: {bats[3]}"


def test_ai_batting_prefers_high_ev():
    # Player bowls only 1s -> AI should favour big numbers that dodge 1
    rng = random.Random(99)
    picks = Counter(get_ai_move(bowling_history([1] * 10), "hard", False, rng)["move"] for _ in range(400))
    assert picks[1] < 80
    assert sum(picks[n] for n in (8, 9, 10)) > 150


def test_api_difficulty_and_ai_ball():
    from backend.app import create_app
    app = create_app()
    c = app.test_client()
    sid = c.post("/api/new", json={}).get_json()["session_id"]
    assert c.post("/api/new", json={}).get_json()["state"]["phase"] == "DIFFICULTY"
    bad = c.post("/api/difficulty", json={"session_id": sid, "difficulty": "ultra"})
    assert bad.status_code == 400
    st = c.post("/api/difficulty", json={"session_id": sid, "difficulty": "hard"}).get_json()["state"]
    assert st["difficulty"] == "hard" and st["phase"] == "TOSS"
    c.post("/api/toss", json={"session_id": sid, "call": "heads"})
    cur = c.get("/api/state", query_string={"session_id": sid}).get_json()["state"]
    if cur["toss_winner"] == "player":
        c.post("/api/decision", json={"session_id": sid, "choice": "bat"})
    else:
        c.post("/api/decision", json={"session_id": sid})
    r = c.post("/api/ball", json={"session_id": sid, "player_move": 7}).get_json()
    assert 1 <= r["result"]["computer_move"] <= 10
    # an early OUT legitimately ends innings 1 — cross the break if so
    if r["state"]["phase"] == "INNINGS_BREAK":
        st = c.post("/api/continue", json={"session_id": sid}).get_json()["state"]
        assert st["phase"] == "INNINGS_2"
    locked = c.post("/api/difficulty", json={"session_id": sid, "difficulty": "easy"})
    assert locked.status_code == 400, "difficulty must stay locked mid-match"
    r2 = c.post("/api/ball", json={"session_id": sid, "player_move": 4}).get_json()
    assert "result" in r2
    eng_state = c.get("/api/state", query_string={"session_id": sid}).get_json()["state"]
    assert eng_state["difficulty"] == "hard"
