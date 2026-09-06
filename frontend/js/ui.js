/* UI helpers. Rendering only. No game rules live here. */
'use strict';

const GESTURES = [
  { n: 0,  name: 'ZERO',  short: 'Fist',                desc: 'All fingers closed.' },
  { n: 1,  name: 'ONE',   short: 'Index',                 desc: 'Index finger open.' },
  { n: 2,  name: 'TWO',   short: 'Index + middle',        desc: 'Index + middle fingers open.' },
  { n: 3,  name: 'THREE', short: 'Index + mid + ring',    desc: 'Index + middle + ring open.' },
  { n: 4,  name: 'FOUR',  short: 'Four, no thumb',        desc: 'Index + middle + ring + little open, thumb folded.' },
  { n: 5,  name: 'FIVE',  short: 'Full hand',             desc: 'All five fingers open.' },
  { n: 6,  name: 'SIX',   short: 'Thumb only',            desc: 'Only thumb open.' },
  { n: 7,  name: 'SEVEN', short: 'Thumb + index',         desc: 'Thumb + index finger open.' },
  { n: 8,  name: 'EIGHT', short: 'Thumb + two',           desc: 'Thumb + index + middle open.' },
  { n: 9,  name: 'NINE',  short: 'Thumb + pinky',         desc: 'Thumb + little finger open.' },
  { n: 10, name: 'TEN',   short: 'Thumb + index + pinky', desc: 'Thumb + index + little finger open.' },
];

const $ = (id) => document.getElementById(id);
const SCREENS = ['screen-rules', 'screen-difficulty', 'screen-toss', 'screen-decision', 'screen-game', 'screen-break', 'screen-result'];

function showScreen(id) {
  SCREENS.forEach((s) => $(s).classList.toggle('active', s === id));
  const label = { 'screen-rules': 'RULES', 'screen-difficulty': 'DIFFICULTY', 'screen-toss': 'TOSS', 'screen-decision': 'TOSS_DECISION', 'screen-game': 'MATCH', 'screen-break': 'INNINGS_BREAK', 'screen-result': 'RESULT' }[id] || id;
  $('phasePill').textContent = label;
  // Drop focus left on a now-hidden control so later Enter presses can't
  // re-trigger it and the screen's own Enter mapping stays predictable.
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.tagName === 'BUTTON' && ae.offsetParent === null) ae.blur();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pad2(n) { return String(n).padStart(2, '0'); }

function renderRulebook() {
  const grid = $('rulebookGrid');
  grid.innerHTML = '';
  GESTURES.forEach((g) => {
    const card = document.createElement('div');
    card.className = 'g-card';
    card.innerHTML = `
      <img src="assets/gestures/gesture-${g.n}.svg" alt="Gesture ${g.n}: ${g.desc}" loading="lazy" />
      <div class="g-num">${pad2(g.n)}</div>
      <div class="g-name">${g.name}</div>
      <div class="g-desc">${g.desc}</div>`;
    grid.appendChild(card);
  });
}

/** Prototype pad. Each button calls provider.provide(n). Buttons stay
 *  modular: the engine never sees the DOM, only the int. */
function renderPad(provider, onPick) {
  const pad = $('movePad');
  pad.innerHTML = '';
  GESTURES.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'pad-btn';
    b.type = 'button';
    b.dataset.move = String(g.n);
    b.setAttribute('aria-label', `Play ${g.n}`);
    b.innerHTML = `<img src="assets/gestures/gesture-${g.n}.svg" alt="${g.desc}"/><b>${g.n}</b><small>${g.short}</small>`;
    b.addEventListener('click', () => {
      provider.provide(g.n);
      if (typeof onPick === 'function') onPick(g.n, b);
    });
    pad.appendChild(b);
  });
}

function setPadLocked(locked) {
  document.querySelectorAll('#movePad .pad-btn').forEach((b) => b.classList.toggle('locked', locked));
}

