/* Hand Cricket gesture classifier — v2 engine around window.HCSpec.
 *
 * Pure geometry on the 21 MediaPipe hand landmarks. No DOM, no game
 * rules, no network. Input: landmarks in MediaPipe order ({x,y,z}).
 * Output: integer 0-10, or null when the pose is unclear.
 *
 * Preserved from v1: metric definitions (ext/straight/avg, spread/lift/
 * perp/contact), palm normalization, dot-product angles, exact 0-10
 * mapping, and the ambiguity rule (unclear => null, never a wrong
 * number). Only the decision boundaries moved (see gesture-spec.js v2).
 *
 * v2 evaluation:
 *   - distances: 3D Euclidean / palm size (distance invariant)
 *   - angles: dot products in degrees (rotation invariant)
 *   - index/middle/ring use finger.openRules/closedRules (v1 tolerance);
 *     pinky uses finger.pinky.* (stricter: half-folded is never open).
  *   - thumb is three-state: foldedRules first (braced/resting/curled/
  *     behind => closed, always), then openRules (needs lift + a second
  *     signal + palm-plane side), else UNKNOWN (blocks the frame). v1's
  *     single-signal open rule is gone — it promoted braced thumbs
  *     (4 -> 5). side/depth split the tip offset into palm-plane lateral
  *     vs out-of-plane so a behind-thumb (small side, large depth) reads
  *     folded, never open (back-of-hand 3/4 fix).
 *   - any UNKNOWN finger or thumb blocks the read (null). The 3/4/5
 *     ladder therefore needs strict evidence at each step up.
 */
'use strict';

