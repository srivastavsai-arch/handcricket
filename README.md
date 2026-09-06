# Hand Cricket — Prototype v2 (Adaptive AI)

Digital Hand Cricket: batsman + bowler each pick **1–10**. Same number → **OUT**,
different → batsman's number scores. Two innings + target chase, now with an
adaptive AI opponent (EASY / MEDIUM / HARD).

## Run

```powershell
pip install -r requirements.txt
python -m backend.app
# open http://127.0.0.1:5000
```

No build step — the frontend is static (`frontend/`), served by Flask.
Opening `frontend/index.html` directly also works (local JS engine fallback).

## Architecture (V3-ready)

```
INPUT PROVIDER → int 1–10 → GAME ENGINE ⇄ AI ENGINE → SCORE/OUT → UI
```

Mouse, touch and keyboard converge on one common player-input API:

```
Mouse click / touch tap ──┐
Physical digit key ───────┼─► provider.provide(n) → int 1–10 → ENGINE
Future camera gesture ────┘
```

- `backend/game_engine.py` — pure rules, no HTML/webcam/SVG knowledge.
- `backend/ai_engine.py` — adaptive predictor (`get_ai_move(history, difficulty,
  ai_is_bowling, rng)`). Sees completed history ONLY — no current-move parameter
  exists, so cheating is impossible by construction.
- `backend/models.py` — `GamePhase` state machine (RULES → DIFFICULTY → TOSS → … → MATCH_RESULT).
- `backend/routes.py` — thin Flask API over the engine.
- `frontend/js/input-provider.js` — `PrototypeInputProvider` (pad buttons:
  mouse + touch) and `KeyboardInputProvider` (digit keys, forwards into the
  SAME sink), camera provider in V3. Same `int 1–10` contract; AI and engine
  untouched and unaware of the source.
- `frontend/js/ai-engine.js` — JS mirror of the Python AI (lockstep weights).
- `frontend/js/game.js` — JS mirror of the Python engine for instant offline play.
- Fair ordering (§19): AI commits from pre-ball history → player taps → reveal
  both → resolve → append completed move to history.

## API

| Method | Endpoint | Body |
|---|---|---|
| POST | `/api/new` | `{difficulty?}` → `{session_id, state}` (phase DIFFICULTY) |
| POST | `/api/difficulty` | `{session_id, difficulty: easy\|medium\|hard}` → locks, advances to TOSS |
| POST | `/api/toss` | `{session_id, call: heads\|tails}` |
| POST | `/api/decision` | `{session_id, choice: bat\|bowl}` (only if player won toss) |
| POST | `/api/ball` | `{session_id, player_move: 1-10, computer_move?}` — omitting `computer_move` uses the adaptive AI |
| POST | `/api/continue` | `{session_id}` (innings break → innings 2) |
| GET | `/api/state?session_id=` | — |

## AI difficulty

| Level | Behaviour |
|---|---|
| EASY | ~85% uniform random + whisper of last-5 frequency. |
| MEDIUM | Overall frequency + recency + streak detection. Hunts favourites. |
| HARD | + transition model P(next\|prev) + order-2 sequences + stronger recency/streak, role-separated memory. Samples (never argmax) + ε-noise so it stays beatable. |

AI bowling → samples the predicted player-batting number (match = OUT).
AI batting → EV-softmax `n·(1−P_bowl(n))`: scores high while dodging the
predicted bowler number. New match = clean memory; difficulty locked per match.

## Keyboard controls

Full keyboard parity with mouse/touch — every key routes into the same
handlers and the same `provide()` sink, gated by the same locks:

| Context | Keys |
|---|---|
| Toss | `H` heads · `T` tails (locked after the call) |
| Difficulty | `1` easy · `2` medium · `3` hard (screen only) |
| Bat/Bowl | `B` bat · `W` bowl (until chosen) |
| Gameplay | `1`–`9` → 1–9 · `0` → 10 (only while the pad is unlocked) |
| Primary | `Enter` = Start · Enter arena · Start chase · Play again |

Unrelated keys are silently ignored. All buttons keep visible
`:focus-visible` outlines; `Enter`/`Space` on a focused button work natively
without double-firing.

## Test the full flow

RULES → DIFFICULTY → TOSS → BAT/BOWL → INNINGS 1 → OUT → BREAK → INNINGS 2 → TARGET → WIN/LOSS → PLAY AGAIN.

```powershell
pytest -q   # engine rules (test_engine.py) + AI adaptation & fairness (test_ai.py) + keyboard unit (test_keyboard.py)
```

## Gestures 1–10

Blueprint SVGs in `frontend/assets/gestures/gesture-N.svg`. Open fingers: cyan solid;
folded: grey dashed stub; gesture 9 index half-fold: amber. Rulebook grid in `index.html`
renders all ten with descriptions.