function renderScores(s) {
  const out1 = s.battingSide === 'player' && (s.phase === 'INNINGS_1' || s.phase === 'INNINGS_2') ? 0 : (s.innings === 1 ? 0 : 1);
  // Simple wicket model: 0 while batting side alive, 1 once that innings ended.
  const youOut = (s.innings === 2 || s.phase === 'INNINGS_BREAK' || s.phase === 'MATCH_RESULT') && s.history.some(h => h.innings === (s.battingSide === 'player' && s.innings === 1 ? 1 : 1) && false);
  $('youScore').innerHTML = `${s.playerScore}<span class="wkts">/ ${wicketsFor(s, 'player')}</span>`;
  $('cpuScore').innerHTML = `${s.computerScore}<span class="wkts">/ ${wicketsFor(s, 'computer')}</span>`;
  $('mInnings').textContent = (s.phase === 'MATCH_RESULT') ? 'FT' : s.innings;
  $('mTarget').textContent = s.target === null || s.target === undefined ? '•' : s.target;
  $('mLast').textContent = s.lastResultText || '•';
  $('mBall').textContent = s.ballCount;
  const diffEl = $('mDiff');
  if (diffEl) diffEl.textContent = String(s.difficulty || 'medium').toUpperCase();
  const youBat = s.battingSide === 'player';
  $('youRole').textContent = !s.battingSide ? '•' : (youBat ? 'BATTING' : 'BOWLING');
  $('cpuRole').textContent = !s.battingSide ? '•' : (!youBat ? 'BATTING' : 'BOWLING');
  $('youRole').classList.toggle('bowling', !!s.battingSide && !youBat);
  $('cpuRole').classList.toggle('bowling', !!s.battingSide && youBat);
  $('youBatBowlTag').textContent = !s.battingSide ? '' : (youBat ? 'BAT' : 'BOWL');
  $('cpuBatBowlTag').textContent = !s.battingSide ? '' : (!youBat ? 'BAT' : 'BOWL');
  $('promptLine').textContent = !s.battingSide
    ? 'Choose your number'
    : (youBat ? 'Choose your number. You are batting.' : 'Choose your number. You are bowling.');
  // chase bar
  const chase = $('chaseBar');
  if (s.innings === 2 && s.target) {
    chase.classList.remove('hidden');
    const chasing = s.battingSide === 'player' ? s.playerScore : s.computerScore;
    const pct = Math.min(100, Math.round((chasing / s.target) * 100));
    $('chaseFill').style.width = pct + '%';
    $('chaseText').textContent = `CHASE ${chasing} / ${s.target}. Need ${Math.max(0, s.target - chasing)}`;
  } else chase.classList.add('hidden');
}

function wicketsFor(s, side) {
  // 1 wicket per side max in this format (all-out ends the innings).
  // A side is "out" if a history record with isOut exists in the innings they batted.
  const batInnings = side === 'player'
    ? inningsBattedBy(s, 'player')
    : inningsBattedBy(s, 'computer');
  if (batInnings === null) return 0;
  return s.history.some((h) => h.innings === batInnings && h.battingSide === side && h.isOut) ? 1 : 0;
}

function inningsBattedBy(s, side) {
  // derive from history first, else current battingSide
  const rec = s.history.find((h) => h.battingSide === side);
  if (rec) {
    // side may bat in only one innings; return the first one they batted in that has an OUT or most recent
    const mine = s.history.filter((h) => h.battingSide === side);
    // if side is currently batting in innings 2, their completed innings-1 record may not exist; prefer current
    if (s.battingSide === side) {
      // if they also batted innings 1 (can't happen. Each side bats once), keep earliest
      return mine[0].innings;
    }
    return mine[0].innings;
  }
  return s.battingSide === side ? s.innings : null;
}

function renderHistory(s) {
  const list = $('historyList');
  list.innerHTML = '';
  if (!s.history.length) {
    list.innerHTML = '<li class="empty">No balls yet.</li>';
    return;
  }
  [...s.history].slice(-8).reverse().forEach((h) => {
    const li = document.createElement('li');
    const tag = h.isOut ? '<b class="out">OUT</b>' : `<b class="runs">+${h.batsmanRuns}</b>`;
    li.innerHTML = `Ball ${h.ballNo}, Innings ${h.innings}, ${h.battingSide === 'player' ? 'You bat' : 'Computer bats'}, ${pad2(h.playerMove)} vs ${pad2(h.computerMove)} = ${tag}`;
    list.appendChild(li);
  });
}

function revealMoves(playerMove, computerMove) {
  const yImg = $('youHand'), cImg = $('cpuHand');
  yImg.src = `assets/gestures/gesture-${playerMove}.svg`;
  cImg.src = `assets/gestures/gesture-${computerMove}.svg`;
  $('youNum').textContent = pad2(playerMove);
  $('cpuNum').textContent = pad2(computerMove);
  document.querySelectorAll('.move-card').forEach((el) => {
    el.classList.remove('reveal');
    void el.offsetWidth;
    el.classList.add('reveal');
  });
}

function flashResult(text, isOut) {
  const el = $('resultFlash');
  el.classList.remove('out', 'runs');
  void el.offsetWidth;
  el.textContent = text;
  el.classList.add(isOut ? 'out' : 'runs');
}

/** Tiny AI status line (§17): coarse state only. Never the prediction. */
function setAiStatus(text, pattern) {
  const el = $('aiStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('pattern', !!pattern);
}

window.HCUI = {
  GESTURES, showScreen, renderRulebook, renderPad, renderScores,
  renderHistory, revealMoves, flashResult, setPadLocked, setAiStatus, pad2, $,
};
