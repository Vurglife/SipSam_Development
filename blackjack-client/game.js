'use strict';
/* ============================================================
   VurgLife Blackjack — game.js
   Rebuilt 2026-05-11 from scratch using:
     - Standard Blackjack rules (universal)
     - SipSam structural patterns (sendMsg, dispatcher, showScreen, igm)
     - BlackjackRoom.js WebSocket protocol
   ============================================================ */

// ─────────────────────────────────────────────────────
// GLOBALS
// ─────────────────────────────────────────────────────
const BJ_WS_URL = `ws://${location.hostname}:3002`;

let BJ_TABLE = {
  minBet: 100, maxBet: 100, walletSize: 2500,
  tieBet: 100, tieBetPayout: 2000, blackjackPayout: null,
  label: 'standard',
  displayLabel: 'Standard'
};

let ws            = null;
let myUsername    = '';
let mySessionId   = null;
let mySeatIndex   = null;
let myChips       = 0;
let pendingBet    = 0;
let lastPhase     = '';
let lastState     = null;
let igmToken      = null;
let igmBank       = 0;
let igmWallet     = 0;

let _isSinglePlayer  = false;
let _isInvitedJoiner = false;
let _isMultiplayerHost = false;
let _pendingRoomId   = null;
let _multiRoomId     = null;
let _multiWaitTimer  = null;
let _multiWaitSecs   = 300;
let _multiInviteFriends = [];

let _bettingHandled  = false;
let _betPlaced       = false;
let _tieBetWantedThisRound = false;

let _tieDecision     = null;    // 'yes' | 'no' | null - per-round Tie Bet choice
let _tieFrozen       = false;   // skip prompt, apply _tieDecision every round
let _tiePromptTimer  = null;

let _cdInterval      = null;
let _autoStartTimer  = null;

// Seat indices: server seat index = visual zone (direct mapping)
function getVisualZone(idx) { return (idx >= 0 && idx < 6) ? idx : -1; }

function publicMultiRoomId() {
  return BJ_TABLE.publicRoomId || `bj_public_${BJ_TABLE.minBet || 100}`;
}

// ─────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────
function fmtChips(n) {
  if (n == null) return '$0';
  const v = Math.abs(n);
  if (v >= 1_000_000) return '$' + (n / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (v >= 10_000)    return '$' + (n / 1000).toFixed(0) + 'K';
  return '$' + n.toLocaleString();
}

function tableDisplayName() {
  return BJ_TABLE.displayLabel || BJ_TABLE.name || ((BJ_TABLE.label === 'vip') ? 'VIP' : 'Standard');
}

function syncLobbyTableCopy() {
  const fixedBet = BJ_TABLE.minBet || 100;
  const tieBet   = BJ_TABLE.tieBet || 100;
  const tieWin   = BJ_TABLE.tieBetPayout || 2000;
  const wallet   = BJ_TABLE.walletSize || BJ_TABLE.wallet || 2500;
  const sub = document.querySelector('.lobby-sub');
  if (sub) sub.textContent = `${tableDisplayName()} Table - Fixed ${fmtChips(fixedBet)} main bet - ${fmtChips(tieBet)} Tie Bet optional`;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('lobby-tier-name', tableDisplayName());
  setText('lobby-fixed-bet', fmtChips(fixedBet));
  setText('lobby-tie-bet', fmtChips(tieBet));
  setText('lobby-tie-payout', fmtChips(tieWin));
  setText('lobby-wallet-size', fmtChips(wallet));
}

function cancelBlackjackTable() {
  window._intentionalExit = true;
  try {
    sessionStorage.removeItem('bj_table');
    sessionStorage.removeItem('bj_tier');
  } catch (_) {}
  window.location.href = '/#blackjack';
}

function showScreen(id) {
  ['screen-lobby', 'screen-game', 'screen-gameover'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('active', s === id);
  });
}

function showGameScreen() {
  showScreen('screen-game');
  const menuBtn = document.getElementById('ingame-menu-btn');
  if (menuBtn) menuBtn.style.display = 'flex';
}

function _showStep(id) {
  ['lobby-step-choose', 'lobby-step-single', 'lobby-step-multi'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = (s === id) ? 'block' : 'none';
  });
}

