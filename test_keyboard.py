"""Unit tests for KeyboardInputProvider (frontend/js/input-provider.js).

Verifies the key->move contract, shared-sink forwarding identity
(keyboard produces moves through the EXACT same provide() the pad
buttons call), silent ignore of unrelated keys, and lock gating.
Runs under plain node (no browser needed) via vm with a window stub.
"""
import subprocess
import textwrap
import json

NODE_HARNESS = textwrap.dedent("""
    const fs = require('fs');
    const vm = require('vm');
    const out = {};
    const listeners = {};
    const sandbox = {
      window: {},
      console,
      setTimeout, clearTimeout,
    };
    sandbox.window.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
    sandbox.window.removeEventListener = (t, fn) => {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync('frontend/js/input-provider.js', 'utf8'), sandbox);
    const K = sandbox.window.KeyboardInputProvider;
    const results = [];
    const check = (name, cond) => results.push([name, !!cond]);

    // 1. mapping contract
    const expected = {1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,0:10};
    check('digits-map', Object.entries(expected).every(([k, v]) => K.keyToMove(k) === v));
    check('invalid-null', ['a','B',' ','Enter','ArrowLeft','F1','!',null,undefined,'10','-1']
      .every((k) => K.keyToMove(k) === null));

    // 2. forwards through the SAME sink.provide (identity, not a copy)
    const calls = [];
    const sink = { provide: (m) => calls.push(m), arm: async () => 9, cancel: () => {} };
    const kb = new K(sink, { isAccepting: () => true });
    let origProvide = sink.provide;
    kb.attach();
    const fire = (key, extra = {}) => listeners['keydown'].forEach((fn) =>
      fn({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
           target: { tagName: 'BODY' }, ...extra }));
    fire('7');
    check('forward-7', calls.length === 1 && calls[0] === 7);
    check('same-fn', sink.provide === origProvide); // sink untouched, shared
    fire('0');
    check('forward-0-is-10', calls.length === 2 && calls[1] === 10);

    // 3. silent ignores
    const n0 = calls.length;
    ['a','X',' ','Enter','ArrowUp','F5'].forEach((k) => fire(k));
    fire('5', { repeat: true });
    fire('5', { ctrlKey: true });
    fire('5', { target: { tagName: 'INPUT' } });
    check('ignores-junk', calls.length === n0);

    // 4. lock gating mirrors the pad lock
    let accepting = false;
    const kb2 = new K(sink, { isAccepting: () => accepting });
    kb2.attach();
    const n1 = calls.length;
    fire('3');
    check('locked-ignored', calls.length === n1 + 1); // kb (accepting) fires, kb2 gated
    accepting = true;
    let seen = null;
    const kb3 = new K(sink, { isAccepting: () => true, onAccepted: (m) => { seen = m; } });
    kb3.attach();
    fire('4');
    check('feedback-hook', seen === 4);

    // 5. detach removes the listener
    const before = listeners['keydown'].length;
    kb.detach(); kb2.detach(); kb3.detach();
    check('detach', listeners['keydown'].length === before - 3);

    // 6. constructor guards
    let threw = false;
    try { new K(null); } catch { threw = true; }
    check('needs-sink', threw);

    console.log(JSON.stringify(results));
""")


def test_keyboard_provider_unit():
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS],
        cwd="G:/NEW AI TRIAL/cric",
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    results = json.loads(proc.stdout.strip().splitlines()[-1])
    failed = [name for name, ok in results if not ok]
    assert not failed, f"keyboard provider unit failures: {failed}"
    assert len(results) == 10, f"expected 10 checks, got {len(results)}"
