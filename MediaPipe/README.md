# MediaPipe Hand Recognition — Preserved Implementation (v1)

This folder preserves the CURRENT working MediaPipe hand-recognition system
exactly as it runs in the game, so it can be re-integrated after a restore.
Nothing here is simplified, retuned, or redesigned.

## Files

| File | Contents | Provenance |
|---|---|---|
| `gesture-spec.js` | Frozen reference v1: landmark layout, finger/thumb rules, 0–10 mapping, temporal + MediaPipe + capture config. Single source of truth. | Byte-identical copy of `frontend/js/gesture-spec.js` (SHA-256 verified) |
| `hand-gestures.js` | Pure classifier engine: geometry helpers + `classifyLandmarks()`. No DOM, no network, no game rules. | Byte-identical copy of `frontend/js/hand-gestures.js` (SHA-256 verified) |
| `camera-input.js` | Full runtime pipeline: CDN load, camera lifecycle, overlay, temporal confirm, release machine. Exposes `window.HCCamera`. | Byte-identical copy of `frontend/js/camera-input.js` (SHA-256 verified) |
| `synthetic-gestures.js` | Proven reference landmark vectors for 6 / 9 / 10, extracted from the passing test harness. | Derived from `test_camera.py` builders (unchanged geometry) |
| `README.md` | This document. | Written from source inspection |

Load order (matters): `gesture-spec.js` → `hand-gestures.js` → `camera-input.js`
(`window.HCSpec` → `window.HCGestures` → `window.HCCamera`).

---

## 1. How MediaPipe is initialized

(`camera-input.js`: `start()` → `loadHandsScript()` → `getUserMedia` →
`waitForVideo()` → `new window.Hands(...)` → `setOptions` → `onResults` →
`requestAnimationFrame(loop)`)

1. `loadHandsScript()` injects one `<script>` tag for the **version-pinned**
   `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js`.
   The promise is cached but a failed load clears the cache so retries
   fetch a fresh tag (never poisoned).
2. `getUserMedia({ video: { facingMode:'user', width:{ideal:1280},
   height:{ideal:960}, aspectRatio:{ideal:4/3} }, audio:false })`.
   All ideals: devices fall back to nearest mode instead of failing.
3. `video.play()` then `waitForVideo()` polls (50 ms, max ~100 tries) until
   `videoWidth > 0 && videoHeight > 0 && readyState >= 2`. No frame reaches
   MediaPipe before real dimensions exist.
4. `new window.Hands({ locateFile: f => HANDS_LOCATE + f })` where
   `HANDS_LOCATE` is the same pinned jsDelivr base (WASM + `.tflite` +
   `.binarypb` resolve there).
5. `setOptions({ maxNumHands:1, modelComplexity:0,
   minDetectionConfidence:0.6, minTrackingConfidence:0.5 })`.
6. `onResults(res => onHandResult(res.multiHandLandmarks[0] || null))`.
7. `loop()` pumps **one frame at a time** (`state.sending` guard):
   `hands.send({ image: video })` each animation frame.

## 2. How landmarks are obtained

- Each pumped frame resolves through `onResults` with
  `res.multiHandLandmarks` (array of hands; only index `[0]` is used).
- One result = **21 landmarks in MediaPipe order, each `{x, y, z}`**
  (normalized 0–1; `z` is relative depth). The classifier also accepts
  `[x, y, z]` arrays (`pt()` in `hand-gestures.js` handles both).
- `null` / empty = no hand this frame (skeleton clears; counted toward
  release tracking).

## 3. How each finger is detected (index / middle / ring / pinky)

Per finger, `fingerShape(lm, mcp, pip, dip, tip, palm)` computes:
- `avg` — mean of the two mid-joint angles (degrees, dot products).
- `reach` — tip→knuckle distance; `bones` — summed bone lengths.
- `straight = reach / bones` (1.0 = ruler-straight).
- `ext = reach / palm` (palm = wrist→middle-MCP distance; scale invariant).