function showIngameToast(title, message) {
  let stack = document.getElementById('big-announce-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'big-announce-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'big-announce';
  el.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:2px;color:#c9a84c">${title || ''}</div>
                  <div style="font-size:12px;color:#9aa8c0;margin-top:2px">${message || ''}</div>`;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .35s'; }, 3000);
  setTimeout(() => { el.remove(); }, 3500);
}

// ─────────────────────────────────────────────────────
// CARD HELPERS — Blackjack-specific (ace-aware)
// ─────────────────────────────────────────────────────
function cardVal(c) {
  if (!c || !c.rank) return 0;
  if (c.rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(c.rank)) return 10;
  return parseInt(c.rank, 10) || 0;
}

function handTotal(hand) {
  let total = 0, aces = 0;
  for (const c of (hand || [])) {
    if (!c || !c.rank || c.faceDown) continue;
    if (c.rank === 'A') { aces++; total += 11; }
    else total += cardVal(c);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return {
    total,
    bust: total > 21,
    bj:   (hand?.length === 2 && total === 21),
    soft: aces > 0 && total <= 21
  };
}

function makeVLCard(c, size) {
  // size: 'sm' | 'lg' | undefined (default).  Used by renderSeats/renderDealer.
  let el;
  if (typeof window.vlCard === 'function')      el = window.vlCard(c);
  else if (typeof vlCard === 'function')        el = vlCard(c);
  else {
    // Minimal fallback renderer
    el = document.createElement('div');
    el.className = 'vl-card';
    el.style.cssText = 'width:62px;height:90px;border-radius:5px;display:inline-flex;'
      + 'align-items:center;justify-content:center;font-weight:700;font-size:20px;'
      + 'border:1px solid #999;box-shadow:0 2px 5px rgba(0,0,0,0.6);margin:1px';
    if (!c || c.faceDown) {
      el.style.background = 'linear-gradient(135deg,#1a3a8a,#0a1850)';
      el.style.border = '1px solid #c9a84c';
      el.textContent = '';
    } else if (c.rank) {
      const isRed = c.suit === '♥' || c.suit === '♦';
      el.style.background = '#fff';
      el.style.color = isRed ? '#cc1830' : '#000';
      el.textContent = c.rank + (c.suit || '');
    }
  }
  if (size === 'lg') el.classList.add('vl-lg');
  else if (size === 'sm') el.classList.add('vl-sm');
  return el;
}

// ─────────────────────────────────────────────────────
// LOBBY
// ─────────────────────────────────────────────────────
function chooseLobby(mode) {
  if (mode === 'single') {
    _isSinglePlayer = true;
    _showStep('lobby-step-single');
    startAdCountdown();
  } else if (mode === 'multi') {
    _isSinglePlayer = false;
    _isInvitedJoiner = false;
    _isMultiplayerHost = false;
    _showStep('lobby-step-multi');
    // Public multiplayer rooms are global by tier. The first occupied seat is
    // treated as host; later entrants and invited players are guests.
    _multiRoomId = publicMultiRoomId();
    _pendingRoomId = _multiRoomId;
    _startMultiWaitTimer();
    _loadMultiFriends();
    _connectHostToLobby();
  }
}

function backToChoose() {
  if (_multiWaitTimer) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; }
  _multiRoomId = null;
  _pendingRoomId = null;
  if (ws) {
    window._intentionalExit = true;
    try { ws.close(); } catch (e) {}
    ws = null;
    window._intentionalExit = false;
  }
  _showStep('lobby-step-choose');
}

function startAdCountdown() {
  const fill = document.getElementById('lobby-ad-fill');
  const cnt  = document.getElementById('lobby-ad-cnt');
  const btn  = document.getElementById('lobby-enter-btn');
  if (!fill || !cnt || !btn) return;

  let t = 10;
  cnt.textContent  = t;
  fill.style.width = '0%';
  btn.disabled     = true;

  const iv = setInterval(() => {
    t--;
    cnt.textContent  = Math.max(0, t);
    fill.style.width = ((10 - t) / 10 * 100) + '%';
    if (t <= 0) {
      clearInterval(iv);
      btn.disabled = false;
      // Auto-enter so a single-player flow runs without an extra click
      enterTableNow();
    }
  }, 1000);
}

function _startMultiWaitTimer() {
  if (_multiWaitTimer) clearInterval(_multiWaitTimer);
  _multiWaitSecs = 300;
  const upd = () => {
    const el = document.getElementById('lobby-wait-timer');
    if (el) {
      const m = Math.floor(_multiWaitSecs / 60);
      const s = (_multiWaitSecs % 60).toString().padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }
  };
  upd();
  _multiWaitTimer = setInterval(() => {
    _multiWaitSecs--;
    upd();
    if (_multiWaitSecs <= 0) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; startNow(); }
  }, 1000);
}

function startNow() {
  if (!_isMultiplayerHost && !_isSinglePlayer) {
    showIngameToast('Host Only', 'Only the host can start a multiplayer table.');
    return;
  }
  if (_multiWaitTimer) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMsg('startGame');
  } else {
    enterTableNow();
  }
}

// ─────────────────────────────────────────────────────
// MULTIPLAYER INVITE (matches SipSam patterns — same endpoints)
// ─────────────────────────────────────────────────────
async function _loadMultiFriends() {
  // Cache once per session; subsequent calls are no-ops
  if (_multiInviteFriends.length) return _multiInviteFriends;
  try {
    const token = igmToken || JSON.parse(sessionStorage.getItem('bj_user') || '{}').token;
    if (!token) return [];
    const r = await fetch('/api/friends', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const d = await r.json();
    _multiInviteFriends = d.friends || [];
    return _multiInviteFriends;
  } catch (e) {
    console.warn('[BJ] friends load:', e.message);
    _multiInviteFriends = [];
    return [];
  }
}

async function _searchAllPlayers(q) {
  try {
    const token = igmToken || JSON.parse(sessionStorage.getItem('bj_user') || '{}').token;
    if (!token) return [];
    const r = await fetch('/api/friends/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ query: q })
    });
    const d = await r.json();
    return d.users || d.results || [];
  } catch (e) {
    return [];
  }
}

let _multiSearchTimer = null;

function _renderMultiInviteDropdown(dd, friends, others, query) {
  dd.innerHTML = '';

  if (!friends.length && !others.length) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:10px 12px;font-size:12px;color:#7a9ac0;font-style:italic';
    msg.textContent = query
      ? 'No matches found — type a full username to invite.'
      : 'No friends yet — type a username to invite anyone.';
    dd.appendChild(msg);
    dd.style.display = 'block';
    return;
  }

  const addRow = (name, isFriend) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;font-size:13px;color:#e8dfc0;border-bottom:1px solid rgba(255,255,255,.04);transition:background .15s';
    row.innerHTML = `<span style="width:26px;height:26px;border-radius:50%;background:rgba(201,168,76,.2);border:1px solid rgba(201,168,76,.3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#c9a84c">${((name || '?')[0] || '').toUpperCase()}</span>
                     <span style="flex:1">${name}</span>
                     <span style="font-size:10px;color:${isFriend ? '#4aabff' : '#666'}">${isFriend ? '🤝 Friend' : ''}</span>`;
    row.onmouseenter = () => row.style.background = 'rgba(26,92,170,.2)';
    row.onmouseleave = () => row.style.background = '';
    row.onmousedown = () => {
      document.getElementById('lobby-invite-input').value = name;
      dd.style.display = 'none';
    };
    dd.appendChild(row);
  };

  if (friends.length) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:2px;color:#4aabff;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.06)';
    hdr.textContent = 'Friends';
    dd.appendChild(hdr);
    friends.forEach(f => addRow(f.username || f.friend_username, true));
  }
  if (others.length) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:2px;color:#888;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.06);margin-top:4px';
    hdr.textContent = 'Other Players';
    dd.appendChild(hdr);
    others.forEach(u => addRow(u.username, false));
  }
  dd.style.display = 'block';
}

function onMultiInviteInput(val) {
  const dd = document.getElementById('lobby-multi-invite-dropdown');
  if (!dd) return;
  clearTimeout(_multiSearchTimer);
  const q = (val || '').trim().toLowerCase();
  if (!q) {
    _loadMultiFriends().then(friends => _renderMultiInviteDropdown(dd, friends.slice(0, 8), [], ''));
    return;
  }
  // Immediate friend-list filter
  _loadMultiFriends().then(friends => {
    const friendMatches = friends.filter(f => (f.username || '').toLowerCase().includes(q)).slice(0, 8);
    _renderMultiInviteDropdown(dd, friendMatches, [], q);
  });
  // Debounced global player search
  _multiSearchTimer = setTimeout(async () => {
    const friends = await _loadMultiFriends();
    const friendNames = new Set(friends.map(f => (f.username || '').toLowerCase()));
    const all = await _searchAllPlayers(val);
    const friendMatches    = friends.filter(f => (f.username || '').toLowerCase().includes(q)).slice(0, 8);
    const nonFriendMatches = all.filter(u => !friendNames.has((u.username || '').toLowerCase())).slice(0, 8);
    _renderMultiInviteDropdown(dd, friendMatches, nonFriendMatches, q);
  }, 350);
}

function onMultiInviteFocus() { onMultiInviteInput(''); }

async function sendMultiInvite() {
  const input    = document.getElementById('lobby-invite-input');
  const st       = document.getElementById('lobby-invite-status');
  const username = (input?.value || '').trim();
  if (!username) { if (st) st.textContent = 'Enter a username first.'; return; }
  if (!_multiRoomId) _multiRoomId = `bj_${BJ_TABLE.minBet || 100}_${Date.now()}`;
  const user  = JSON.parse(sessionStorage.getItem('bj_user') || '{}');
  const token = user.token || sessionStorage.getItem('bj_token') || igmToken;

  if (st) st.textContent = 'Sending invite…';
  try {
    const res = await fetch('/api/friends/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      credentials: 'include',
      body: JSON.stringify({
        toUsername:   username,
        roomId:       _multiRoomId,
        tableMinBet:  BJ_TABLE.minBet || 100,
        game:         'blackjack',
        tableConfig:  Object.assign({}, BJ_TABLE),
        expiresIn:    300
      })
    });
    const d = await res.json();
    if (d.ok) {
      if (st) st.textContent = '✅ Invite sent to ' + username + ' (expires in 5 min)';
      if (input) input.value = '';
      const dd = document.getElementById('lobby-multi-invite-dropdown');
      if (dd) dd.style.display = 'none';
    } else {
      if (st) st.textContent = '❌ ' + (d.error || 'Failed to send invite.');
    }
  } catch (e) {
    if (st) st.textContent = '❌ Network error: ' + e.message;
  }
}

async function _connectHostToLobby() {
  const user  = JSON.parse(sessionStorage.getItem('bj_user') || '{}');
  const token = user.token || sessionStorage.getItem('bj_token') || igmToken;
  const ok    = await _drawWalletFromBank(token);
  if (!ok) {
    _showStep('lobby-step-choose');
    if (_multiWaitTimer) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; }
    return;
  }
  connectWS(user.username || myUsername, token, _multiRoomId);
}

async function _setupInvitedJoinerLobby(roomId, user) {
  _isInvitedJoiner = true;
  _isSinglePlayer = false;
  _isMultiplayerHost = false;
  _multiRoomId = roomId;
  _pendingRoomId = roomId;
  _showStep('lobby-step-multi');

  ['lobby-multi-timer-row', 'lobby-multi-invite-panel', 'lobby-multi-host-actions']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  _ensureGuestCancelOnly();

  const seatsList = document.getElementById('lobby-seats-list');
  if (seatsList && !document.getElementById('invited-wait-msg')) {
    const msg = document.createElement('div');
    msg.id = 'invited-wait-msg';
    msg.style.cssText = 'text-align:center;margin:14px 0;color:#c9a84c;font-weight:700;font-size:15px';
    msg.textContent = 'Guest seat joined. Waiting for host to start the game.';
    seatsList.insertAdjacentElement('afterend', msg);
  }

  const token = user.token || sessionStorage.getItem('bj_token') || igmToken;
  const ok = await _drawWalletFromBank(token);
  if (!ok) {
    _showStep('lobby-step-choose');
    return;
  }
  connectWS(user.username || myUsername, token, roomId);
}

function _renderMultiSeats(players) {
  const rows = document.getElementById('lobby-player-rows');
  if (!rows) return;
  rows.innerHTML = '';
  (players || []).forEach((p, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;font-size:13px;color:#e8dfc0';
    row.innerHTML = `<span style="width:22px;height:22px;border-radius:50%;background:rgba(201,168,76,.2);border:1px solid #c9a84c;display:flex;align-items:center;justify-content:center;font-size:11px;color:#c9a84c">${((p.username || '?')[0] || '').toUpperCase()}</span>
                     <span style="flex:1">${p.username}${p.isHost ? ' <span style="font-size:10px;color:#4aabff">(host)</span>' : ''}</span>`;
    rows.appendChild(row);
  });
}

function _ensureGuestCancelOnly() {
  let btn = document.getElementById('guest-cancel-btn');
  const hostActions = document.getElementById('lobby-multi-host-actions');
  if (!btn && hostActions) {
    btn = document.createElement('button');
    btn.id = 'guest-cancel-btn';
    btn.className = 'btn-secondary';
    btn.style.cssText = 'width:100%;margin-top:8px;font-size:12px;padding:10px 14px';
    btn.textContent = 'Cancel';
    btn.onclick = exitToLobby;
    hostActions.insertAdjacentElement('afterend', btn);
  }
  if (btn) btn.style.display = 'block';
}

function _syncMultiLobbyRole(state, orderedEntries) {
  if (_isSinglePlayer) return;
  const lobbyStep = document.getElementById('lobby-step-multi');
  if (!lobbyStep || lobbyStep.style.display === 'none') return;

  const ownIndex = orderedEntries.findIndex(([, s]) =>
    s.userId === myUsername || s.sessionId === mySessionId || s.isYou
  );
  _isMultiplayerHost = !_isInvitedJoiner && ownIndex === 0;
  const isGuest = !_isMultiplayerHost;

  const timer = document.getElementById('lobby-multi-timer-row');
  const invite = document.getElementById('lobby-multi-invite-panel');
  const hostActions = document.getElementById('lobby-multi-host-actions');
  [timer, invite, hostActions].forEach(el => { if (el) el.style.display = _isMultiplayerHost ? '' : 'none'; });

  let msg = document.getElementById('invited-wait-msg');
  if (isGuest && !msg) {
    const seatsList = document.getElementById('lobby-seats-list');
    if (seatsList) {
      msg = document.createElement('div');
      msg.id = 'invited-wait-msg';
      msg.style.cssText = 'text-align:center;margin:14px 0;color:#c9a84c;font-weight:700;font-size:15px';
      seatsList.insertAdjacentElement('afterend', msg);
    }
  }
  if (msg) {
    msg.textContent = isGuest ? 'Guest seat joined. Waiting for host to start the game.' : 'You are hosting this public multiplayer table.';
    msg.style.display = isGuest ? 'block' : 'none';
  }

  const cancelBtn = document.getElementById('guest-cancel-btn');
  if (isGuest) _ensureGuestCancelOnly();
  else if (cancelBtn) cancelBtn.style.display = 'none';
}

// ─────────────────────────────────────────────────────
// ENTER TABLE  (wallet draw + WS connect + auto-start single)
// ─────────────────────────────────────────────────────
async function _drawWalletFromBank(token) {
  try {
    const res = await fetch('/api/game/bj/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
      credentials: 'include',
      body: JSON.stringify({ tableMinBet: BJ_TABLE.minBet || 100 })
    });
    const d = await res.json();
    if (d?.ok) {
      myChips  = d.walletSize ?? BJ_TABLE.walletSize ?? 2500;
      igmWallet = myChips;
      if (typeof d.newBankBalance === 'number') igmBank = d.newBankBalance;
      return true;
    }
    showIngameToast('Entry Failed', d?.error || 'Could not draw wallet from bank.');
    return false;
  } catch (e) {
    showIngameToast('Entry Failed', 'Server error — please try again.');
    return false;
  }
}

async function enterTableNow() {
  const user  = JSON.parse(sessionStorage.getItem('bj_user') || '{}');
  const token = user.token || sessionStorage.getItem('bj_token') || igmToken;
  myUsername  = user.username || myUsername || 'Player';

  if (!_isInvitedJoiner) {
    const ok = await _drawWalletFromBank(token);
    if (!ok) { _showStep('lobby-step-choose'); return; }
  }

  // Transition to game screen
  showGameScreen();

  const roomId = _pendingRoomId || _multiRoomId || `bj_${BJ_TABLE.minBet || 100}_${Date.now()}`;
  connectWS(myUsername, token, roomId);

  // Single player: auto-start once WS is open (server only auto-starts on explicit startGame)
  if (_isSinglePlayer) {
    if (_autoStartTimer) clearTimeout(_autoStartTimer);
    _autoStartTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) sendMsg('startGame');
    }, 800);
  }
}

// ─────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────
function connectWS(username, token, roomId) {
  myUsername  = username;
  mySessionId = mySessionId || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  igmToken    = token || igmToken;
  window._bjRoomId = roomId;

  const tableMinBet = BJ_TABLE.minBet || 100;
  const tokParam    = token ? `&token=${encodeURIComponent(token)}` : '';
  const url = `${BJ_WS_URL}/blackjack?roomId=${encodeURIComponent(roomId)}`
            + `&userId=${encodeURIComponent(username)}`
            + `&sessionId=${encodeURIComponent(mySessionId)}`
            + `&minBet=${tableMinBet}${tokParam}`;
  console.log('[BJ] connecting:', url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[BJ] WS open');
    ws.send(JSON.stringify({ type: 'set_name',   name:   username }));
    if (window._myAvatar) ws.send(JSON.stringify({ type: 'set_avatar', avatar: window._myAvatar }));
  };
  ws.onmessage = e => {
    try { handleMsg(JSON.parse(e.data)); }
    catch (err) { console.error('[BJ] msg parse error:', err); }
  };
  ws.onclose = (ev) => {
    console.log('[BJ] WS closed');
    if (ev && (ev.code === 1008 || /table full/i.test(ev.reason || ''))) {
      window._intentionalExit = true;
      showIngameToast('Table Full', 'No open seats at this table.');
      setTimeout(() => { window.location.replace('/#blackjack'); }, 1200);
      return;
    }
    if (!window._intentionalExit && !window._serverSettled) {
      setTimeout(() => reconnectWS(token, roomId), 3000);
    }
  };
  ws.onerror = err => console.error('[BJ] WS error:', err);
}

function reconnectWS(token, roomId) {
  if (window._intentionalExit || window._serverSettled) return;
  connectWS(myUsername, token, roomId);
}

function sendMsg(type, data = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[BJ] sendMsg: WS not open', type);
    return;
  }
  ws.send(JSON.stringify({ type, ...data }));
}
function sendAction(type) { sendMsg(type); }

// ─────────────────────────────────────────────────────
// MESSAGE DISPATCHER
// ─────────────────────────────────────────────────────
function handleMsg(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'state':       applyState(msg.state); break;
    case 'phase':       handlePhase(msg); break;
    case 'your_turn':   handleYourTurn(msg); break;
    case 'tie_win':     handleTieWin(msg); break;
    case 'chatHistory': if (Array.isArray(msg.messages)) msg.messages.forEach(appendChat); break;
    case 'chatMessage': appendChat(msg); break;
    case 'toast':       showIngameToast(msg.title, msg.message); break;
    case 'kicked':      handleKicked(msg); break;
    default:            console.log('[BJ] unknown msg:', msg.type);
  }
}

function handleKicked(msg) {
  window._intentionalExit = true;
  const reason = msg.reason === 'insufficient_funds' ? 'Insufficient funds to continue.' :
                 msg.reason === 'left'               ? 'You have left the table.'        :
                                                       (msg.reason || 'You have been removed.');
  showIngameToast('Removed from Table', reason);
  setTimeout(() => { window.location.replace('/'); }, 1500);
}

// ─────────────────────────────────────────────────────
// STATE SYNC
// ─────────────────────────────────────────────────────
function applyState(state) {
  if (!state) return;
  lastState = state;
  window._lastBJState = state;

  if (state.phase && state.phase !== 'waiting') {
    const lobby = document.getElementById('screen-lobby');
    if (lobby && lobby.classList.contains('active')) showGameScreen();
  }

  // Lobby sync: while in lobby-step-multi, show seats from server
  const lobbyStep = document.getElementById('lobby-step-multi');
  if (lobbyStep && lobbyStep.style.display !== 'none' && state.seats) {
    const entries = Object.entries(state.seats).sort((a, b) => (+a[0]) - (+b[0]));
    const players = entries.map(([idx, s], i) => ({
      username: s.displayName || s.userId || 'Player',
      isHost:   i === 0
    }));
    _renderMultiSeats(players);
    _syncMultiLobbyRole(state, entries);
  }

  // Find my seat
  mySeatIndex = null;
  for (const [idx, seat] of Object.entries(state.seats || {})) {
    if (seat.userId === myUsername || seat.sessionId === mySessionId) {
      mySeatIndex = parseInt(idx, 10);
      break;
    }
  }
  const mySeat = (mySeatIndex !== null) ? state.seats?.[mySeatIndex] : null;

  // Wallet sync (server-authoritative)
  if (mySeat) {
    myChips = mySeat.wallet;
    igmWallet = myChips;
  }

  renderDealer(state);
  renderSeats(state);
  updateUI(state);

  // Phase transitions
  if (state.phase !== lastPhase) {
    onPhaseChange(state.phase, lastPhase, state);
    lastPhase = state.phase;
  }
}

function onPhaseChange(newPhase, oldPhase, state) {
  console.log('[BJ] phase change:', oldPhase, '→', newPhase);
  const mySeat = (mySeatIndex !== null) ? state.seats?.[mySeatIndex] : null;

  if (newPhase === 'betting') {
    _betPlaced = false; pendingBet = 0; _tieBetWantedThisRound = false; _bettingHandled = true;
    _hideTieBetPrompt();
    hideInsurancePrompt();
    document.getElementById('player-actions').style.display = 'none';
    hideBetOverlay();
    _startFixedBettingFlow();
    startCountdown(10, false);
  } else if (newPhase === 'deal') {
    hideBetOverlay();
    _hideTieBetPrompt();
    stopCountdown();
  } else if (newPhase === 'insurance') {
    if (mySeat && !mySeat.insuranceBet && !mySeat.insuranceDeclined) showInsurancePrompt();
    startCountdown(7, false);
  } else if (newPhase === 'player_action') {
    hideInsurancePrompt();
    // Action buttons visibility handled by updateUI
  } else if (newPhase === 'dealer') {
    stopCountdown();
    document.getElementById('player-actions').style.display = 'none';
  } else if (newPhase === 'payout') {
    stopCountdown();
    document.getElementById('player-actions').style.display = 'none';
    if (mySeat) {
      const r = (mySeat.result || []).find(x => x);
      if (r) flashTable(r);
    }
  } else if (newPhase === 'round_end') {
    hideBetOverlay();
    hideInsurancePrompt();
    stopCountdown();
    document.getElementById('player-actions').style.display = 'none';
  } else if (newPhase === 'waiting') {
    hideBetOverlay();
    hideInsurancePrompt();
    stopCountdown();
  }
}

function handlePhase(msg) {
  // Transition lobby → game on any non-waiting phase
  if (msg.phase && msg.phase !== 'waiting') {
    const lobby = document.getElementById('screen-lobby');
    if (lobby && lobby.classList.contains('active')) {
      showGameScreen();
    }
  }
}

function handleYourTurn(msg) {
  if (msg.seatIndex === mySeatIndex) {
    startCountdown(Math.floor((msg.duration || 10000) / 1000), true);
    if (lastState) updateUI(lastState);
  } else {
    stopCountdown();
    document.getElementById('player-actions').style.display = 'none';
    const allSeats = window._lastBJState?.seats || {};
    const activeName = allSeats[msg.seatIndex]?.displayName || `Player ${msg.seatIndex + 1}`;
    const gs = document.getElementById('game-status');
    if (gs) gs.textContent = `${activeName}'s turn…`;
  }
}

