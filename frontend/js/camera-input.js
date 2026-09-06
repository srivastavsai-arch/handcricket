/* Prototype 3.5 camera input — experimental layer on top of Prototype 2.
 *
 * Safety rules:
 * - Nothing here runs on page load. No permission prompt, no webcam,
 *   no network fetch until the player presses Play with Camera.
 * - The click pad keeps working. Camera submits through the SAME sink
 *   (provider.provide) with the SAME acceptance gate as keyboard input.
 * - Any failure (denied, no hardware, load error, unreliable reads)
 *   leaves Prototype 2 fully playable. Back to Click Mode stops hardware.
 *
 * State flow (release is mandatory, never skipped):
 *   READY -> DETECTING (needs several steady frames) -> GESTURE CONFIRMED
 *   -> INPUT LOCKED -> WAITING FOR RELEASE -> HAND REMOVED -> READY
 * One held pose can only ever send one move. The next move needs the
 * hand to leave first. Leaving the frame or dropping the hand out of
 * reliable sight both count as a release. No extra pose needed.
 *
 * The game can also suspend input (strict lock while a turn resolves).
 * Suspended preview keeps drawing, but no pose is read and nothing can
 * send. Release tracking still runs while suspended.
 */
'use strict';

(function () {
  var HANDS_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js';
  var HANDS_LOCATE = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';
  var NEED_STABLE = 6;
  var ABSENT_TO_RELEASE = 6;

  var state = {
    active: false,
    starting: false,
    stream: null,
    hands: null,
    rafId: 0,
    sending: false,
    buffer: [],
    phase: 'ready', // 'ready' | 'tracking' | 'waiting-release'
    absentCount: 0,
    suspended: false, // strict game lock: preview on, reading off
    sink: null,
    isAccepting: null,
    onConfirm: null,
  };

  function $(id) { return document.getElementById(id); }

  function setLine(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  function showError(text) {
    var el = $('camError');
    if (!el) return;
    if (!text) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.textContent = text;
      el.classList.remove('hidden');
    }
  }

  function setProgress(done, need) {
    var fill = $('camConfirmFill');
    if (!fill) return;
    var pct = 0;
    if (need > 0) pct = Math.max(0, Math.min(100, Math.round((done / need) * 100)));
    fill.style.width = pct + '%';
  }

  function loadHandsScript() {
    if (window.Hands) return Promise.resolve();
    if (loadHandsScript._p) return loadHandsScript._p;
    loadHandsScript._p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = HANDS_URL;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('hand library failed')); };
      document.head.appendChild(s);
    });
    return loadHandsScript._p;
  }

  function drawSkeleton(canvas, landmarks) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!landmarks) return;
    var links = [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
    ];
    ctx.lineWidth = Math.max(2, w / 160);
    ctx.strokeStyle = 'rgba(125,249,255,.85)';
    ctx.fillStyle = 'rgba(125,249,255,.95)';
    ctx.beginPath();
    links.forEach(function (lk) {
      var a = landmarks[lk[0]], b = landmarks[lk[1]];
      if (!a || !b) return;
      ctx.moveTo((1 - a.x) * w, a.y * h);
      ctx.lineTo((1 - b.x) * w, b.y * h);
    });
    ctx.stroke();
    landmarks.forEach(function (p) {
      if (!p) return;
      ctx.beginPath();
      ctx.arc((1 - p.x) * w, p.y * h, Math.max(2, w / 120), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function fitCanvas() {
    var video = $('camVideo'), canvas = $('camOverlay');
    if (!video || !canvas) return;
    var w = video.videoWidth || 640, h = video.videoHeight || 480;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function resetBuffer() {
    state.buffer = [];
  }

  function pushReading(n) {
    state.buffer.push(n);
    if (state.buffer.length > 8) state.buffer.shift();
  }

  function stableGesture() {
    if (state.buffer.length < NEED_STABLE) return null;
    var tail = state.buffer.slice(-NEED_STABLE);
    var first = tail[0];
    if (first === null || first === undefined) return null;
    for (var i = 1; i < tail.length; i++) {
      if (tail[i] !== first) return null;
    }
    return first;
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

  function onHandResult(landmarks) {
    if (landmarks && landmarks.length) {
      state.absentCount = 0;
      // INPUT LOCKED + WAITING FOR RELEASE: the previous hand is still
      // here, so every pose is ignored until it leaves. No exceptions,
      // not even a different number.
      if (state.phase === 'waiting-release') {
        drawSkeleton($('camOverlay'), landmarks);
        setLine('camHandStatus', 'Hand found');
        setLine('camGestureStatus', 'Seen: •');
        setLine('camConfirmStatus', 'Remove your hand');
        setProgress(0, NEED_STABLE);
        return;
      }
      // Strict lock: preview keeps drawing, but nothing is read.
      if (state.suspended) {
        drawSkeleton($('camOverlay'), landmarks);
        setLine('camHandStatus', 'Show your hand');
        setLine('camGestureStatus', 'Seen: •');
        return;
      }
      state.phase = 'tracking';
      var n = null;
      try {
        if (window.HCGestures) n = window.HCGestures.classifyLandmarks(landmarks);
      } catch (e) { n = null; }
      pushReading(n);
      setLine('camHandStatus', 'Hand found');
      if (n !== null && n !== undefined) {
        setLine('camGestureStatus', 'Seen: ' + n);
      } else {
        setLine('camGestureStatus', 'Seen: •');
      }
      drawSkeleton($('camOverlay'), landmarks);

      var stable = stableGesture();
      var streak = currentStreak();
      setProgress(streak.value === null ? 0 : streak.count, NEED_STABLE);

      if (stable !== null) {
        var accept = true;
        try {
          accept = state.isAccepting ? state.isAccepting() : true;
        } catch (e) { accept = false; }
        if (!accept) {
          // Game is between balls. Hold without confirming so nothing
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
          try { state.sink.provide(stable); } catch (e) { /* click pad still works */ }
          try {
            if (typeof state.onConfirm === 'function') state.onConfirm(stable);
          } catch (e) { /* feedback must never break input */ }
        }
      } else if (streak.value === null) {
        setLine('camConfirmStatus', 'Hold steady to confirm');
      } else {
        setLine('camConfirmStatus', 'Hold steady…');
      }
    } else {
      pushReading(null);
      drawSkeleton($('camOverlay'), null);
      setProgress(0, NEED_STABLE);
      if (state.phase === 'waiting-release') {
        // Tolerant release: out of frame or out of reliable sight both
        // count. A few missed frames in a row are enough.
        state.absentCount += 1;
        if (state.absentCount >= ABSENT_TO_RELEASE) {
          // HAND REMOVED -> READY.
          toReady();
        } else {
          setLine('camHandStatus', 'Show your hand');
          setLine('camGestureStatus', 'Seen: •');
          setLine('camConfirmStatus', 'Remove your hand');
        }
      } else {
        state.phase = 'ready';
        setLine('camHandStatus', 'Show your hand');
        setLine('camGestureStatus', 'Seen: •');
        var err = $('camError');
        var hasErr = err && !err.classList.contains('hidden');
        if (!hasErr) setLine('camConfirmStatus', 'Ready');
      }
    }
  }

  function loop() {
    if (!state.active) return;
    var video = $('camVideo');
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

  // Strict game lock. False = preview on, pose reading off. Release
  // tracking is unaffected. Never disturbs the waiting-release display.
  function setInputEnabled(on) {
    state.suspended = !on;
    resetBuffer();
    if (state.phase !== 'waiting-release') toReady();
  }

  function stop() {
    state.active = false;
    state.starting = false;
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
      try {
        state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      } catch (e) {}
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
  }

  function start(opts) {
    opts = opts || {};
    if (state.active || state.starting) return Promise.resolve();
    state.starting = true;
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
      if (!window.Hands) throw new Error('hand library missing');
      return navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    }).then(function (stream) {
      state.stream = stream;
      var video = $('camVideo');
      if (!video) throw new Error('no preview');
      video.srcObject = stream;
      video.muted = true;
      return video.play().then(function () {
        fitCanvas();
        var hands = new window.Hands({
          locateFile: function (f) { return HANDS_LOCATE + f; },
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.5,
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
      try { if (state.stream) state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {}
      state.stream = null;
      throw err;
    });
  }

  window.HCCamera = { start, stop, isActive, setInputEnabled };
})();
