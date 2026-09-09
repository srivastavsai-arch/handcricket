"""Adaptive AI prediction engine (Prototype 2).

Fairness contract (critical):
    The AI NEVER sees the player's current move. It receives ONLY completed
    history — balls that have already been resolved and appended. The call
    order enforced by the game engine / app layer is:

        PREVIOUS HISTORY -> AI ANALYSIS -> AI MOVE LOCKED
            -> PLAYER MOVE INPUT -> REVEAL BOTH -> RESOLVE
            -> APPEND COMPLETED MOVE TO HISTORY -> NEXT BALL

    ``get_ai_move`` therefore takes ``history`` (completed balls only),
    ``difficulty``, ``ai_is_bowling`` and ``rng``. There is deliberately NO
    parameter for the current / pending player move — cheating is impossible
    by construction, not just by discipline.

Signals (Hard combines all five; Medium a subset; Easy almost none):
    1. Overall frequency      — Laplace-smoothed count of each number.
    2. Recency weighting      — exponential decay, recent balls matter more.
    3. Streak detection       — repeated consecutive numbers get a boost,
                               but uncertainty is always preserved.
    4. Transition patterns    — P(next | previous) from prev->next counts.
    5. Short sequences        — order-2 model P(next | prev two).

Decision:
    * AI bowling  -> sample from the predicted player-batting distribution
                     (weighted sampling, never pure argmax).
    * AI batting  -> predict the player's likely bowling number, then pick a
                     batting number maximizing EV(n) = n * (1 - P_bowl(n))
                     via temperature softmax sampling (scores high while
                     dodging the predicted bowler number).
    Anti-exploit: every decision is epsilon-mixed with uniform noise.

Memory is stateless per call (derived from the passed history) and
role-specific: player batting moves and player bowling moves are modelled
separately, because humans behave differently batting vs bowling.
"""
from __future__ import annotations

import math
import random
from typing import Dict, List, Sequence, Tuple

MIN_MOVE, MAX_MOVE = 1, 10
N_MOVES = 10

DIFFICULTIES: Tuple[str, ...] = ("easy", "medium", "hard")

# Semi-arbitrary but fixed tuning. Kept in one place so both the Python
# engine and the JS mirror stay in lockstep.
_RECENCY_GAMMA = {"easy": 0.0, "medium": 0.80, "hard": 0.88}
_RECENT_WINDOW = {"easy": 5, "medium": 8, "hard": 10**9}  # easy: short memory
_EPSILON = {"easy": 0.25, "medium": 0.15, "hard": 0.12}   # anti-exploit noise
_BAT_TEMPERATURE = {"easy": 1e9, "medium": 3.0, "hard": 2.0}  # easy ~ random
_PATTERN_THRESHOLD = 0.22  # max-prob above this (+ enough history) => "pattern detected"

# Ensemble weights over [uniform, overall, recency, transition, sequence2, streak]
_WEIGHTS = {
    "easy":   {"uniform": 0.85, "overall": 0.0,  "recency": 0.15, "transition": 0.0,  "sequence2": 0.0,  "streak": 0.0},
    "medium": {"uniform": 0.25, "overall": 0.35, "recency": 0.30, "transition": 0.0,  "sequence2": 0.0,  "streak": 0.10},
    "hard":   {"uniform": 0.12, "overall": 0.20, "recency": 0.24, "transition": 0.16, "sequence2": 0.12, "streak": 0.16},
}


def validate_difficulty(difficulty: str) -> str:
    d = str(difficulty or "").lower().strip()
    if d not in DIFFICULTIES:
        raise ValueError(f"Difficulty must be one of {DIFFICULTIES}, got {difficulty!r}")
    return d


def _idx(move: int) -> int:
    return int(move) - 1


def _get(rec, key, default=None):
    if isinstance(rec, dict):
        return rec.get(key, default)
    return getattr(rec, key, default)


def role_sequences(history: Sequence) -> Dict[str, List[int]]:
    """Split completed history into role-specific player-move sequences.

    * ``player_batting``: player_move on balls where the player batted.
    * ``player_bowling``: player_move on balls where the computer batted
      (i.e. the player's bowling numbers).
    """
    batting, bowling = [], []
    for rec in history or []:
        side = _get(rec, "batting_side")
        mv = _get(rec, "player_move")
        if not isinstance(mv, int) or not (MIN_MOVE <= mv <= MAX_MOVE):
            continue
        if side == "player":
            batting.append(mv)
        elif side == "computer":
            bowling.append(mv)
    return {"player_batting": batting, "player_bowling": bowling}


def _uniform() -> List[float]:
    return [1.0 / N_MOVES] * N_MOVES


def _smooth(counts: List[float], alpha: float = 1.0) -> List[float]:
    total = sum(counts) + alpha * N_MOVES
    return [(c + alpha) / total for c in counts]


def _overall_freq(seq: Sequence[int]) -> List[float]:
    counts = [0.0] * N_MOVES
    for m in seq:
        counts[_idx(m)] += 1.0
    return _smooth(counts)


def _recency_freq(seq: Sequence[int], gamma: float, window: int) -> List[float]:
    if not seq:
        return _uniform()
    tail = list(seq)[-window:]
    counts = [0.0] * N_MOVES
    # most recent element gets weight 1, older decay by gamma per step back
    for pos, m in enumerate(reversed(tail)):
        counts[_idx(m)] += gamma ** pos if gamma > 0 else 1.0
    return _smooth(counts)