function handleTieWin(msg) {
  if (typeof SFX !== 'undefined') SFX.bj?.();
  const name   = msg.displayName || 'A player';
  const bonus  = msg.bonus ? '$' + msg.bonus.toLocaleString() : '';
  const credit = msg.totalCredit ? '$' + msg.totalCredit.toLocaleString() : '';
  let stack = document.getElementById('big-announce-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'big-announce-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'big-announce ba-tie';
  el.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:3px;color:#ffd700">TIE BET WIN!</div>
                  <div style="font-size:13px;color:#e8dfc0;margin-top:4px">${name}</div>
                  <div style="font-family:'Rajdhani',sans-serif;font-size:18px;font-weight:900;color:#ffd700;margin-top:2px">+${bonus}${credit ? ' (paid ' + credit + ')' : ''}</div>`;
  stack.appendChild(el);
  const flash = document.getElementById('result-flash');
  if (flash) flash._tieTimer = setTimeout(() => { delete flash._tieTimer; }, 2200);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3500);
  setTimeout(() => el.remove(), 4000);
}

// ─────────────────────────────────────────────────────
// RENDER — dealer
// ─────────────────────────────────────────────────────
function renderDealer(state) {
  const cardsEl = document.getElementById('dealer-cards');
  if (cardsEl) {
    cardsEl.innerHTML = '';
    (state.dealerCards || []).forEach(c => cardsEl.appendChild(makeVLCard(c, 'lg')));
  }
  const totalEl = document.getElementById('dealer-total-display');
  if (totalEl) {
    const t = state.dealerTotal;
    totalEl.textContent = (t != null && t > 0) ? String(t) : '';
    const ht = handTotal(state.dealerCards || []);
    totalEl.classList.toggle('bust', ht.bust);
    totalEl.classList.toggle('bj',   ht.bj);
  }
}

// ─────────────────────────────────────────────────────
// RENDER — seats
// ─────────────────────────────────────────────────────
function renderSeats(state) {
  const allSeatIdxs = Object.keys(state.seats || {}).map(Number).sort();
  const occupiedZones = new Set();

  for (const [seatIdxStr, seat] of Object.entries(state.seats || {})) {
    const seatIdx = parseInt(seatIdxStr, 10);
    const vz = getVisualZone(seatIdx);
    if (vz < 0) continue;
    occupiedZones.add(vz);
    const isMe = (seatIdx === mySeatIndex);

    // Mark the seat element so CSS can scale up MY cards / highlight my seat
    const seatEl = document.getElementById(`bj-seat-${vz}`);
    if (seatEl) seatEl.classList.toggle('bj-seat-mine', isMe);

    const emptyEl = document.getElementById(`seat${vz}-empty`);
    if (emptyEl) emptyEl.style.display = 'none';

    const nameEl = document.getElementById(`seat${vz}-name`);
    if (nameEl) {
      nameEl.textContent = (seat.avatar ? seat.avatar + ' ' : '') + (seat.displayName || 'Player');
      nameEl.classList.toggle('is-you',    isMe);
      nameEl.classList.toggle('is-active', state.activeSeat === seatIdx);
      nameEl.classList.toggle('is-bot',    !!seat.isBot);
    }
    const chipsEl = document.getElementById(`seat${vz}-chips`);
    if (chipsEl) chipsEl.textContent = (seat.wallet > 0) ? fmtChips(seat.wallet) : '';
    const betEl = document.getElementById(`seat${vz}-bet`);
    if (betEl)   betEl.textContent   = (seat.bet > 0)    ? fmtChips(seat.bet)    : '';

    const cardsEl = document.getElementById(`seat${vz}-cards`);
    if (cardsEl) {
      const hands = seat.hands || [];
      const isSplit = hands.length > 1;
      // My own cards render at large size for readability; others stay default
      const cardSize = isMe ? 'lg' : null;
      if (isSplit) {
        cardsEl.innerHTML = '';
        cardsEl.style.cssText = isMe
          ? 'display:flex;flex-direction:row;gap:8px;flex-wrap:nowrap;justify-content:center;align-items:flex-end;width:max-content;max-width:none'
          : 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center';
        hands.forEach((hand, hi) => {
          const wrap = document.createElement('div');
          wrap.className = 'split-hand-wrapper' + (hi === seat.activeHandIdx ? ' active' : '');
          wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px';
          const box = document.createElement('div');
          box.style.cssText = isMe
            ? 'display:flex;flex-direction:row;gap:4px;flex-wrap:nowrap;align-items:flex-end'
            : 'display:flex;gap:2px';
          (hand || []).forEach(c => box.appendChild(makeVLCard(c, cardSize)));
          const ht = handTotal(hand || []);
          if (ht.total > 0) {
            const t = document.createElement('div');
            t.className = 'hand-total' + (ht.bust ? ' bust' : ht.bj ? ' bj' : '');
            t.style.cssText = 'font-size:11px;font-weight:700;color:' + (ht.bust ? '#ff5555' : ht.bj ? '#ffd700' : '#e8dfc0');
            t.textContent = ht.bj ? 'BJ!' : (ht.bust ? 'BUST' : String(ht.total));
            box.appendChild(t);
          }
          wrap.appendChild(box);
          const r = seat.result?.[hi];
          if (r) {
            const rb = document.createElement('div');
            rb.className = 'result-badge-inline ' + r;
            rb.textContent = r === 'blackjack' ? 'BJ!' : (r === 'tie' ? 'TIE!' : r.toUpperCase());
            wrap.appendChild(rb);
          }
          cardsEl.appendChild(wrap);
        });
      } else {
        cardsEl.innerHTML = '';
        cardsEl.style.cssText = isMe
          ? 'display:flex;flex-direction:row;gap:8px;align-items:flex-end;flex-wrap:nowrap;width:max-content;max-width:none'
          : 'display:flex;gap:3px;align-items:flex-end;flex-wrap:wrap';
        const hand = hands[0] || [];
        hand.forEach(c => cardsEl.appendChild(makeVLCard(c, cardSize)));
        const ht = handTotal(hand);
        if (ht.total > 0) {
          const t = document.createElement('div');
          t.className = 'hand-total' + (ht.bust ? ' bust' : ht.bj ? ' bj' : '');
          t.style.cssText = 'font-size:12px;font-weight:700;margin-left:4px;color:' + (ht.bust ? '#ff5555' : ht.bj ? '#ffd700' : '#e8dfc0');
          t.textContent = ht.bj ? 'BJ!' : (ht.bust ? 'BUST' : String(ht.total));
          cardsEl.appendChild(t);
        }
      }
    }

    // Overall seat result badge (priority: blackjack > win > tie > push > bust > lose)
    const rs = document.getElementById(`seat${vz}-result`);
    if (rs) {
      const priority = ['blackjack', 'win', 'tie', 'push', 'bust', 'lose'];
      const results = seat.result || [];
      const best = priority.find(p => results.includes(p));
      if (best) {
        rs.className   = 'result-badge-inline ' + best;
        rs.textContent = best === 'blackjack' ? 'BLACKJACK!' : (best === 'tie' ? 'TIE!' : best.toUpperCase());
      } else {
        rs.className = 'result-badge-inline';
        rs.textContent = '';
      }
    }
  }

  // Empty seats — show invite/bot UI
  for (let vz = 0; vz < 6; vz++) {
    if (occupiedZones.has(vz)) continue;
    const seatEl = document.getElementById(`bj-seat-${vz}`);
    if (seatEl) seatEl.classList.remove('bj-seat-mine');
    const nameEl = document.getElementById(`seat${vz}-name`);   if (nameEl)  nameEl.textContent  = '';
    const chipsEl = document.getElementById(`seat${vz}-chips`); if (chipsEl) chipsEl.textContent = '';
    const betEl  = document.getElementById(`seat${vz}-bet`);    if (betEl)   betEl.textContent   = '';
    const cardsEl = document.getElementById(`seat${vz}-cards`); if (cardsEl) cardsEl.innerHTML   = '';
    const rs = document.getElementById(`seat${vz}-result`);     if (rs)      { rs.textContent = ''; rs.className = 'result-badge-inline'; }
    const emptyEl = document.getElementById(`seat${vz}-empty`); if (emptyEl) emptyEl.style.display = '';
  }
}

// ─────────────────────────────────────────────────────
// UPDATE UI — top bar, action buttons, tie bet
// ─────────────────────────────────────────────────────
function updateUI(state) {
  const roundEl  = document.getElementById('game-round');
  if (roundEl) roundEl.textContent = state.roundNum ? 'Round ' + state.roundNum : 'Round —';
  const statusEl = document.getElementById('game-status');
  if (statusEl) statusEl.textContent = fmtPhase(state.phase);

  const mySeat = (mySeatIndex !== null) ? state.seats?.[mySeatIndex] : null;

  // Action buttons: only show on my turn
  const isMyTurn = (state.activeSeat === mySeatIndex && state.phase === 'player_action' && mySeat);
  const pa = document.getElementById('player-actions');
  if (pa) pa.style.display = isMyTurn ? '' : 'none';
  if (isMyTurn && mySeat) {
    const hi   = mySeat.activeHandIdx || 0;
    const hand = (mySeat.hands || [[]])[hi] || [];
    const w    = mySeat.wallet || 0;
    const b    = mySeat.bet    || 0;
    const ht   = handTotal(hand);
    const dbl  = document.getElementById('btn-double');
    const spl  = document.getElementById('btn-split');
    const hit  = document.getElementById('btn-hit');
    const stnd = document.getElementById('btn-stand');
    if (hit)  hit.disabled  = ht.bust || mySeat.splitAces;
    if (stnd) stnd.disabled = false;
    if (dbl)  dbl.disabled  = hand.length !== 2 || w < b;
    if (spl)  spl.disabled  = hand.length !== 2 || !hand[0] || !hand[1]
                           || cardVal(hand[0]) !== cardVal(hand[1])
                           || (mySeat.hands || []).length >= 4 || w < b;
    const ss = document.getElementById('split-status');
    if (ss) ss.textContent = (mySeat.hands?.length > 1)
      ? `Playing Hand ${hi + 1} of ${mySeat.hands.length}` : '';
  }

  // Wallet display
  if (mySeat) {
    const ow = document.getElementById('bet-overlay-wallet');
    if (ow) ow.textContent = fmtChips(myChips);
  }

  // Tie bet button label
  const tieBetVal = mySeat?.tieBet || 0;
  const tieBetAmt = BJ_TABLE.tieBet || 100;
  const tbBtn = document.getElementById('btn-tie-bet');
  if (tbBtn) {
    const amt = fmtChips(tieBetAmt);
    tbBtn.classList.toggle('placed', tieBetVal > 0);
    tbBtn.textContent = tieBetVal > 0 ? `✓ TIE BET (${amt})` : `🎯 TIE BET — ${amt}`;
  }

  // Tie bet hint
  const hint = document.getElementById('bet-tiebet-hint');
  if (hint) {
    const payout = BJ_TABLE.tieBetPayout || 2000;
    hint.innerHTML = `<strong style="color:#ffd700">${fmtChips(payout)} Bonus</strong><br>Wins if your total = dealer's total`;
  }

  // Freeze button UI
  _updateFreezeUI();
}

