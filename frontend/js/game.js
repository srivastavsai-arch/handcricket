/* Pure JS game engine. Mirrors backend/game_engine.py exactly.
 * Knows nothing about DOM / SVG / webcam. Only ints, scores, phases.
 * The Python engine is authoritative for API play; this copy allows
 * instant offline play. Logic is kept in lockstep by shared tests.
 *
 * Prototype 2: the AI opponent lives in ai-engine.js (HCAI). The engine
 * only passes COMPLETED history to it. Never the pending player move. */
'use strict';

const Phases = Object.freeze({
  RULES: 'RULES',
  DIFFICULTY: 'DIFFICULTY',
  TOSS: 'TOSS',
  TOSS_RESULT: 'TOSS_RESULT',
  TOSS_DECISION: 'TOSS_DECISION',
  INNINGS_1: 'INNINGS_1',
  INNINGS_BREAK: 'INNINGS_BREAK',
  INNINGS_2: 'INNINGS_2',
  MATCH_RESULT: 'MATCH_RESULT',
});

function validateMove(v) {
  if (!Number.isInteger(v) || v < 0 || v > 10) {
    throw new Error(`Move must be an integer 0-10, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Legacy uniform-random pick (Prototype 1 behaviour, kept for compat). */
function computerPick(rng = Math.random) {
  return 1 + Math.floor(rng() * 10);
}
function computerTossDecision(rng = Math.random) {
  return rng() < 0.5 ? 'bat' : 'bowl';
}

function freshState() {
  return {
    phase: Phases.RULES,
    innings: 1,
    playerScore: 0,
    computerScore: 0,
    battingSide: null,   // 'player' | 'computer'
    bowlingSide: null,
    target: null,
    tossWinner: null,
    tossCall: null,
    tossResult: null,
    playerChoseTo: null,
    computerDecision: null,
    difficulty: 'medium', // locked once the first ball is played
    ballCount: 0,
    lastResultText: '',
    lastOut: false,
    winner: null,        // 'player' | 'computer' | null
    winMargin: '',
    history: [],         // {ballNo, innings, battingSide, playerMove, computerMove, batsmanRuns, isOut, scoreAfter}
  };
}

class GameEngine {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.state = freshState();
    this.lastAiInfo = { historyLen: 0, patternDetected: false };
  }
  reset() {
    const diff = this.state.difficulty;
    this.state = freshState();
    this.state.difficulty = diff;
    this.lastAiInfo = { historyLen: 0, patternDetected: false };
    return this.state;
  }

  setDifficulty(difficulty) {
    if (this.state.ballCount > 0) throw new Error('Difficulty is locked once the match has started');
    this.state.difficulty = window.HCAI.validateDifficulty(difficulty);
    return this.state;
  }

  startDifficultySelect() { this.state.phase = Phases.DIFFICULTY; return this.state; }
  startToss() { this.state.phase = Phases.TOSS; return this.state; }

  doToss(call) {
    call = String(call || '').toLowerCase().trim();
    if (call !== 'heads' && call !== 'tails') throw new Error("Toss call must be 'heads' or 'tails'");
    const result = this.rng() < 0.5 ? 'heads' : 'tails';
    const s = this.state;
    s.tossCall = call;
    s.tossResult = result;
    s.tossWinner = (call === result) ? 'player' : 'computer';
    s.phase = Phases.TOSS_RESULT;
    return s;
  }

  decideAfterToss(playerChoice = null) {
    const s = this.state;
    if (!s.tossWinner) throw new Error('Cannot decide before the toss');
    let firstBatting;
    if (s.tossWinner === 'player') {
      if (playerChoice !== 'bat' && playerChoice !== 'bowl') throw new Error("Player must choose 'bat' or 'bowl'");
      s.playerChoseTo = playerChoice;
      s.computerDecision = null;
      firstBatting = (playerChoice === 'bat') ? 'player' : 'computer';
    } else {
      const auto = computerTossDecision(this.rng);
      s.computerDecision = auto;
      s.lastResultText = `Computer chooses to ${auto.toUpperCase()}`;
      firstBatting = (auto === 'bat') ? 'computer' : 'player';
    }
    this._beginInnings(1, firstBatting);
    s.phase = Phases.INNINGS_1;
    return s;
  }

  _beginInnings(no, battingSide) {
    const s = this.state;
    s.innings = no;
    s.battingSide = battingSide;
    s.bowlingSide = (battingSide === 'player') ? 'computer' : 'player';
  }
  _battingScore() {
    const s = this.state;
    return s.battingSide === 'player' ? s.playerScore : s.computerScore;
  }

  /** THE core rule: equal => OUT (0 vs 0 is OUT); else the batting
   *  score grows by the BATSMAN's number, except a batsman on 0 who
   *  scores the BOWLER's number instead. */
  resolveBall(playerMove, computerMove) {
    validateMove(playerMove);
    validateMove(computerMove);
    const s = this.state;
    if (s.phase !== Phases.INNINGS_1 && s.phase !== Phases.INNINGS_2) {
      throw new Error(`Cannot play a ball in phase ${s.phase}`);
    }
    if (!s.battingSide) throw new Error('Innings has no batting side');

    const batsmanMove = (s.battingSide === 'player') ? playerMove : computerMove;
    const bowlerMove = (s.battingSide === 'player') ? computerMove : playerMove;
    const isOut = batsmanMove === bowlerMove;
    const runs = isOut ? 0 : (batsmanMove === 0 ? bowlerMove : batsmanMove);
    if (!isOut) {
      if (s.battingSide === 'player') s.playerScore += runs;
      else s.computerScore += runs;
    }
    s.ballCount += 1;
    const rec = {
      ballNo: s.ballCount,
      innings: s.innings,
      battingSide: s.battingSide,
      playerMove, computerMove,
      batsmanRuns: runs,
      isOut,
      scoreAfter: this._battingScore(),
    };
    s.history.push(rec);
    s.lastOut = isOut;
    s.lastResultText = isOut ? 'OUT!' : `+${runs} RUNS`;

    if (s.innings === 1) {
      if (isOut) {
        const firstScore = this._battingScore();
        s.target = firstScore + 1;
        this._beginInnings(2, s.bowlingSide);
        s.phase = Phases.INNINGS_BREAK;
      }
    } else {
      const chasing = this._battingScore();
      if (chasing >= s.target) this._finish(true);
      else if (isOut) this._finish(false);
    }
    return {
      playerMove, computerMove, batsmanMove, bowlerMove,
      isOut, runs,
      playerScore: s.playerScore, computerScore: s.computerScore,
      phase: s.phase, innings: s.innings, battingSide: s.battingSide,
      target: s.target, winner: s.winner,
      resultText: s.lastResultText, record: rec,
    };
  }

  /** AI commits from COMPLETED history only. Call BEFORE the player's
   *  current move is known. Returns {move, patternDetected, historyLen}. */
  commitAiMove() {
    const s = this.state;
    if (s.phase !== Phases.INNINGS_1 && s.phase !== Phases.INNINGS_2) {
      throw new Error(`AI cannot commit in phase ${s.phase}`);
    }
    if (!s.battingSide) throw new Error('Innings has no batting side');
    const snapshot = s.history.slice(); // completed balls only. No pending move exists here
    const out = window.HCAI.getAIMove(snapshot, s.difficulty, s.battingSide === 'player', this.rng);
    this.lastAiInfo = { historyLen: out.historyLen, patternDetected: out.patternDetected };
    return out;
  }

  playBallWithAI(playerMove, injectedComputerMove = null) {
    validateMove(playerMove);
    if (injectedComputerMove !== null && injectedComputerMove !== undefined) {
      return this.resolveBall(playerMove, validateMove(injectedComputerMove));
    }
    const ai = this.commitAiMove(); // fair ordering: AI locks first...
    const out = this.resolveBall(playerMove, ai.move); // ...then the player move resolves
    out.aiPatternDetected = ai.patternDetected;
    return out;
  }

  continueAfterBreak() {
    const s = this.state;
    if (s.phase !== Phases.INNINGS_BREAK) throw new Error('No innings break to continue from');
    s.phase = Phases.INNINGS_2;
    s.lastResultText = `Target ${s.target}. ${String(s.battingSide).toUpperCase()} to chase.`;
    return s;
  }

  _finish(chasingWon) {
    const s = this.state;
    const chasingSide = s.battingSide;
    s.winner = chasingWon ? chasingSide : s.bowlingSide;
    if (s.winner === 'player') {
      s.winMargin = (chasingWon && chasingSide === 'player')
        ? `Chased down target ${s.target}. You win.`
        : `Won by ${s.playerScore - s.computerScore} runs. Computer fell short.`;
    } else {
      s.winMargin = (chasingWon && chasingSide === 'computer')
        ? `Computer chased target ${s.target}. You lose.`
        : `Computer wins by ${s.computerScore - s.playerScore} runs.`;
    }
    s.phase = Phases.MATCH_RESULT;
    s.lastResultText = s.winner === 'player' ? 'YOU WIN!' : 'COMPUTER WINS';
  }
}

window.HCPhases = Phases;
window.HCGameEngine = GameEngine;
window.HCComputerPick = computerPick;
window.HCValidateMove = validateMove;