(function () {
  function spec() {
    return (typeof window !== 'undefined' && window.HCSpec) || null;
  }

  function pt(lm, i) {
    const p = lm[i];
    if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] || 0 };
    return { x: p.x, y: p.y, z: p.z || 0 };
  }

  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function angleDeg(a, b, c) {
    const v1x = a.x - b.x, v1y = a.y - b.y, v1z = a.z - b.z;
    const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
    const d1 = Math.sqrt(v1x * v1x + v1y * v1y + v1z * v1z);
    const d2 = Math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z);
    if (d1 < 1e-9 || d2 < 1e-9) return 180;
    let cos = (v1x * v2x + v1y * v2y + v1z * v2z) / (d1 * d2);
    if (cos > 1) cos = 1;
    if (cos < -1) cos = -1;
    return Math.acos(cos) * (180 / Math.PI);
  }

  // A rule holds when every listed metric passes. Plain keys are minimums
  // (>=); keys ending in "Max" are maximums (<=). Non-finite metrics fail.
  function matchRule(shape, rule) {
    for (const k in rule) {
      if (!Object.prototype.hasOwnProperty.call(rule, k)) continue;
      const isMax = k.slice(-3) === 'Max';
      const key = isMax ? k.slice(0, -3) : k;
      const got = shape[key];
      const want = rule[k];
      if (typeof got !== 'number' || !isFinite(got)) return false;
      if (isMax ? got > want : got < want) return false;
    }
    return true;
  }

  function matchAny(shape, rules) {
    if (!rules) return false;
    for (let i = 0; i < rules.length; i++) {
      if (matchRule(shape, rules[i])) return true;
    }
    return false;
  }

  // straight: tip-to-knuckle reach / summed bone lengths (1.0 = ruler).
  // ext: reach / palm size. avg: mean of the two mid-joint angles.
  function fingerShape(lm, mcp, pip, dip, tip, palm) {
    const A = pt(lm, mcp), B = pt(lm, pip), C = pt(lm, dip), D = pt(lm, tip);
    const a1 = angleDeg(A, B, C);
    const a2 = angleDeg(B, C, D);
    const avg = (a1 + a2) / 2;
    const reach = dist(D, A);
    const bones = dist(A, B) + dist(B, C) + dist(C, D);
    const straight = bones > 1e-9 ? reach / bones : 1;
    const ext = reach / palm;
    return { a1, a2, avg, ext, straight };
  }

  // Three-state finger read: true (open) / false (closed) / null
  // (ambiguous — blocks classification). Pinky uses its stricter rules.
  function fingerState(S, shape, isPinky) {
    const P = (isPinky && S.finger.pinky) || S.finger;
    if (matchAny(shape, P.openRules)) return true;
    if (matchAny(shape, P.closedRules)) return false;
    return null;
  }

  function thumbShape(lm, palm) {
    const S = spec();
    const L = S ? S.landmarks : null;
    const wrist = pt(lm, 0);
    const cmc = pt(lm, 1), mcp = pt(lm, 2), ip = pt(lm, 3), tip = pt(lm, 4);
    const indexMcp = pt(lm, 5), midMcp = pt(lm, 9);
    const ringMcp = pt(lm, 13), pinkyMcp = pt(lm, 17);
    const a1 = angleDeg(cmc, mcp, ip);
    const a2 = angleDeg(mcp, ip, tip);
    const avg = (a1 + a2) / 2;
    const spread = dist(tip, indexMcp) / palm;
    const lift = dist(tip, midMcp) / palm;
    // Sideways abduction from the wrist-to-middle-knuckle axis (unsigned
    // 3D cross product: rotation and handedness independent).
    const ax = midMcp.x - wrist.x, ay = midMcp.y - wrist.y, az = midMcp.z - wrist.z;
    const bx = tip.x - wrist.x, by = tip.y - wrist.y, bz = tip.z - wrist.z;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const perp = Math.sqrt(cx * cx + cy * cy + cz * cz) / (palm * palm);
    // Palm-plane orientation (back-of-hand aware, hand landmarks only).
    // Normal from wrist->index x wrist->pinky; center = mean of wrist +
    // 4 knuckles. Decompose tip-center into lateral in-plane (side) vs
    // out-of-plane (depth). A thumb tucked BEHIND the hand has small side
    // even when its 3D lift/spread/perp look large from depth (z) alone.
    // Genuine extension is lateral (sticks OUT of the silhouette).
    // Rotation/handedness independent (magnitudes only).
    const pcx = (wrist.x + indexMcp.x + midMcp.x + ringMcp.x + pinkyMcp.x) / 5;
    const pcy = (wrist.y + indexMcp.y + midMcp.y + ringMcp.y + pinkyMcp.y) / 5;
    const pcz = (wrist.z + indexMcp.z + midMcp.z + ringMcp.z + pinkyMcp.z) / 5;
    const ux = indexMcp.x - wrist.x, uy = indexMcp.y - wrist.y, uz = indexMcp.z - wrist.z;
    const vx = pinkyMcp.x - wrist.x, vy = pinkyMcp.y - wrist.y, vz = pinkyMcp.z - wrist.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nn = Math.sqrt(nx * nx + ny * ny + nz * nz);
    let side, depth;
    if (!(nn > 1e-9)) {
      // Degenerate palm (never in practice): sit in the UNKNOWN band so
      // the frame blocks instead of guessing a wrong number.
      side = 0.37;
      depth = 0;
    } else {
      const wx = tip.x - pcx, wy = tip.y - pcy, wz = tip.z - pcz;
      const vdotn = wx * nx + wy * ny + wz * nz;
      const axial = vdotn / nn;
      const v2 = wx * wx + wy * wy + wz * wz;
      const lat2 = Math.max(0, v2 - axial * axial);
      side = Math.sqrt(lat2) / palm;
      depth = Math.abs(axial) / palm;
    }
    // Nearest approach to the middle/ring/pinky mid-joints. A wrapped
    // thumb rests ON them (small) even when it reaches far sideways.
    const contactIdx = (L && L.thumb.contactIndices) || [10, 11, 14, 15, 18, 19];
    let contact = Infinity;
    contactIdx.forEach((i) => {
      const d = dist(tip, pt(lm, i)) / palm;
      if (d < contact) contact = d;
    });
    return { a1, a2, avg, spread, lift, perp, contact, side, depth };
  }

  // Three-state thumb read: true (open) / false (folded) / null
  // (marginal — blocks classification, never a wrong number).
  // Folded is tested FIRST: a braced, resting, or curled thumb is
  // closed no matter what the other signals say.
  function thumbState(S, t) {
    if (matchAny(t, S.thumb.foldedRules)) return false;
    if (t.contact < S.thumb.contactMin) return false;
    // Gray zone (contactMin..contactBand): the tip is off the fist but
    // not clearly clear. Only undeniable extension reads OPEN here;
    // anything weaker blocks the frame instead of risking a 4 -> 5.
    if (S.thumb.contactBand && t.contact < S.thumb.contactBand) {
      if (matchAny(t, S.thumb.strongOpenRules || S.thumb.openRules)) return true;
      return null;
    }
    if (matchAny(t, S.thumb.openRules)) return true;
    // Backward compatibility: v1 specs have no foldedRules (only
    // contactMin + openRules). On v1, fall back to binary v1 logic.
    if (!S.thumb.foldedRules) return matchAny(t, S.thumb.openRules);
    // v2: marginal thumb blocks the frame instead of guessing.
    // Hysteresis note: folded already returned false above, so reaching
    // here means the tip is clear of the fist but not clearly extended.
    return null;
  }

  function classifyLandmarks(landmarks) {
    const S = spec();
    if (!S || !landmarks || landmarks.length < 21) return null;
    try {
      const L = S.landmarks;
      const wrist = pt(landmarks, L.wrist);
      const midMcp = pt(landmarks, L.palmKnuckle);
      const palm = dist(wrist, midMcp);
      if (!isFinite(palm) || palm < 1e-6) return null;

      const fingers = ['index', 'middle', 'ring', 'pinky'];
      const open = {};
      for (let f = 0; f < fingers.length; f++) {
        const name = fingers[f];
        const J = L[name];
        const shape = fingerShape(landmarks, J.mcp, J.pip, J.dip, J.tip, palm);
        const st = fingerState(S, shape, name === 'pinky');
        // Ambiguous fingers block the read: one unstable frame must
        // never become a submitted number. This is also the 3/4 guard:
        // a half-folded pinky yields null here, never a promotion to 4.
        if (st === null) return null;
        open[name] = st;
      }
      const t = thumbState(S, thumbShape(landmarks, palm));
      // Marginal thumb blocks the read: the 4/5 guard. A thumb that is
      // neither clearly braced nor clearly extended can never promote
      // a 4 to a 5.
      if (t === null) return null;
      const state = [t, open.index, open.middle, open.ring, open.pinky];

      for (let r = 0; r < S.mapping.length; r++) {
        const row = S.mapping[r];
        let hit = true;
        for (let k = 0; k < 5; k++) {
          if (!!row.open[k] !== state[k]) { hit = false; break; }
        }
        if (hit) return row.n;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  window.HCGestures = {
    classifyLandmarks,
    _helpers: { fingerShape, thumbShape, fingerState, thumbState, angleDeg, dist },
  };
})();