function fmtPhase(p) {
  return {
    waiting:        'Waiting for players…',
    betting:        'Tie Bet? Fixed main bet auto-places',
    deal:           'Dealing…',
    insurance:      'Insurance?',
    player_action:  'Your turn — Hit or Stand',
    dealer:         "Dealer's turn",
    payout:         'Payouts',
    round_end:      'Round complete'
  }[p] || (p || 'Connecting…');
}

// ─────────────────────────────────────────────────────
// BET OVERLAY  (legacy/manual fallback only; tables auto-place fixed main bets)
// ─────────────────────────────────────────────────────
function showBetOverlay(state) {
  const overlay = document.getElementById('bet-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.getElementById('bet-chips-section')?.style?.setProperty('display', 'flex');
  document.getElementById('bet-confirm-section')?.style?.setProperty('display', 'block');
  document.getElementById('bet-fixed-section')?.style?.setProperty('display', 'none');
  const rl = document.getElementById('bet-round-label');
  if (rl) rl.textContent = state.roundNum || '—';
  const ow = document.getElementById('bet-overlay-wallet');
  if (ow) ow.textContent = fmtChips(myChips);
  pendingBet = 0;
  updateBetDisplay();
}

function hideBetOverlay() {
  const overlay = document.getElementById('bet-overlay');
  if (overlay) overlay.style.display = 'none';
}

function addChip(amount) {
  if (_betPlaced) return;
  showIngameToast('Fixed Table', `Main bet is fixed at ${fmtChips(BJ_TABLE.minBet || 100)}.`);
}

function updateBetDisplay() {
  const el = document.getElementById('bet-display');
  if (el) el.textContent = pendingBet > 0 ? fmtChips(pendingBet) : '';
}

function _sendBet() {
  if (_betPlaced || pendingBet <= 0) return;
  const min = BJ_TABLE.minBet || 100;
  if (pendingBet < min) {
    showIngameToast('Bet Too Low', `Minimum bet is ${fmtChips(min)}.`);
    return;
  }
  sendMsg('place_bet', { amount: pendingBet });
  _betPlaced = true;
}
function placeBet() { _sendBet(); }

function _autoPlaceFixedBet() {
  if (_betPlaced) return;
  const seat = lastState?.seats?.[mySeatIndex];
  const avail = seat?.wallet ?? myChips;
  const amt = BJ_TABLE.minBet || 0;
  if (!amt || amt > avail) return;
  pendingBet = amt;
  _sendBet();
}

function placeTieBet() {
  if (_betPlaced) {
    showIngameToast('Bet Already Placed', 'Tie bet must be placed before main bet.');
    return;
  }
  _tieDecision = _tieDecision === 'yes' ? 'no' : 'yes';
  _tieBetWantedThisRound = !_tieBetWantedThisRound;
  sendMsg('place_tie');
  _updateFreezeUI();
}

// ─────────────────────────────────────────────────────
// TIE BET PROMPT  (all fixed-bet tables)
// ─────────────────────────────────────────────────────
function _startFixedBettingFlow() {
  _hideTieBetPrompt();
  if (_tieFrozen && _tieDecision) {
    if (_tieDecision === 'yes') sendMsg('place_tie');
    setTimeout(() => _autoPlaceFixedBet(), 300);
    return;
  }
  _tieDecision = null;
  _showTieBetPrompt();
}

function _showTieBetPrompt() {
  const ov = document.getElementById('tie-bet-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  const lbl = document.getElementById('tie-round-label');
  if (lbl) lbl.textContent = lastState?.roundNum || '—';
  const amt = document.getElementById('tie-amount-display');
  if (amt) amt.textContent = fmtChips(BJ_TABLE.tieBet || 100);
  const hint = document.getElementById('tie-payout-hint');
  if (hint) hint.innerHTML = `Wins if your total matches the dealer's — bonus: <strong style="color:#ffd700">${fmtChips(BJ_TABLE.tieBetPayout || 2000)}</strong>`;

  let n = 5;
  const cn = document.getElementById('tie-countdown');
  if (cn) cn.textContent = n;
  if (_tiePromptTimer) clearInterval(_tiePromptTimer);
  _tiePromptTimer = setInterval(() => {
    n--;
    if (cn) cn.textContent = n;
    if (n <= 0) { clearInterval(_tiePromptTimer); _tiePromptTimer = null; tieBetDecide('no', true); }
  }, 1000);
}

function _hideTieBetPrompt() {
  if (_tiePromptTimer) { clearInterval(_tiePromptTimer); _tiePromptTimer = null; }
  const ov = document.getElementById('tie-bet-overlay');
  if (ov) ov.style.display = 'none';
}

function tieBetDecide(choice, auto) {
  _tieDecision = choice;
  _tieBetWantedThisRound = choice === 'yes';
  _hideTieBetPrompt();
  if (choice === 'yes') sendMsg('place_tie');
  setTimeout(() => _autoPlaceFixedBet(), 300);
}

// ─────────────────────────────────────────────────────
// INSURANCE
// ─────────────────────────────────────────────────────
function showInsurancePrompt() {
  const el = document.getElementById('insurance-prompt');
  if (el) el.style.display = 'flex';
}
function hideInsurancePrompt() {
  const el = document.getElementById('insurance-prompt');
  if (el) el.style.display = 'none';
}
function takeInsurance(take) {
  sendMsg('insurance', { take: !!take });
  hideInsurancePrompt();
}

// ─────────────────────────────────────────────────────
// FREEZE TIE BET  (persists YES/NO tie decision across rounds)
// ─────────────────────────────────────────────────────
function toggleFreeze() {
  if (_tieFrozen) {
    _tieFrozen = false;
    showIngameToast('Tie Freeze Removed', 'You will be asked again next round.');
  } else {
    if (!_tieDecision) {
      showIngameToast('No Tie Decision', 'Choose Tie Bet YES or NO first.');
      return;
    }
    _tieFrozen = true;
    const label = (_tieDecision === 'yes') ? 'Tie Bet YES' : 'Tie Bet NO';
    showIngameToast('Tie Decision Frozen', label);
  }
  _updateFreezeUI();
}

function _updateFreezeUI() {
  const bb = document.getElementById('btn-freeze-bar');
  if (!bb) return;
  if (_tieFrozen && _tieDecision) {
    bb.textContent = `Frozen - Tie: ${_tieDecision.toUpperCase()}`;
    bb.classList.add('active');
  } else {
    bb.textContent = 'Freeze Tie Bet';
    bb.classList.remove('active');
  }
}

// ─────────────────────────────────────────────────────
// FLASH (oval colour pulse on win/lose)
// ─────────────────────────────────────────────────────
function flashTable(result) {
  const oval = document.getElementById('oval-table');
  if (!oval) return;
  oval.classList.remove('flash-win', 'flash-lose', 'flash-bj');
  if (result === 'blackjack')                        { oval.classList.add('flash-bj');   if (typeof SFX !== 'undefined') SFX.bj?.(); }
  else if (result === 'win')                         { oval.classList.add('flash-win');  if (typeof SFX !== 'undefined') SFX.win?.(); }
  else if (result === 'lose' || result === 'bust')   { oval.classList.add('flash-lose'); if (typeof SFX !== 'undefined') SFX.lose?.(); }
  setTimeout(() => oval.classList.remove('flash-win', 'flash-lose', 'flash-bj'), 800);
}

// ─────────────────────────────────────────────────────
// COUNTDOWN
// ─────────────────────────────────────────────────────
function startCountdown(secs, showOverlay) {
  stopCountdown();
  let t = Math.floor(secs);
  const TOTAL   = secs;
  const cd      = document.getElementById('cd-number');
  const overlay = document.getElementById('your-turn-overlay');
  const ring    = document.getElementById('bet-ring');
  const bc      = document.getElementById('bet-countdown');
  if (overlay) overlay.style.display = showOverlay ? 'flex' : 'none';

  const update = rem => {
    if (cd) { cd.textContent = rem; cd.classList.toggle('urgent', rem > 0 && rem <= 3); }
    if (ring) {
      ring.style.strokeDashoffset = 213.6 * (1 - rem / TOTAL);
      ring.style.stroke = rem <= 3 ? '#ef4444' : rem <= 5 ? '#f87171' : '#c9a84c';
    }
    if (bc) bc.textContent = rem;
  };
  update(t);
  _cdInterval = setInterval(() => {
    t--;
    if (t <= 0) { stopCountdown(); return; }
    update(t);
  }, 1000);
}

function stopCountdown() {
  if (_cdInterval) { clearInterval(_cdInterval); _cdInterval = null; }
  const overlay = document.getElementById('your-turn-overlay');
  if (overlay) overlay.style.display = 'none';
  const cd = document.getElementById('cd-number');
  if (cd) cd.classList.remove('urgent');
}

// ─────────────────────────────────────────────────────
// SEAT INTERACTIONS  (empty seat invite / add bot)
// ─────────────────────────────────────────────────────
function inviteToSeat() {
  toggleIngameMenu();
  setTimeout(() => igmShowSub('igm-sub-invite'), 200);
}
function addBotToSeat(visualZone) {
  sendMsg('add_bot');
}

// ─────────────────────────────────────────────────────
// IN-GAME MENU
// ─────────────────────────────────────────────────────
function toggleIngameMenu() {
  const ov = document.getElementById('igm-overlay');
  const pn = document.getElementById('igm-panel');
  if (!ov || !pn) return;
  const open = pn.style.transform !== 'translateX(0%)' && !pn.classList.contains('open');
  if (open) {
    ov.style.display = 'block';
    pn.style.transform = 'translateX(0%)';
    pn.classList.add('open');
    document.body.classList.add('igm-open');
    igmRefresh();
  } else {
    closeIngameMenu();
  }
}
function closeIngameMenu() {
  const ov = document.getElementById('igm-overlay');
  const pn = document.getElementById('igm-panel');
  if (ov) ov.style.display = 'none';
  if (pn) { pn.style.transform = 'translateX(100%)'; pn.classList.remove('open'); }
  document.body.classList.remove('igm-open');
  // Hide any open sub-panel
  document.querySelectorAll('.igm-sub').forEach(s => s.style.display = 'none');
  const m = document.getElementById('igm-main');
  if (m) m.style.display = 'block';
}
function igmShowSub(id) {
  document.querySelectorAll('.igm-sub').forEach(s => s.style.display = 'none');
  const sub = document.getElementById(id);
  if (sub) sub.style.display = 'block';
  const main = document.getElementById('igm-main');
  if (main) main.style.display = 'none';
}
function igmBack() {
  document.querySelectorAll('.igm-sub').forEach(s => s.style.display = 'none');
  const main = document.getElementById('igm-main');
  if (main) main.style.display = 'block';
}
function igmShowReplenish() { igmShowSub('igm-sub-replenish'); }
function igmShowInvite()    { igmShowSub('igm-sub-invite'); }
function igmShowPayouts()   { igmShowSub('igm-sub-payouts'); }
function igmShowRules()     { igmShowSub('igm-sub-rules'); }

function igmRefresh() {
  const u = document.getElementById('igm-username');     if (u) u.textContent = myUsername || '—';
  const w = document.getElementById('igm-wallet-display'); if (w) w.textContent = 'Wallet: ' + fmtChips(myChips);
  const b = document.getElementById('igm-bank-display');   if (b) b.textContent = fmtChips(igmBank);
  const rw = document.getElementById('rep-cur-wallet');    if (rw) rw.textContent = fmtChips(myChips);
  const rb = document.getElementById('rep-cur-bank');      if (rb) rb.textContent = fmtChips(igmBank);
}

async function igmExitTable() {
  closeIngameMenu();
  window._intentionalExit = true;
  const token = igmToken;
  try {
    if (token) {
      await fetch('/api/game/bj/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        credentials: 'include',
        body: JSON.stringify({ remainingWallet: myChips, tableMinBet: BJ_TABLE.minBet || 100 })
      });
    }
  } catch (e) {}
  if (ws) { try { ws.send(JSON.stringify({ type: 'leave' })); ws.close(); } catch (e) {} }
  setTimeout(() => { window.location.replace('/#blackjack'); }, 400);
}
function exitToLobby() { igmExitTable(); }

// ─────────────────────────────────────────────────────
// IGM menu-item handlers (wired from index.html onclick=)
// ─────────────────────────────────────────────────────
function igmReplenish() { igmShowSub('igm-sub-replenish'); }
function igmInvite()    { igmShowSub('igm-sub-invite'); }
function igmExit()      { igmExitTable(); }

function igmAddBot() {
  // Server picks the next free seat; no zone needed
  sendMsg('add_bot');
  closeIngameMenu();
  showIngameToast('Bot Added', 'A bot will join the next empty seat.');
}

function igmFillMax() {
  // Fill the replenish input with the player's full bank balance
  const input = document.getElementById('rep-amount');
  if (input) input.value = String(Math.max(0, igmBank | 0));
}

async function doReplenish() {
  const input = document.getElementById('rep-amount');
  const err   = document.getElementById('rep-err');
  const amt   = Math.floor(Number(input?.value || 0));
  if (err) err.style.display = 'none';
  if (!amt || amt <= 0) {
    if (err) { err.textContent = 'Enter a positive amount.'; err.style.display = 'block'; }
    return;
  }
  if (amt > igmBank) {
    if (err) { err.textContent = `Insufficient bank (have ${fmtChips(igmBank)}).`; err.style.display = 'block'; }
    return;
  }
  try {
    const res = await fetch('/api/game/replenish', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + igmToken },
      credentials: 'include',
      body: JSON.stringify({ amount: amt, gameType: 'blackjack', tableMinBet: BJ_TABLE.minBet || 100 })
    });
    const d = await res.json();
    if (!d?.ok) {
      if (err) { err.textContent = d?.error || 'Replenish failed.'; err.style.display = 'block'; }
      return;
    }
    // Server already debited the bank — credit our local wallet via add_wallet
    sendMsg('add_wallet', { amount: amt });
    if (typeof d.newBankBalance === 'number') igmBank = d.newBankBalance;
    myChips += amt;
    igmWallet = myChips;
    igmRefresh();
    if (input) input.value = '';
    showIngameToast('Replenished', `+${fmtChips(amt)} drawn to wallet.`);
    setTimeout(() => igmBack(), 600);
  } catch (e) {
    if (err) { err.textContent = 'Network error: ' + e.message; err.style.display = 'block'; }
  }
}

