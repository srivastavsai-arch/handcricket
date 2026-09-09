"""HTTP routes — thin wrappers over HandCricketEngine.

One in-memory session per match id (prototype-grade storage).
"""
from __future__ import annotations

import uuid
from flask import Blueprint, jsonify, request

from .game_engine import HandCricketEngine
from .models import GamePhase

api = Blueprint("api", __name__, url_prefix="/api")
SESSIONS: dict[str, HandCricketEngine] = {}


def _get_engine(sid: str | None) -> HandCricketEngine:
    if sid and sid in SESSIONS:
        return SESSIONS[sid]
    eng = HandCricketEngine()
    return eng


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
    SESSIONS[sid] = eng
    eng.start_difficulty_select()
    return jsonify({"session_id": sid, "state": eng.to_dict()})


@api.post("/difficulty")
def set_difficulty():
    """Lock AI difficulty. Allowed once, before the first ball."""
    data = request.get_json(force=True, silent=True) or {}
    eng = SESSIONS.get(data.get("session_id") or "")
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
    eng = SESSIONS.get(sid or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    return jsonify({"session_id": sid, "state": eng.to_dict()})


@api.post("/toss")
def toss():
    data = request.get_json(force=True, silent=True) or {}
    eng = SESSIONS.get(data.get("session_id") or "")
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
    eng = SESSIONS.get(data.get("session_id") or "")
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
    eng = SESSIONS.get(data.get("session_id") or "")
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
    eng = SESSIONS.get(data.get("session_id") or "")
    if not eng:
        return jsonify({"error": "unknown session_id"}), 404
    try:
        player_move = int(data.get("player_move", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "player_move must be an integer 0-10"}), 400
    cm = data.get("computer_move")
    try:
        if cm is not None:
            # Deterministic injection (tests only) — bypasses the AI.
            out = eng.resolve_ball(player_move, int(cm))
        else:
            # Fair ordering: AI commits from completed history, then the
            # already-received player move is resolved against it.
            out = eng.play_ball_with_ai(player_move)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"session_id": data["session_id"], "result": out, "state": eng.to_dict()})
