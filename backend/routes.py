"""HTTP routes — thin wrappers over HandCricketEngine.

One in-memory session per match id (prototype-grade storage).
"""
from __future__ import annotations

import os
import time
import uuid
from flask import Blueprint, jsonify, request

from .game_engine import HandCricketEngine
from .models import GamePhase

api = Blueprint("api", __name__, url_prefix="/api")

# --- production hardening (env-driven, safe defaults) ---
# Deterministic computer_move injection exists for local testing only.
# It is OFF unless explicitly enabled, so clients can never force the AI.
ALLOW_MOVE_OVERRIDE = os.environ.get("HC_ALLOW_MOVE_OVERRIDE", "").lower() in ("1", "true", "yes")

try:
    SESSION_TTL_SECONDS = int(os.environ.get("HC_SESSION_TTL_SECONDS", "7200") or 7200)
except ValueError:
    SESSION_TTL_SECONDS = 7200

SESSIONS: dict[str, dict] = {}  # sid -> {"eng": HandCricketEngine, "at": monotonic last-touch}
# Bound in-memory sessions so anonymous callers cannot grow server memory
# without limit. Oldest idle session is evicted; normal play (one session
# per match) is unaffected. No gameplay/AI behaviour changes.
MAX_SESSIONS = 500
_last_purge = 0.0


def _purge_expired() -> None:
    """Drop idle sessions. Throttled: at most one sweep per minute."""
    global _last_purge
    now = time.monotonic()
    if now - _last_purge < 60:
        return
    _last_purge = now
    dead = [sid for sid, ent in SESSIONS.items() if now - ent["at"] > SESSION_TTL_SECONDS]
    for sid in dead:
        SESSIONS.pop(sid, None)


def _get_session(sid: str | None) -> HandCricketEngine | None:
    """Return the live engine for sid, or None (unknown/expired). Touches TTL."""
    ent = SESSIONS.get(sid or "")
    if not ent:
        return None
    now = time.monotonic()
    if now - ent["at"] > SESSION_TTL_SECONDS:
        SESSIONS.pop(sid, None)
        return None
    ent["at"] = now
    return ent["eng"]


@api.post("/new")
def new_match():
    data = request.get_json(force=True, silent=True) or {}
    eng = HandCricketEngine()
    if data.get("difficulty"):
        try:
            eng.set_difficulty(data["difficulty"])
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
    sid = uuid.uuid4().hex[:12]
    SESSIONS[sid] = {"eng": eng, "at": time.monotonic()}
    _purge_expired()
    while len(SESSIONS) > MAX_SESSIONS:
        SESSIONS.pop(next(iter(SESSIONS)))
    eng.start_difficulty_select()
    return jsonify({"session_id": sid, "state": eng.to_dict()})


@api.post("/difficulty")
def set_difficulty():
    """Lock AI difficulty. Allowed once, before the first ball."""
    data = request.get_json(force=True, silent=True) or {}
    eng = _get_session(data.get("session_id") or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    try:
        eng.set_difficulty(data.get("difficulty", ""))
        if eng.state.phase == GamePhase.DIFFICULTY.value:
            eng.start_toss()
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"session_id": data["session_id"], "state": eng.to_dict()})


@api.get("/state")
def get_state():
    sid = request.args.get("session_id")
    eng = _get_session(sid or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    return jsonify({"session_id": sid, "state": eng.to_dict()})


@api.post("/toss")
def toss():
    data = request.get_json(force=True, silent=True) or {}
    eng = _get_session(data.get("session_id") or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    try:
        eng.do_toss(data.get("call", ""))
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"session_id": data["session_id"], "state": eng.to_dict()})


@api.post("/decision")
def decision():
    data = request.get_json(force=True, silent=True) or {}
    eng = _get_session(data.get("session_id") or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    try:
        eng.decide_after_toss(data.get("choice"))
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"session_id": data["session_id"], "state": eng.to_dict()})


@api.post("/continue")
def innings_continue():
    data = request.get_json(force=True, silent=True) or {}
    eng = _get_session(data.get("session_id") or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    try:
        eng.continue_after_break()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"session_id": data["session_id"], "state": eng.to_dict()})


@api.post("/ball")
def ball():
    data = request.get_json(force=True, silent=True) or {}
    eng = _get_session(data.get("session_id") or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    try:
        player_move = int(data.get("player_move", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "player_move must be an integer 0-10"}), 400
    cm = data.get("computer_move")
    try:
        if cm is not None:
            # Deterministic injection (local tests only). Disabled by
            # default: HC_ALLOW_MOVE_OVERRIDE=1 re-enables it. A client
            # must never be able to dictate the AI's move in production.
            if not ALLOW_MOVE_OVERRIDE:
                return jsonify({"error": "computer_move override is disabled"}), 403
            out = eng.resolve_ball(player_move, int(cm))
        else:
            # Fair ordering: AI commits from completed history, then the
            # already-received player move is resolved against it.
            out = eng.play_ball_with_ai(player_move)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"session_id": data["session_id"], "result": out, "state": eng.to_dict()})
