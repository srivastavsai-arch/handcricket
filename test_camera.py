"""Lifecycle + pipeline tests for camera-input.js (frontend/js/camera-input.js).

Runs the REAL module under plain node with stubbed browser APIs:
  - 4:3 capture is requested (1280x960 ideal + aspectRatio 4/3)
  - a failed MediaPipe script load does not poison later attempts
  - stop() during a pending start leaks no stream/loop and stays silent
  - start -> stop -> restart works with exactly one loop, no stale state
  - end-to-end: synthetic 6 / 9 / 10 landmark frames flow through the real
    gesture classifier + confirmation state machine into sink.provide()
"""
import subprocess
import textwrap
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent

NODE_HARNESS = textwrap.dedent("""
    const fs = require('fs');
    const vm = require('vm');
    const results = [];
    const check = (name, cond) => results.push([name, !!cond]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function flush(n = 8) { for (let i = 0; i < n; i++) await sleep(0); }

    // ---------- browser stubs ----------
    function makeEl() {
      return { textContent: '', style: {},
        classList: { add() {}, remove() {}, contains() { return false; } } };
    }
    const video = { srcObject: null, muted: false, playsInline: false,
      videoWidth: 1280, videoHeight: 960, readyState: 4,
      play() { return Promise.resolve(); } };
    const ctx2d = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() {}, arc() {}, fill() {} };
    const canvas = { clientWidth: 400, clientHeight: 300, width: 0, height: 0,
      getContext() { return ctx2d; } };
    const els = {};
    const scripts = [];
    const gumPending = [];
    let gumCalls = 0, gumConstraints = null;
    const rafCalls = [];
    let rafId = 0;
    const sandbox = {
      window: {},
      console,
      setTimeout, clearTimeout,
      requestAnimationFrame: (fn) => { rafCalls.push(fn); return ++rafId; },
      cancelAnimationFrame: () => {},
      navigator: { mediaDevices: { getUserMedia: (c) => {
        gumCalls++;
        gumConstraints = c;
        return new Promise((resolve, reject) => gumPending.push({ resolve, reject }));
      } } },
      document: {
        getElementById: (id) => {
          if (id === 'camVideo') return video;
          if (id === 'camOverlay') return canvas;
          if (!els[id]) els[id] = makeEl();
          return els[id];
        },
        createElement: (tag) => {
          const s = { tag, src: '', async: false, onload: null, onerror: null };
          scripts.push(s);
          return s;
        },
        head: { appendChild: () => {} },
      },
    };
    sandbox.window.navigator = sandbox.navigator;
    sandbox.window.document = sandbox.document;
    sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
    sandbox.window.cancelAnimationFrame = sandbox.cancelAnimationFrame;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync('frontend/js/gesture-spec.js', 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync('frontend/js/hand-gestures.js', 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync('frontend/js/camera-input.js', 'utf8'), sandbox);
    const CAM = sandbox.window.HCCamera;

    function fakeStream() {
      const track = { stopped: false, stop() { track.stopped = true; } };
      return { getTracks: () => [track], _track: track };
    }
    const handsInstances = [];
    function FakeHands() {
      this.opts = null; this.cb = null; this.sent = []; this.closed = false;
      handsInstances.push(this);
    }
    FakeHands.prototype.setOptions = function (o) { this.opts = o; };
    FakeHands.prototype.onResults = function (cb) { this.cb = cb; };
    FakeHands.prototype.send = function (img) { this.sent.push(img); return Promise.resolve(); };
    FakeHands.prototype.close = function () { this.closed = true; };

    // synthetic landmarks (same geometry proven by the gesture audit)
    const rad = (d) => (d * Math.PI) / 180;
    const rot2 = (v, t) => { const c = Math.cos(rad(t)), s = Math.sin(rad(t));
      return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
    function chain(mcp, dir, c1, c2, segs) {
      const PIP = [mcp[0] + dir[0] * segs[0], mcp[1] + dir[1] * segs[0], 0];
      const d1 = rot2(dir, c1);
      const DIP = [PIP[0] + d1[0] * segs[1], PIP[1] + d1[1] * segs[1], 0];
      const d2 = rot2(d1, c2);
      const TIP = [DIP[0] + d2[0] * segs[2], DIP[1] + d2[1] * segs[2], 0];
      return [PIP, DIP, TIP];
    }
    const MCP = { index: [-0.3, 0.95, 0], middle: [-0.1, 1.0, 0],
      ring: [0.1, 0.95, 0], pinky: [0.28, 0.85, 0] };
    function finger(name, open) {
      return chain(MCP[name], [0, 1], open ? 6 : 85, open ? 4 : 95, [0.34, 0.24, 0.22]);
    }
    function gesture(idxOpen, pnkOpen) {
      const lm = new Array(21);
      lm[0] = [0, 0, 0];
      const t = chain([-0.28, 0.3, 0.02], [-0.55 / 1.0, 0.83 / 1.0], 8, 6, [0.3, 0.24, 0.22]);
      lm[1] = [-0.28, 0.3, 0.02]; lm[2] = t[0]; lm[3] = t[1]; lm[4] = t[2];
      const map = { index: [5, idxOpen], middle: [9, false], ring: [13, false], pinky: [17, pnkOpen] };
      for (const [f, [bi, o]] of Object.entries(map)) {
        const [PIP, DIP, TIP] = finger(f, o);
        lm[bi] = MCP[f].slice(); lm[bi + 1] = PIP; lm[bi + 2] = DIP; lm[bi + 3] = TIP;
      }
      return lm;
    }
    const LM6 = () => gesture(false, false);
    const LM9 = () => gesture(false, true);
    const LM10 = () => gesture(true, true);

    (async () => {
      const provided = [];
      const sink = { provide: (m) => provided.push(m) };
      const accepting = () => true;
      sandbox.window.Hands = FakeHands;

      // 1. 4:3 constraints requested
      let p = CAM.start({ sink, isAccepting: accepting });
      p.then(function(){}, function(){}); // pre-handled: node24 crashes on cross-sleep rejections
      await flush();
      const v = gumConstraints && gumConstraints.video;
      check('c43-width', v && v.width && v.width.ideal === 1280);
      check('c43-height', v && v.height && v.height.ideal === 960);
      check('c43-ratio', v && v.aspectRatio && Math.abs(v.aspectRatio.ideal - 4 / 3) < 1e-9);
      check('c43-facing', v && v.facingMode === 'user');
      // finish this start cleanly
      gumPending.shift().resolve(fakeStream());
      await flush(20);
      check('c43-active', CAM.isActive() === true);
      const h0 = handsInstances[handsInstances.length - 1];
      check('c43-thresholds', h0.opts && h0.opts.maxNumHands === 1 &&
        h0.opts.minDetectionConfidence === 0.6 && h0.opts.minTrackingConfidence === 0.5 &&
        h0.opts.modelComplexity === 0);
      CAM.stop();
      check('c43-stopped', CAM.isActive() === false);

      // 2. failed script load does not poison retry
      delete sandbox.window.Hands;
      const scriptsBefore = scripts.length;
      let p2 = CAM.start({ sink, isAccepting: accepting });
      p2.then(function(){}, function(){}); // pre-handled: node24 crashes on cross-sleep rejections
      await flush();
      check('retry-tag-appended', scripts.length === scriptsBefore + 1);
      scripts[scripts.length - 1].onerror(new Error('net down'));
      let rejected = false;
      try { await p2; } catch (e) { rejected = true; }
      check('retry-first-rejects', rejected);
      // Retry while the library is STILL missing: must attempt a fresh
      // fetch (without the fix, the cached rejection fires, no new tag).
      let p3 = CAM.start({ sink, isAccepting: accepting });
      p3.then(function(){}, function(){}); // pre-handled: node24 crashes on cross-sleep rejections
      await flush();
      check('retry-tag-reappended', scripts.length === scriptsBefore + 2);
      scripts[scripts.length - 1].onload();
      await flush();
      let p3rejected = false;
      try { await p3; } catch (e) { p3rejected = /hand library missing/.test(e && e.message); }
      check('retry-missing-library', p3rejected);
      // Now provide the library: start must proceed to the camera.
      sandbox.window.Hands = FakeHands;
      let p3b = CAM.start({ sink, isAccepting: accepting });
      p3b.then(function(){}, function(){}); // pre-handled: node24 crashes on cross-sleep rejections
      await flush();
      gumPending.shift().resolve(fakeStream());
      await flush(20);
      check('retry-succeeds', CAM.isActive() === true);
      CAM.stop();

      // 3. stop() during pending start: no leak, silent
      const rafBefore = rafCalls.length;
      const errEl = els['camError'];
      errEl.textContent = '';
      let p4 = CAM.start({ sink, isAccepting: accepting });
      p4.then(function(){}, function(){}); // pre-handled: node24 crashes on cross-sleep rejections
      await flush();
      const pend = gumPending.shift();
      CAM.stop();
      let p4settled = false, p4rejected = false;
      p4.then(() => { p4settled = true; }, () => { p4rejected = true; });
      const leaked = fakeStream();
      pend.resolve(leaked);
      await flush(20);
      check('stale-not-active', CAM.isActive() === false);
      check('stale-track-stopped', leaked._track.stopped === true);
      check('stale-no-loop', rafCalls.length === rafBefore);
      check('stale-silent', errEl.textContent === '');
      check('stale-settled', p4settled && !p4rejected);

      // 3b. stop() while waiting for first frames: silent, nothing created
      video.videoWidth = 0; video.videoHeight = 0;
      const handsBefore = handsInstances.length;
      let p6 = CAM.start({ sink, isAccepting: accepting });
      p6.then(function(){}, function(){});
      await flush();
      gumPending.shift().resolve(fakeStream());
      await flush(10); // now polling inside waitForVideo
      CAM.stop();
      video.videoWidth = 1280; video.videoHeight = 960; // frames arrive after close
      await flush(20);
      check('wait-stopped-silent', els['camError'].textContent === '');
      check('wait-no-hands', handsInstances.length === handsBefore);

      // 4. clean start after the storm, then E2E 6 -> 9 -> 10
      provided.length = 0;
      let p5 = CAM.start({ sink, isAccepting: accepting });
      p5.then(function(){}, function(){}); // pre-handled: node24 crashes on cross-sleep rejections
      await flush();
      gumPending.shift().resolve(fakeStream());
      await flush(20);
      check('e2e-active', CAM.isActive() === true);
      const h = handsInstances[handsInstances.length - 1];
      const fire = (lm, n) => { for (let i = 0; i < n; i++) h.cb({ multiHandLandmarks: [lm] }); };
      const fireNull = (n) => { for (let i = 0; i < n; i++) h.cb({ multiHandLandmarks: [] }); };
      fire(LM6(), 6);
      check('e2e-6', provided.length === 1 && provided[0] === 6);
      fireNull(6); // release
      fire(LM9(), 6);
      check('e2e-9', provided.length === 2 && provided[1] === 9);
      fireNull(6);
      fire(LM10(), 6);
      check('e2e-10', provided.length === 3 && provided[2] === 10);
      // one gesture = one move: extra held frames must not re-fire
      fire(LM10(), 6);
      check('e2e-no-refire', provided.length === 3);
      CAM.stop();
      check('e2e-stopped-clean', CAM.isActive() === false && h.closed === true);

      console.log(JSON.stringify(results));
    })().catch((e) => { console.log(JSON.stringify([...results, ['harness-crash:' + (e && e.message), false]])); });
""")


def test_camera_lifecycle_and_pipeline():
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS],
        cwd=str(REPO_ROOT),
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    results = json.loads(proc.stdout.strip().splitlines()[-1])
    failed = [name for name, ok in results if not ok]
    assert not failed, f"camera lifecycle failures: {failed}"
    assert len(results) == 25, f"expected 25 checks, got {len(results)}"
