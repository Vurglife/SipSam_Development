'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Roulette — client/game.js
// Wire-level protocol matches RouletteRoom:
//   → placeBet { bet: {type, ...} }
//   → undoBet, clearBets, replenish, chat
//   ← state, spin, resolve, bigAnnouncement, error, chat, replenished
// ─────────────────────────────────────────────────────────────

// ── Configurable endpoints ─────────────────────────────────
// Mirrors the Rhum32 / Blackjack pattern: HTTP matchmake goes through
// whichever origin served the page (standalone → :3005, platform → :3000
// which proxies to :3005). WS always points directly at the game server
// port 3006 on the current host — other games bypass the platform for WS
// and so do we, to keep it simple.
const PLATFORM_HOSTED = (window.location.port !== '3005');
const API_BASE = '';  // relative — works standalone and through platform proxy
const WS_BASE  = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                + location.hostname + ':3006';

// ── Bet type labels + payouts (mirrors server engine.js) ──
const BET_PAYOUTS = {
  straight: 35, split: 17, street: 11, trio: 11, corner: 8, line: 5,
  column: 2, dozen: 2,
  red: 1, black: 1, even: 1, odd: 1, low: 1, high: 1,
};

const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const BLACK_SET = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);
function colorOfNum(n) {
  if (n === 0 || n === '00') return 'green';
  return RED_SET.has(n) ? 'red' : (BLACK_SET.has(n) ? 'black' : null);
}

const AMERICAN_WHEEL = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1,
  '00', 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
];
const EUROPEAN_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

const PHASE_SECONDS = { betting: 40, spinning: 8, resolving: 5 };
const SVG_NS = 'http://www.w3.org/2000/svg';
const WHEEL_CENTER = 120;
const WHEEL_OUTER_R = 112;
const WHEEL_INNER_R = 73;
const WHEEL_LABEL_R = 94;
const BALL_TRACK_R = 82;

// ── Client state ──────────────────────────────────────────
const S = {
  username:   'Player',
  userId:     null,
  sessionId:  null,
  roomId:     null,
  variant:    'american',
  mode:       'multiplayer',   // 'multiplayer' | 'single'
  tableMinBet: 100,
  accessLevel: '',
  wallet:     0,
  walletSize: 0,               // default wallet draw (for replenish cap)

  selectedChip: 100,
  chipDenoms:   [100, 500, 1000, 5000, 10000],

  cfg:       null,
  phase:     'waiting',
  round:     0,
  phaseEnd:  0,
  history:   [],
  gameMemory: [],
  lastWinning: null,
  ws:        null,
  authToken: '',
  autoEnter: false,

  // UI helpers
  timerInt:  null,
  tableHooks: {}, // cellKey → DOM element for chip-stack update
  myBets:    [],  // mirror of server-side bets (for optimistic chip draw)
  lastBets:  [],
  insideMode: null,
  insideSelection: [],
  showWinValues: false,
  soundEnabled: true,
  audioCtx: null,
  spinSoundTimer: null,
  betView: 'table',
  wheelRotation: 0,
  ballAngle: 0,
  wheelAnimId: null,
  wheelResetTimer: null,
};

const INSIDE_BET_SPECS = {
  split:  { label: 'Split',  count: 2, payout: '17:1' },
  street: { label: 'Row',    count: 3, payout: '11:1' },
  trio:   { label: 'Trio',   count: 3, payout: '11:1' },
  corner: { label: 'Corner', count: 4, payout: '8:1' },
  line:   { label: 'Line',   count: 6, payout: '5:1' },
};

const ZERO_DIRECT_BETS = [
  { label: '0-00', type: 'split', targets: [0, '00'], className: 'zero-hotspot-0-00', title: 'Split 0 and 00' },
  { label: '0-1', type: 'split', targets: [0, 1], className: 'zero-hotspot-0-1', title: 'Split 0 and 1' },
  { label: '00-3', type: 'split', targets: ['00', 3], className: 'zero-hotspot-00-3', title: 'Split 00 and 3' },
  { label: '0-00-2', type: 'trio', targets: [0, '00', 2], className: 'zero-hotspot-0-00-2', title: 'Trio 0, 00, and 2' },
];

const PARTNER_ODDS_RATES = {
  first: '5%',
  second: '4%',
  third: '3.5%',
  fourth: '3%',
};

const PARTNER_ODDS_CHART = [
  ['1',  '21, 27', '17, 34', '16, 22, 2', '31, 24, 15, 10, 19, 28'],
  ['2',  '28', '31, 24, 15', '22, 5, 32, 1', '00, 33, 11, 20, 29'],
  ['3',  '26', '33, 9', '5, 4', '34, 12, 21, 30'],
  ['4',  '28, 9', '2, 20, 0', '8, 3, 26', '13, 22, 31'],
  ['5',  '9', '33, 26, 31', '6, 2', '3, 32, 14, 23'],
  ['6',  '26, 9', '31, 2, 24, 15, 10, 8', '5', '33, 35, 17'],
  ['7',  '00, 14, 21', '30, 11, 1, 27, 20', '8, 2, 0', '34, 25, 16'],
  ['8',  '6, 30, 2, 20', '', '4, 16, 32, 7', '17, 26, 25, 33, 24, 15'],
  ['9',  '4, 5, 6', '23, 16, 20, 17', '10', '18, 27, 36'],
  ['10', '1, 32, 13', '6, 12', '9', '28, 19'],
  ['11', '7, 17, 26', '25', '00, 22, 33, 12', '2, 29, 20'],
  ['12', '32, 24', '21, 1, 23', '11', '3, 30'],
  ['13', '26, 31', '10', '14', '4, 22'],
  ['14', '21, 30, 7', '23, 33, 6', '13', '5, 32'],
  ['15', '30, 13, 6', '26', '16, 17', '24, 33, 8, 35'],
  ['16', '0, 19, 23', '32, 1, 8, 28, 2', '15, 18', '7, 34, 25, 31, 24, 26'],
  ['17', '1, 34, 26', '00, 13, 22, 15', '18, 6', '8, 35, 33'],
  ['18', '0, 28, 32', '2, 3, 36', '17, 25, 16', '9, 27'],
  ['19', '1, 23, 16, 3', '', '20, 34', '28, 10'],
  ['20', '4, 8, 28', '2, 14', '19, 23, 30', '11, 29, 0, 00'],
  ['21', '00, 27, 1, 14, 12', '5', '22, 35, 16', '3, 30'],
  ['22', '34, 3, 2, 30', '23, 8', '21, 14, 24', '4, 31, 13'],
  ['23', '24, 25, 30, 12, 14', '26, 17, 32', '3, 36, 10, 29', '5, 11'],
  ['24', '23, 12, 1', '32, 2, 4, 35, 29', '26, 17, 8', '15, 31, 6, 33'],
  ['25', '26, 23, 30', '11, 9, 4, 33', '', '7, 27, 16'],
  ['26', '3, 25, 6, 13', '5, 17, 15, 24, 29', '10, 21', '8, 35'],
  ['27', '35, 00, 1, 21, 12', '13, 6, 19', '28', '9, 18, 36, 33'],
  ['28', '4, 32, 8, 12', '16, 2, 20', '27, 26, 30', '1, 19, 10'],
  ['29', '24, 26', '23, 30, 11', '3, 36, 9', '2, 20'],
  ['30', '8, 14, 25, 23, 15', '12, 19, 20, 10, 3', '29, 36', '21, 0, 00'],
  ['31', '13, 15, 33', '26, 2, 22', '32, 5', '4'],
  ['32', '23, 12, 28, 1, 16', '18, 8, 19, 20, 34', '31, 5', '14, 26, 17'],
  ['33', '35, 31, 5', '22, 14', '34, 17, 26', '00, 2, 6, 15, 24, 8'],
  ['34', '17, 1, 23', '22, 19, 32, 36', '33', '7, 25, 16'],
  ['35', '12, 27, 33', '26, 28, 19', '36, 17, 4, 30', '8, 1, 0, 00'],
  ['36', '1, 21, 14', '13, 18', '35, 26, 6, 34', '00, 33, 9, 27, 32'],
  ['00', '21, 8, 7', '33, 11, 23, 26, 17', '0, 19, 6, 28, 2', '10, 20, 30, 12'],
  ['0',  '16, 17', '18, 00, 4, 33, 26', '21, 1, 20, 5', '11, 30, 10'],
];

// ── URL params + sessionStorage handoff ────────────────────
function readHandoff() {
  const p = new URLSearchParams(location.search);
  const urlVariant = p.get('variant');
  const urlMinBet  = p.get('minBet') || p.get('tableMinBet');
  const urlMode    = p.get('mode');
  const urlLevel   = p.get('level');
  const urlUser    = p.get('username') || p.get('user');
  const urlUid     = p.get('userId');
  const urlWallet  = p.get('wallet');

  if (urlVariant === 'american') S.variant = 'american';
  if (urlMinBet)   S.tableMinBet = Number(urlMinBet);
  if (urlMode)     S.mode = urlMode;
  if (urlLevel)    S.accessLevel = urlLevel;
  if (urlUser)     S.username = urlUser;
  if (urlUid)      S.userId = urlUid;
  if (urlWallet)   S.wallet = Number(urlWallet);
  S.autoEnter = Boolean(urlMinBet && urlWallet);

  // Pull auth token / extra fields from sessionStorage (set by dashboard)
  try {
    const u = JSON.parse(sessionStorage.getItem('roulette_user') || 'null');
    if (u) {
      if (!S.username || S.username === 'Player') S.username = u.username || S.username;
      if (!S.userId)   S.userId   = u.id || S.userId;
      if (u.token)     S.authToken = u.token;
    }
    const t = JSON.parse(sessionStorage.getItem('roulette_table') || 'null');
    if (t) {
      if (!S.tableMinBet) S.tableMinBet = Number(t.entryKey || t.minBet);
      if (!S.accessLevel) S.accessLevel = t.label || t.level || '';
      if (!S.wallet)      S.wallet = Number(t.wallet || t.walletSize || 0);
    }
  } catch (_) {}
  loadGameMemory();
}

