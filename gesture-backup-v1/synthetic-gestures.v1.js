/* MediaPipe preserved reference vectors — DO NOT TUNE.
 *
 * Provenance: extracted verbatim from the geometry builders in
 * test_camera.py (the node harness that drives the REAL classifier +
 * confirmation state machine end-to-end). These are the ONLY synthetic
 * poses proven to classify correctly against the frozen HCSpec v1:
 *   LM6()  -> classifies to  6 (thumb only)
 *   LM9()  -> classifies to  9 (thumb + pinky)
 *   LM10() -> classifies to 10 (thumb + index + pinky)
 *
 * Construction notes (preserved exactly):
 * - Landmarks are [x, y, z] arrays in MediaPipe order (21 points).
 *   hand-gestures.js pt() accepts arrays OR {x,y,z} objects.
 * - The thumb chain uses small curls (8, 6) so the thumb is OPEN in all
 *   three vectors; middle + ring fingers are always curled CLOSED
 *   (curls 85, 95); only index / pinky vary.
 * - No vectors for 0-5 / 7 / 8 exist in the harness; do NOT invent them.
 *   They must be built and proven the same way before use.
 *
 * How to verify (browser console or node):
 *   classifyLandmarks(LM6())  === 6
 *   classifyLandmarks(LM9())  === 9
 *   classifyLandmarks(LM10()) === 10
 * where classifyLandmarks is window.HCGestures.classifyLandmarks with
 * window.HCSpec (gesture-spec.js) loaded first.
 */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MCSynthetic = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  var rad = function (d) { return (d * Math.PI) / 180; };
  var rot2 = function (v, t) {
    var c = Math.cos(rad(t)), s = Math.sin(rad(t));
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  };

  // Bone chain from a knuckle along dir with two curl angles (degrees)
  // and three segment lengths. Open fingers: curls (6, 4).
  // Closed fingers: curls (85, 95).
  function chain(mcp, dir, c1, c2, segs) {
    var PIP = [mcp[0] + dir[0] * segs[0], mcp[1] + dir[1] * segs[0], 0];
    var d1 = rot2(dir, c1);
    var DIP = [PIP[0] + d1[0] * segs[1], PIP[1] + d1[1] * segs[1], 0];
    var d2 = rot2(d1, c2);
    var TIP = [DIP[0] + d2[0] * segs[2], DIP[1] + d2[1] * segs[2], 0];
    return [PIP, DIP, TIP];
  }

  var MCP = {
    index: [-0.3, 0.95, 0],
    middle: [-0.1, 1.0, 0],
    ring: [0.1, 0.95, 0],
    pinky: [0.28, 0.85, 0],
  };

  function finger(name, open) {
    return chain(MCP[name], [0, 1], open ? 6 : 85, open ? 4 : 95, [0.34, 0.24, 0.22]);
  }

  // Thumb always OPEN here; middle + ring always CLOSED.
  // idxOpen/pnkOpen select which of 6 / 9 / 10 is built.
  function gesture(idxOpen, pnkOpen) {
    var lm = new Array(21);
    lm[0] = [0, 0, 0];
    var t = chain([-0.28, 0.3, 0.02], [-0.55 / 1.0, 0.83 / 1.0], 8, 6, [0.3, 0.24, 0.22]);
    lm[1] = [-0.28, 0.3, 0.02];
    lm[2] = t[0];
    lm[3] = t[1];
    lm[4] = t[2];
    var map = { index: [5, idxOpen], middle: [9, false], ring: [13, false], pinky: [17, pnkOpen] };
    Object.keys(map).forEach(function (f) {
      var bi = map[f][0], o = map[f][1];
      var pts = finger(f, o);
      lm[bi] = MCP[f].slice();
      lm[bi + 1] = pts[0];
      lm[bi + 2] = pts[1];
      lm[bi + 3] = pts[2];
    });
    return lm;
  }

  function LM6() { return gesture(false, false); }
  function LM9() { return gesture(false, true); }
  function LM10() { return gesture(true, true); }

  return { chain: chain, finger: finger, gesture: gesture, LM6: LM6, LM9: LM9, LM10: LM10 };
}));
