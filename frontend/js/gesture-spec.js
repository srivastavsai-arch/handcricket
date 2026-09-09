/* Hand Cricket gesture specification — FROZEN REFERENCE (v1).
 *
 * This file preserves every piece of gesture knowledge from the audited
 * implementation. It is the single source of truth the classifier
 * (hand-gestures.js) and the camera pipeline (camera-input.js) are built
 * around. Values here must NOT be tuned casually: each threshold was
 * verified against natural hand variation (tilt, bend, rotation, scale).
 *
 * There is no ML model and no training dataset in this project — the
 * system is rule-based geometry on MediaPipe hand landmarks, and this
 * file documents those rules exactly.
 *
 * Conventions:
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
    version: 1,

    // ---- MediaPipe landmark layout ----
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
    finger: {
      openRules: [
        { ext: 0.95 },
        { straight: 0.86, ext: 0.55 },
        { avg: 135, ext: 0.60 },
        { avg: 150, ext: 0.55 },
      ],
      closedRules: [
        { extMax: 0.50 },
        { straightMax: 0.70, extMax: 0.72 },
        { avgMax: 105, extMax: 0.75 },
      ],
      // Neither open nor closed => UNKNOWN: blocks classification (null),
      // never a wrong number. One unstable frame must never submit a move.
    },

    // ---- Thumb metrics ----
    // spread  = tip-to-index-knuckle / palm. lift = tip-to-middle-knuckle.
    // perp    = sideways abduction: |cross(handAxis, wrist->tip)| / palm^2,
    //           large when the thumb sticks OUT, small when wrapped.
    // contact = nearest tip approach to middle/ring/pinky mid-joints
    //           (indices 10,11,14,15,18,19; index excluded on purpose).
    thumb: {
      contactIndices: [10, 11, 14, 15, 18, 19],
      contactMin: 0.55, // below this the thumb rests ON the fist => folded
      openRules: [
        { perp: 0.38, avg: 120 },
        { lift: 0.78 },
        { spread: 0.64, lift: 0.55 },
        { perp: 0.28, spread: 0.30, avg: 110 },
      ],
    },

    // ---- Gesture mapping: [thumb, index, middle, ring, pinky] open? ----
    // 6 = thumb ONLY; 9 = thumb + pinky; 10 = thumb + index + pinky.
    // The trio is distinguished by pinky/index state, never by the thumb.
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
    temporal: {
      needStable: 6, // identical readings to confirm (6th generates the move)
      bufferMax: 8, // sliding window of recent readings
      nullSkip: 1, // tolerate one noisy frame inside the window
      absentToRelease: 6, // empty frames in a row == hand removed
    },

    // ---- MediaPipe Hands configuration (pinned, verified) ----
    mediapipe: {
      version: '0.4.1675469240',
      base: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    },

    // ---- Camera capture (true 4:3, all ideals = graceful fallback) ----
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