// ── Screen helpers ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// Browser-safe synthesized sounds. Audio starts only after a player gesture.
function ensureAudio() {
  if (!S.soundEnabled) return null;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!S.audioCtx) S.audioCtx = new AudioCtor();
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume().catch(() => {});
  return S.audioCtx;
}

function playTone(freq, duration, type, delay, gainValue) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const when = ctx.currentTime + (delay || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, when);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(gainValue || 0.035, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + duration + 0.02);
}

function playSound(name) {
  if (!S.soundEnabled) return;
  if (name === 'chip') {
    playTone(520, 0.055, 'triangle', 0, 0.04);
    playTone(760, 0.045, 'triangle', 0.035, 0.025);
  } else if (name === 'button') {
    playTone(360, 0.045, 'sine', 0, 0.025);
  } else if (name === 'error') {
    playTone(150, 0.09, 'sawtooth', 0, 0.035);
    playTone(110, 0.12, 'sawtooth', 0.075, 0.025);
  } else if (name === 'tick') {
    playTone(1180, 0.028, 'square', 0, 0.018);
  } else if (name === 'win') {
    playTone(520, 0.08, 'triangle', 0, 0.04);
    playTone(660, 0.08, 'triangle', 0.08, 0.04);
    playTone(880, 0.16, 'triangle', 0.16, 0.05);
  } else if (name === 'lose') {
    playTone(260, 0.09, 'triangle', 0, 0.028);
    playTone(190, 0.16, 'triangle', 0.09, 0.025);
  } else if (name === 'push') {
    playTone(420, 0.08, 'sine', 0, 0.025);
  }
}

function startSpinSound() {
  stopSpinSound();
  if (!S.soundEnabled) return;
  const started = Date.now();
  const tick = () => {
    if (S.phase !== 'spinning') return stopSpinSound();
    playSound('tick');
    const elapsed = Date.now() - started;
    const next = Math.min(240, 45 + elapsed / 42);
    S.spinSoundTimer = setTimeout(tick, next);
  };
  playTone(95, 0.45, 'sawtooth', 0, 0.018);
  S.spinSoundTimer = setTimeout(tick, 40);
}

function stopSpinSound() {
  if (!S.spinSoundTimer) return;
  clearTimeout(S.spinSoundTimer);
  S.spinSoundTimer = null;
}

function updateSoundButton() {
  const btn = document.getElementById('btn-sound-toggle');
  if (!btn) return;
  btn.textContent = S.soundEnabled ? 'Sound: On' : 'Sound: Off';
  btn.classList.toggle('active', S.soundEnabled);
}

window.toggleSound = function () {
  S.soundEnabled = !S.soundEnabled;
  if (!S.soundEnabled) stopSpinSound();
  else {
    ensureAudio();
    playSound('button');
  }
  updateSoundButton();
};

window.addEventListener('pointerdown', () => ensureAudio(), { passive: true });
window.addEventListener('keydown', () => ensureAudio());

// ── Mode-select screen ────────────────────────────────────
window.pickVariant = function (v) {
  S.variant = 'american';
  document.querySelectorAll('.variant-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.variant === S.variant);
  });
  refreshEnterButton();
};
window.pickMode = function (m) {
  S.mode = m;
  document.querySelectorAll('.mode-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.mode === m);
  });
  refreshEnterButton();
};
function refreshEnterButton() {
  document.getElementById('btn-enter').disabled =
    !(S.variant && S.mode);
}
window.backToDashboard = function () {
  // When hosted by platform, the back button returns to dashboard.
  if (PLATFORM_HOSTED) {
    settleWallet('lobby-back').then((ok) => {
      if (!ok) return alert('Could not return your Roulette wallet. Please try again.');
      window._intentionalExit = true;
      window.location.href = '/';
    });
  } else {
    showScreen('screen-login');
  }
};

