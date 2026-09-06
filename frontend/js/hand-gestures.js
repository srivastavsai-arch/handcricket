/* Prototype 3.5 gesture classifier — experimental camera input.
 *
 * Pure geometry on hand landmarks. No DOM, no game rules, no network.
 * Input: 21 landmarks in MediaPipe order, each {x,y,z} or [x,y,z].
 * Output: integer 0 to 10, or null when the pose is unclear.
 *
 * Mapping (must stay in lockstep with the rulebook):
 *   0: closed fist, everything folded
 *   1: index open only
 *   2: index + middle open
 *   3: index + middle + ring open
 *   4: index + middle + ring + little open, thumb closed
 *   5: all five open
 *   6: thumb only open
 *   7: thumb + index open
 *   8: thumb + index + middle open
 *   9: thumb + little open, index + middle + ring closed
 *  10: thumb + index + little open
 *
 * Robustness strategy (no raw pixel rules):
 * - All distances are Euclidean in landmark space, divided by palm size
 *   (wrist to middle knuckle). This makes the result independent of how
 *   close or far the hand is from the camera.
 * - Joint angles use dot products, which are independent of hand rotation,
 *   tilt and position. No comparison of raw x or y coordinates is used,
 *   so left and right hands behave the same.
 * - A finger counts as open only when it is BOTH fairly straight AND
 *   reasonably extended. Either signal alone is not enough.
 * - The thumb counts as open only when it sticks OUT sideways from the
 *   hand axis. A thumb wrapped across a fist can look straight, so
 *   straightness alone never opens it.
 */
'use strict';