// IGM invite panel (mirrors the lobby invite — uses different element IDs)
let _igmInviteFriends = null;
async function _igmLoadFriends() {
  if (_igmInviteFriends) return _igmInviteFriends;
  try {
    const r = await fetch('/api/friends', { headers: { 'Authorization': 'Bearer ' + igmToken } });
    const d = await r.json();
    _igmInviteFriends = d.friends || [];
    return _igmInviteFriends;
  } catch (e) { _igmInviteFriends = []; return []; }
}

function _renderIgmInviteDropdown(dd, friends, others, q) {
  dd.innerHTML = '';
  if (!friends.length && !others.length) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:10px 12px;font-size:12px;color:#7a9ac0;font-style:italic';
    msg.textContent = q ? 'No matches found.' : 'No friends yet — type a username.';
    dd.appendChild(msg);
    dd.style.display = 'block';
    return;
  }
  const addRow = (name, isFriend) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;font-size:13px;color:#e8dfc0;border-bottom:1px solid rgba(255,255,255,.04)';
    row.innerHTML = `<span style="width:22px;height:22px;border-radius:50%;background:rgba(201,168,76,.18);border:1px solid #c9a84c;display:flex;align-items:center;justify-content:center;font-size:11px;color:#c9a84c">${(name[0] || '?').toUpperCase()}</span>
                     <span style="flex:1">${name}</span>${isFriend ? '<span style="font-size:10px;color:#4aabff">🤝</span>' : ''}`;
    row.onmousedown = () => {
      const inp = document.getElementById('invite-username');
      if (inp) inp.value = name;
      dd.style.display = 'none';
    };
    dd.appendChild(row);
  };
  friends.forEach(f => addRow(f.username || f.friend_username, true));
  others.forEach(u => addRow(u.username, false));
  dd.style.display = 'block';
}

