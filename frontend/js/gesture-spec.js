/* Hand Cricket gesture specification — REFERENCE (v2).
 *
 * Preserves ALL v1 gesture knowledge (landmark layout, 0-10 mapping,
 * tolerance philosophy, pipeline, MediaPipe + capture config) and rebuilds
 * the recognition thresholds that caused the 3/4 -> 5 confusion.
 *
 * What was preserved from v1 (unchanged):
 * - MediaPipe landmark layout + skeleton links (display only).
 * - Exact 0-10 physical gestures + open-vector mapping (see below).
 * - Metric definitions: ext/straight/avg (fingers); spread/lift/perp/
 *   contact/avg (thumb). Same formulas, same normalization (palm size),
 *   same rotation/scale invariance. Mirroring stays display-only.
 * - Tolerance philosophy: natural bend allowed; ambiguous reads return
 *   null (never a wrong number); skeleton draws for any detected hand.
 * - One-gesture-one-input state machine + sink contract (camera-input.js).
 * - MediaPipe version/pinned base/confidences + 4:3 capture ideals.
 *
 * What v2 changes (and why):
 * - Fingers: per-finger rules. Index/middle/ring keep v1 tolerance
 *   (counted fingers must stay easy). Pinky gets STRICTER open rules: a
 *   half-folded pinky (the natural resting pose in gesture 3) must read
 *   CLOSED or UNKNOWN, never OPEN. This fixes 3 -> 4.
 * - Thumb: two-sided decision. A folded fast-path (contact OR buried-tip
 *   OR tight-curl) is checked FIRST so a thumb braced against the index
 *   or resting on the fist can never read OPEN. Open paths then require
 *   lift (tip genuinely clear of the palm) PLUS a second signal, so one
 *   strong-looking metric alone cannot promote 4 -> 5. Marginal thumbs
 *   read UNKNOWN (blocks the frame) instead of guessing. This fixes 4->5,
 *   and together with the pinky fix, 3 -> 5.
 * - Temporal: needStable 6 -> 4, bufferMax 8 -> 6, absentToRelease 6 -> 4.
 *   Same algorithm (identical readings + 1 null skip + release lock),
 *   fewer frames: noticeably faster confirm + faster re-arm, same
 *   one-gesture-one-input guarantee.
 *
 * Conventions (unchanged):
 * - Landmarks arrive in MediaPipe order: 21 points, each {x, y, z}.
 * - All distances are 3D Euclidean, normalized by palm size
 *   (wrist -> middle-knuckle). Scale/distance invariant by construction.
 * - All joint angles use dot products (degrees). Rotation invariant.
 * - A rule object lists minimums a metric must reach (>=). A key ending
 *   in "Max" is a maximum (<=). One matching rule is enough (OR);
 *   every key inside a rule must hold (AND).
 */
'use strict';

