/* Input-provider abstraction (spec §9 / §20 / §27).
 *
 * Concept:  PLAYER SOURCE -> number 0-10 -> GAME ENGINE -> UI
 *
 *  - PrototypeInputProvider: reads the tapped pad button (mouse + touch).
 *  - KeyboardInputProvider:  reads physical digit keys, forwards into the
 *                             SAME shared sink (common player-input API).
 *                             Physical 0 still means 10; 0 is played by
 *                             tapping the fist pad or showing a fist.
 *  - FutureCameraInputProvider: will read MediaPipe/OpenCV (version 2).
 * All satisfy the same interface and produce the same integer 0-10.
 * the engine never knows which source the move came from.
 *
 * Diagram:
 *   MouseInput / TouchInput (pad click) ─┐
 *   KeyboardInput (digit key) ───────────┼─> COMMON SINK (provide/arm) -> ENGINE
 *   FutureCameraInput ───────────────────┘
 */
'use strict';

class InputProvider {
  async getPlayerMove() {
    throw new Error('getPlayerMove() not implemented');
  }
  get name() { return 'base'; }
}

/** V1. Click or tap the 0 to 10 pad. Resolves once per armed gesture. */
class PrototypeInputProvider extends InputProvider {
  constructor() {
    super();
    this._waiter = null;
    this._lastMove = null;
  }
  get name() { return 'prototype-buttons'; }

  /** Arm for exactly one move; resolves with the tapped value. */
  arm() {
    return new Promise((resolve) => { this._waiter = resolve; });
  }

  /** Called by the pad buttons. Also usable as getPlayerMove() directly. */
  provide(move) {
    const v = Number(move);
    if (!Number.isInteger(v) || v < 0 || v > 10) return;
    this._lastMove = v;
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w(v);
    }
  }

  async getPlayerMove() {
    if (this._lastMove !== null) {
      const v = this._lastMove;
      this._lastMove = null;
      return v;
    }
    return this.arm();
  }

  cancel() {
    if (this._waiter) { const w = this._waiter; this._waiter = null; w(null); }
  }
}

/** Keyboard number entry. Another Input Provider, not a parallel game path.
 *
 * Physical digits map to moves (there is no single key for 10, so 0 = 10):
 *   '1'-'9' -> 1-9,  '0' -> 10,  anything else -> null (silently ignored).
 *
 * Forwarding: every accepted key calls the SHARED sink's `provide()`. The
 * exact same function the pad buttons call. Mouse, touch and keyboard are
 * therefore indistinguishable downstream, and all input locking (one move
 * per armed ball, stale presses dropped) applies identically.
 *
 * Gating (which screen may accept digits, whether the pad is locked) is NOT
 * decided here; the app passes an `isAccepting` predicate so this class
 * stays free of UI state. Unrelated keys are always ignored, never errors.
 */
class KeyboardInputProvider extends InputProvider {
  constructor(sink, options = {}) {
    super();
    if (!sink || typeof sink.provide !== 'function') {
      throw new Error('KeyboardInputProvider needs a sink with provide(move)');
    }
    this.sink = sink;
    this.isAccepting = typeof options.isAccepting === 'function' ? options.isAccepting : () => true;
    this.onAccepted = typeof options.onAccepted === 'function' ? options.onAccepted : null;
    this._onKeyDown = (e) => this._route(e);
    this._attached = false;
  }
  get name() { return 'keyboard'; }

  static keyToMove(key) {
    if (key === '0') return 10;
    if (typeof key === 'string' && /^[1-9]$/.test(key)) return Number(key);
    return null;
  }

  /** Common player-input API passthroughs (same sink the buttons use). */
  provide(move) { this.sink.provide(move); }
  arm() { return this.sink.arm(); }
  cancel() { return this.sink.cancel(); }

  attach() {
    if (!this._attached) {
      window.addEventListener('keydown', this._onKeyDown);
      this._attached = true;
    }
    return this;
  }
  detach() {
    if (this._attached) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._attached = false;
    }
    return this;
  }

  _route(e) {
    // Never hijack browser/OS shortcuts or editable fields; no key-repeat.
    if (!e || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const move = KeyboardInputProvider.keyToMove(e.key);
    if (move === null) return; // unrelated key: ignore silently, no error
    if (!this.isAccepting()) return; // locked state: ignore exactly like a locked pad
    this.provide(move);
    if (this.onAccepted) { try { this.onAccepted(move); } catch { /* feedback must never break input */ } }
  }
}

/** V2 placeholder. Webcam + hand detection plugs in here.
 *  Contract: return an integer 0-10, never an SVG/emoji/string.
 *  The engine must not change when this provider goes live. */
class FutureCameraInputProvider extends InputProvider {
  constructor() {
    super();
    this.ready = false;
  }
  get name() { return 'camera-v2-stub'; }

  async init() {
    // V2: await navigator.mediaDevices.getUserMedia(...); load MediaPipe; ...
    this.ready = false;
    throw new Error(
      'FutureCameraInputProvider is a V2 stub. Wire MediaPipe/OpenCV here; ' +
      'implement getPlayerMoveFromCamera() -> int 0-10.'
    );
  }

  // V2 entry point (name kept stable for the cutover):
  async getPlayerMoveFromCamera() {
    throw new Error('V2 not implemented yet. Use PrototypeInputProvider.');
  }

  async getPlayerMove() {
    return this.getPlayerMoveFromCamera();
  }
}

// Browser global export (no bundler in prototype).
window.InputProvider = InputProvider;
window.PrototypeInputProvider = PrototypeInputProvider;
window.KeyboardInputProvider = KeyboardInputProvider;
window.FutureCameraInputProvider = FutureCameraInputProvider;