let _igmSearchTimer = null;
function onLobbyInviteInput(val) {
  const dd = document.getElementById('lobby-invite-dropdown');
  if (!dd) return;
  clearTimeout(_igmSearchTimer);
  const q = (val || '').trim().toLowerCase();
  _igmLoadFriends().then(friends => {
    const matches = q
      ? friends.filter(f => (f.username || '').toLowerCase().includes(q)).slice(0, 6)
      : friends.slice(0, 6);
    _renderIgmInviteDropdown(dd, matches, [], q);
  });
  if (!q) return;
  _igmSearchTimer = setTimeout(async () => {
    const friends = await _igmLoadFriends();
    const friendNames = new Set(friends.map(f => (f.username || '').toLowerCase()));
    const all = await _searchAllPlayers(val);
    const fm = friends.filter(f => (f.username || '').toLowerCase().includes(q)).slice(0, 6);
    const om = all.filter(u => !friendNames.has((u.username || '').toLowerCase())).slice(0, 6);
    _renderIgmInviteDropdown(dd, fm, om, q);
  }, 350);
}
function onLobbyInviteFocus() { onLobbyInviteInput(''); }

async function sendLobbyInvite() {
  const inp = document.getElementById('invite-username');
  const st  = document.getElementById('invite-status');
  const username = (inp?.value || '').trim();
  if (!username) { if (st) st.textContent = 'Enter a username first.'; return; }
  const roomId = window._bjRoomId || `bj_${BJ_TABLE.minBet || 100}_${Date.now()}`;
  if (st) st.textContent = 'Sending invite…';
  try {
    const r = await fetch('/api/friends/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + igmToken },
      body: JSON.stringify({
        toUsername:  username,
        roomId:      roomId,
        tableMinBet: BJ_TABLE.minBet || 100,
        game:        'blackjack',
        tableConfig: Object.assign({}, BJ_TABLE),
        expiresIn:   300
      })
    });
    const d = await r.json();
    if (d.ok) {
      if (st) st.textContent = '✅ Invite sent to ' + username;
      if (inp) inp.value = '';
    } else {
      if (st) st.textContent = '❌ ' + (d.error || 'Failed.');
    }
  } catch (e) {
    if (st) st.textContent = '❌ ' + e.message;
  }
}

