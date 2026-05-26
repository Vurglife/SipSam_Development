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
  straight: 35, split: 17, street: 11, corner: 8, line: 5,
  basket: 6, column: 2, dozen: 2,
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
  wallet:     0,
  walletSize: 0,               // default wallet draw (for replenish cap)

  selectedChip: 100,
  chipDenoms:   [100, 500, 1000, 5000, 10000],

  cfg:       null,
  phase:     'waiting',
  round:     0,
  phaseEnd:  0,
  history:   [],
  lastWinning: null,
  ws:        null,
  authToken: '',
  autoEnter: false,

  // UI helpers
  timerInt:  null,
  tableHooks: {}, // cellKey → DOM element for chip-stack update
  myBets:    [],  // mirror of server-side bets (for optimistic chip draw)
  insideMode: null,
  insideSelection: [],
  betView: 'table',
  wheelRotation: 0,
  ballAngle: 0,
  wheelAnimId: null,
};

const INSIDE_BET_SPECS = {
  split:  { label: 'Split',  count: 2, payout: '17:1' },
  street: { label: 'Street', count: 3, payout: '11:1' },
  corner: { label: 'Corner', count: 4, payout: '8:1' },
  line:   { label: 'Line',   count: 6, payout: '5:1' },
};

// ── URL params + sessionStorage handoff ────────────────────
function readHandoff() {
  const p = new URLSearchParams(location.search);
  const urlVariant = p.get('variant');
  const urlMinBet  = p.get('minBet') || p.get('tableMinBet');
  const urlMode    = p.get('mode');
  const urlUser    = p.get('username') || p.get('user');
  const urlUid     = p.get('userId');
  const urlWallet  = p.get('wallet');

  if (urlVariant === 'american') S.variant = 'american';
  if (urlMinBet)   S.tableMinBet = Number(urlMinBet);
  if (urlMode)     S.mode = urlMode;
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
      if (!S.tableMinBet) S.tableMinBet = Number(t.minBet);
      if (!S.wallet)      S.wallet = Number(t.wallet || t.walletSize || 0);
    }
  } catch (_) {}
}

// ── Screen helpers ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

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
    S.wallet = me.wallet;
    S.myBets = me.bets.slice();
  }

  renderBoard();      // ensures the variant-correct board is drawn
  renderWheelFace();
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
  animateWheel(d.winning);
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
  renderHistory();
  highlightWinningCell(d.winning);
  if (me) {
    S.wallet = me.wallet;
    showResult(me);
  }
  renderWallet();
  showWinningNumber(d.winning, true);
  highlightWinningPocket(d.winning);
  refreshPhaseUI();
}

function onBigAnnouncement(d) {
  const el = document.getElementById('big-announcement');
  el.textContent = d.text;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, d.duration || 3500);
}

function onChat(d) {
  // Placeholder hook — can flash a small toast. Deferred for now.
}

function onErr(d) {
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
  document.querySelectorAll('.wheel-pocket').forEach((pocket) => {
    pocket.classList.toggle('betting-open', bettingOpen && S.betView === 'wheel');
    pocket.classList.toggle('betting-closed', !bettingOpen || S.betView !== 'wheel');
  });
  document.getElementById('btn-undo').disabled  = !bettingOpen;
  document.getElementById('btn-clear').disabled = !bettingOpen;
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
  const basket = document.getElementById('basket-row');
  if (S.variant === 'american') {
    dbl.style.display = '';
    basket.style.display = '';
  } else {
    dbl.style.display = 'none';
    basket.style.display = 'none';
  }
  refreshBoardSelection();
}

