/* Adaptive AI prediction engine. JS mirror of the Python AI.
 * Same signals, same weights, same fairness contract: input is COMPLETED
 * history only. There is no parameter for the player's current/pending
 * move. Cheating is impossible by construction.
 *
 * API: HCAI.getAIMove(history, difficulty, aiIsBowling, rng)
 *      -> {move: 1-10, patternDetected: bool, historyLen: number}
 *      HCAI.predictDistribution(seq, difficulty) -> [p1..p10]
 */
'use strict';

(function () {
  const N = 10;
  const DIFFICULTIES = ['easy', 'medium', 'hard'];
  const RECENCY_GAMMA = { easy: 0.0, medium: 0.80, hard: 0.88 };
  const RECENT_WINDOW = { easy: 5, medium: 8, hard: 1e9 };
  const EPSILON = { easy: 0.25, medium: 0.15, hard: 0.12 };
  const BAT_TEMP = { easy: 1e9, medium: 3.0, hard: 2.0 };
  const PATTERN_THRESHOLD = 0.22;
  const WEIGHTS = {
    easy:   { uniform: 0.85, overall: 0.0,  recency: 0.15, transition: 0.0,  sequence2: 0.0,  streak: 0.0 },
    medium: { uniform: 0.25, overall: 0.35, recency: 0.30, transition: 0.0,  sequence2: 0.0,  streak: 0.10 },
    hard:   { uniform: 0.12, overall: 0.20, recency: 0.24, transition: 0.16, sequence2: 0.12, streak: 0.16 },
  };

  function validateDifficulty(d) {
    d = String(d || '').toLowerCase().trim();
    if (!DIFFICULTIES.includes(d)) throw new Error(`Difficulty must be one of ${DIFFICULTIES}, got ${JSON.stringify(d)}`);
    return d;
  }

  function roleSequences(history) {
    const batting = [], bowling = [];
    (history || []).forEach((rec) => {
      const mv = rec && rec.playerMove;
      if (!Number.isInteger(mv) || mv < 1 || mv > 10) return;
      if (rec.battingSide === 'player') batting.push(mv);
      else if (rec.battingSide === 'computer') bowling.push(mv);
    });
    return { playerBatting: batting, playerBowling: bowling };
  }

  const uniform = () => Array(N).fill(1 / N);
  function smooth(counts, alpha = 1.0) {
    const total = counts.reduce((a, b) => a + b, 0) + alpha * N;
    return counts.map((c) => (c + alpha) / total);
  }
  function overallFreq(seq) {
    const c = Array(N).fill(0);
    seq.forEach((m) => { c[m - 1] += 1; });
    return smooth(c);
  }
  function recencyFreq(seq, gamma, window) {
    if (!seq.length) return uniform();
    const tail = seq.slice(-window);
    const c = Array(N).fill(0);
    [...tail].reverse().forEach((m, pos) => { c[m - 1] += gamma > 0 ? Math.pow(gamma, pos) : 1.0; });
    return smooth(c);
  }
  function streakDist(seq, strength) {
    if (seq.length < 2) return uniform();
    const last = seq[seq.length - 1];
    let run = 1;
    for (let i = seq.length - 2; i >= 0 && seq[i] === last; i--) run++;
    if (run < 2) return uniform();
    const mass = strength > 0.5 ? Math.min(0.55 + 0.10 * Math.min(run, 4), 0.95) : 0.6;
    const rest = (1 - mass) / (N - 1);
    return Array.from({ length: N }, (_, i) => (i === last - 1 ? mass : rest));
  }
  function transitionDist(seq) {
    if (seq.length < 2) return uniform();
    const last = seq[seq.length - 1];
    const c = Array(N).fill(0);
    let out = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i] === last) { c[seq[i + 1] - 1] += 1; out++; }
    }
    return out === 0 ? uniform() : smooth(c);
  }
  function sequence2Dist(seq) {
    if (seq.length < 3) return uniform();
    const a0 = seq[seq.length - 2], b0 = seq[seq.length - 1];
    const c = Array(N).fill(0);
    let hits = 0;
    for (let i = 0; i < seq.length - 2; i++) {
      if (seq[i] === a0 && seq[i + 1] === b0) { c[seq[i + 2] - 1] += 1; hits++; }
    }
    return hits === 0 ? uniform() : smooth(c);
  }

  function predictDistribution(seqLike, difficulty) {
    const d = validateDifficulty(difficulty);
    const seq = (seqLike || []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 10);
    if (!seq.length) return uniform();
    const w = WEIGHTS[d];
    const parts = {
      uniform: uniform(),
      overall: overallFreq(seq),
      recency: recencyFreq(seq, RECENCY_GAMMA[d], RECENT_WINDOW[d]),
      transition: transitionDist(seq),
      sequence2: sequence2Dist(seq),
      streak: streakDist(seq, d === 'hard' ? 0.9 : 0.6),
    };
    let mixed;
    if (d === 'easy') {
      mixed = parts.uniform.map((u, i) => w.uniform * u + w.recency * parts.recency[i]);
    } else {
      mixed = parts.uniform.map((_, i) => Object.keys(w).reduce((acc, k) => acc + w[k] * parts[k][i], 0));
    }
    const tot = mixed.reduce((a, b) => a + b, 0) || 1;
    return mixed.map((p) => p / tot);
  }

  function sample(dist, rng) {
    const tot = dist.reduce((a, b) => a + b, 0);
    let r = rng() * tot, acc = 0;
    for (let i = 0; i < dist.length; i++) {
      acc += dist[i];
      if (r < acc) return i + 1;
    }
    return N;
  }

  function chooseBowlingMove(dist, difficulty, rng) {
    const d = validateDifficulty(difficulty);
    if (rng() < EPSILON[d]) return 1 + Math.floor(rng() * N);
    return sample(dist, rng);
  }

  function chooseBattingMove(dist, difficulty, rng) {
    const d = validateDifficulty(difficulty);
    if (d === 'easy' || rng() < EPSILON[d]) return 1 + Math.floor(rng() * N);
    const tau = BAT_TEMP[d];
    const ev = dist.map((p, i) => (i + 1) * (1 - p));
    const m = Math.max(...ev);
    const exps = ev.map((v) => Math.exp((v - m) / tau));
    const tot = exps.reduce((a, b) => a + b, 0) || 1;
    return sample(exps.map((e) => e / tot), rng);
  }

  function getAIMove(history, difficulty, aiIsBowling, rng = Math.random) {
    const d = validateDifficulty(difficulty);
    const seqs = roleSequences(history);
    const seq = aiIsBowling ? seqs.playerBatting : seqs.playerBowling;
    const dist = predictDistribution(seq, d);
    const move = aiIsBowling
      ? chooseBowlingMove(dist, d, rng)
      : chooseBattingMove(dist, d, rng);
    return {
      move,
      patternDetected: seq.length >= 4 && Math.max(...dist) >= PATTERN_THRESHOLD,
      historyLen: seq.length,
    };
  }

  window.HCAI = {
    DIFFICULTIES: DIFFICULTIES.slice(),
    validateDifficulty,
    roleSequences,
    predictDistribution,
    chooseBowlingMove,
    chooseBattingMove,
    getAIMove,
  };
})();