(function () {
  var SPEC = {
    version: 2,

    // ---- MediaPipe landmark layout (PRESERVED from v1) ----
    landmarks: {
      wrist: 0,
      thumb: { cmc: 1, mcp: 2, ip: 3, tip: 4 },
      index: { mcp: 5, pip: 6, dip: 7, tip: 8 },
      middle: { mcp: 9, pip: 10, dip: 11, tip: 12 },
      ring: { mcp: 13, pip: 14, dip: 15, tip: 16 },
      pinky: { mcp: 17, pip: 18, dip: 19, tip: 20 },
      palmKnuckle: 9, // middle MCP: wrist->here == palm size
      // Skeleton links for the overlay exoskeleton (display only).
      links: [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16],
        [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
      ],
    },

    // ---- Long-finger shape metrics (per finger) ----
    // straight = tip-to-knuckle reach / summed bone lengths (1.0 = ruler).
    // ext     = reach / palm size (distance invariant).
    // avg     = mean of the two mid-joint angles in degrees.
    //
    // Index/middle/ring keep v1 tolerance (they are the counted fingers:
    // a naturally curved but genuinely extended finger must still open).
    // Pinky is STRICTER: it is short, often rests half-folded in gesture
    // 3, and was the 3 -> 4 culprit. A half-folded pinky must be CLOSED
    // or UNKNOWN, never OPEN.
    finger: {
      openRules: [
        { ext: 0.95 },
        { straight: 0.86, ext: 0.60 },
        { avg: 135, ext: 0.62 },
        { avg: 150, ext: 0.55 },
      ],
      closedRules: [
        { extMax: 0.52 },
        { straightMax: 0.72, extMax: 0.74 },
        { avgMax: 110, extMax: 0.78 },
      ],
      // Neither open nor closed => UNKNOWN: blocks classification (null),
      // never a wrong number. One unstable frame must never submit a move.
      pinky: {
        openRules: [
          { ext: 0.95 },
          { straight: 0.88, ext: 0.65 },
          { avg: 145, ext: 0.66 },
          { avg: 152, ext: 0.60 },
        ],
        closedRules: [
          { extMax: 0.55 },
          { straightMax: 0.75, extMax: 0.76 },
          { avgMax: 118, extMax: 0.80 },
        ],
      },
    },

    // ---- Thumb metrics ----
    // spread  = tip-to-index-knuckle / palm. lift = tip-to-middle-knuckle.
    // perp    = sideways abduction: |cross(handAxis, wrist->tip)| / palm^2,
    //           large when the thumb sticks OUT, small when wrapped.
    // contact = nearest tip approach to middle/ring/pinky mid-joints
    //           (indices 10,11,14,15,18,19; index excluded on purpose).
    //
    // v2 is two-sided. foldedRules are checked FIRST: any match means the
    // thumb is braced/resting/curled and can never read OPEN, no matter
    // how straight it looks. openRules then need lift (tip genuinely
    // clear of the palm) PLUS a second signal. v1's single-signal rule
    // ({perp, avg} with no lift/spread requirement) is gone: it fired
    // for thumbs lying flat against the index finger (the 4 -> 5 bug).
    // Neither folded nor open => UNKNOWN (blocks the frame, never 5).
    // contactBand is the gray zone between resting-ON and clearly-clear:
    // in it, only undeniable extension (strongOpenRules) reads OPEN;
    // anything weaker blocks instead of guessing. This keeps genuine 6s
    // stable under landmark noise without loosening the 4 -> 5 guard.
    thumb: {
      contactIndices: [10, 11, 14, 15, 18, 19],
      contactMin: 0.55, // below this the thumb rests ON the fist => folded
      contactBand: 0.62, // gray zone: needs strong-open evidence, else null
      foldedRules: [
        { contactMax: 0.55 },
        { spreadMax: 0.45, liftMax: 0.50 },
        { avgMax: 115 },
      ],
      strongOpenRules: [
        { lift: 0.85 },
        { perp: 0.45, lift: 0.55, avg: 120 },
      ],
      openRules: [
        { lift: 0.85 },
        { perp: 0.45, lift: 0.55, avg: 120 },
        { spread: 0.70, lift: 0.60, avg: 125 },
        { perp: 0.35, spread: 0.45, lift: 0.50, avg: 120 },
      ],
    },

    // ---- Gesture mapping: [thumb, index, middle, ring, pinky] open? ----
    // PRESERVED EXACTLY from v1. Do not change these gestures.
    // 0 = fist; 4 = four fingers, thumb closed; 5 = all five;
    // 6 = thumb ONLY; 9 = thumb + pinky; 10 = thumb + index + pinky.
    // The trio is distinguished by pinky/index state, never by the thumb.
    // Note the 3/4/5 ladder: [F,T,T,T,F] -> 3, [F,T,T,T,T] -> 4,
    // [T,T,T,T,T] -> 5. Promoting 3 -> 4 needs strict pinky-open;
    // promoting 4 -> 5 needs strict thumb-open. Marginal evidence on
    // either step yields null, never the higher number.
    mapping: [
      { n: 0, open: [false, false, false, false, false] },
      { n: 1, open: [false, true, false, false, false] },
      { n: 2, open: [false, true, true, false, false] },
      { n: 3, open: [false, true, true, true, false] },
      { n: 4, open: [false, true, true, true, true] },
      { n: 5, open: [true, true, true, true, true] },
      { n: 6, open: [true, false, false, false, false] },
      { n: 7, open: [true, true, false, false, false] },
      { n: 8, open: [true, true, true, false, false] },
      { n: 9, open: [true, false, false, false, true] },
      { n: 10, open: [true, true, false, false, true] },
    ],

    // ---- Temporal stabilization (frames, not ms — latency-safe) ----
    // Same algorithm as v1 (identical readings + nullSkip + release
    // lock); fewer frames so confirmation feels instant while keeping
    // the one-gesture-one-input guarantee.
    temporal: {
      needStable: 4, // identical readings to confirm (4th generates the move)
      bufferMax: 6, // sliding window of recent readings
      nullSkip: 1, // tolerate one noisy frame inside the window
      absentToRelease: 4, // empty frames in a row == hand removed
    },

    // ---- MediaPipe Hands configuration (PRESERVED, pinned, verified) ----
    mediapipe: {
      version: '0.4.1675469240',
      base: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    },

    // ---- Camera capture (PRESERVED: true 4:3, all ideals = fallback) ----
    capture: {
      facingMode: 'user',
      widthIdeal: 1280,
      heightIdeal: 960,
      aspectRatioIdeal: 4 / 3,
    },
  };

  // Deep-freeze so nothing at runtime can drift the reference.
  (function freeze(o) {
    Object.keys(o).forEach(function (k) {
      if (o[k] && typeof o[k] === 'object') freeze(o[k]);
    });
    try { Object.freeze(o); } catch (e) {}
  })(SPEC);

  window.HCSpec = SPEC;
})();
