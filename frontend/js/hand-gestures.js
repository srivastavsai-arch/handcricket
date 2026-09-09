/* Hand Cricket gesture classifier — rebuilt around window.HCSpec.
 *
 * Pure geometry on the 21 MediaPipe hand landmarks. No DOM, no game
 * rules, no network. Input: landmarks in MediaPipe order ({x,y,z}).
 * Output: integer 0-10, or null when the pose is unclear.
 *
 * Every threshold, index, and mapping row lives in gesture-spec.js
 * (HCSpec v1, frozen). This file is only the evaluation engine:
 *   - distances: 3D Euclidean / palm size (distance invariant)
 *   - angles: dot products in degrees (rotation invariant)
 *   - one matching rule is enough; ambiguity always yields null,
 *     never a wrong number.
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

  function fingerOpen(S, shape) {
    return matchAny(shape, S.finger.openRules);
  }

  function fingerClosed(S, shape) {
    return matchAny(shape, S.finger.closedRules);
  }

  function thumbShape(lm, palm) {
    const S = spec();
    const L = S ? S.landmarks : null;
    const wrist = pt(lm, 0);
    const cmc = pt(lm, 1), mcp = pt(lm, 2), ip = pt(lm, 3), tip = pt(lm, 4);
    const indexMcp = pt(lm, 5), midMcp = pt(lm, 9);
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
    // Nearest approach to the middle/ring/pinky mid-joints. A wrapped
    // thumb rests ON them (small) even when it reaches far sideways.
    const contactIdx = (L && L.thumb.contactIndices) || [10, 11, 14, 15, 18, 19];
    let contact = Infinity;
    contactIdx.forEach((i) => {
      const d = dist(tip, pt(lm, i)) / palm;
      if (d < contact) contact = d;
    });
    return { a1, a2, avg, spread, lift, perp, contact };
  }

  function thumbOpen(S, t) {
    // A wrapped thumb can look straight with a long sideways reach, so it
    // is tested for resting ON the fingers first. Contact always means
    // folded, no matter what the other signals say.
    if (t.contact < S.thumb.contactMin) return false;
    return matchAny(t, S.thumb.openRules);
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
        const isOpen = fingerOpen(S, shape);
        // Ambiguous fingers block the read: one unstable frame must
        // never become a submitted number.
        if (!isOpen && !fingerClosed(S, shape)) return null;
        open[name] = isOpen;
      }
      const tOpen = thumbOpen(S, thumbShape(landmarks, palm));
      const state = [tOpen, open.index, open.middle, open.ring, open.pinky];

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
    _helpers: { fingerShape, thumbShape, angleDeg, dist },
  };
})();
