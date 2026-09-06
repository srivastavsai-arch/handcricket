"""Pure Hand Cricket game engine.

Knows NOTHING about HTML / CSS / webcam / MediaPipe / SVG.
It only understands integers 0-10, scores, innings, target, OUT and winner.

Flow:
    INPUT PROVIDER  ->  int 0-10  ->  Engine.resolve_ball()  ->  score / out
                                       ->  innings / target  ->  winner

The camera provider only needs to return an int 0-10 and call
``resolve_ball`` — no engine rewrite required.
"""
from __future__ import annotations

import random
from typing import Dict, List, Optional, Tuple

from . import ai_engine
from .ai_engine import DIFFICULTIES
from .models import BallRecord, GamePhase, MatchState


MIN_MOVE, MAX_MOVE = 0, 10


def validate_move(value: int) -> int:
    if not isinstance(value, int) or not (MIN_MOVE <= value <= MAX_MOVE):
        raise ValueError(f"Move must be an integer {MIN_MOVE}-{MAX_MOVE}, got {value!r}")
    return value


def computer_pick(rng: random.Random | None = None) -> int:
    """Legacy uniform-random pick (Prototype 1 behaviour).

    Kept for backwards compatibility / tests. New code should go through
    :meth:`HandCricketEngine.play_ball_with_ai`, which uses the adaptive
    :mod:`backend.ai_engine` at the match's locked difficulty.
    """
    rng = rng or random
    return rng.randint(1, MAX_MOVE)


def computer_toss_decision(rng: random.Random | None = None) -> str:
    rng = rng or random
    return rng.choice(["bat", "bowl"])