OPEN if **any** `openRules` row holds (OR); CLOSED if **any** `closedRules`
row holds (OR). Suffix `Max` = maximum (≤), plain key = minimum (≥):
- open: `{ext ≥ 0.95}` · `{straight ≥ 0.86, ext ≥ 0.55}` ·
  `{avg ≥ 135, ext ≥ 0.60}` · `{avg ≥ 150, ext ≥ 0.55}`
- closed: `{ext ≤ 0.50}` · `{straight ≤ 0.70, ext ≤ 0.72}` ·
  `{avg ≤ 105, ext ≤ 0.75}`
- **Neither open nor closed → UNKNOWN → whole read returns `null`.**
  One ambiguous finger blocks the frame; never a wrong number.

## 4. How the thumb is detected

`thumbShape()` computes `spread` (tip→index-MCP / palm), `lift`
(tip→middle-MCP / palm), `perp` (unsigned 3D cross-product abduction /
palm²; large = sticking OUT, small = wrapped), `contact` (nearest tip
approach to mid-joints 10,11,14,15,18,19 / palm — index excluded), `avg`
(mean of its two joint angles).
- **Contact gate first:** `contact < 0.55` (thumb resting ON the fist) →
  folded, regardless of other signals.
- Else OPEN if any row holds: `{perp ≥ 0.38, avg ≥ 120}` ·
  `{lift ≥ 0.78}` · `{spread ≥ 0.64, lift ≥ 0.55}` ·
  `{perp ≥ 0.28, spread ≥ 0.30, avg ≥ 110}`.

## 5. How hand orientation is handled

- All distances are **3D Euclidean normalized by palm size** → distance /
  scale invariant by construction.
- All angles are **dot products in degrees** → rotation invariant.
- Thumb abduction uses an **unsigned cross product** → rotation and
  handedness independent.
- **Mirroring is display-only** (CSS `scaleX(-1)` on video + mirrored
  overlay mapping `(1 - p.x)` in `drawSkeleton`). Landmarks are NEVER
  re-mirrored before classification.

## 6. How gestures 0–10 are classified

`classifyLandmarks()` builds the open-state vector
`[thumb, index, middle, ring, pinky]` (booleans) and returns the `n` of
the **first mapping row that matches exactly**. No match, short input
(< 21 points), degenerate palm, any exception → `null`.

## 7. Exact gesture mapping (PRESERVED — do not retune)

| Number | Gesture | Open vector [T,I,M,R,P] |
|---|---|---|
| 0 | Closed fist | [–,–,–,–,–] all closed |
| 1 | Index | [–,T,–,–,–] |
| 2 | Index + middle | [–,T,T,–,–] |
| 3 | Index + middle + ring | [–,T,T,T,–] |
| 4 | Index + middle + ring + pinky | [–,T,T,T,T] |
| 5 | All five | [T,T,T,T,T] |
| 6 | **Thumb only** | [T,–,–,–,–] |
| 7 | Thumb + index | [T,T,–,–,–] |
| 8 | Thumb + index + middle | [T,T,T,–,–] |
| 9 | **Thumb + pinky** | [T,–,–,–,T] |
| 10 | **Thumb + index + pinky** | [T,T,–,–,T] |

(T = open, – = closed. The 6/9/10 trio is distinguished by pinky/index
state, never by the thumb alone.)

## 8. Important thresholds / tolerances

- Detection: `minDetectionConfidence 0.6`, `minTrackingConfidence 0.5`,
  `maxNumHands 1`, `modelComplexity 0` (lite model).
- Finger open/closed rules: see §3 (ext/straight/avg bounds above).
- Thumb: `contactMin 0.55`; open rules: see §4.
- Temporal: `needStable 6`, `bufferMax 8`, `nullSkip 1`,
  `absentToRelease 6`.
