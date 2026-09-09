/* Hand Cricket Camera Mode — rebuilt pipeline (v2).
 *
 * Pipeline:
 *   Camera -> Video -> MediaPipe -> Landmarks -> Colored Exoskeleton
 *     -> Finger States -> Gesture Classification -> Temporal Confirm
 *     -> sink.provide(number) -> existing game engine.
 *
 * Design rules (from gesture-spec.js, the frozen reference):
 * - The EXOSKELETON is independent of recognition: any detected hand is
 *   drawn, whether or not it classifies to 0-10.
 * - Recognition is palm-normalized geometry: no screen coordinates, no
 *   aspect assumptions, rotation and handedness independent. Mirroring is
 *   display-only (CSS + overlay mapping); landmarks are never re-mirrored.
 * - One held pose submits exactly one move; the hand must leave before
 *   the next. The tap pad always works alongside.
 * - Nothing runs before the player presses Play with Camera: no
 *   permission prompt, no stream, no library fetch.
 *
 * Public API (unchanged — app.js depends on it):
 *   HCCamera.start({sink, isAccepting, onConfirm}) -> Promise
 *   HCCamera.stop() | HCCamera.isActive() | HCCamera.setInputEnabled(on)
 */
'use strict';

(function () {
  // ---------- configuration (values: gesture-spec.js) ----------
  function spec() {
    return (typeof window !== 'undefined' && window.HCSpec) || null;
  }
  var MP = (spec() && spec().mediapipe) || {};
  var HANDS_URL = (MP.base || 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/') + 'hands.js';
  var HANDS_LOCATE = MP.base || 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';
  var MAX_HANDS = MP.maxNumHands || 1;
  var MODEL_COMPLEXITY = (MP.modelComplexity === undefined) ? 0 : MP.modelComplexity;
  var MIN_DETECT = MP.minDetectionConfidence || 0.6;
  var MIN_TRACK = MP.minTrackingConfidence || 0.5;
  var CAP = (spec() && spec().capture) || {};
  var NEED_STABLE = ((spec() && spec().temporal) || {}).needStable || 6;
  var BUFFER_MAX = ((spec() && spec().temporal) || {}).bufferMax || 8;
  var NULL_SKIP = ((spec() && spec().temporal) || {}).nullSkip || 1;
  var ABSENT_TO_RELEASE = ((spec() && spec().temporal) || {}).absentToRelease || 6;
  var LINKS = ((spec() && spec().landmarks) || {}).links || [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];

  // ---------- state (one session; stop() fully resets it) ----------
  var state = {
    active: false, // loop running, frames flowing
    starting: false, // async start in flight
    startSeq: 0, // generation: stop() invalidates pending starts
    stream: null,
    hands: null,
    rafId: 0,
    sending: false, // a frame is inside MediaPipe right now
    buffer: [], // recent readings (ints and nulls), newest last
    phase: 'ready', // ready | tracking | waiting-release
    absentCount: 0, // consecutive empty frames while locked
    suspended: false, // game lock: preview on, reading off
    sink: null, // {provide(n)} — the SAME sink the pad buttons use
    isAccepting: null, // game-owned gate: may we submit right now?
    onConfirm: null, // UI feedback hook (never load-bearing)
  };

  // ---------- tiny DOM layer (cached; camera ticks must not thrash) ----------
  function $(id) { return document.getElementById(id); }
  var els = {};
  function el(id) {
    if (!els[id]) els[id] = $(id);
    return els[id];
  }
  var lastText = {};
  function setLine(id, text) {
    if (lastText[id] === text) return;
    lastText[id] = text;
    var node = el(id);
    if (node) node.textContent = text;
  }
  function showError(text) {
    var node = el('camError');
    if (!node) return;
    if (!text) {
      node.classList.add('hidden');
      node.textContent = '';
    } else {
      node.textContent = text;
      node.classList.remove('hidden');
    }
  }
  var lastPct = -1;
  function setProgress(done, need) {
    var fill = el('camConfirmFill');
    if (!fill) return;
    var pct = 0;
    if (need > 0) pct = Math.max(0, Math.min(100, Math.round((done / need) * 100)));
    if (pct === lastPct) return;
    lastPct = pct;
    fill.style.width = pct + '%';
  }

  // ---------- step 1: library (plain version-pinned load, retryable) ----------
  // NOTE: deliberately no Subresource Integrity pin here. An SRI hash that
  // mismatches what the browser receives fails CLOSED (no skeleton, no
  // detection at all), which is worse than the version pin alone. The URL
  // is version-pinned, so the bytes cannot drift silently upstream.
  function loadHandsScript() {
    if (window.Hands) return Promise.resolve();
    if (loadHandsScript._p) return loadHandsScript._p;
    loadHandsScript._p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = HANDS_URL;
      s.async = true;
      s.onload = function () { resolve(); };
      // Never poison retries: a failed fetch must not break later opens.
      s.onerror = function () { loadHandsScript._p = null; reject(new Error('hand library failed')); };
      document.head.appendChild(s);
    });
    return loadHandsScript._p;
  }

  // ---------- step 2: overlay (display only; never gates recognition) ----------
  // Contain-fit mapping from the LIVE frame size, so landmarks always sit
  // on the hand as shown (mirrored preview => mirrored mapping here; the
  // classifier itself uses raw, unmirrored landmarks).
  var viewBox = { vw: 640, vh: 480, cw: 0, ch: 0, ctx: null };
  function fitCanvas() {
    var video = el('camVideo');
    if (!video) return;
    var w = video.videoWidth || 0, h = video.videoHeight || 0;
    if (w > 0 && h > 0 && (w !== viewBox.vw || h !== viewBox.vh)) {
      viewBox.vw = w;
      viewBox.vh = h;
    }
  }
  function drawSkeleton(canvas, landmarks) {
    var video = el('camVideo');
    if (!canvas) canvas = el('camOverlay');
    if (!canvas || !video) return;
    var vw = video.videoWidth || viewBox.vw;
    var vh = video.videoHeight || viewBox.vh;
    var cw = canvas.clientWidth || canvas.width || vw;
    var ch = canvas.clientHeight || canvas.height || vh;
    if (viewBox.ctx === null || viewBox.cw !== cw || viewBox.ch !== ch) {
      canvas.width = Math.max(1, Math.round(cw));
      canvas.height = Math.max(1, Math.round(ch));
      viewBox.cw = cw;
      viewBox.ch = ch;
      viewBox.ctx = canvas.getContext('2d');
    }
    var ctx = viewBox.ctx;
    ctx.clearRect(0, 0, viewBox.cw, viewBox.ch);
    if (!landmarks) return;
    var scale = Math.min(viewBox.cw / vw, viewBox.ch / vh);
    var ox = (viewBox.cw - vw * scale) / 2;
    var oy = (viewBox.ch - vh * scale) / 2;
    function map(p) {
      return [(1 - p.x) * vw * scale + ox, p.y * vh * scale + oy];
    }
    ctx.lineWidth = Math.max(2, Math.min(viewBox.cw, viewBox.ch) / 160);
    ctx.strokeStyle = 'rgba(125,249,255,.85)';
    ctx.fillStyle = 'rgba(125,249,255,.95)';
    ctx.beginPath();
    LINKS.forEach(function (lk) {
      var a = landmarks[lk[0]], b = landmarks[lk[1]];
      if (!a || !b) return;
      var pa = map(a), pb = map(b);
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
    });
    ctx.stroke();
    var dot = Math.max(2, Math.min(viewBox.cw, viewBox.ch) / 120);
    landmarks.forEach(function (p) {
      if (!p) return;
      var pp = map(p);
      ctx.beginPath();
      ctx.arc(pp[0], pp[1], dot, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // ---------- step 3: temporal confirmation (frames, not ms) ----------
  function resetBuffer() {
    state.buffer = [];
  }
  function pushReading(n) {
    state.buffer.push(n);
    if (state.buffer.length > BUFFER_MAX) state.buffer.shift();
  }
  // Stable = latest reading backed by NEED_STABLE identical detections.
  // Up to NULL_SKIP noisy (null) frames are skipped, never counted; a
  // DIFFERENT gesture always breaks stability.
  function stableGesture() {
    if (state.buffer.length < NEED_STABLE) return null;
    var cand = null, count = 0, skips = 0;
    for (var i = state.buffer.length - 1; i >= 0; i--) {
      var v = state.buffer[i];
      if (v === null || v === undefined) {
        if (count > 0 && skips < NULL_SKIP) { skips++; continue; }
        return null;
      }
      if (cand === null) cand = v;
      if (v !== cand) return null;
      count++;
      if (count >= NEED_STABLE) return cand;
    }
    return null;
  }
  function currentStreak() {
    if (!state.buffer.length) return { value: null, count: 0 };
    var v = state.buffer[state.buffer.length - 1];
    if (v === null || v === undefined) return { value: null, count: 0 };
    var c = 0;
    for (var i = state.buffer.length - 1; i >= 0; i--) {
      if (state.buffer[i] === v) c++;
      else break;
    }
    return { value: v, count: Math.min(c, NEED_STABLE) };
  }
  function toReady() {
    state.phase = 'ready';
    state.absentCount = 0;
    resetBuffer();
    setLine('camHandStatus', 'Show your hand');
    setLine('camGestureStatus', 'Seen: •');
    setLine('camConfirmStatus', 'Ready');
    setProgress(0, NEED_STABLE);
  }

  // ---------- step 4: per-result state machine ----------
  // READY -> TRACKING -> CONFIRMED -> LOCKED -> WAITING-FOR-RELEASE
  //   -> HAND REMOVED -> READY. One held pose = exactly one move.
  function classify(landmarks) {
    try {
      if (window.HCGestures) return window.HCGestures.classifyLandmarks(landmarks);
    } catch (e) { /* fall through to null */ }
    return null;
  }
  function onHandResult(landmarks) {
    if (landmarks && landmarks.length) {
      state.absentCount = 0;
      drawSkeleton(null, landmarks); // skeleton FIRST: always visible
      if (state.phase === 'waiting-release') {
        // Locked: the previous hand is still here; every pose is ignored
        // until it leaves. No exceptions, not even a different number.
        setLine('camHandStatus', 'Hand found');
        setLine('camGestureStatus', 'Seen: •');
        setLine('camConfirmStatus', 'Remove your hand');
        setProgress(0, NEED_STABLE);
        return;
      }
      if (state.suspended) {
        // Game lock: preview on, reading off.
        setLine('camHandStatus', 'Show your hand');
        setLine('camGestureStatus', 'Seen: •');
        return;
      }
      state.phase = 'tracking';
      var n = classify(landmarks);
      pushReading(n);
      setLine('camHandStatus', 'Hand found');
      setLine('camGestureStatus', (n !== null && n !== undefined) ? 'Seen: ' + n : 'Seen: •');

      var stable = stableGesture();
      var streak = currentStreak();
      setProgress(streak.value === null ? 0 : streak.count, NEED_STABLE);

      if (stable === null) {
        setLine('camConfirmStatus', streak.value === null ? 'Hold steady to confirm' : 'Hold steady…');
        return;
      }
      var accept = true;
      try {
        accept = state.isAccepting ? state.isAccepting() : true;
      } catch (e) { accept = false; }
      if (!accept) {
        // Game is between balls: hold without confirming so nothing
        // queues up for the next ball.
        setLine('camConfirmStatus', 'Hold on…');
        resetBuffer();
        return;
      }
      // GESTURE CONFIRMED -> INPUT LOCKED, immediately.
      setLine('camConfirmStatus', 'Move locked');
      setProgress(NEED_STABLE, NEED_STABLE);
      state.phase = 'waiting-release';
      state.absentCount = 0;
      resetBuffer();
      if (state.sink && typeof state.sink.provide === 'function') {
        try { state.sink.provide(stable); } catch (e) { /* pad still works */ }
        try {
          if (typeof state.onConfirm === 'function') state.onConfirm(stable);
        } catch (e) { /* feedback must never break input */ }
      }
      return;
    }
    // No hand in frame: skeleton clears; a locked hand must leave before
    // the next move (out-of-frame and out-of-sight both count).
    pushReading(null);
    drawSkeleton(null, null);
    setProgress(0, NEED_STABLE);
    if (state.phase === 'waiting-release') {
      state.absentCount += 1;
      if (state.absentCount >= ABSENT_TO_RELEASE) {
        toReady(); // HAND REMOVED -> READY
      } else {
        setLine('camHandStatus', 'Show your hand');
        setLine('camGestureStatus', 'Seen: •');
        setLine('camConfirmStatus', 'Remove your hand');
      }
      return;
    }
    state.phase = 'ready';
    setLine('camHandStatus', 'Show your hand');
    setLine('camGestureStatus', 'Seen: •');
    var err = el('camError');
    var hasErr = err && !err.classList.contains('hidden');
    if (!hasErr) setLine('camConfirmStatus', 'Ready');
  }

  // ---------- step 5: frame pump (one frame inside MediaPipe at a time) ----------
  function loop() {
    if (!state.active) return;
    var video = el('camVideo');
    if (video && state.hands && video.readyState >= 2 && !state.sending) {
      state.sending = true;
      try {
        var p = state.hands.send({ image: video });
        if (p && typeof p.then === 'function') {
          p.then(function () { state.sending = false; }, function () { state.sending = false; });
        } else {
          state.sending = false;
        }
      } catch (e) {
        state.sending = false;
      }
    }
    state.rafId = requestAnimationFrame(loop);
  }

  function isActive() { return state.active; }

  // Game-owned lock: preview keeps drawing, pose reading pauses, release
  // tracking is unaffected. Never disturbs the waiting-release display.
  function setInputEnabled(on) {
    state.suspended = !on;
    resetBuffer();
    if (state.phase !== 'waiting-release') toReady();
  }

  // ---------- step 6: lifecycle (single stream, single loop, clean restarts) ----------
  function stopTracks(stream) {
    try {
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    } catch (e) {}
  }
  function stop() {
    state.active = false;
    state.starting = false;
    // Invalidate any start() still awaiting permission, script, or first
    // frames: its continuations die silently instead of leaking a second
    // stream/loop behind closed UI.
    state.startSeq = (state.startSeq || 0) + 1;
    if (state.rafId) {
      try { cancelAnimationFrame(state.rafId); } catch (e) {}
      state.rafId = 0;
    }
    state.sending = false;
    resetBuffer();
    state.phase = 'ready';
    state.absentCount = 0;
    state.suspended = false;
    if (state.stream) {
      stopTracks(state.stream);
      state.stream = null;
    }
    var video = $('camVideo');
    if (video) {
      try { video.srcObject = null; } catch (e) {}
    }
    try {
      if (state.hands && typeof state.hands.close === 'function') state.hands.close();
    } catch (e) {}
    state.hands = null;
    state.sink = null;
    state.isAccepting = null;
    state.onConfirm = null;
    els = {};
    lastText = {};
    lastPct = -1;
    viewBox = { vw: 640, vh: 480, cw: 0, ch: 0, ctx: null };
  }

  // Video must report REAL dimensions before MediaPipe sees a frame
  // (guards the videoWidth/videoHeight == 0 startup window).
  function waitForVideo(video, attempts, isCancelled) {
    var ready = false;
    try {
      ready = !!video && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
    } catch (e) { ready = false; }
    if (ready) return Promise.resolve();
    if (typeof isCancelled === 'function' && isCancelled()) {
      var stale = new Error('camera start superseded');
      stale.name = 'StaleStart';
      return Promise.reject(stale);
    }
    if ((attempts || 0) > 100) return Promise.reject(new Error('no video frames'));
    return new Promise(function (res) { setTimeout(res, 50); }).then(function () {
      return waitForVideo(video, (attempts || 0) + 1, isCancelled);
    });
  }

  function start(opts) {
    opts = opts || {};
    if (state.active || state.starting) return Promise.resolve();
    state.starting = true;
    // Generation token: stop() bumps startSeq, so every hop below can
    // tell it was superseded, release what it holds, and stay silent.
    var myStart = (state.startSeq = (state.startSeq || 0) + 1);
    function isStale() { return state.startSeq !== myStart; }
    function staleError() {
      var err = new Error('camera start superseded');
      err.name = 'StaleStart';
      return err;
    }
    showError(null);
    setLine('camHandStatus', 'Starting camera…');
    setLine('camGestureStatus', 'Seen: •');
    setLine('camConfirmStatus', 'Ready');
    setProgress(0, NEED_STABLE);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.starting = false;
      showError('Camera unavailable. You can keep playing with clicks.');
      setLine('camHandStatus', 'Show your hand');
      return Promise.reject(new Error('no camera api'));
    }

    state.sink = opts.sink || null;
    state.isAccepting = typeof opts.isAccepting === 'function' ? opts.isAccepting : function () { return true; };
    state.onConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;

    return loadHandsScript().then(function () {
      if (isStale()) throw staleError();
      if (!window.Hands) { loadHandsScript._p = null; throw new Error('hand library missing'); }
      return navigator.mediaDevices.getUserMedia({
        // True 4:3 capture (1280x960 class): 720p-grade detail in the 4:3
        // frame the viewport and overlay are built for. All ideals, so a
        // device falls back to its nearest supported mode (commonly
        // 960x720 or 640x480 — also 4:3) instead of failing. Everything
        // downstream uses the ACTUAL live dimensions, never assumed ones.
        video: {
          facingMode: CAP.facingMode || 'user',
          width: { ideal: CAP.widthIdeal || 1280 },
          height: { ideal: CAP.heightIdeal || 960 },
          aspectRatio: { ideal: CAP.aspectRatioIdeal || (4 / 3) },
        },
        audio: false,
      });
    }).then(function (stream) {
      if (isStale()) { stopTracks(stream); throw staleError(); }
      state.stream = stream;
      var video = el('camVideo');
      if (!video) throw new Error('no preview');
      video.srcObject = stream;
      video.muted = true;
      try { video.playsInline = true; } catch (e) {}
      return video.play().then(function () {
        if (isStale()) {
          if (state.stream === stream) state.stream = null;
          stopTracks(stream);
          try { video.srcObject = null; } catch (e) {}
          throw staleError();
        }
        return waitForVideo(video, 0, isStale);
      }).then(function () {
        if (isStale()) throw staleError();
        fitCanvas();
        var hands = new window.Hands({
          locateFile: function (f) { return HANDS_LOCATE + f; },
        });
        hands.setOptions({
          maxNumHands: MAX_HANDS,
          modelComplexity: MODEL_COMPLEXITY,
          minDetectionConfidence: MIN_DETECT,
          minTrackingConfidence: MIN_TRACK,
        });
        hands.onResults(function (res) {
          fitCanvas();
          var list = res && res.multiHandLandmarks;
          onHandResult(list && list.length ? list[0] : null);
        });
        state.hands = hands;
        state.active = true;
        state.starting = false;
        state.phase = 'ready';
        state.absentCount = 0;
        resetBuffer();
        setLine('camHandStatus', 'Show your hand');
        showError(null);
        state.rafId = requestAnimationFrame(loop);
      });
    }).catch(function (err) {
      state.starting = false;
      // Superseded by stop()/restart: already cleaned up, UI already
      // reset. Stay completely silent.
      if (err && err.name === 'StaleStart') return;
      var name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        showError('Camera blocked. You can keep playing with clicks.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        showError('No camera found. You can keep playing with clicks.');
      } else if (name === 'NotReadableError') {
        showError('Camera busy. You can keep playing with clicks.');
      } else {
        showError('Camera unavailable. You can keep playing with clicks.');
      }
      setLine('camHandStatus', 'Show your hand');
      if (state.stream) { stopTracks(state.stream); state.stream = null; }
      throw err;
    });
  }

  window.HCCamera = { start, stop, isActive, setInputEnabled };
})();