class HandCricketEngine:
    """State-machine driven match. One instance == one match."""

    def __init__(self, rng: random.Random | None = None, difficulty: str = "medium"):
        self.rng = rng or random.Random()
        self.state = MatchState()
        self.state.difficulty = ai_engine.validate_difficulty(difficulty)
        # Fairness audit trail: history length the AI actually saw when it
        # committed to the most recent ball (must equal ball_no - 1, proving
        # the current move was NOT in the AI's knowledge).
        self.last_ai_info: Dict = {"history_len": 0, "pattern_detected": False}

    # ---------- lifecycle ----------
    def reset(self) -> MatchState:
        diff = self.state.difficulty
        self.state = MatchState()
        self.state.difficulty = diff
        self.last_ai_info = {"history_len": 0, "pattern_detected": False}
        return self.state

    def set_difficulty(self, difficulty: str) -> MatchState:
        """Lock the AI difficulty. Only allowed before the first ball —
        the difficulty is fixed for the entire match (§2, §21)."""
        if self.state.ball_count > 0:
            raise RuntimeError("Difficulty is locked once the match has started")
        self.state.difficulty = ai_engine.validate_difficulty(difficulty)
        return self.state

    def start_difficulty_select(self) -> MatchState:
        self.state.phase = GamePhase.DIFFICULTY.value
        return self.state

    def to_dict(self):
        return self.state.to_dict()

    def start_toss(self) -> MatchState:
        self.state.phase = GamePhase.TOSS.value
        return self.state

    def do_toss(self, call: str) -> MatchState:
        """call: 'heads' | 'tails'. Flips a fair coin."""
        call = call.lower().strip()
        if call not in ("heads", "tails"):
            raise ValueError("Toss call must be 'heads' or 'tails'")
        result = self.rng.choice(["heads", "tails"])
        s = self.state
        s.toss_call = call
        s.toss_result = result
        s.toss_winner = "player" if call == result else "computer"
        s.phase = GamePhase.TOSS_RESULT.value
        return s

    def decide_after_toss(self, player_choice: Optional[str] = None) -> MatchState:
        """Resolve who bats first.

        - If player won the toss, player_choice ('bat'|'bowl') is required.
        - If computer won, it auto-decides (player_choice ignored).
        """
        s = self.state
        if not s.toss_winner:
            raise RuntimeError("Cannot decide before the toss")
        if s.toss_winner == "player":
            if player_choice not in ("bat", "bowl"):
                raise ValueError("Player must choose 'bat' or 'bowl'")
            s.player_chose_to = player_choice
            first_batting = "player" if player_choice == "bat" else "computer"
        else:
            auto = computer_toss_decision(self.rng)
            s.player_chose_to = None
            # record computer's decision in last_result_text for the UI
            first_batting = "computer" if auto == "bat" else "player"
            s.last_result_text = f"Computer chooses to {auto.upper()}"
            # stash so UI can display it
            s.toss_call = s.toss_call  # unchanged
            self._computer_decision = auto
        self._begin_innings(1, first_batting)
        s.phase = GamePhase.INNINGS_1.value
        return s

    # ---------- innings ----------
    def _begin_innings(self, innings_no: int, batting_side: str):
        s = self.state
        s.innings = innings_no
        s.batting_side = batting_side
        s.bowling_side = "computer" if batting_side == "player" else "player"

    def _batting_score(self) -> int:
        s = self.state
        return s.player_score if s.batting_side == "player" else s.computer_score

    def _add_runs(self, runs: int):
        s = self.state
        if s.batting_side == "player":
            s.player_score += runs
        else:
            s.computer_score += runs

    # ---------- ball resolution (THE core rule) ----------
    def resolve_ball(self, player_move: int, computer_move: int) -> dict:
        """Play one ball. Returns a summary dict for the UI / API.

        Rule:
          batsman_move == bowler_move  -> OUT (so 0 vs 0 is OUT)
          else -> batting score += BATSMAN's number, except a batsman
          playing 0 scores the BOWLER's number instead.
        """
        validate_move(player_move)
        validate_move(computer_move)
        s = self.state
        if s.phase not in (GamePhase.INNINGS_1.value, GamePhase.INNINGS_2.value):
            raise RuntimeError(f"Cannot play a ball in phase {s.phase}")
        if not s.batting_side:
            raise RuntimeError("Innings has no batting side")

        # Identify batsman / bowler moves (THE critical mapping).
        if s.batting_side == "player":
            batsman_move, bowler_move = player_move, computer_move
        else:
            batsman_move, bowler_move = computer_move, player_move

        is_out = batsman_move == bowler_move
        runs = 0 if is_out else (bowler_move if batsman_move == 0 else batsman_move)
        if not is_out:
            self._add_runs(runs)

        s.ball_count += 1
        rec = BallRecord(
            ball_no=s.ball_count,
            innings=s.innings,
            batting_side=s.batting_side,
            player_move=player_move,
            computer_move=computer_move,
            batsman_runs=runs,
            is_out=is_out,
            batting_score_after=self._batting_score(),
        )
        s.history.append(rec)
        s.last_out = is_out
        s.last_result_text = "OUT!" if is_out else f"+{runs} RUNS"

        innings_no = s.innings
        if innings_no == 1:
            if is_out:
                # innings break: set target, swap sides
                first_score = self._batting_score()
                s.target = first_score + 1
                self._begin_innings(2, s.bowling_side)  # other side bats
                s.phase = GamePhase.INNINGS_BREAK.value
        else:  # innings 2 — chase logic, check after EVERY ball
            assert s.target is not None
            chasing_score = self._batting_score()
            if chasing_score >= s.target:
                self._finish(chasing_won=True)
            elif is_out:
                self._finish(chasing_won=False)

        return {
            "player_move": player_move,
            "computer_move": computer_move,
            "batsman_move": batsman_move,
            "bowler_move": bowler_move,
            "is_out": is_out,
            "runs": runs,
            "player_score": s.player_score,
            "computer_score": s.computer_score,
            "phase": s.phase,
            "innings": s.innings,
            "batting_side": s.batting_side,
            "target": s.target,
            "winner": s.winner,
            "result_text": s.last_result_text,
            "record": rec.to_dict(),
        }

    def continue_after_break(self) -> MatchState:
        s = self.state
        if s.phase != GamePhase.INNINGS_BREAK.value:
            raise RuntimeError("No innings break to continue from")
        s.phase = GamePhase.INNINGS_2.value
        s.last_result_text = f"Target {s.target}. {s.batting_side.upper()} to chase."
        return s

    # ---------- result ----------
    def _finish(self, chasing_won: bool):
        s = self.state
        chasing_side = s.batting_side
        assert chasing_side in ("player", "computer")
        if chasing_won:
            s.winner = chasing_side
        else:
            s.winner = s.bowling_side
        # draw is impossible with target = score+1, but keep the field honest
        if s.player_score + 1 == s.target and s.computer_score + 1 == s.target:
            pass
        if s.winner == "player":
            if chasing_won and chasing_side == "player":
                need = s.target or 0
                s.win_margin = f"Won chasing {need - 1} (target {need})"
            else:
                s.win_margin = f"Won by {s.player_score - s.computer_score} runs"
        elif s.winner == "computer":
            if chasing_won and chasing_side == "computer":
                need = s.target or 0
                s.win_margin = f"Computer chased {need - 1} (target {need})"
            else:
                s.win_margin = f"Computer won by {s.computer_score - s.player_score} runs"
        s.phase = GamePhase.MATCH_RESULT.value
        s.last_result_text = (
            "YOU WIN!" if s.winner == "player"
            else "COMPUTER WINS" if s.winner == "computer"
            else "DRAW"
        )

    # ---------- helpers for tests ----------
    def commit_ai_move(self) -> Dict:
        """AI analysis + locked move from COMPLETED history only.

        Must be called BEFORE the player's current move is known/appended.
        The returned dict carries no prediction details — only the move and
        a coarse pattern flag safe for the UI status line.
        """
        s = self.state
        if s.phase not in (GamePhase.INNINGS_1.value, GamePhase.INNINGS_2.value):
            raise RuntimeError(f"AI cannot commit in phase {s.phase}")
        if not s.batting_side:
            raise RuntimeError("Innings has no batting side")
        ai_is_bowling = s.batting_side == "player"
        # Snapshot: a plain list of completed records. The pending player
        # move does not exist anywhere in this data (§1 fairness rule).
        snapshot: List = list(s.history)
        out = ai_engine.get_ai_move(snapshot, s.difficulty, ai_is_bowling, self.rng)
        self.last_ai_info = {"history_len": out["history_len"], "pattern_detected": out["pattern_detected"]}
        return out

    def play_ball_with_ai(self, player_move: int, computer_move: Optional[int] = None) -> dict:
        """Resolve one ball.

        Fair ordering (§19): the AI commits from pre-ball history FIRST,
        and only then is the player's move resolved. ``computer_move`` may
        be injected for deterministic tests (bypasses the AI).
        """
        validate_move(player_move)
        if computer_move is not None:
            validate_move(computer_move)
            return self.resolve_ball(player_move, computer_move)
        ai = self.commit_ai_move()
        out = self.resolve_ball(player_move, ai["move"])
        out["ai_pattern_detected"] = ai["pattern_detected"]
        return out
