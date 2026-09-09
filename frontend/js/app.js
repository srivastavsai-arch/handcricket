/* App orchestrator: screens + state machine + providers.
 *
 * Intended flow:
 *   PREVIOUS HISTORY -> AI ANALYSIS -> AI MOVE LOCKED -> PLAYER MOVE INPUT
 *   -> REVEAL BOTH -> RESOLVE -> UPDATE SCORE -> APPEND TO HISTORY -> NEXT
 */
'use strict';

(function () {
  const { $, showScreen, renderRulebook, renderPad, renderScores, renderHistory, revealMoves, flashResult, setPadLocked, setAiStatus } = window.HCUI;
  const GameEngine = window.HCGameEngine;

  const engine = new GameEngine(Math.random);
  const provider = new window.ButtonInputProvider();
  // Keyboard is ANOTHER provider feeding the SAME sink: mouse click, touch
  // tap and digit key all converge on provider.provide(). One shared
  // input, one set of locks, zero divergent game logic.
  const keyboardInput = new window.KeyboardInputProvider(provider, {
    isAccepting: () => activeScreen() === 'screen-game' && acceptingInput,
    onAccepted: (move) => flashPadButton(move),
  });
  let acceptingInput = false;
  let pendingAi = null; // AI move locked BEFORE the player taps (fairness §1)
  // Delayed AI-batting reveal (presentation only). Token-guarded so a
  // stale timer can never resolve twice or after a restart/nav.
  let resolveTimer = null;
  let resolveToken = 0;
  // Input locks (mirror the mouse/touch restrictions for keyboard):
  let tossAwaiting = false; // H/T accepted only while the toss awaits a call
  let decisionMade = false; // B/W accepted only until the player has chosen
  let diffOpen = false;     // 1/2/3 accepted only on the difficulty screen

  function activeScreen() {
    const el = document.querySelector('.screen.active');
    return el ? el.id : null;
  }

  function flashPadButton(move) {
    const b = document.querySelector(`#movePad .pad-btn[data-move="${move}"]`);
    if (!b) return;
    b.classList.remove('kbd-hit');
    void b.offsetWidth;
    b.classList.add('kbd-hit');
    setTimeout(() => b.classList.remove('kbd-hit'), 300);
  }

  // ---------- optional server sync (non-blocking, no visible UI) ----------
  let sessionId = null;
  async function serverNew() {
    try {
      const r = await fetch('/api/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) throw new Error('no server');
      const j = await r.json();
      sessionId = j.session_id;
    } catch { /* local rules remain authoritative, nothing shown */ }
  }
  async function serverDifficulty(d) {
    if (!sessionId) return;
    try {
      await fetch('/api/difficulty', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, difficulty: d }),
      });
    } catch { /* local rules remain authoritative */ }
  }

  // ---------- rules -> difficulty -> toss ----------
  function gotoDifficulty() {
    engine.reset();
    engine.startDifficultySelect();
    serverNew(); // fresh server session per match (best-effort; local rules are authoritative)
    diffOpen = true;
    showScreen('screen-difficulty');
    document.querySelectorAll('.diff-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.difficulty === engine.state.difficulty);
    });
  }

  function pickDifficulty(d) {
    if (!diffOpen) return; // locked: one pick per visit, then we navigate away
    diffOpen = false;
    engine.setDifficulty(d); // locked: setDifficulty throws once balls are played
    document.querySelectorAll('.diff-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.difficulty === d);
    });
    serverDifficulty(d);
    setTimeout(gotoToss, 350);
  }

  function gotoToss() {
    engine.startToss();
    tossAwaiting = true;
    showScreen('screen-toss');
    $('coinLabel').textContent = 'CALL HEADS OR TAILS';
    $('coin').classList.remove('flipping');
  }

  // Single entry point for Heads and Tails. Buttons converge
  // here, so double clicks cannot double-toss.
  function callToss(call) {
    if (!tossAwaiting) return;
    tossAwaiting = false;
    onTossCall(call);
  }

  // ---------- toss ----------
  async function onTossCall(call) {
    const coin = $('coin');
    coin.classList.remove('flipping');
    void coin.offsetWidth;
    $('coinLabel').textContent = `YOU CALLED ${call.toUpperCase()}`;
    coin.classList.add('flipping');
    // mirror to server if present (fire-and-forget)
    await new Promise((r) => setTimeout(r, 1050));
    engine.doToss(call);
    const s = engine.state;
    $('coinLabel').textContent = `COIN SHOWS ${s.tossResult.toUpperCase()}`;
    await new Promise((r) => setTimeout(r, 550));
    showDecision();
  }

  function showDecision() {
    const s = engine.state;
    showScreen('screen-decision');
    decisionMade = false;
    const youWon = s.tossWinner === 'player';
    $('tossTitle').textContent = youWon ? 'YOU WON THE TOSS' : 'COMPUTER WON THE TOSS';
    $('tossDetail').textContent = youWon
      ? `You called ${s.tossCall.toUpperCase()}. Coin shows ${s.tossResult.toUpperCase()}.`
      : `You called ${s.tossCall.toUpperCase()}. Coin shows ${s.tossResult.toUpperCase()}. Computer decides.`;
    $('playerDecision').classList.toggle('hidden', !youWon);
    $('computerDecision').classList.toggle('hidden', youWon);
    if (!youWon) {
      // computer auto-decides after a beat for drama
      $('computerDecisionText').textContent = 'COMPUTER IS THINKING…';
      $('btnToMatch').disabled = true;
      setTimeout(() => {
        engine.decideAfterToss(null);
        const d = engine.state.computerDecision;
        $('computerDecisionText').textContent = `COMPUTER CHOOSES TO ${d.toUpperCase()}`;
        $('btnToMatch').disabled = false;
      }, 900);
    }
  }

  // Single entry point for Bat and Bowl. The buttons converge here,
  // so the choice registers exactly once per decision.
  function chooseSide(choice) {
    if (decisionMade) return;
    decisionMade = true;
    engine.decideAfterToss(choice);
    enterArena();
  }

  function startChase() {
    engine.continueAfterBreak();
    enterArena();
    flashResult(`TARGET ${engine.state.target}. CHASE IS ON`, false);
  }

  function replay() { fullReset(); gotoDifficulty(); }

  // ---------- keyboard shortcuts (screen-gated, same handlers as clicks) ----------
  const DIFF_ORDER = ['easy', 'medium', 'hard'];

  function onShortcutKey(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const screen = activeScreen();
    const key = e.key;
    if (typeof key === 'string' && /^[0-9]$/.test(key)) {
      // Gameplay digits are owned by KeyboardInputProvider; here only the
      // difficulty screen maps 1/2/3 to its cards. Anything else: silence.
      if (screen === 'screen-difficulty' && diffOpen && key >= '1' && key <= '3') {
        pickDifficulty(DIFF_ORDER[Number(key) - 1]);
      }
      return;
    }
    const k = typeof key === 'string' ? key.toLowerCase() : '';
    if (screen === 'screen-toss' && (k === 'h' || k === 't')) {
      callToss(k === 'h' ? 'heads' : 'tails');
      return;
    }
    if (screen === 'screen-decision' && !decisionMade &&
        !$('playerDecision').classList.contains('hidden') && (k === 'b' || k === 'w')) {
      chooseSide(k === 'b' ? 'bat' : 'bowl');
      return;
    }
    if (key === 'Enter') {
      // A visible focused button fires natively. Never double trigger it.
      const ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON' && ae.offsetParent !== null) return;
      if (screen === 'screen-rules') gotoDifficulty();
      else if (screen === 'screen-decision' &&
               !$('computerDecision').classList.contains('hidden') && !$('btnToMatch').disabled) enterArena();
      else if (screen === 'screen-break') startChase();
      else if (screen === 'screen-result') replay();
      // Toss, difficulty and gameplay have dedicated keys (H·T / 1·2·3 /
      // digits). Enter deliberately stays silent there, never random.
    }
    // Every other key (A/B/C/X/Z/arrows/space/…): ignored silently, no errors.
  }

  // ---------- match ----------
  function cancelPendingResolve() {
    resolveToken += 1;
    if (resolveTimer !== null) {
      try { clearTimeout(resolveTimer); } catch (e) {}
      resolveTimer = null;
    }
  }

  function enterArena() {
    cancelPendingResolve();
    renderScores(engine.state);
    renderHistory(engine.state);
    revealMoves(1, 1);
    $('youNum').textContent = '•';
    $('cpuNum').textContent = '•';
    flashResult(engine.state.battingSide === 'player' ? 'YOU BAT FIRST' : 'YOU BOWL FIRST', false);
    showScreen('screen-game');
    acceptingInput = true;
    setPadLocked(false);
    waitForMove();
  }

  async function waitForMove() {
    if (engine.state.phase === 'MATCH_RESULT' || engine.state.phase === 'INNINGS_BREAK') return;
    acceptingInput = true;
    try { if (window.HCCamera) window.HCCamera.setInputEnabled(true); } catch (e) {}
    // FAIRNESS: the AI analyzes COMPLETED history and LOCKS its
    // move BEFORE the player's input exists. provider.arm() only resolves
    // afterwards, so the AI structurally cannot see the current move.
    try {
      pendingAi = engine.commitAiMove();
    } catch { return; }
    setAiStatus('AI ANALYZING…', false);
    setPadLocked(false);
    const move = await provider.arm(); // <-- player input happens AFTER the AI lock
    if (move === null || move === undefined) return; // reset mid-wait
    if (!acceptingInput || !pendingAi) return;
    playBall(move, pendingAi);
    pendingAi = null;
  }

  function playBall(playerMove, aiCommit) {
    acceptingInput = false;
    setPadLocked(true);
    try { if (window.HCCamera) window.HCCamera.setInputEnabled(false); } catch (e) {}
    // AI batting (player just bowled): confirm the bowl now, reveal the
    // AI number after a short pause. Decision stays pre-committed.
    if (engine.state.battingSide === 'computer') {
      $('youHand').src = `assets/gestures/gesture-${playerMove}.svg`;
      $('youNum').textContent = window.HCUI.pad2(playerMove);
      flashResult('Move confirmed', false);
      const token = ++resolveToken;
      if (resolveTimer !== null) {
        try { clearTimeout(resolveTimer); } catch (e) {}
      }
      resolveTimer = setTimeout(() => {
        if (token !== resolveToken) return; // restarted / moved on
        resolveTimer = null;
        try {
          doResolve(playerMove, aiCommit);
        } catch (e) { /* stale state; stale timer stays silent */ }
      }, 1000);
      return;
    }
    doResolve(playerMove, aiCommit);
  }

  function doResolve(playerMove, aiCommit) {
    // The AI move was committed pre-input; resolve directly against it.
    // (Deliberately NOT engine.playBallWithAI. That would commit a second,
    // post-input AI move and break the fairness ordering.)
    const out = engine.resolveBall(playerMove, aiCommit.move);
    setAiStatus('AI LOCKED ✓', false);
    revealMoves(out.playerMove, out.computerMove);
    renderScores(engine.state);
    renderHistory(engine.state);
    flashResult(out.isOut ? 'OUT!' : `+${out.runs}`, out.isOut);

    if (engine.state.phase === 'INNINGS_BREAK') {
      setTimeout(showBreak, 1400);
    } else if (engine.state.phase === 'MATCH_RESULT') {
      setTimeout(showResult, 1400);
    } else {
      setTimeout(waitForMove, 950);
    }
  }

  function showBreak() {
    const s = engine.state;
    $('breakYou').textContent = s.playerScore;
    $('breakCpu').textContent = s.computerScore;
    $('breakTarget').textContent = s.target;
    const chaser = s.battingSide === 'player' ? 'YOU' : 'COMPUTER';
    $('breakText').textContent = `${chaser} need${chaser === 'YOU' ? '' : 's'} ${s.target} to win. ${s.battingSide === 'player' ? 'Your number scores. Avoid matching the bowler.' : 'Bowl the same number as the computer to get it out.'}`;
    showScreen('screen-break');
  }

  function showResult() {
    const s = engine.state;
    $('finalYou').textContent = s.playerScore;
    $('finalCpu').textContent = s.computerScore;
    const banner = $('winnerBanner');
    banner.textContent = s.winner === 'player' ? 'YOU WIN' : 'COMPUTER WINS';
    banner.classList.toggle('lose', s.winner !== 'player');
    $('winMargin').textContent = `${s.winMargin} Target was ${s.target}.`;
    const fh = $('finalHistory');
    fh.innerHTML = '';
    s.history.slice(-10).forEach((h) => {
      const li = document.createElement('li');
      li.textContent = `${String(h.playerMove).padStart(2, '0')} vs ${String(h.computerMove).padStart(2, '0')}${h.isOut ? ' OUT' : ` +${h.batsmanRuns}`}`;
      fh.appendChild(li);
    });
    showScreen('screen-result');
  }

  function fullReset() {
    cancelPendingResolve();
    try { if (window.HCCamera) window.HCCamera.stop(); } catch (e) {}
    var camPanel = $('camPanel');
    if (camPanel) camPanel.classList.add('hidden');
    try { document.getElementById('screen-game').classList.remove('cam-on'); } catch (e) {}
    var camBtn = $('btnCamera');
    if (camBtn) camBtn.classList.remove('hidden');
    provider.cancel();
    pendingAi = null;
    engine.reset();
    acceptingInput = false;
    renderRulebook();
    showScreen('screen-rules');
  }

  // ---------- Camera mode (opt in only, pad stays as fallback) ----------
  function openCamera() {
    var panel = $('camPanel');
    if (panel) panel.classList.remove('hidden');
    var btn = $('btnCamera');
    if (btn) btn.classList.add('hidden');
    try { document.getElementById('screen-game').classList.add('cam-on'); } catch (e) {}
    if (panel && panel.scrollIntoView) {
      try { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    }
    if (window.HCCamera) {
      window.HCCamera.start({
        sink: provider,
        isAccepting: function () { return activeScreen() === 'screen-game' && acceptingInput; },
        onConfirm: function (move) { flashPadButton(move); },
      }).then(function () {
        // Strict lock: only read poses while the game awaits this turn.
        if (!(activeScreen() === 'screen-game' && acceptingInput)) {
          try { window.HCCamera.setInputEnabled(false); } catch (e) {}
        }
      }).catch(function () { /* panel shows the friendly error, clicks still work */ });
    }
  }

  function closeCamera() {
    try { if (window.HCCamera) window.HCCamera.stop(); } catch (e) {}
    var panel = $('camPanel');
    if (panel) panel.classList.add('hidden');
    var btn = $('btnCamera');
    if (btn) btn.classList.remove('hidden');
    try { document.getElementById('screen-game').classList.remove('cam-on'); } catch (e) {}
  }

  // ---------- wire up ----------
  function init() {
    renderRulebook();
    renderPad(provider, null);
    showScreen('screen-rules');
    serverNew();

    $('btnStart').addEventListener('click', gotoDifficulty);
    $('btnStart2').addEventListener('click', gotoDifficulty);
    $('btnHow').addEventListener('click', () => $('howStrip').classList.toggle('hidden'));
    document.querySelectorAll('[data-nav="rules"]').forEach((b) => b.addEventListener('click', fullReset));
    var brandHome = $('brandHome');
    if (brandHome) brandHome.addEventListener('click', fullReset);
    document.querySelectorAll('.btn.toss').forEach((b) => b.addEventListener('click', () => callToss(b.dataset.call)));
    $('btnBat').addEventListener('click', () => chooseSide('bat'));
    $('btnBowl').addEventListener('click', () => chooseSide('bowl'));
    $('btnToMatch').addEventListener('click', enterArena);
    $('btnInnings2').addEventListener('click', startChase);
    $('btnAgain').addEventListener('click', replay);
    var camOpen = $('btnCamera');
    if (camOpen) camOpen.addEventListener('click', openCamera);
    var camBack = $('btnCamBack');
    if (camBack) camBack.addEventListener('click', closeCamera);
    document.querySelectorAll('.diff-card').forEach((c) => {
      c.addEventListener('click', () => pickDifficulty(c.dataset.difficulty));
    });
    // Keyboard: digits feed the shared sink via KeyboardInputProvider;
    // H/T, B/W, 1/2/3 and Enter ride the same click handlers above.
    keyboardInput.attach();
    document.addEventListener('keydown', onShortcutKey);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