(function () {
  function pt(lm, i) {
    const p = lm[i];
    if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] || 0 };
    return { x: p.x, y: p.y, z: p.z || 0 };
  }

  function dist(a, b) {
    // Full 3D Euclidean distance. Keeping depth at full weight (instead
    // of discounting z) is what keeps finger reach correct when the hand
    // is tilted or a finger points toward the camera.
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

  // Straightness of a long finger from its two mid joints.
  function fingerShape(lm, mcp, pip, dip, tip, palm) {
    const A = pt(lm, mcp), B = pt(lm, pip), C = pt(lm, dip), D = pt(lm, tip);
    const a1 = angleDeg(A, B, C);
    const a2 = angleDeg(B, C, D);
    const avg = (a1 + a2) / 2;
    const ext = dist(D, A) / palm;
    return { a1, a2, avg, ext };
  }

  function fingerOpen(shape) {
    if (shape.ext >= 0.95) return true;
    if (shape.avg >= 150 && shape.ext >= 0.62) return true;
    return false;
  }

  function fingerClosed(shape) {
    if (shape.ext <= 0.50) return true;
    if (shape.avg <= 105 && shape.ext <= 0.72) return true;
    return false;
  }

  function thumbShape(lm, palm) {
    const wrist = pt(lm, 0);
    const cmc = pt(lm, 1), mcp = pt(lm, 2), ip = pt(lm, 3), tip = pt(lm, 4);
    const indexMcp = pt(lm, 5), midMcp = pt(lm, 9);
    const a1 = angleDeg(cmc, mcp, ip);
    const a2 = angleDeg(mcp, ip, tip);
    const avg = (a1 + a2) / 2;
    const spread = dist(tip, indexMcp) / palm;
    const lift = dist(tip, midMcp) / palm;
    // Abduction: perpendicular distance of the thumb tip from the
    // wrist-to-middle-knuckle axis. An extended thumb sticks OUT sideways
    // (large); a thumb folded or wrapped across the hand lies near the
    // axis (small) even when its own joints look straight. Rotation and
    // handedness independent by construction (unsigned 3D cross product).
    const ax = midMcp.x - wrist.x, ay = midMcp.y - wrist.y, az = midMcp.z - wrist.z;
    const bx = tip.x - wrist.x, by = tip.y - wrist.y, bz = tip.z - wrist.z;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const perp = Math.sqrt(cx * cx + cy * cy + cz * cz) / (palm * palm);
    // Nearest approach of the tip to the middle/ring/little mid-joints.
    // A thumb wrapped across a fist rests ON those joints (small) even
    // when it reaches far sideways; an extended thumb is far from all of
    // them. Index is excluded: it sits next to the thumb in several open
    // poses (7, 8, 10) and must not count as wrapping.
    let contact = Infinity;
    [10, 11, 14, 15, 18, 19].forEach((i) => {
      const d = dist(tip, pt(lm, i)) / palm;
      if (d < contact) contact = d;
    });
    return { a1, a2, avg, spread, lift, perp, contact };
  }

  function thumbOpen(t) {
    // A wrapped fist thumb can look straight with a long sideways reach,
    // so it is tested for resting ON the fingers first. Contact always
    // means folded, no matter what the other signals say.
    if (t.contact < 0.55) return false;
    // Clearly out sideways and fairly straight, touching nothing.
    if (t.perp >= 0.38 && t.avg >= 120) return true;
    if (t.lift >= 0.78) return true;
    if (t.spread >= 0.64 && t.lift >= 0.55) return true;
    if (t.perp >= 0.28 && t.spread >= 0.30 && t.avg >= 110) return true;
    return false;
  }

  function classifyLandmarks(landmarks) {
    if (!landmarks || landmarks.length < 21) return null;
    try {
      const wrist = pt(landmarks, 0);
      const midMcp = pt(landmarks, 9);
      const palm = dist(wrist, midMcp);
      if (!isFinite(palm) || palm < 1e-6) return null;

      const index = fingerShape(landmarks, 5, 6, 7, 8, palm);
      const middle = fingerShape(landmarks, 9, 10, 11, 12, palm);
      const ring = fingerShape(landmarks, 13, 14, 15, 16, palm);
      const little = fingerShape(landmarks, 17, 18, 19, 20, palm);
      const thumb = thumbShape(landmarks, palm);

      const iOpen = fingerOpen(index);
      const mOpen = fingerOpen(middle);
      const rOpen = fingerOpen(ring);
      const lOpen = fingerOpen(little);
      const tOpen = thumbOpen(thumb);

      // Any ambiguous long finger blocks the read. One unstable frame
      // must never become a submitted number.
      const iKnown = iOpen || fingerClosed(index);
      const mKnown = mOpen || fingerClosed(middle);
      const rKnown = rOpen || fingerClosed(ring);
      const lKnown = lOpen || fingerClosed(little);
      if (!mKnown || !rKnown || !lKnown || !iKnown) return null;

      const iClosed = !iOpen, mClosed = !mOpen, rClosed = !rOpen, lClosed = !lOpen;
      const tClosed = !tOpen;

      if (tClosed && iClosed && mClosed && rClosed && lClosed) return 0;
      if (tClosed && iOpen && mClosed && rClosed && lClosed) return 1;
      if (tClosed && iOpen && mOpen && rClosed && lClosed) return 2;
      if (tClosed && iOpen && mOpen && rOpen && lClosed) return 3;
      if (tClosed && iOpen && mOpen && rOpen && lOpen) return 4;
      if (tOpen && iOpen && mOpen && rOpen && lOpen) return 5;
      if (tOpen && iClosed && mClosed && rClosed && lClosed) return 6;
      if (tOpen && iOpen && mClosed && rClosed && lClosed) return 7;
      if (tOpen && iOpen && mOpen && rClosed && lClosed) return 8;
      if (tOpen && iClosed && mClosed && rClosed && lOpen) return 9;
      if (tOpen && iOpen && mClosed && rClosed && lOpen) return 10;
      return null;
    } catch (e) {
      return null;
    }
  }

  window.HCGestures = {
    classifyLandmarks,
    _debug: { fingerShape, thumbShape, angleDeg, dist },
  };
})();
