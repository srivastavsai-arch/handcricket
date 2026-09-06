"""Core domain models — no I/O, no framework imports."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import List, Optional


class GamePhase(str, Enum):
    RULES = "RULES"
    DIFFICULTY = "DIFFICULTY"
    TOSS = "TOSS"
    TOSS_RESULT = "TOSS_RESULT"
    TOSS_DECISION = "TOSS_DECISION"
    INNINGS_1 = "INNINGS_1"
    INNINGS_BREAK = "INNINGS_BREAK"
    INNINGS_2 = "INNINGS_2"
    MATCH_RESULT = "MATCH_RESULT"


class Side(str, Enum):
    PLAYER = "player"
    COMPUTER = "computer"


@dataclass
class BallRecord:
    ball_no: int            # global ball counter
    innings: int            # 1 or 2
    batting_side: str       # "player" | "computer"
    player_move: int        # 0-10 (whatever the human picked / camera returned)
    computer_move: int      # 1-10
    batsman_runs: int       # runs credited this ball (0 on OUT)
    is_out: bool
    batting_score_after: int

    def label(self) -> str:
        if self.is_out:
            return f"{self.player_move:02d} → {self.computer_move:02d} = OUT"
        return f"{self.player_move:02d} → {self.computer_move:02d} = +{self.batsman_runs}"

    def to_dict(self):
        return asdict(self)


@dataclass
class MatchState:
    phase: str = GamePhase.RULES.value
    innings: int = 1
    player_score: int = 0
    computer_score: int = 0
    # who is batting in the *current* innings
    batting_side: Optional[str] = None
    bowling_side: Optional[str] = None
    target: Optional[int] = None
    toss_winner: Optional[str] = None          # "player" | "computer"
    toss_call: Optional[str] = None            # "heads" | "tails"
    toss_result: Optional[str] = None          # "heads" | "tails"
    player_chose_to: Optional[str] = None      # "bat" | "bowl"
    difficulty: str = "medium"                 # "easy" | "medium" | "hard" (locked once balls are played)
    ball_count: int = 0
    last_result_text: str = ""
    last_out: bool = False
    winner: Optional[str] = None               # "player" | "computer" | "draw"
    win_margin: str = ""
    history: List[BallRecord] = field(default_factory=list)

    def to_dict(self):
        d = asdict(self)
        d["history"] = [h.to_dict() if isinstance(h, BallRecord) else h for h in self.history]
        return d