// ─────────────────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────────────────
function toggleChatPopup() {
  const p = document.getElementById('chat-popup');
  if (!p) return;
  p.style.display = (p.style.display === 'flex') ? 'none' : 'flex';
  if (p.style.display === 'flex') document.getElementById('chat-bar-input')?.focus();
}
function chatBarSend() {
  const inp = document.getElementById('chat-bar-input');
  if (!inp) return;
  const msg = inp.value.trim();
  if (!msg) return;
  sendMsg('chatMessage', { message: msg });
  inp.value = '';
}
function appendChat(msg) {
  // Minimal chat sink — full popup logging can be added later
  console.log('[chat]', msg.username || '?', ':', msg.message);
}

// ─────────────────────────────────────────────────────
// AUTO-LOGIN  (called from VurgLife dashboard via sessionStorage)
// ─────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (window._intentionalExit || window._serverSettled || !igmToken || !myChips) return;
  const mb = BJ_TABLE.minBet || 100;
  navigator.sendBeacon('/api/game/bj/exit-beacon?token=' + encodeURIComponent(igmToken),
    new Blob([JSON.stringify({ remainingWallet: myChips, tableMinBet: mb })], { type: 'application/json' }));
});

window.addEventListener('DOMContentLoaded', () => {
  // Load saved user from sessionStorage (set by the dashboard before redirect)
  try {
    const uj = sessionStorage.getItem('bj_user');
    if (uj) {
      const user = JSON.parse(uj);
      myUsername = user.username || '';
      igmToken   = user.token || '';
      if (typeof user.bank === 'number') igmBank = user.bank;
      const tj = sessionStorage.getItem('bj_table');
      if (tj) {
        try { BJ_TABLE = Object.assign({}, BJ_TABLE, JSON.parse(tj)); } catch (_) {}
      }
      const tier = sessionStorage.getItem('bj_tier');
      if (tier) BJ_TABLE.label = tier;
      syncLobbyTableCopy();
    }
  } catch (e) {
    console.warn('[BJ] auto-login parse error:', e.message);
  }

  // URL has roomId → invited-joiner path
  syncLobbyTableCopy();
  const urlParams = new URLSearchParams(window.location.search);
  const urlRoomId = urlParams.get('roomId');
  if (urlRoomId) {
    _isInvitedJoiner = urlParams.get('invited') === '1';
    _pendingRoomId   = urlRoomId;
    const user = JSON.parse(sessionStorage.getItem('bj_user') || '{}');
    if (_isInvitedJoiner) {
      _setupInvitedJoinerLobby(urlRoomId, user);
    } else {
      // Direct join: skip lobby, go straight to table
      _isSinglePlayer = false;
      enterTableNow();
    }
    return;
  }

  // Dashboard invite-accept path stores bj_table instead of URL params.
  // Invited players always enter as guests in the host's lobby: no start,
  // invite, table, or round controls; Cancel is the only lobby action.
  try {
    const table = JSON.parse(sessionStorage.getItem('bj_table') || '{}');
    if (table?.isInvitedJoiner && table.roomId) {
      _isInvitedJoiner = true;
      _pendingRoomId = table.roomId;
      _setupInvitedJoinerLobby(table.roomId, JSON.parse(sessionStorage.getItem('bj_user') || '{}'));
      return;
    }
  } catch (_) {}

  _showStep('lobby-step-choose');
});

// Click-outside to close invite dropdown
document.addEventListener('click', e => {
  const dd = document.getElementById('lobby-multi-invite-dropdown');
  const inp = document.getElementById('lobby-invite-input');
  if (dd && inp && !dd.contains(e.target) && e.target !== inp) dd.style.display = 'none';
});