function attachBoardHandlers() {
  const board = document.getElementById('board');
  if (board.dataset.handlersAttached) return;
  board.dataset.handlersAttached = '1';
  board.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !cell.dataset.bet) return;
    if (S.phase !== 'betting') return flashMessage('Betting is closed');
    let desc;
    try { desc = JSON.parse(cell.dataset.bet); } catch (_) { return; }
    if (S.insideMode && desc.type === 'straight') {
      toggleInsideTarget(desc.target);
      return;
    }
    desc.amount = S.selectedChip;
    send({ type: 'placeBet', bet: desc });
  });
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
    send({
      type: 'placeBet',
      bet: { type: 'straight', target, amount: S.selectedChip },
    });
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
  if (face) face.setAttribute('transform', `rotate(${deg} ${WHEEL_CENTER} ${WHEEL_CENTER})`);
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
  // directly to a cell. For compound (split/street/corner/line) a chip stack lives
  // on the first selected straight cell for a compact mobile table.
  switch (b.type) {
    case 'straight': return 'straight:' + b.numbers[0];
    case 'column':   return 'column:' + (b.which || b.numbers[0]);
    case 'dozen':    return 'dozen:'  + (b.which || b.numbers[0]);
    case 'red': case 'black': case 'even': case 'odd':
    case 'low': case 'high':
    case 'basket':
      return b.type + ':';
    default:
      return 'straight:' + b.numbers[0];
  }
}

function redrawChipStacks() {
  // Clear existing stacks
  document.querySelectorAll('.chip-stack').forEach((n) => n.remove());
  const sums = new Map();
  for (const b of S.myBets) {
    const k = cellKeyForBet(b);
    sums.set(k, (sums.get(k) || 0) + b.amount);
  }
  for (const [key, total] of sums) {
    const cell = findCellByKey(key);
    if (!cell) continue;
    const chip = document.createElement('div');
    chip.className = 'chip-stack';
    chip.textContent = fmtChip(total);
    cell.appendChild(chip);
  }
  redrawWheelChipStacks();
  // Staked total
  const staked = S.myBets.reduce((s, b) => s + b.amount, 0);
  document.getElementById('my-staked').textContent = 'Staked $' + staked.toLocaleString();
}

function redrawWheelChipStacks() {
  const face = document.getElementById('wheel-face');
  if (!face) return;
  face.querySelectorAll('.wheel-chip').forEach((n) => n.remove());
  const sums = new Map();
  for (const b of S.myBets) {
    if (b.type !== 'straight' || !b.numbers || !b.numbers.length) continue;
    const key = String(b.numbers[0]);
    sums.set(key, (sums.get(key) || 0) + b.amount);
  }
  for (const [key, total] of sums) {
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
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      y: 0.5,
    });
    label.textContent = fmtChip(total);
    chip.appendChild(label);
    face.appendChild(chip);
  }
}

function findCellByKey(key) {
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
    if (['red','black','even','odd','low','high','basket'].includes(type)) return c;
  }
  return null;
}

function fmtChip(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Inside bets: mobile-safe precision controls for split, street, corner, line.
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
    return flashMessage(spec.label + ' targets are not valid');
  }
  send({
    type: 'placeBet',
    bet: {
      type: S.insideMode,
      targets: S.insideSelection.slice(),
      amount: S.selectedChip,
    },
  });
  S.insideSelection = [];
  updateInsideBetUI();
  refreshBoardSelection();
};