window.enterTable = async function () {
  try {
    const res = await fetch(API_BASE + '/matchmake/joinOrCreate/roulette_room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username:     S.username,
        userId:       S.userId,
        token:        S.authToken,
        wallet:       S.wallet,
        tableMinBet:  S.tableMinBet,
        variant:      'american',
        mode:         S.mode,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Join failed');
    S.sessionId = data.sessionId;
    S.roomId    = data.roomId;
    connectWS();
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

// ── WebSocket ─────────────────────────────────────────────
function connectWS() {
  if (S.ws) try { S.ws.close(); } catch (_) {}
  const url = WS_BASE + '?sessionId=' + encodeURIComponent(S.sessionId);
  const ws = new WebSocket(url);
  S.ws = ws;

  ws.onopen = () => {
    showScreen('screen-game');
    renderChips();
    renderWheelFace();
    attachBoardHandlers();
    attachWheelHandlers();
    refreshBetViewUI();
    window.addEventListener('beforeunload', handleBeforeUnload);
  };
  ws.onclose = (e) => {
    console.log('[Roulette] WS closed', e.code, e.reason);
    if (document.getElementById('screen-game').classList.contains('active')) {
      document.getElementById('table-message').textContent = 'Disconnected';
    }
  };
  ws.onerror = (e) => console.error('[Roulette] WS error', e);
  ws.onmessage = (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch (_) { return; }
    handleMessage(data);
  };
}
function send(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }
function sendExit() {
  // Best-effort close notify (beacon not needed — socket close on server side calls onLeave)
  try { if (S.ws) S.ws.close(1000, 'user-exit'); } catch (_) {}
}
function remainingWalletForExit() {
  const wallet = Math.max(0, Math.floor(S.wallet || 0));
  const lockedStake = S.phase === 'spinning'
    ? S.myBets.reduce((sum, bet) => sum + (Number(bet.amount) || 0), 0)
    : 0;
  return Math.max(0, wallet - lockedStake);
}
async function settleWallet(reason) {
  if (!PLATFORM_HOSTED || !S.authToken) return true;
  try {
    const res = await fetch('/api/game/roulette/exit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + S.authToken,
      },
      body: JSON.stringify({
        remainingWallet: remainingWalletForExit(),
        tableMinBet: S.tableMinBet,
        reason: reason || 'exit',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || 'Exit settlement failed');
    try {
      sessionStorage.removeItem('roulette_table');
      sessionStorage.removeItem('roulette_user');
    } catch (_) {}
    return true;
  } catch (e) {
    console.warn('[Roulette] exit API failed:', e);
    return false;
  }
}
function sendExitBeacon() {
  if (!PLATFORM_HOSTED || !S.authToken) return;
  try {
    const blob = new Blob([JSON.stringify({
      remainingWallet: remainingWalletForExit(),
      tableMinBet: S.tableMinBet,
    })], { type: 'application/json' });
    navigator.sendBeacon('/api/game/roulette/exit-beacon?token=' + encodeURIComponent(S.authToken), blob);
  } catch (_) {}
}
function handleBeforeUnload() {
  if (window._intentionalExit) return;
  sendExitBeacon();
  sendExit();
}

// ── Inbound messages ──────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'state':           return onState(data);
    case 'spin':            return onSpin(data);
    case 'resolve':         return onResolve(data);
    case 'bigAnnouncement': return onBigAnnouncement(data);
    case 'chat':            return onChat(data);
    case 'error':           return onErr(data);
    case 'replenished':     return onReplenished(data);
    case 'replenishResult': return onReplenishResult(data);
    case 'pong':            return;
  }
}

function onState(d) {
  const prevStake = S.myBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  const prevCfg = JSON.stringify(S.cfg || {});
  S.variant    = d.variant;
  S.mode       = d.mode;
  S.cfg        = d.cfg;
  S.walletSize = d.cfg?.walletSize || 0;
  S.phase      = d.phase;
  S.phaseEnd   = d.phaseEnd;
  S.round      = d.round;
  S.history    = d.history || [];
  S.lastWinning = d.winning !== null && d.winning !== undefined
    ? d.winning
    : (S.history[0]?.pocket ?? S.lastWinning);

  const me = d.players && d.players[S.sessionId];
  if (me) {
    S.cfg = me.cfg || S.cfg;
    S.tableMinBet = Number(me.tableMinBet) || S.tableMinBet;
    S.accessLevel = S.cfg?.level || S.accessLevel;
    S.walletSize = S.cfg?.walletSize || S.walletSize;
    S.wallet = me.wallet;
    S.myBets = me.bets.slice();
  }
  const nextStake = S.myBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  if (S.phase === 'betting' && nextStake > prevStake) playSound('chip');

  renderBoard();      // ensures the variant-correct board is drawn
  renderWheelFace();
  if (JSON.stringify(S.cfg || {}) !== prevCfg) renderChips();
  updateHeader(d.message);
  renderWallet();
  renderHistory();
  redrawChipStacks();
  if (S.phase === 'betting') clearWheelFocus();
  refreshBetViewUI();
  refreshPhaseUI();
}

function onSpin(d) {
  S.phaseEnd = d.phaseEnd;
  S.phase    = 'spinning';
  S.lastWinning = d.winning;
  rememberLastBets();
  cancelWheelResetTimer();
  animateWheel(d.winning);
  startSpinSound();
  document.getElementById('game-status').textContent = 'Spinning…';
  document.getElementById('table-message').textContent = 'No more bets';
  refreshPhaseUI();
}

function onResolve(d) {
  S.phase      = 'resolving';
  S.phaseEnd   = d.phaseEnd;
  S.history    = d.history;
  S.lastWinning = d.winning;
  const me = d.results && d.results[S.sessionId];
  stopSpinSound();
  renderHistory();
  highlightWinningCell(d.winning);
  if (me) {
    S.wallet = me.wallet;
    showResult(me);
  }
  rememberGameResult(d, me);
  renderWallet();
  showWinningNumber(d.winning, true);
  highlightWinningPocket(d.winning);
  showRoundAnnouncement(d.winning, me);
  scheduleWheelRoundReset(d.phaseEnd);
  refreshPhaseUI();
}

function onBigAnnouncement(d) {
  showTextAnnouncement(d.text, d.duration || 3500);
}

function onChat(d) {
  // Placeholder hook — can flash a small toast. Deferred for now.
}

function onErr(d) {
  playSound('error');
  flashMessage(d.message || 'Error');
}

function onReplenished(d) {
  S.wallet = d.wallet;
  renderWallet();
  flashMessage('Wallet topped up to $' + d.wallet.toLocaleString());
}
function onReplenishResult(d) {
  if (!d || !d.ok) return flashMessage((d && d.error) || 'Replenish failed');
  S.wallet = d.newWallet;
  renderWallet();
  flashMessage('Wallet replenished: +$' + (d.added || 0).toLocaleString());
}

// ── Header / status ───────────────────────────────────────
function updateHeader(msg) {
  document.getElementById('game-round').textContent = 'Round ' + (S.round || '--');
  document.getElementById('game-status').textContent =
    S.phase === 'betting'   ? 'Place your bets' :
    S.phase === 'spinning'  ? 'Spinning…' :
    S.phase === 'resolving' ? 'Payouts' :
    'Waiting for players';
  if (msg) document.getElementById('table-message').textContent = msg;
}

function refreshPhaseUI() {
  startTimerLoop();
  const bettingOpen = S.phase === 'betting';
  if (!bettingOpen && S.insideSelection.length) {
    S.insideSelection = [];
  }
  document.querySelectorAll('.cell').forEach((c) => {
    c.style.pointerEvents = bettingOpen ? '' : 'none';
    c.style.opacity = bettingOpen ? '' : '0.78';
  });
  document.querySelectorAll('.bet-hotspot, .zero-hotspot').forEach((c) => {
    c.style.pointerEvents = bettingOpen ? '' : 'none';
    c.classList.toggle('betting-closed', !bettingOpen);
  });
  document.querySelectorAll('.wheel-special-bet').forEach((c) => {
    c.disabled = !bettingOpen;
    c.classList.toggle('betting-closed', !bettingOpen);
  });
  document.querySelectorAll('.wheel-pocket').forEach((pocket) => {
    pocket.classList.toggle('betting-open', bettingOpen && S.betView === 'wheel');
    pocket.classList.toggle('betting-closed', !bettingOpen || S.betView !== 'wheel');
  });
  document.getElementById('btn-undo').disabled  = !bettingOpen;
  document.getElementById('btn-clear').disabled = !bettingOpen;
  updateDoubleButton();
  updateRepeatButton();
  updateWinToggleButton();
  updateSoundButton();
  updateInsideBetUI();
  refreshBoardSelection();
  updateMyAreaHeight();
}

function startTimerLoop() {
  if (S.timerInt) clearInterval(S.timerInt);
  const tick = () => {
    const remain = Math.max(0, Math.ceil((S.phaseEnd - Date.now()) / 1000));
    const el = document.getElementById('game-timer');
    if (el) {
      el.textContent = remain;
      el.classList.toggle('urgent', S.phase === 'betting' && remain <= 5);
    }
    const ring = document.getElementById('timer-ring');
    if (ring) {
      const total = PHASE_SECONDS[S.phase] || 5;
      const frac = Math.max(0, Math.min(1, remain / total));
      ring.style.strokeDashoffset = String(100 - frac * 100);
    }
  };
  tick();
  S.timerInt = setInterval(tick, 200);
}

// ── Board rendering ───────────────────────────────────────
function renderBoard() {
  // Clear and rebuild the main 3×12 grid, honouring variant.
  const main = document.getElementById('grid-main');
  if (!main.dataset.rendered) {
    // Top row: 3, 6, 9, …, 36
    // Mid row: 2, 5, 8, …, 35
    // Bot row: 1, 4, 7, …, 34
    const rows = [
      [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
      [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
      [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
    ];
    for (const r of rows) {
      for (const n of r) {
        const btn = document.createElement('button');
        btn.className = 'cell ' + (RED_SET.has(n) ? 'num-red' : 'num-black');
        btn.textContent = String(n);
        btn.dataset.bet = JSON.stringify({ type: 'straight', target: n });
        main.appendChild(btn);
      }
    }
    main.dataset.rendered = '1';
  }

  // Variant-conditional cells
  const dbl = document.getElementById('cell-dblzero');
  const zeroCol = document.querySelector('.zero-col');
  if (zeroCol) zeroCol.classList.toggle('american-zero', S.variant === 'american');
  if (S.variant === 'american') {
    dbl.style.display = '';
  } else {
    dbl.style.display = 'none';
  }
  refreshBoardSelection();
  renderDirectBetHotspots();
  renderZeroDirectHotspots();
}

function renderDirectBetHotspots() {
  const main = document.getElementById('grid-main');
  if (!main || main.dataset.hotspotsRendered) return;
  const overlay = document.createElement('div');
  overlay.className = 'grid-hotspots';
  main.appendChild(overlay);

  for (let street = 1; street <= 12; street += 1) {
    for (let col = 1; col <= 2; col += 1) {
      addHotspot(overlay, 'split', [tableNumber(street, col), tableNumber(street, col + 1)], {
        kind: 'split-v',
        x: streetCenterPct(street),
        y: colBoundaryPct(col),
      });
    }
  }

  for (let street = 1; street <= 11; street += 1) {
    for (let col = 1; col <= 3; col += 1) {
      addHotspot(overlay, 'split', [tableNumber(street, col), tableNumber(street + 1, col)], {
        kind: 'split-h',
        x: streetBoundaryPct(street),
        y: colCenterPct(col),
      });
    }
  }

  for (let street = 1; street <= 11; street += 1) {
    for (let col = 1; col <= 2; col += 1) {
      addHotspot(overlay, 'corner', [
        tableNumber(street, col),
        tableNumber(street, col + 1),
        tableNumber(street + 1, col),
        tableNumber(street + 1, col + 1),
      ], {
        kind: 'corner',
        x: streetBoundaryPct(street),
        y: colBoundaryPct(col),
      });
    }
  }

  for (let street = 1; street <= 12; street += 1) {
    addHotspot(overlay, 'street', streetForRow(street), {
      kind: 'street',
      label: '3',
      x: streetCenterPct(street),
      y: '100%',
    });
  }

  for (let street = 1; street <= 11; street += 1) {
    addHotspot(overlay, 'line', [...streetForRow(street), ...streetForRow(street + 1)], {
      kind: 'line',
      label: '6',
      x: streetBoundaryPct(street),
      y: '100%',
    });
  }

  main.dataset.hotspotsRendered = '1';
}

function renderZeroDirectHotspots() {
  const zeroCol = document.querySelector('.zero-col');
  if (!zeroCol || zeroCol.dataset.zeroRendered) return;
  for (const bet of ZERO_DIRECT_BETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zero-hotspot ' + bet.className;
    btn.textContent = bet.label;
    btn.title = bet.title;
    btn.setAttribute('aria-label', bet.title);
    btn.dataset.bet = JSON.stringify({ type: bet.type, targets: bet.targets });
    btn.dataset.betKey = compoundKey(bet.type, bet.targets);
    zeroCol.appendChild(btn);
  }
  zeroCol.dataset.zeroRendered = '1';
}

function addHotspot(parent, type, targets, opts) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bet-hotspot bet-hotspot-' + opts.kind;
  if (opts.label) btn.textContent = opts.label;
  btn.title = `${betLabelForType(type)} ${targets.map(formatTarget).join('-')}`;
  btn.style.left = opts.x;
  btn.style.top = opts.y;
  btn.dataset.bet = JSON.stringify({ type, targets });
  btn.dataset.betKey = compoundKey(type, targets);
  parent.appendChild(btn);
}

function betLabelForType(type) {
  return INSIDE_BET_SPECS[type]?.label || type;
}

function tableNumber(street, col) {
  return ((street - 1) * 3) + col;
}

function streetCenterPct(street) {
  return (((street - 0.5) / 12) * 100).toFixed(4) + '%';
}

function streetBoundaryPct(street) {
  return ((street / 12) * 100).toFixed(4) + '%';
}

function colCenterPct(col) {
  const displayRow = 3 - col;
  return (((displayRow + 0.5) / 3) * 100).toFixed(4) + '%';
}

function colBoundaryPct(lowCol) {
  return (((3 - lowCol) / 3) * 100).toFixed(4) + '%';
}

function attachBoardHandlers() {
  const board = document.getElementById('board');
  if (board.dataset.handlersAttached) return;
  board.dataset.handlersAttached = '1';
  board.addEventListener('pointerover', previewBetTarget);
  board.addEventListener('pointerout', clearPreviewOnLeave);
  board.addEventListener('focusin', previewBetTarget);
  board.addEventListener('focusout', clearBetPreview);
  board.addEventListener('click', (e) => {
    const direct = e.target.closest('.bet-hotspot, .zero-hotspot');
    if (direct && direct.dataset.bet) {
      if (S.phase !== 'betting') return flashMessage('Betting is closed');
      let desc;
      try { desc = JSON.parse(direct.dataset.bet); } catch (_) { return; }
      placeBetDescriptor(desc);
      return;
    }
    const cell = e.target.closest('.cell');
    if (!cell || !cell.dataset.bet) return;
    if (S.phase !== 'betting') return flashMessage('Betting is closed');
    let desc;
    try { desc = JSON.parse(cell.dataset.bet); } catch (_) { return; }
    if (S.insideMode && desc.type === 'straight') {
      toggleInsideTarget(desc.target);
      return;
    }
    placeBetDescriptor(desc);
  });
}

function previewBetTarget(e) {
  const el = e.target.closest('.bet-hotspot, .zero-hotspot, .cell');
  if (!el || !el.dataset.bet) return;
  showBetPreview(el);
}

function clearPreviewOnLeave(e) {
  const el = e.target.closest('.bet-hotspot, .zero-hotspot, .cell');
  if (!el) return;
  const next = e.relatedTarget && e.relatedTarget.closest
    ? e.relatedTarget.closest('.bet-hotspot, .zero-hotspot, .cell')
    : null;
  if (next === el) return;
  clearBetPreview();
}

function showBetPreview(el) {
  clearBetPreview();
  el.classList.add('bet-preview-anchor');
  let desc;
  try { desc = JSON.parse(el.dataset.bet); } catch (_) { return; }
  const targets = previewTargetsFor(desc);
  for (const target of targets) {
    const cell = findCellByKey('straight:' + target);
    if (cell) cell.classList.add('bet-preview');
  }
}

function clearBetPreview() {
  document.querySelectorAll('.bet-preview, .bet-preview-anchor').forEach((n) => {
    n.classList.remove('bet-preview', 'bet-preview-anchor');
  });
}

function previewTargetsFor(desc) {
  if (!desc) return [];
  if (desc.type === 'straight') return [desc.target];
  if (Array.isArray(desc.targets)) return desc.targets.slice();
  return [];
}

function placeBetDescriptor(desc) {
  const bet = { ...desc, amount: S.selectedChip };
  send({ type: 'placeBet', bet });
}

function rememberLastBets() {
  if (!S.myBets.length) return;
  const repeatable = S.myBets.map(repeatableBetFrom).filter(Boolean);
  if (repeatable.length) S.lastBets = repeatable;
  updateRepeatButton();
}

function repeatableBetFrom(b) {
  const amount = Number(b.amount) || 0;
  if (!amount || !b.type) return null;
  if (b.type === 'straight') return { type: 'straight', target: b.numbers[0], amount };
  if (['split', 'street', 'trio', 'corner', 'line'].includes(b.type)) {
    return { type: b.type, targets: (b.numbers || []).slice(), amount };
  }
  if (b.type === 'column') return { type: 'column', which: b.which || columnForNumbers(b.numbers), amount };
  if (b.type === 'dozen') return { type: 'dozen', which: b.which || dozenForNumbers(b.numbers), amount };
  if (['red', 'black', 'even', 'odd', 'low', 'high'].includes(b.type)) return { type: b.type, amount };
  return null;
}

function columnForNumbers(numbers) {
  if (!Array.isArray(numbers) || !numbers.length) return 1;
  return colOf(numbers[0]);
}

function dozenForNumbers(numbers) {
  if (!Array.isArray(numbers) || !numbers.length) return 1;
  const first = numbers[0];
  if (first >= 25) return 3;
  if (first >= 13) return 2;
  return 1;
}

window.repeatLastBets = function () {
  if (S.phase !== 'betting') return flashMessage('Betting is closed');
  if (!S.lastBets.length) return flashMessage('No previous bet to repeat');
  const repeatStake = S.lastBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  const currentStake = currentBetStake();
  if (repeatStake + currentStake > S.wallet) {
    playSound('error');
    return flashMessage('Not enough chips to repeat');
  }
  playSound('button');
  for (const bet of S.lastBets) {
    send({ type: 'placeBet', bet: { ...bet, targets: bet.targets ? bet.targets.slice() : undefined } });
  }
};

window.doubleCurrentBets = function () {
  if (S.phase !== 'betting') return flashMessage('Betting is closed');
  const currentStake = currentBetStake();
  if (!currentStake) return flashMessage('No current bet to double');
  if (currentStake * 2 > S.wallet) {
    playSound('error');
    return flashMessage('Not enough chips to double');
  }
  playSound('button');
  send({ type: 'doubleBets' });
};

function currentBetStake() {
  return S.myBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
}

function displayedBalance() {
  const lockedBet = (S.phase === 'betting' || S.phase === 'spinning') ? currentBetStake() : 0;
  return Math.max(0, (Number(S.wallet) || 0) - lockedBet);
}

function updateDoubleButton() {
  const btn = document.getElementById('btn-double');
  if (!btn) return;
  const currentStake = currentBetStake();
  btn.disabled = !(S.phase === 'betting' && currentStake > 0 && currentStake * 2 <= S.wallet);
}

function updateRepeatButton() {
  const btn = document.getElementById('btn-repeat');
  if (!btn) return;
  const repeatStake = S.lastBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  const currentStake = currentBetStake();
  const canRepeat = S.phase === 'betting' && S.lastBets.length > 0 && repeatStake + currentStake <= S.wallet;
  btn.disabled = !canRepeat;
}

window.toggleWinValues = function () {
  S.showWinValues = !S.showWinValues;
  playSound('button');
  updateWinToggleButton();
  redrawChipStacks();
};

function updateWinToggleButton() {
  const btn = document.getElementById('btn-win-toggle');
  if (!btn) return;
  btn.textContent = S.showWinValues ? 'Win: On' : 'Win: Off';
  btn.classList.toggle('active', S.showWinValues);
}

window.setBetView = function (view) {
  S.betView = view === 'wheel' ? 'wheel' : 'table';
  if (S.betView === 'wheel') {
    S.insideMode = null;
    S.insideSelection = [];
  }
  refreshBetViewUI();
  updateInsideBetUI();
  refreshBoardSelection();
  refreshPhaseUI();
};

function refreshBetViewUI() {
  const game = document.getElementById('screen-game');
  if (game) game.classList.toggle('bet-view-wheel', S.betView === 'wheel');
  document.querySelectorAll('.view-toggle').forEach((btn) => {
    const active = (btn.id === 'view-wheel' && S.betView === 'wheel')
      || (btn.id === 'view-table' && S.betView !== 'wheel');
    btn.classList.toggle('active', active);
  });
  updateMyAreaHeight();
}

function attachWheelHandlers() {
  const wheel = document.getElementById('wheel');
  if (!wheel || wheel.dataset.handlersAttached) return;
  wheel.dataset.handlersAttached = '1';
  wheel.addEventListener('click', (e) => {
    const pocket = e.target.closest('.wheel-pocket');
    if (!pocket || S.betView !== 'wheel') return;
    if (S.phase !== 'betting') return flashMessage('Betting is closed');
    const target = parseWheelTarget(pocket.dataset.pocket);
    placeBetDescriptor({ type: 'straight', target });
  });

  document.querySelectorAll('.wheel-special-bet').forEach((btn) => {
    btn.addEventListener('pointerenter', () => showWheelTargetPreview([0, '00']));
    btn.addEventListener('pointerleave', clearWheelTargetPreview);
    btn.addEventListener('focus', () => showWheelTargetPreview([0, '00']));
    btn.addEventListener('blur', clearWheelTargetPreview);
  });
}

window.placeWheelSpecialBet = function (el) {
  if (S.phase !== 'betting') return flashMessage('Betting is closed');
  let desc;
  try { desc = JSON.parse(el.dataset.bet); } catch (_) { return; }
  placeBetDescriptor(desc);
};

function showWheelTargetPreview(targets) {
  clearWheelTargetPreview();
  const wanted = new Set((targets || []).map(String));
  document.querySelectorAll('.wheel-pocket').forEach((pocket) => {
    pocket.classList.toggle('bet-preview', wanted.has(pocket.dataset.pocket));
  });
}

function clearWheelTargetPreview() {
  document.querySelectorAll('.wheel-pocket.bet-preview').forEach((pocket) => {
    pocket.classList.remove('bet-preview');
  });
}

function parseWheelTarget(value) {
  return value === '00' ? '00' : Number(value);
}

function renderWheelFace() {
  const mount = document.getElementById('wheel');
  if (!mount || mount.dataset.rendered) return;

  const svg = svgEl('svg', {
    id: 'wheel-svg',
    class: 'wheel-svg',
    viewBox: '0 0 240 240',
    role: 'img',
    'aria-label': 'American roulette wheel',
  });

  svg.appendChild(svgEl('circle', {
    class: 'wheel-bowl',
    cx: WHEEL_CENTER,
    cy: WHEEL_CENTER,
    r: 118,
  }));

  const face = svgEl('g', { id: 'wheel-face', class: 'wheel-face' });
  const wheel = wheelFor(S.variant);
  const seg = 360 / wheel.length;
  for (let i = 0; i < wheel.length; i += 1) {
    const pocket = wheel[i];
    const start = i * seg;
    const end = start + seg;
    const mid = start + seg / 2;
    const color = colorOfNum(pocket);
    const group = svgEl('g', {
      class: 'wheel-pocket pocket-' + color,
      'data-pocket': String(pocket),
      role: 'button',
      tabindex: '0',
    });
    group.appendChild(svgEl('path', {
      class: 'wheel-pocket-path',
      d: sectorPath(WHEEL_OUTER_R, WHEEL_INNER_R, start, end),
    }));
    const labelPos = polarPoint(WHEEL_LABEL_R, mid);
    const chipPos = polarPoint(84, mid);
    group.dataset.chipX = chipPos.x.toFixed(2);
    group.dataset.chipY = chipPos.y.toFixed(2);
    const labelRotation = mid > 90 && mid < 270 ? mid + 180 : mid;
    const label = svgEl('text', {
      class: 'wheel-pocket-label',
      x: labelPos.x.toFixed(2),
      y: labelPos.y.toFixed(2),
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      transform: `rotate(${labelRotation} ${labelPos.x.toFixed(2)} ${labelPos.y.toFixed(2)})`,
    });
    label.textContent = String(pocket);
    group.appendChild(label);
    face.appendChild(group);
  }

  svg.appendChild(face);
  svg.appendChild(svgEl('circle', {
    class: 'wheel-ball-track',
    cx: WHEEL_CENTER,
    cy: WHEEL_CENTER,
    r: BALL_TRACK_R,
  }));
  svg.appendChild(svgEl('circle', {
    class: 'wheel-inner',
    cx: WHEEL_CENTER,
    cy: WHEEL_CENTER,
    r: WHEEL_INNER_R - 11,
  }));
  svg.appendChild(svgEl('circle', {
    class: 'wheel-hub',
    cx: WHEEL_CENTER,
    cy: WHEEL_CENTER,
    r: 14,
  }));
  svg.appendChild(svgEl('circle', {
    id: 'wheel-ball',
    class: 'wheel-ball',
    r: 4.8,
  }));

  mount.textContent = '';
  mount.appendChild(svg);
  mount.dataset.rendered = '1';
  setWheelFaceRotation(S.wheelRotation);
  setBallAtAngle(S.ballAngle);
  redrawWheelChipStacks();
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs || {})) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function sectorPath(outerR, innerR, startDeg, endDeg) {
  const a = polarPoint(outerR, startDeg);
  const b = polarPoint(outerR, endDeg);
  const c = polarPoint(innerR, endDeg);
  const d = polarPoint(innerR, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${a.x.toFixed(2)} ${a.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
    `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${d.x.toFixed(2)} ${d.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

function polarPoint(radius, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return {
    x: WHEEL_CENTER + Math.cos(rad) * radius,
    y: WHEEL_CENTER + Math.sin(rad) * radius,
  };
}

function setWheelFaceRotation(deg) {
  S.wheelRotation = deg;
  const face = document.getElementById('wheel-face');
  if (!face) return;
  face.removeAttribute('transform');
  face.style.transformBox = 'view-box';
  face.style.transformOrigin = `${WHEEL_CENTER}px ${WHEEL_CENTER}px`;
  face.style.transform = `rotate(${deg}deg)`;
}

function setBallAtAngle(deg) {
  S.ballAngle = deg;
  const ball = document.getElementById('wheel-ball');
  if (!ball) return;
  const p = polarPoint(BALL_TRACK_R, normalizeDeg(deg));
  ball.setAttribute('cx', p.x.toFixed(2));
  ball.setAttribute('cy', p.y.toFixed(2));
}

function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function cellKeyForBet(b) {
  // Key used for drawing a chip stack on a bet. For simple straight/outside we map
  // directly to a cell. Compound bets use the matching edge/intersection hotspot
  // when it exists, with a straight-cell fallback for precision-rail selections.
  switch (b.type) {
    case 'straight': return 'straight:' + b.numbers[0];
    case 'split':
    case 'street':
    case 'trio':
    case 'corner':
    case 'line':
      return compoundKey(b.type, b.numbers || []);
    case 'column':   return 'column:' + (b.which || b.numbers[0]);
    case 'dozen':    return 'dozen:'  + (b.which || b.numbers[0]);
    case 'red': case 'black': case 'even': case 'odd':
    case 'low': case 'high':
      return b.type + ':';
    default:
      return 'straight:' + b.numbers[0];
  }
}

function redrawChipStacks() {
  // Clear existing stacks
  document.querySelectorAll('.chip-stack').forEach((n) => n.remove());
  document.querySelectorAll('.bet-hotspot.has-chip, .zero-hotspot.has-chip, .wheel-special-bet.has-chip').forEach((n) => n.classList.remove('has-chip'));
  const sums = new Map();
  for (const b of S.myBets) {
    const k = cellKeyForBet(b);
    const prev = sums.get(k) || { amount: 0, win: 0 };
    prev.amount += b.amount;
    prev.win += potentialWinForBet(b);
    sums.set(k, prev);
  }
  for (const [key, sum] of sums) {
    const cell = findCellByKey(key);
    if (!cell) continue;
    const chip = document.createElement('div');
    chip.className = 'chip-stack' + (S.showWinValues ? ' with-win' : '');
    const stake = document.createElement('span');
    stake.className = 'chip-stake';
    stake.textContent = fmtChip(sum.amount);
    chip.appendChild(stake);
    if (S.showWinValues) {
      const win = document.createElement('span');
      win.className = 'chip-win-label';
      win.textContent = '+$' + fmtChip(sum.win);
      chip.appendChild(win);
    }
    cell.appendChild(chip);
    cell.classList.add('has-chip');
  }
  redrawWheelChipStacks();
  renderWallet();
}

function redrawWheelChipStacks() {
  const face = document.getElementById('wheel-face');
  if (!face) return;
  face.querySelectorAll('.wheel-chip').forEach((n) => n.remove());
  const sums = new Map();
  for (const b of S.myBets) {
    if (b.type !== 'straight' || !b.numbers || !b.numbers.length) continue;
    const key = String(b.numbers[0]);
    const prev = sums.get(key) || { amount: 0, win: 0 };
    prev.amount += b.amount;
    prev.win += potentialWinForBet(b);
    sums.set(key, prev);
  }
  for (const [key, sum] of sums) {
    let pocket = null;
    for (const node of face.querySelectorAll('.wheel-pocket')) {
      if (node.dataset.pocket === key) {
        pocket = node;
        break;
      }
    }
    if (!pocket) continue;
    const x = Number(pocket.dataset.chipX);
    const y = Number(pocket.dataset.chipY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const chip = svgEl('g', {
      class: 'wheel-chip',
      transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})`,
    });
    chip.appendChild(svgEl('circle', { r: 8.5 }));
    const label = svgEl('text', {
      class: 'wheel-chip-stake',
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      y: 0.5,
    });
    label.textContent = fmtChip(sum.amount);
    chip.appendChild(label);
    if (S.showWinValues) {
      const win = svgEl('text', {
        class: 'wheel-chip-win',
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        y: 15,
      });
      win.textContent = '+$' + fmtChip(sum.win);
      chip.appendChild(win);
    }
    face.appendChild(chip);
  }
}

function potentialWinForBet(b) {
  const ratio = BET_PAYOUTS[b.type] || 0;
  return (Number(b.amount) || 0) * ratio;
}

function findCellByKey(key) {
  const matches = [];
  for (const hook of document.querySelectorAll('[data-bet-key]')) {
    if (hook.dataset.betKey !== key) continue;
    if (isVisibleBetHook(hook)) return hook;
    matches.push(hook);
  }
  if (matches.length) return matches[0];
  const [type, rest] = key.split(':');
  const cells = document.querySelectorAll('.cell');
  for (const c of cells) {
    if (!c.dataset.bet) continue;
    let d;
    try { d = JSON.parse(c.dataset.bet); } catch (_) { continue; }
    if (d.type !== type) continue;
    if (type === 'straight' && String(d.target) === rest) return c;
    if (type === 'column'  && String(d.which)  === rest) return c;
    if (type === 'dozen'   && String(d.which)  === rest) return c;
    if (['red','black','even','odd','low','high'].includes(type)) return c;
  }
  if (['split', 'street', 'trio', 'corner', 'line'].includes(type)) {
    const first = (rest || '').split('|')[0];
    if (first) return findCellByKey('straight:' + first);
  }
  return null;
}

function isVisibleBetHook(el) {
  return !!(el && el.getClientRects && el.getClientRects().length);
}

function fmtChip(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Inside bets: mobile-safe precision controls for split, row, trio, corner, line.
window.setInsideMode = function (mode) {
  S.insideMode = mode && mode !== 'straight' ? mode : null;
  S.insideSelection = [];
  updateInsideBetUI();
  refreshBoardSelection();
};

window.clearInsideSelection = function () {
  S.insideSelection = [];
  updateInsideBetUI();
  refreshBoardSelection();
};

window.placeInsideBet = function () {
  const spec = INSIDE_BET_SPECS[S.insideMode];
  if (!spec) return;
  if (!isValidInsideSelection(S.insideMode, S.insideSelection)) {
    playSound('error');
    return flashMessage(spec.label + ' targets are not valid');
  }
  placeBetDescriptor({
    type: S.insideMode,
    targets: S.insideSelection.slice(),
  });
  S.insideSelection = [];
  updateInsideBetUI();
  refreshBoardSelection();
};

function toggleInsideTarget(target) {
  const spec = INSIDE_BET_SPECS[S.insideMode];
  if (!spec) return;
  if (!isEligibleInsideTarget(S.insideMode, target)) {
    playSound('error');
    return flashMessage(spec.label + ' uses table numbers only');
  }
  const idx = S.insideSelection.findIndex((n) => sameTarget(n, target));
  if (idx >= 0) {
    S.insideSelection.splice(idx, 1);
  } else {
    if (S.insideSelection.length >= spec.count) S.insideSelection.shift();
    S.insideSelection.push(target);
  }
  updateInsideBetUI();
  refreshBoardSelection();
}

function updateInsideBetUI() {
  const bettingOpen = S.phase === 'betting';
  document.querySelectorAll('.inside-mode-btn').forEach((btn) => {
    const mode = btn.dataset.insideMode;
    btn.classList.toggle('active', mode === (S.insideMode || 'straight'));
    btn.disabled = !bettingOpen;
  });

  const label = document.getElementById('inside-selection-label');
  const clear = document.getElementById('inside-clear');
  const place = document.getElementById('inside-place');
  if (!label || !clear || !place) return;

  const spec = INSIDE_BET_SPECS[S.insideMode];
  if (!spec) {
    label.textContent = 'Straight bets active';
    clear.disabled = true;
    place.disabled = true;
    updateMyAreaHeight();
    return;
  }

  const count = S.insideSelection.length;
  const targets = S.insideSelection.map(formatTarget).join(', ');
  const valid = isValidInsideSelection(S.insideMode, S.insideSelection);
  label.textContent = targets
    ? `${spec.label} ${targets} (${count}/${spec.count})`
    : `${spec.label} ${spec.payout}`;
  if (count === spec.count && !valid) label.textContent = `${spec.label} invalid`;
  clear.disabled = !bettingOpen || count === 0;
  place.disabled = !bettingOpen || !valid;
  updateMyAreaHeight();
}

function refreshBoardSelection() {
  const board = document.getElementById('board');
  if (board) board.classList.toggle('inside-mode', !!S.insideMode);
  document.querySelectorAll('.cell').forEach((cell) => {
    cell.classList.remove('inside-selected', 'inside-eligible');
    if (!cell.dataset.bet) return;
    let desc;
    try { desc = JSON.parse(cell.dataset.bet); } catch (_) { return; }
    if (desc.type !== 'straight') return;
    if (S.insideMode && isEligibleInsideTarget(S.insideMode, desc.target)) {
      cell.classList.add('inside-eligible');
    }
    if (S.insideSelection.some((n) => sameTarget(n, desc.target))) {
      cell.classList.add('inside-selected');
    }
  });
}

function updateMyAreaHeight() {
  window.requestAnimationFrame(() => {
    const el = document.querySelector('.my-area');
    if (!el) return;
    document.documentElement.style.setProperty('--my-area-h', Math.ceil(el.getBoundingClientRect().height) + 'px');
  });
}

function isEligibleInsideTarget(mode, target) {
  if (mode === 'split' || mode === 'trio' || mode === 'corner') {
    return target === 0 || target === '00' || isNumericTarget(target);
  }
  return isNumericTarget(target);
}

function isNumericTarget(n) {
  return Number.isInteger(n) && n >= 1 && n <= 36;
}

function sameTarget(a, b) {
  return String(a) === String(b);
}

function formatTarget(n) {
  return n === '00' ? '00' : String(n);
}

function sortedTargets(targets) {
  return targets.slice().sort((a, b) => targetRank(a) - targetRank(b));
}

function compoundKey(type, targets) {
  return type + ':' + sortedTargets(targets || []).map(formatTarget).join('|');
}

function targetRank(n) {
  if (n === 0) return 0;
  if (n === '00') return 1;
  return n + 1;
}

function rowOf(n) {
  return Math.ceil(n / 3);
}

function colOf(n) {
  return ((n - 1) % 3) + 1;
}

function streetForRow(row) {
  const start = ((row - 1) * 3) + 1;
  return [start, start + 1, start + 2];
}

function sameTargetSet(a, b) {
  return a.length === b.length && a.every((x) => b.some((y) => sameTarget(x, y)));
}

function isValidInsideSelection(mode, targets) {
  const spec = INSIDE_BET_SPECS[mode];
  if (!spec || targets.length !== spec.count) return false;
  const ns = sortedTargets(targets);
  if (new Set(ns.map(formatTarget)).size !== ns.length) return false;

  if (mode === 'split') return isValidSplitSelection(ns);
  if (mode === 'trio') return isValidTrioSelection(ns);
  if (mode === 'corner') return isValidCornerSelection(ns);
  if (!ns.every(isNumericTarget)) return false;
  if (mode === 'street') return sameTargetSet(ns, streetForRow(rowOf(ns[0])));
  if (mode === 'line') return isValidLineSelection(ns);
  return false;
}

function isValidSplitSelection(ns) {
  const zeroSplits = [[0, '00'], [0, 1], ['00', 3]];
  if (ns.some((n) => n === 0 || n === '00')) {
    return zeroSplits.some((pair) => sameTargetSet(ns, pair));
  }
  if (!ns.every(isNumericTarget)) return false;
  const [a, b] = ns;
  const sameRow = rowOf(a) === rowOf(b) && Math.abs(colOf(a) - colOf(b)) === 1;
  const sameCol = colOf(a) === colOf(b) && Math.abs(rowOf(a) - rowOf(b)) === 1;
  return sameRow || sameCol;
}

function isValidTrioSelection(ns) {
  const zeroTrios = [
    [0, '00', 2],
  ];
  return zeroTrios.some((set) => sameTargetSet(ns, set));
}

function isValidCornerSelection(ns) {
  if (ns.some((n) => n === 0 || n === '00')) {
    return false;
  }
  if (!ns.every(isNumericTarget)) return false;
  const rows = [...new Set(ns.map(rowOf))].sort((a, b) => a - b);
  const cols = [...new Set(ns.map(colOf))].sort((a, b) => a - b);
  if (rows.length !== 2 || cols.length !== 2) return false;
  if (rows[1] - rows[0] !== 1 || cols[1] - cols[0] !== 1) return false;
  const expected = [];
  for (const row of rows) {
    for (const col of cols) expected.push(((row - 1) * 3) + col);
  }
  return sameTargetSet(ns, expected);
}

function isValidLineSelection(ns) {
  const rows = [...new Set(ns.map(rowOf))].sort((a, b) => a - b);
  const cols = [...new Set(ns.map(colOf))].sort((a, b) => a - b);
  if (rows.length !== 2 || rows[1] - rows[0] !== 1) return false;
  if (cols.length !== 3 || cols[0] !== 1 || cols[1] !== 2 || cols[2] !== 3) return false;
  return sameTargetSet(ns, [...streetForRow(rows[0]), ...streetForRow(rows[1])]);
}

// ── Chips row ─────────────────────────────────────────────
function renderChips() {
  const row = document.getElementById('chip-row');
  row.innerHTML = '';
  const chipCap = Number(S.cfg?.maxChip || S.cfg?.maxBet || 500);
  let denoms = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000]
    .filter((value) => value <= chipCap);
  if (!denoms.length) denoms = [100];
  S.chipDenoms = denoms;
  if (!denoms.includes(S.selectedChip)) S.selectedChip = denoms[0];

  for (const d of denoms) {
    const btn = document.createElement('button');
    btn.className = 'chip c-' + d + (d === S.selectedChip ? ' selected' : '');
    btn.textContent = '$' + fmtChip(d);
    btn.onclick = () => {
      S.selectedChip = d;
      playSound('button');
      document.querySelectorAll('.chip').forEach((c) =>
        c.classList.toggle('selected', c.textContent === '$' + fmtChip(d)));
      document.getElementById('selected-chip-label').textContent = 'CHIP: $' + fmtChip(d);
    };
    row.appendChild(btn);
  }
  document.getElementById('selected-chip-label').textContent = 'CHIP: $' + fmtChip(S.selectedChip);
  updateInsideBetUI();
  updateMyAreaHeight();
}

// ── Wallet / history ──────────────────────────────────────
function renderWallet() {
  const bet = currentBetStake();
  document.getElementById('my-name').textContent = S.username;
  document.getElementById('my-wallet').textContent = 'Balance $' + displayedBalance().toLocaleString();
  document.getElementById('my-bet').textContent = 'Bet $' + bet.toLocaleString();
}
function renderHistory() {
  const strip = document.getElementById('history-strip');
  strip.innerHTML = '';
  for (const h of S.history.slice(0, 14)) {
    const chip = document.createElement('div');
    chip.className = 'history-chip ' + h.color;
    chip.textContent = String(h.pocket);
    strip.appendChild(chip);
  }
}

// ── Wheel animation ───────────────────────────────────────
function gameMemoryKey() {
  const user = S.userId || S.username || 'guest';
  return 'vurglife_roulette_last100_' + String(user);
}

function loadGameMemory() {
  try {
    const raw = localStorage.getItem(gameMemoryKey());
    const parsed = raw ? JSON.parse(raw) : [];
    S.gameMemory = Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch (_) {
    S.gameMemory = [];
  }
}

function saveGameMemory() {
  try {
    localStorage.setItem(gameMemoryKey(), JSON.stringify(S.gameMemory.slice(0, 100)));
  } catch (_) {}
}

function rememberGameResult(d, me) {
  const net = Number(me && me.net) || 0;
  const stake = Number(me && me.totalStake) || 0;
  const outcome = net > 0 ? 'Win'
    : net < 0 ? 'Lose'
    : stake > 0 ? 'Push'
    : 'No Bet';
  const pocket = d.winning;
  S.gameMemory.unshift({
    round: d.round || S.round,
    pocket,
    color: d.color || colorOfNum(pocket),
    outcome,
    net,
    stake,
    wallet: Number(me && me.wallet) || S.wallet,
    at: Date.now(),
  });
  if (S.gameMemory.length > 100) S.gameMemory.length = 100;
  saveGameMemory();
  renderGameMemory();
}

window.showGameMemory = function () {
  renderGameMemory();
  const overlay = document.getElementById('memory-overlay');
  if (overlay) overlay.style.display = 'flex';
  const menu = document.getElementById('game-menu');
  if (menu) menu.style.display = 'none';
};

function renderGameMemory() {
  const body = document.getElementById('memory-body');
  if (!body) return;
  const wins = S.gameMemory.filter((h) => h.outcome === 'Win').length;
  const losses = S.gameMemory.filter((h) => h.outcome === 'Lose').length;
  const pushes = S.gameMemory.filter((h) => h.outcome === 'Push').length;
  const net = S.gameMemory.reduce((sum, h) => sum + (Number(h.net) || 0), 0);
  if (!S.gameMemory.length) {
    body.innerHTML = '<p class="payouts-note">No Roulette results recorded yet.</p>';
    return;
  }
  body.innerHTML = `
    <div class="memory-summary">
      <span>Wins <b>${wins}</b></span>
      <span>Losses <b>${losses}</b></span>
      <span>Push <b>${pushes}</b></span>
      <span>Net <b class="${net >= 0 ? 'memory-win' : 'memory-lose'}">${net >= 0 ? '+' : '-'}$${Math.abs(net).toLocaleString()}</b></span>
    </div>
    <div class="memory-list">
      ${S.gameMemory.map(memoryRowHtml).join('')}
    </div>`;
}

function memoryRowHtml(row) {
  const color = row.color || colorOfNum(row.pocket);
  const net = Number(row.net) || 0;
  const netLabel = net === 0 ? '$0' : `${net > 0 ? '+' : '-'}$${Math.abs(net).toLocaleString()}`;
  const time = row.at ? new Date(row.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const outcomeClass = row.outcome === 'Win' ? 'memory-win'
    : row.outcome === 'Lose' ? 'memory-lose'
    : 'memory-push';
  return `
    <div class="memory-row">
      <span class="memory-pocket ${color}">${row.pocket}</span>
      <span class="memory-outcome ${outcomeClass}">${row.outcome}</span>
      <span class="memory-net ${outcomeClass}">${netLabel}</span>
      <span class="memory-meta">Round ${row.round || '--'}${time ? ' - ' + time : ''}</span>
    </div>`;
}

function wheelFor(variant) {
  return AMERICAN_WHEEL;
}

function animateWheel(winning) {
  renderWheelFace();
  const wheel = wheelFor(S.variant);
  const idx = wheel.findIndex((p) => String(p) === String(winning));
  if (idx < 0) return;
  const segAngle = 360 / wheel.length;
  const winningAngle = idx * segAngle + segAngle / 2;
  const startWheel = S.wheelRotation || 0;
  const targetWheelMod = normalizeDeg(-winningAngle);
  const wheelDelta = normalizeDeg(targetWheelMod - normalizeDeg(startWheel));
  const endWheel = startWheel + 360 * 5 + wheelDelta;
  const startBall = S.ballAngle || 0;
  const ballBackToTop = normalizeDeg(startBall);
  const endBall = startBall - 360 * 8 - ballBackToTop;
  const started = performance.now();
  const duration = Math.max(3600, (PHASE_SECONDS.spinning - 0.45) * 1000);

  setWheelFocus(true);
  showWinningNumber(null, true);
  if (S.wheelAnimId) cancelAnimationFrame(S.wheelAnimId);

  const frame = (now) => {
    const t = Math.min(1, (now - started) / duration);
    const eased = easeOutCubic(t);
    setWheelFaceRotation(startWheel + (endWheel - startWheel) * eased);
    setBallAtAngle(startBall + (endBall - startBall) * eased);
    if (t < 1) {
      S.wheelAnimId = requestAnimationFrame(frame);
      return;
    }
    S.wheelAnimId = null;
    setWheelFaceRotation(endWheel);
    setBallAtAngle(0);
    showWinningNumber(winning, true);
    highlightWinningPocket(winning);
  };
  S.wheelAnimId = requestAnimationFrame(frame);
}

function highlightWinningCell(winning) {
  document.querySelectorAll('.cell.hit').forEach((c) => c.classList.remove('hit'));
  const cell = findCellByKey('straight:' + winning);
  if (cell) cell.classList.add('hit');
  setTimeout(() => {
    if (cell) cell.classList.remove('hit');
  }, 2800);
}

function highlightWinningPocket(winning) {
  document.querySelectorAll('.wheel-pocket.hit').forEach((p) => p.classList.remove('hit'));
  const key = String(winning);
  let target = null;
  document.querySelectorAll('.wheel-pocket').forEach((pocket) => {
    if (pocket.dataset.pocket === key) target = pocket;
  });
  if (!target) return;
  target.classList.add('hit');
  setTimeout(() => target.classList.remove('hit'), 3000);
}

function showWinningNumber(winning, big) {
  const display = document.getElementById('winning-display');
  const num = document.getElementById('winning-num');
  if (!display || !num) return;
  display.classList.toggle('show-win', !!big);
  if (winning === null) {
    num.textContent = '...';
    num.style.color = '#ffe9a8';
    return;
  }
  if (winning === undefined) {
    num.textContent = '--';
    num.style.color = '#f0fff0';
    return;
  }
  num.textContent = String(winning);
  const color = colorOfNum(winning);
  num.style.color = color === 'red' ? '#ff8585'
    : color === 'black' ? '#fff'
    : '#9aeeaa';
}

function setWheelFocus(active) {
  const game = document.getElementById('screen-game');
  if (game) game.classList.toggle('wheel-focus', !!active);
}

function clearWheelFocus() {
  cancelWheelResetTimer();
  stopSpinSound();
  if (S.wheelAnimId) {
    cancelAnimationFrame(S.wheelAnimId);
    S.wheelAnimId = null;
  }
  setWheelFocus(false);
  setBallAtAngle(0);
  if (S.lastWinning !== null && S.lastWinning !== undefined) {
    showWinningNumber(S.lastWinning, false);
  } else {
    showWinningNumber(undefined, false);
  }
}

function scheduleWheelRoundReset(phaseEnd) {
  cancelWheelResetTimer();
  const delay = Math.max(1100, Math.min(6200, (Number(phaseEnd) || Date.now()) - Date.now() + 120));
  S.wheelResetTimer = setTimeout(() => {
    S.wheelResetTimer = null;
    setWheelFocus(false);
    setBallAtAngle(0);
    showWinningNumber(S.lastWinning !== null && S.lastWinning !== undefined ? S.lastWinning : undefined, false);
  }, delay);
}

function cancelWheelResetTimer() {
  if (!S.wheelResetTimer) return;
  clearTimeout(S.wheelResetTimer);
  S.wheelResetTimer = null;
}

function showResult(me) {
  const banner = document.getElementById('result-banner');
  banner.className = 'result-banner ' + (me.net > 0 ? 'win' : (me.net < 0 ? 'lose' : 'push'));
  banner.style.display = 'block';
  if (me.net > 0) {
    playSound('win');
    banner.textContent = 'Win $' + me.net.toLocaleString();
    animateWinChipFlow(me);
  } else if (me.net < 0) {
    playSound('lose');
    banner.textContent = 'Lose';
  } else {
    playSound('push');
    banner.textContent = me.totalStake === 0 ? 'No bet this round' : 'Push';
  }
  setTimeout(() => { banner.style.display = 'none'; }, 4500);
}

let announcementTimer = null;

function clearAnnouncementTimer() {
  if (!announcementTimer) return;
  clearTimeout(announcementTimer);
  announcementTimer = null;
}

function showTextAnnouncement(text, duration) {
  const el = document.getElementById('big-announcement');
  if (!el) return;
  clearAnnouncementTimer();
  el.className = 'big-announce text-announce';
  el.replaceChildren();
  const card = document.createElement('div');
  card.className = 'announce-card';
  card.textContent = text || '';
  el.appendChild(card);
  el.style.display = 'flex';
  void el.offsetWidth;
  announcementTimer = setTimeout(() => {
    el.style.display = 'none';
    announcementTimer = null;
  }, duration || 3500);
}

function showRoundAnnouncement(winning, me) {
  const el = document.getElementById('big-announcement');
  if (!el) return;

  const result = getPlayerResult(me);
  const color = colorOfNum(winning);
  clearAnnouncementTimer();
  el.className = 'big-announce round-result ' + color + ' ' + result.kind;
  el.replaceChildren();

  const card = document.createElement('div');
  card.className = 'announce-card';

  const kicker = document.createElement('div');
  kicker.className = 'announce-kicker';
  kicker.textContent = 'Winning Number';

  const number = document.createElement('div');
  number.className = 'announce-number';
  number.textContent = String(winning);

  const outcome = document.createElement('div');
  outcome.className = 'announce-outcome';
  outcome.textContent = result.label;
  card.append(kicker, number, outcome);

  if (result.amount) {
    const amount = document.createElement('div');
    amount.className = 'announce-amount';
    amount.textContent = result.amount;
    card.appendChild(amount);
  }

  el.appendChild(card);
  el.style.display = 'flex';
  void el.offsetWidth;
  announcementTimer = setTimeout(() => {
    el.style.display = 'none';
    announcementTimer = null;
  }, result.kind === 'win' ? 5600 : 4200);
}

function getPlayerResult(me) {
  const net = Number(me && me.net) || 0;
  const stake = Number(me && me.totalStake) || 0;
  if (net > 0) {
    return {
      kind: 'win',
      label: 'You Win',
      amount: '+$' + net.toLocaleString(),
    };
  }
  if (net < 0) return { kind: 'lose', label: 'Lose', amount: '' };
  if (!me || !stake) return { kind: 'neutral', label: 'No Bet', amount: '' };
  return { kind: 'push', label: 'Push', amount: '' };
}

function animateWinChipFlow(me) {
  if (!me || !(me.net > 0)) return;

  const source = document.querySelector('#screen-game.wheel-focus .wheel-wrap')
    || (S.betView === 'wheel' ? document.getElementById('wheel-wrap') : document.querySelector('.felt'))
    || document.getElementById('wheel-wrap')
    || document.body;
  const target = document.getElementById('my-wallet') || document.querySelector('.my-area') || document.body;
  const from = rectCenter(source);
  const to = rectCenter(target);
  const count = Math.max(5, Math.min(12, Math.ceil(Math.log10(Math.max(10, me.net))) + 4));

  for (let i = 0; i < count; i += 1) {
    const chip = document.createElement('div');
    chip.className = 'win-flow-chip';
    chip.setAttribute('aria-hidden', 'true');
    chip.textContent = '$';
    document.body.appendChild(chip);

    const spread = count <= 1 ? 0 : (i - (count - 1) / 2);
    const startX = from.x + spread * 5;
    const startY = from.y + ((i % 2) ? 8 : -6);
    const midX = from.x + (to.x - from.x) * 0.46 + spread * 14;
    const midY = Math.min(from.y, to.y) - 62 - (i % 3) * 12;
    const endX = to.x + spread * 3;
    const endY = to.y + ((i % 2) ? 3 : -3);

    const animation = chip.animate([
      {
        left: startX + 'px',
        top: startY + 'px',
        opacity: 0,
        transform: 'translate(-50%, -50%) scale(0.62)',
      },
      {
        left: startX + 'px',
        top: startY + 'px',
        opacity: 1,
        transform: 'translate(-50%, -50%) scale(0.92)',
        offset: 0.12,
      },
      {
        left: midX + 'px',
        top: midY + 'px',
        opacity: 1,
        transform: 'translate(-50%, -50%) scale(1)',
        offset: 0.58,
      },
      {
        left: endX + 'px',
        top: endY + 'px',
        opacity: 0,
        transform: 'translate(-50%, -50%) scale(0.42)',
      },
    ], {
      duration: 850 + i * 35,
      delay: i * 55,
      easing: 'cubic-bezier(0.16, 0.84, 0.28, 1)',
      fill: 'forwards',
    });
    animation.onfinish = () => chip.remove();
    animation.oncancel = () => chip.remove();
  }
  pulseWalletCredit();
}

function rectCenter(el) {
  const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  if (!r || (!r.width && !r.height)) {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pulseWalletCredit() {
  const wallet = document.getElementById('my-wallet');
  if (!wallet) return;
  wallet.classList.remove('wallet-credit-pulse');
  void wallet.offsetWidth;
  wallet.classList.add('wallet-credit-pulse');
  setTimeout(() => wallet.classList.remove('wallet-credit-pulse'), 1200);
}

// ── Menu / actions ────────────────────────────────────────
window.toggleGameMenu = function () {
  const m = document.getElementById('game-menu');
  m.style.display = m.style.display === 'none' ? 'flex' : 'none';
};
window.undoBet    = function () { playSound('button'); send({ type: 'undoBet' }); };
window.clearBets  = function () { playSound('button'); send({ type: 'clearBets' }); };
window.replenishWallet = function () {
  send({ type: 'replenishWallet' });
  document.getElementById('game-menu').style.display = 'none';
};
window.exitGame = async function () {
  // Return remaining wallet to platform bank, then close socket and redirect.
  const ok = await settleWallet('player-exit');
  if (ok) window._intentionalExit = true;
  sendExit();
  if (PLATFORM_HOSTED) window.location.href = '/';
  else showScreen('screen-login');
};
window.showPayouts = function () {
  const body = document.getElementById('payouts-body');
  const cfg  = S.cfg;
  const variantLabel = 'American (0 &amp; 00)';
  const tierNote = cfg?.level
    ? `<p class="payouts-note"><strong>${cfg.level} access:</strong> max chip $${(cfg.maxChip || 0).toLocaleString()}, max direct number bet $${(cfg.maxDirectBet || 0).toLocaleString()}.</p>`
    : '';

  body.innerHTML = `
    <p class="payouts-note"><strong>Variant:</strong> ${variantLabel} — house edge 5.26%</p>
    ${tierNote}
    <table class="payouts-table">
      <tr><th>BET</th><th>PAYOUT</th></tr>
      <tr><td>Straight Up (1 number)</td><td>35:1</td></tr>
      <tr><td>Split (2 numbers)</td><td>17:1</td></tr>
      <tr><td>Row (3 numbers)</td><td>11:1</td></tr>
      <tr><td>Trio near 0/00 (3 numbers)</td><td>11:1</td></tr>
      <tr><td>Corner (4 numbers)</td><td>8:1</td></tr>
      <tr><td>Line (6 numbers)</td><td>5:1</td></tr>
      <tr><td>Column / Dozen</td><td>2:1</td></tr>
      <tr><td>Red / Black / Odd / Even / 1-18 / 19-36</td><td>1:1</td></tr>
    </table>
    <p class="payouts-note"><strong>Zero-area bets:</strong> click the zero-area seams for 0-00, 0-1, 00-3, and 0-00-2.</p>
    <p class="payouts-note"><strong>Partner odds:</strong> after a winning number, listed partner pockets are weighted for the next spin. First tier is ${PARTNER_ODDS_RATES.first} each, second tier ${PARTNER_ODDS_RATES.second} each, third tier ${PARTNER_ODDS_RATES.third} each, and fourth tier ${PARTNER_ODDS_RATES.fourth} each. Unlisted pockets share the remaining chance evenly.</p>
    <div class="partner-chart-wrap">
      <table class="partner-chart">
        <tr><th>Number</th><th>1st</th><th>2nd</th><th>3rd</th><th>4th</th></tr>
        ${partnerOddsRowsHtml()}
      </table>
    </div>
    <p class="payouts-note"><strong>Table limits:</strong>
       min chip $${(cfg?.minBet || 0).toLocaleString()},
       max chip $${(cfg?.maxChip || cfg?.maxBet || 0).toLocaleString()},
       max direct number bet $${(cfg?.maxDirectBet || 0).toLocaleString()}.</p>
  `;
  document.getElementById('payouts-overlay').style.display = 'flex';
  document.getElementById('game-menu').style.display = 'none';
};

function partnerOddsRowsHtml() {
  return PARTNER_ODDS_CHART.map((row) => `
    <tr>
      <td>${row[0]}</td>
      <td>${row[1] || '-'}</td>
      <td>${row[2] || '-'}</td>
      <td>${row[3] || '-'}</td>
      <td>${row[4] || '-'}</td>
    </tr>
  `).join('');
}

// ── Small UX helpers ──────────────────────────────────────
function flashMessage(txt) {
  const el = document.getElementById('table-message');
  const prev = el.textContent;
  el.textContent = txt;
  setTimeout(() => { el.textContent = prev; }, 1600);
}

// ── BOOT ──────────────────────────────────────────────────
(function boot() {
  readHandoff();
  S.variant = 'american';
  // Update lobby banner with any incoming handoff details.
  document.getElementById('lci-table').textContent = 'Shared';
  if (S.accessLevel) document.getElementById('lci-minbet').textContent = S.accessLevel;
  else if (S.tableMinBet) document.getElementById('lci-minbet').textContent = '$' + S.tableMinBet.toLocaleString();
  if (S.wallet)      document.getElementById('lci-wallet').textContent = '$' + S.wallet.toLocaleString();

  // If the handoff provided everything needed, jump straight to the mode picker.
  if (S.sessionId) {
    // Already have a session — go straight to the game (pre-wired).
    connectWS();
  } else if (S.autoEnter) {
    document.getElementById('login-status').textContent = 'Opening Roulette table...';
    showScreen('screen-login');
    enterTable();
  } else {
    // Mark the active American table type and preselected mode from URL if any
    document.querySelectorAll('.variant-card').forEach((c) =>
      c.classList.toggle('selected', c.dataset.variant === S.variant));
    document.querySelectorAll('.mode-card').forEach((c) =>
      c.classList.toggle('selected', c.dataset.mode === S.mode));
    refreshEnterButton();
    showScreen('screen-mode');
  }
})();