- Capture ideals: 1280×960, 4:3, `facingMode 'user'` (all ideals =
  graceful fallback; downstream always uses ACTUAL stream dimensions).

## 9. Temporal stabilization

- Every result (int or `null`) is pushed into a sliding window
  (`bufferMax 8`).
- `stableGesture()`: the newest reading backed by `needStable (6)`
  identical detections, tolerating up to `nullSkip (1)` noisy null
  frame; a DIFFERENT gesture always breaks stability → `null`.
- `currentStreak()` drives the confirm progress bar (frames, not ms —
  latency-safe).

## 10. Gesture confirmation (one gesture = exactly one move)

`onHandResult` state machine:
`ready → tracking → CONFIRMED → waiting-release → (hand removed) → ready`.
- Stable reading + `isAccepting()` true → `sink.provide(n)` fires
  **once**, `onConfirm(n)` feedback fires, phase locks to
  `waiting-release`.
- If the game is between balls (`isAccepting()` false) the hold is shown
  as "Hold on…" and the buffer resets — nothing queues for the next ball.

## 11. Gesture release / reset behavior

- While `waiting-release`, every pose is ignored ("Remove your hand")
  until `absentToRelease (6)` consecutive empty frames → `toReady()`.
  Out-of-frame and out-of-sight both count as absent.
- `setInputEnabled(false)` (game lock): preview keeps drawing, pose
  reading pauses, release tracking unaffected.
- `stop()`: cancels loop, stops tracks, closes Hands, bumps the start
  generation so pending starts die silent, fully resets state. Start/stop
  races are generation-guarded (`StaleStart`).

## 12. Important edge cases

- Skeleton draws for **any** detected hand, even unclassifiable poses
  (overlay is independent of recognition).
- Ambiguous finger or thumb-contact edge → `null`, never a wrong number.
- Non-finite metrics fail their rule (`matchRule`).
- Script-load failure rejects but clears the cached promise (retry safe).
- `video.play()` / zero-dimension startup guarded before MediaPipe runs.
- Single in-flight frame (`sending` flag) — no pile-up on slow devices.

## 13. What depends on the existing application

- **Script globals:** `window.HCSpec` (from `gesture-spec.js`) must load
  before the other two; `window.HCGestures` before `camera-input.js`.
- **DOM ids (must exist):** `camVideo`, `camOverlay`, `camError`,
  `camHandStatus`, `camGestureStatus`, `camConfirmStatus`,
  `camConfirmFill`. (Status lines are feedback only; detection never
  depends on them.)
- **Sink contract:** `sink.provide(int 0–10)` — same function the pad
  buttons call; `isAccepting()` predicate from the game;
  `onConfirm(move)` UI hook (never load-bearing).
- **Runtime requirement (observed, not a change):** the pinned jsDelivr
  base must be reachable, and where a page CSP exists it must permit
  WASM compilation (`'wasm-unsafe-eval'`) or landmarks never arrive.
- **CSS contract:** video mirrored for preview; canvas absolutely
  overlaid (`pointer-events:none`); 4:3 viewport wrap.

## 14. How to integrate into the older version later

1. Copy the three JS files into the old project in load order
   (§13 globals order), or keep this folder as-is and reference it.
2. Add the 7 DOM ids (§13) to the old camera panel markup
   (video + canvas overlay + status lines + error + progress fill).
3. Wire `HCCamera.start({ sink, isAccepting, onConfirm })` to the old
   game's single shared input sink (`provide(0–10)`), the old
   per-ball acceptance gate, and an optional pad-flash hook.
4. Call `HCCamera.setInputEnabled(true/false)` around the old ball
   lifecycle; call `HCCamera.stop()` on reset/navigation.
5. Keep the pinned MediaPipe version/base and the capture ideals;
   verify with `synthetic-gestures.js` vectors
   (`LM6→6, LM9→9, LM10→10`) before live-camera testing.
6. Do NOT retune thresholds, mapping, or temporal constants — they are
   the preserved, verified knowledge.