function toggleInsideTarget(target) {
  const spec = INSIDE_BET_SPECS[S.insideMode];
  if (!spec) return;
  if (!isEligibleInsideTarget(S.insideMode, target)) {
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
  if (mode === 'split') return target === 0 || target === '00' || isNumericTarget(target);
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
  if (!ns.every(isNumericTarget)) return false;
  if (mode === 'street') return sameTargetSet(ns, streetForRow(rowOf(ns[0])));
  if (mode === 'corner') return isValidCornerSelection(ns);
  if (mode === 'line') return isValidLineSelection(ns);
  return false;
}

function isValidSplitSelection(ns) {
  const zeroSplits = [[0, '00'], [0, 1], [0, 2], ['00', 2], ['00', 3]];
  if (ns.some((n) => n === 0 || n === '00')) {
    return zeroSplits.some((pair) => sameTargetSet(ns, pair));
  }
  if (!ns.every(isNumericTarget)) return false;
  const [a, b] = ns;
  const sameRow = rowOf(a) === rowOf(b) && Math.abs(colOf(a) - colOf(b)) === 1;
  const sameCol = colOf(a) === colOf(b) && Math.abs(rowOf(a) - rowOf(b)) === 1;
  return sameRow || sameCol;
}

function isValidCornerSelection(ns) {
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
  // Pick chip denominations appropriate for this tier.
  const min = S.tableMinBet || 100;
  let denoms;
  if (min >= 50000) denoms = [50000, 100000, 250000];
  else if (min >= 10000) denoms = [10000, 25000, 50000, 100000];
  else if (min >= 5000)  denoms = [5000, 10000, 25000, 50000];
  else if (min >= 1000)  denoms = [1000, 5000, 10000, 25000];
  else                   denoms = [100, 500, 1000, 5000, 10000];
  S.chipDenoms = denoms;
  S.selectedChip = denoms[0];

  for (const d of denoms) {
    const btn = document.createElement('button');
    btn.className = 'chip c-' + d + (d === S.selectedChip ? ' selected' : '');
    btn.textContent = '$' + fmtChip(d);
    btn.onclick = () => {
      S.selectedChip = d;
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
  document.getElementById('my-name').textContent = S.username;
  document.getElementById('my-wallet').textContent = '$' + (S.wallet || 0).toLocaleString();
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
  setWheelFocus(false);
  if (S.lastWinning !== null && S.lastWinning !== undefined) {
    showWinningNumber(S.lastWinning, false);
  } else {
    showWinningNumber(undefined, false);
  }
}

function showResult(me) {
  const banner = document.getElementById('result-banner');
  banner.className = 'result-banner ' + (me.net > 0 ? 'win' : (me.net < 0 ? 'lose' : 'push'));
  banner.style.display = 'block';
  if (me.net > 0) {
    banner.textContent = 'Won $' + me.net.toLocaleString() + ' (total $' + me.totalPayout.toLocaleString() + ')';
    animateWinChipFlow(me);
  } else if (me.net < 0) {
    banner.textContent = 'Lost $' + Math.abs(me.net).toLocaleString();
  } else {
    banner.textContent = me.totalStake === 0 ? 'No bet this round' : 'Push';
  }
  setTimeout(() => { banner.style.display = 'none'; }, 4500);
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
window.undoBet    = function () { send({ type: 'undoBet' }); };
window.clearBets  = function () { send({ type: 'clearBets' }); };
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
  const vipNote = cfg && cfg.label === 'vip'
    ? '<p class="payouts-note"><strong>VIP table.</strong> Higher limits, standard payouts.</p>'
    : '';
  const basketNote = '<p class="payouts-note"><strong>Basket bet</strong> (0-00-1-2-3) pays 6:1 and is available only on the American board.</p>';

  body.innerHTML = `
    <p class="payouts-note"><strong>Variant:</strong> ${variantLabel} — house edge 5.26%</p>
    ${vipNote}
    <table class="payouts-table">
      <tr><th>BET</th><th>PAYOUT</th></tr>
      <tr><td>Straight Up (1 number)</td><td>35:1</td></tr>
      <tr><td>Split (2 numbers)</td><td>17:1</td></tr>
      <tr><td>Street (3 numbers)</td><td>11:1</td></tr>
      <tr><td>Corner (4 numbers)</td><td>8:1</td></tr>
      <tr><td>Line (6 numbers)</td><td>5:1</td></tr>
      <tr><td>Basket (0-00-1-2-3)</td><td>6:1</td></tr>
      <tr><td>Column / Dozen</td><td>2:1</td></tr>
      <tr><td>Red / Black / Odd / Even / 1-18 / 19-36</td><td>1:1</td></tr>
    </table>
    ${basketNote}
    <p class="payouts-note"><strong>Table limits:</strong>
       min $${(cfg?.minBet || 0).toLocaleString()},
       max $${(cfg?.maxBet || 0).toLocaleString()} per bet.</p>
  `;
  document.getElementById('payouts-overlay').style.display = 'flex';
  document.getElementById('game-menu').style.display = 'none';
};

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
  if (S.tableMinBet) document.getElementById('lci-minbet').textContent = '$' + S.tableMinBet.toLocaleString();
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