def _streak_info(seq: Sequence[int]) -> Tuple[int | None, int]:
    """Return (streak_number, streak_length) for the trailing run."""
    if not seq:
        return None, 0
    run = 1
    for m in reversed(list(seq)[:-1]):
        if m == seq[-1]:
            run += 1
        else:
            break
    return seq[-1], run


def _streak_dist(seq: Sequence[int], strength: float = 0.85) -> List[float]:
    """Distribution concentrating ``strength`` mass on the streak number.

    Falls back to uniform when there is no real streak (length < 2), so
    Medium/Hard keep full uncertainty against non-streaky players.
    """
    num, run = _streak_info(seq)
    if num is None or run < 2:
        return _uniform()
    mass = min(0.55 + 0.10 * min(run, 4), 0.95) if strength > 0.5 else 0.6
    rest = (1.0 - mass) / (N_MOVES - 1)
    return [mass if i == _idx(num) else rest for i in range(N_MOVES)]


def _transition_dist(seq: Sequence[int]) -> List[float]:
    """P(next | last move) from prev->next counts. Uniform if last unseen."""
    if len(seq) < 2:
        return _uniform()
    last = seq[-1]
    counts = [0.0] * N_MOVES
    total_out = 0
    for a, b in zip(seq[:-1], seq[1:]):
        if a == last:
            counts[_idx(b)] += 1.0
            total_out += 1
    if total_out == 0:
        return _uniform()
    return _smooth(counts)


def _sequence2_dist(seq: Sequence[int]) -> List[float]:
    """Order-2 model P(next | previous two). Uniform if context unseen."""
    if len(seq) < 3:
        return _uniform()
    ctx = (seq[-2], seq[-1])
    counts = [0.0] * N_MOVES
    hits = 0
    for a, b, c in zip(seq[:-2], seq[1:-1], seq[2:]):
        if (a, b) == ctx:
            counts[_idx(c)] += 1.0
            hits += 1
    if hits == 0:
        return _uniform()
    return _smooth(counts)


def predict_distribution(seq: Sequence[int], difficulty: str) -> List[float]:
    """Probability distribution over the player's LIKELY NEXT number.

    Pure function of completed-sequence ``seq`` — deterministic, no RNG,
    no access to any pending move. ``seq`` should be the role-relevant
    sequence (player batting moves when AI bowls, bowling moves when bats).
    """
    d = validate_difficulty(difficulty)
    seq = [int(m) for m in (seq or []) if isinstance(m, int) and MIN_MOVE <= m <= MAX_MOVE]
    if not seq:
        return _uniform()
    w = _WEIGHTS[d]
    gamma = _RECENCY_GAMMA[d]
    window = _RECENT_WINDOW[d]
    parts = {
        "uniform": _uniform(),
        "overall": _overall_freq(seq),
        "recency": _recency_freq(seq, gamma, window),
        "transition": _transition_dist(seq),
        "sequence2": _sequence2_dist(seq),
        "streak": _streak_dist(seq, strength=0.9 if d == "hard" else 0.6),
    }
    if d == "easy":
        # Easy: mostly uniform + a whisper of last-5 frequency.
        mixed = [w["uniform"] * parts["uniform"][i] + w["recency"] * parts["recency"][i]
                 for i in range(N_MOVES)]
    else:
        mixed = [sum(w[k] * parts[k][i] for k in w) for i in range(N_MOVES)]
    total = sum(mixed) or 1.0
    return [p / total for p in mixed]


def _sample(dist: List[float], rng) -> int:
    r = rng.random() * sum(dist)
    acc = 0.0
    for i, p in enumerate(dist):
        acc += p
        if r < acc:
            return i + 1
    return N_MOVES


def choose_bowling_move(dist: List[float], difficulty: str, rng=None) -> int:
    """AI is bowling: sample the predicted player-batting number (match = OUT)."""
    d = validate_difficulty(difficulty)
    rng = rng or random
    eps = _EPSILON[d]
    if rng.random() < eps:
        return 1 + int(rng.random() * N_MOVES)
    return _sample(dist, rng)


def choose_batting_move(dist: List[float], difficulty: str, rng=None) -> int:
    """AI is batting: dodge the predicted bowler number while scoring high.

    EV(n) = n * (1 - P_player_bowls(n)), sampled via temperature softmax.
    Easy ignores the model entirely (uniform random batting).
    """
    d = validate_difficulty(difficulty)
    rng = rng or random
    if d == "easy" or rng.random() < _EPSILON[d]:
        return 1 + int(rng.random() * N_MOVES)
    tau = _BAT_TEMPERATURE[d]
    ev = [(i + 1) * (1.0 - dist[i]) for i in range(N_MOVES)]
    m = max(ev)
    exps = [math.exp((v - m) / tau) for v in ev]
    tot = sum(exps) or 1.0
    return _sample([e / tot for e in exps], rng)


def get_ai_move(history: Sequence, difficulty: str, ai_is_bowling: bool, rng=None) -> Dict:
    """Commit to an AI move using ONLY completed history.

    Parameters intentionally exclude the player's current/pending move.
    Returns ``{"move": int 1-10, "pattern_detected": bool, "history_len": int}``
    — never the predicted number or distribution (the UI must not leak it).
    """
    d = validate_difficulty(difficulty)
    rng = rng or random
    seqs = role_sequences(history)
    seq = seqs["player_batting"] if ai_is_bowling else seqs["player_bowling"]
    dist = predict_distribution(seq, d)
    move = choose_bowling_move(dist, d, rng) if ai_is_bowling else choose_batting_move(dist, d, rng)
    peak = max(dist)
    return {
        "move": move,
        "pattern_detected": bool(len(seq) >= 4 and peak >= _PATTERN_THRESHOLD),
        "history_len": len(seq),
    }
