// ============================================================
// VURGLIFE BLACKJACK — game.js v4.0
// Proper Multiplayer/Single lobby, 6-seat semicircle,
// random player seating, per-seat bot buttons, replenish fixed
// ============================================================

const BJ_WS_URL = `ws://${location.hostname}:3002`;
// Default table config — overwritten by sessionStorage 'bj_tier' (dashboard tier pick)
// or 'bj_table' (from invite accept).
let BJ_TABLE  = { minBet:100, maxBet:500, walletSize:2500, tieBet:100, tieBetPayout:2000, blackjackPayout:null, label:'standard' };
try {
  const _tierJson  = sessionStorage.getItem('bj_tier');
  const _tableJson = sessionStorage.getItem('bj_table');
  if (_tierJson)  BJ_TABLE = Object.assign(BJ_TABLE, JSON.parse(_tierJson));
  if (_tableJson) BJ_TABLE = Object.assign(BJ_TABLE, JSON.parse(_tableJson));
} catch(e) {}

let ws             = null;
let myUsername     = '';
let mySessionId    = null;
let mySeatIndex    = null;   // server seat index (0-5, random)
let pendingBet     = 0;
let lastPhase      = '';
let _betPlaced     = false;

// ── Freeze Bet ───────────────────────────────────────────────
// Stores the player's frozen bet amount and tie bet preference.
// Session-only freeze — never persists across games
let _frozenBet     = 0;       // 0 = not frozen (standard tables)
let _frozenTie     = false;   // whether tie bet is also frozen (standard tables)
let _freezePending = false;   // freeze was changed mid-round — apply next round

// ── VIP Tie Bet decision state ───────────────────────────────
let _tieDecision   = null;    // 'yes' | 'no' | null — this round's choice
let _tieFrozen     = false;   // true → skip overlay, apply _tieDecision every round
let _tiePromptTimer = null;   // active 5s auto-skip timer
// One-shot guard — set true when the betting-phase flow has run for the
// current round, cleared on round_end. Prevents double-fire (server broadcasts
// both `phase:'betting'` AND `state{phase:'betting'}` so both handlers trigger).
// Critical for tie bets because `place_tie` on the server is a TOGGLE — a second
// call silently cancels the bet. Applies to ALL tables (VIP + standard freeze).
let _bettingHandled = false;

// Remove any stale freeze from previous sessions
try { localStorage.removeItem('vl_bj_freeze'); } catch(e) {}

function _loadFreeze() { /* no-op — freeze is session-only */ }
function _saveFreeze() { /* no-op — freeze is session-only */ }

function _clearFreezeBet() {
  _frozenBet = 0; _frozenTie = false; _freezePending = false;
  _updateFreezeUI();
}

function toggleFreeze() {
  // Cancel any pending overlay auto-close
  const ov = document.getElementById('bet-overlay');
  if (ov) clearTimeout(ov._closeTimer);

  const isVIP = BJ_TABLE.label === 'vip';

  // ── VIP mode: freeze button locks/unlocks the Tie Bet decision across rounds.
  // The decision itself (YES/NO) is made via the "Place Tie Bet?" overlay each
  // round UNLESS frozen, in which case the last decision auto-applies.
  if (isVIP) {
    if (_tieFrozen) {
      _tieFrozen = false;
      _updateFreezeUI();
      showIngameToast('🔓 Decision Unfrozen', 'You will be asked again next round.');
    } else {
      if (!_tieDecision) {
        showIngameToast('No Decision to Freeze', 'Pick YES or NO on a tie bet first, then freeze.');
        return;
      }
      _tieFrozen = true;
      _updateFreezeUI();
      const label = _tieDecision === 'yes' ? 'ALWAYS PLACE TIE BET' : 'ALWAYS SKIP TIE BET';
      showIngameToast('🔒 Decision Frozen', label);
    }
    return;
  }

  // ── Standard mode: original behaviour (freeze main bet + tie bet together) ──
  if (_frozenBet > 0) {
    // Currently frozen — unfreeze
    const wasInBetting = window._lastBJState?.phase === 'betting' && !_betPlaced;
    _frozenBet = 0; _frozenTie = false;
    _saveFreeze();
    _updateFreezeUI();
    if (wasInBetting) {
      _applyBetUIMode();
      const ov = document.getElementById('bet-overlay');
      if (ov) ov.style.display = 'flex';
      showIngameToast('🔓 Freeze Removed', 'Choose your bet for this round.');
    } else {
      showIngameToast('🔓 Freeze Removed', 'You will choose your bet manually next round.');
    }
  } else {
    // Not frozen — freeze current bet
    const currentBet = pendingBet || (window._lastBJState?.seats?.[mySeatIndex]?.bet) || 0;
    if (!currentBet || currentBet < BJ_TABLE.minBet) {
      showIngameToast('No Bet to Freeze', 'Place a bet first, then freeze it.');
      return;
    }
    const tieActive = (window._lastBJState?.seats?.[mySeatIndex]?.tieBet || 0) > 0;
    _frozenBet = currentBet;
    _frozenTie = tieActive;
    _saveFreeze();
    _updateFreezeUI();
    const tieMsg = _frozenTie ? ' + Tie Bet' : '';
    showIngameToast('🔒 Bet Frozen', `$${_frozenBet.toLocaleString()}${tieMsg} auto-places every round.`);
  }
}

function _updateFreezeUI() {
  const isVIP = BJ_TABLE.label === 'vip';
  const bb = document.getElementById('btn-freeze-bar');
  const si = document.getElementById('seat-freeze-indicator');

  if (isVIP) {
    // VIP: freeze button locks the player's YES/NO tie-bet decision across rounds.
    // Without a prior decision the button is a hint to make one in the overlay.
    if (bb) {
      if (_tieFrozen && _tieDecision) {
        const label = _tieDecision === 'yes' ? 'TIE: YES' : 'TIE: NO';
        bb.textContent = `🔒 Frozen — ${label}`;
        bb.className   = 'freeze-btn-bar freeze-btn-bar-active';
      } else if (_tieDecision) {
        const label = _tieDecision === 'yes' ? 'YES' : 'NO';
        bb.textContent = `🔓 Freeze (${label})`;
        bb.className   = 'freeze-btn-bar';
      } else {
        bb.textContent = `🔒 Freeze Tie Decision`;
        bb.className   = 'freeze-btn-bar';
      }
    }
    if (si) {
      if (_tieFrozen && _tieDecision) {
        si.textContent   = _tieDecision === 'yes' ? '🔒 TIE: YES' : '🔒 TIE: NO';
        si.style.display = 'inline-block';
      } else {
        si.textContent   = '';
        si.style.display = 'none';
      }
    }
    return;
  }

  // Standard
  const isFrozen = _frozenBet > 0;
  if (bb) {
    bb.textContent = isFrozen
      ? `🔓 Unfreeze ($${_frozenBet.toLocaleString()}${_frozenTie ? ' +TIE' : ''})`
      : `🔒 Freeze Bet`;
    bb.className = isFrozen ? 'freeze-btn-bar freeze-btn-bar-active' : 'freeze-btn-bar';
  }
  if (si) {
    si.textContent = isFrozen ? `🔒 $${_frozenBet.toLocaleString()}${_frozenTie ? ' +TIE' : ''}` : '';
    si.style.display = isFrozen ? 'inline-block' : 'none';
  }
}

function _applyFreezeIfActive() {
  if (!_frozenBet || _betPlaced) return;
  // Auto-place frozen bet
  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
  if (_frozenBet > avail) {
    // Can't afford frozen bet — unfreeze and let player choose manually
    _frozenBet = 0; _frozenTie = false; _saveFreeze(); _updateFreezeUI();
    showIngameToast('Freeze Removed', 'Insufficient chips for frozen bet.');
    return;
  }
  pendingBet = _frozenBet;
  updateBetDisplay();
  _sendBet();
  // Auto-place tie bet if frozen
  if (_frozenTie) {
    setTimeout(() => {
      const tieCost = 100;
      const walletAfterBet = (window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips);
      if (walletAfterBet >= tieCost) sendMsg('place_tie');
    }, 200);
  }
}
let _lobbyMode     = null;   // 'single' | 'multi'
let _pendingRoomId = null;
let _isSinglePlayer = false;
var myChips        = 0;

window._bjRoomId        = null;
window._serverSettled   = false;
window._intentionalExit = false;
window._lastBJState     = null;

// ── Semicircle seat positions ──────────────────────────────
// 6 DOM zones arranged in a casino semicircle
// Zone IDs: seat-0 through seat-5
// My seat is assigned by server (random) — could be any of the 6
// Visual positions on table:
//   [seat-0]  [seat-1]  [seat-2]     ← top arc
//      [seat-3]  [seat-4]  [seat-5]  ← bottom arc (closest to player)

// Map server seatIndex → visual zone index (0-5)
// Since any seat could be mine, we just map server indices to visual positions
// preserving relative order, with mySeat always at visual zone closest to bottom
// Visual zone = server seat index directly.
// This guarantees every player at the table sees the same seat layout.
// Server assigns seats randomly (0-5), so players still appear in different
// positions each game — but everyone agrees on who sits where.
function getVisualZone(serverIdx, allServerSeats) {
  // Direct 1:1 mapping: server seat index IS the visual zone
  if (serverIdx >= 0 && serverIdx < 6) return serverIdx;
  return -1;
}

// ─────────────────────────────────────────────────────
// LOBBY
// ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────
// LOBBY — Mode selection, Single Player, Multiplayer waiting room
// ─────────────────────────────────────────────────────

let _multiWaitTimer  = null;  // interval for 5-min countdown
let _multiWaitSecs   = 300;   // 5 minutes
let _multiRoomId     = null;  // room created for multiplayer waiting
let _isInvitedJoiner = false; // true when entering via an accepted invite

// When an invited friend enters via accepted invite: show the multi lobby
// with host controls hidden. Mid-game join fast-forwards automatically once
// the server pushes active game state over the WebSocket.
function _setupInvitedJoinerLobby(roomId, user) {
  _isInvitedJoiner = true;
  _showStep('lobby-step-multi');

  ['lobby-multi-timer-row','lobby-multi-invite-panel','lobby-multi-host-actions']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  const seatsList = document.getElementById('lobby-seats-list');
  if (seatsList && !document.getElementById('invited-wait-msg')) {
    const msg = document.createElement('div');
    msg.id = 'invited-wait-msg';
    msg.style.cssText = 'text-align:center;margin:14px 0;color:#c9a84c;font-weight:700;font-size:15px';
    msg.textContent = 'Waiting for host to start the game…';
    seatsList.insertAdjacentElement('afterend', msg);

    const exitBtn = document.createElement('button');
    exitBtn.className = 'btn-secondary';
    exitBtn.style.cssText = 'width:100%;margin-top:8px;font-size:12px;padding:10px 14px';
    exitBtn.textContent = '← Exit';
    exitBtn.onclick = () => { window._intentionalExit = true; window.location.replace('/'); };
    msg.insertAdjacentElement('afterend', exitBtn);
  }

  connectWS(user.username, user.token, roomId);
}
let _isInvitedJoiner = false; // true when entering via an accepted invite

// When an invited friend enters via accepted invite: show the multi lobby
// with host controls hidden. Mid-game join fast-forwards automatically once
// the server pushes active game state over the WebSocket.
function _setupInvitedJoinerLobby(roomId, user) {
  _isInvitedJoiner = true;
  _showStep('lobby-step-multi');

  ['lobby-multi-timer-row','lobby-multi-invite-panel','lobby-multi-host-actions']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  const seatsList = document.getElementById('lobby-seats-list');
  if (seatsList && !document.getElementById('invited-wait-msg')) {
    const msg = document.createElement('div');
    msg.id = 'invited-wait-msg';
    msg.style.cssText = 'text-align:center;margin:14px 0;color:#c9a84c;font-weight:700;font-size:15px';
    msg.textContent = 'Waiting for host to start the game…';
    seatsList.insertAdjacentElement('afterend', msg);

    const exitBtn = document.createElement('button');
    exitBtn.className = 'btn-secondary';
    exitBtn.style.cssText = 'width:100%;margin-top:8px;font-size:12px;padding:10px 14px';
    exitBtn.textContent = '← Exit';
    exitBtn.onclick = () => { window._intentionalExit = true; window.location.replace('/'); };
    msg.insertAdjacentElement('afterend', exitBtn);
  }

  connectWS(user.username, user.token, roomId);
}

function _showStep(id) {
  ['lobby-step-choose','lobby-step-single','lobby-step-multi'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? 'block' : 'none';
  });
}

function backToChoose() {
  // Cancel any running multi timer
  if (_multiWaitTimer) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; }
  _multiRoomId = null;
  _showStep('lobby-step-choose');
}

function chooseLobby(mode) {
  _lobbyMode = mode;
  _isSinglePlayer = (mode === 'single');
  if (typeof SFX !== 'undefined') SFX.click();
  const tmb = BJ_TABLE.minBet || 100;
  if (mode === 'single') {
    _showStep('lobby-step-single');
    _pendingRoomId = `bj_${tmb}_${Date.now()}_private`;
    startAdCountdown(() => enterTableNow());
  } else {
    _pendingRoomId = `bj_${tmb}_${Date.now()}`;
    _multiRoomId   = _pendingRoomId;
    window._bjRoomId = _pendingRoomId;
    _showStep('lobby-step-multi');
    _startMultiWait();
    _loadMultiFriends();
    _connectHostToLobby();
  }
}

// Host joins its own WS room as soon as it enters the multi lobby, so that any
// invited friend who joins later sees the host in the player list and so that
// a single 'startGame' message from the host can kick betting for everyone.
async function _connectHostToLobby() {
  let enterOk = false;
  try {
    const res = await fetch('/api/game/bj/enter', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+(igmToken||'')},
      credentials:'include',
      body: JSON.stringify({ tableMinBet: BJ_TABLE.minBet || 100 })
    });
    const d = await res.json();
    if (d?.ok) {
      enterOk = true;
      if (typeof igmBank !== 'undefined') igmBank = d.newBankBalance;
    } else {
      showIngameToast('Entry Failed', d?.error || 'Could not draw wallet from bank.');
    }
  } catch(e) {
    showIngameToast('Entry Failed', 'Server error — please try again.');
  }
  if (!enterOk) {
    // Return to mode-select so the user can retry; session has no bank debit
    _showStep('lobby-step-choose');
    if (_multiWaitTimer) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; }
    return;
  }
  connectWS(myUsername, igmToken, _multiRoomId);
}

// ── Single player: ad countdown ──────────────────────
function startAdCountdown(onComplete) {
  const fill = document.getElementById('lobby-ad-fill');
  const cnt  = document.getElementById('lobby-ad-cnt');
  const btn  = document.getElementById('lobby-enter-btn');
  if (!fill || !cnt || !btn) return;

  let t = 10;
  cnt.textContent  = t;
  fill.style.width = '0%';
  btn.disabled     = true;
  btn.textContent  = 'ENTER TABLE →';

  const iv = setInterval(() => {
    t--;
    cnt.textContent  = t;
function startNow() {
  if (_multiWaitTimer) { clearInterval(_multiWaitTimer); _multiWaitTimer = null; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMsg('startGame');
  } else {
    enterTableNow();
  }
}

// ── Multiplayer invite (lobby) ────────────────────────
let _multiInviteFriends = [];

async function _loadMultiFriends() {
  try {
    // igmToken is set by the IIFE from bj_user sessionStorage — use it directly
    const token = igmToken || (typeof authToken !== 'undefined' ? authToken : '');
    if (!token) { _multiInviteFriends = []; return; }
    const res = await fetch('/api/game/friends', {
      headers: { 'Authorization': 'Bearer ' + token }, credentials: 'include'
    });
    const d = await res.json();
    // API returns already-accepted friends — no filtering needed
    _multiInviteFriends = d.friends || d.data || [];
    console.log('[BJ Lobby] Friends loaded:', _multiInviteFriends.length);
  } catch(e) {
    console.warn('[BJ Lobby] Could not load friends:', e.message);
    _multiInviteFriends = [];
  }
}

function onMultiInviteInput(val) {
  const dd = document.getElementById('lobby-multi-invite-dropdown');
  if (!dd) return;

  // Show all friends when empty, filter when typing
  const query = val.trim().toLowerCase();
  const matches = query
    ? _multiInviteFriends.filter(f =>
        (f.username||f.friend_username||'').toLowerCase().includes(query)
      ).slice(0, 8)
    : _multiInviteFriends.slice(0, 8); // show all friends on empty/focus

  dd.innerHTML = '';

  if (!matches.length) {
    // Show a helpful message instead of hiding
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:10px 12px;font-size:12px;color:#7a9ac0;font-style:italic';
    msg.textContent = query ? 'No matches found.' : 'No friends yet — type a username to invite anyone.';
    dd.appendChild(msg);
    dd.style.display = 'block';
    return;
  }

  // Header label
  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:2px;color:#4aabff;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.06)';
  hdr.textContent = 'Friends';
  dd.appendChild(hdr);

  matches.forEach(f => {
    const name = f.username || f.friend_username;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;font-size:13px;color:#e8dfc0;border-bottom:1px solid rgba(255,255,255,.04);transition:background .15s';
    row.innerHTML = `
      <span style="width:26px;height:26px;border-radius:50%;background:rgba(201,168,76,.2);border:1px solid rgba(201,168,76,.3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#c9a84c;flex-shrink:0">${name[0].toUpperCase()}</span>
      <span style="flex:1">${name}</span>
      <span style="font-size:10px;color:#4aabff">🤝 Friend</span>`;
    row.onmouseenter = () => row.style.background = 'rgba(26,92,170,.2)';
    row.onmouseleave = () => row.style.background = '';
    row.onmousedown = () => {
      document.getElementById('lobby-invite-input').value = name;
      dd.style.display = 'none';
    };
  try {
    const res = await fetch('/api/friends/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      credentials: 'include',
      body: JSON.stringify({
        toUsername:   username,
        roomId:       roomId,
        tableMinBet:  BJ_TABLE.minBet || 100,
        game:         'blackjack',
        tableConfig:  {
          minBet: BJ_TABLE.minBet || 100,
          maxBet: BJ_TABLE.maxBet || 500,
          wallet: BJ_TABLE.walletSize || 2500,
          walletSize: BJ_TABLE.walletSize || 2500,
          tieBet: BJ_TABLE.tieBet || 100,
          tieBetPayout: BJ_TABLE.tieBetPayout || 2000,
          blackjackPayout: BJ_TABLE.blackjackPayout || null,
          tier: BJ_TABLE.label || 'standard',
        },
        expiresIn:    300  // 5 minutes
      })
    });
    const d = await res.json();
    if (d.ok) {
      st.textContent = '✅ Invite sent to ' + username + '! (expires in 5 min)';
// [LINE 406 MISSING — no Read snapshot covers it]
// [LINE 407 MISSING — no Read snapshot covers it]
// [LINE 408 MISSING — no Read snapshot covers it]
// [LINE 409 MISSING — no Read snapshot covers it]
// [LINE 410 MISSING — no Read snapshot covers it]
// [LINE 411 MISSING — no Read snapshot covers it]
// [LINE 412 MISSING — no Read snapshot covers it]
// [LINE 413 MISSING — no Read snapshot covers it]
// [LINE 414 MISSING — no Read snapshot covers it]
// [LINE 415 MISSING — no Read snapshot covers it]
// [LINE 416 MISSING — no Read snapshot covers it]
// [LINE 417 MISSING — no Read snapshot covers it]
// [LINE 418 MISSING — no Read snapshot covers it]
// [LINE 419 MISSING — no Read snapshot covers it]
// [LINE 420 MISSING — no Read snapshot covers it]
// [LINE 421 MISSING — no Read snapshot covers it]
// [LINE 422 MISSING — no Read snapshot covers it]
// [LINE 423 MISSING — no Read snapshot covers it]
// [LINE 424 MISSING — no Read snapshot covers it]
async function enterTableNow() {
  if (typeof SFX !== 'undefined') SFX.click();
  const roomId = _pendingRoomId || `bj_${BJ_TABLE.minBet||100}_${Date.now()}`;
  const user   = JSON.parse(sessionStorage.getItem('bj_user') || '{}');

  try {
    const d = await fetch('/api/game/bj/enter', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+(user.token||igmToken||'')},
      credentials:'include',
      body: JSON.stringify({ tableMinBet: BJ_TABLE.minBet || 100 })
    }).then(r => r.json());
    if (d.ok && typeof igmBank !== 'undefined') igmBank = d.newBankBalance;
  } catch(e) {}

  st.textContent = 'Sending…'; st.style.color = '#7a9ac0';
  try {
    const res = await fetch('/api/friends/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      credentials: 'include',
      body: JSON.stringify({
        toUsername:   username,
        roomId:       roomId,
        tableMinBet:  100,
        game:         'blackjack',
        expiresIn:    300  // 5 minutes
      })
    });
    const d = await res.json();
    if (d.ok) {
      st.textContent = '✅ Invite sent to ' + username + '! (expires in 5 min)';
      st.style.color = '#22c55e';
      inp.value = '';
      setTimeout(() => { st.textContent = ''; }, 6000);
    } else {
      st.textContent = '❌ ' + (d.error || 'Failed to send');
      st.style.color = '#fca5a5';
    }
  } catch(e) {
  }
}

document.addEventListener('click', e => {
  const dd = document.getElementById('lobby-multi-invite-dropdown');
  const inp = document.getElementById('lobby-invite-input');
  if (dd && inp && !dd.contains(e.target) && e.target !== inp) dd.style.display = 'none';
});

async function enterTableNow() {
  if (typeof SFX !== 'undefined') SFX.click();
  const roomId = _pendingRoomId || `bj_100_${Date.now()}`;
  const user   = JSON.parse(sessionStorage.getItem('bj_user') || '{}');

  try {
  const dd = document.getElementById('lobby-multi-invite-dropdown');
  const inp = document.getElementById('lobby-invite-input');
  if (dd && inp && !dd.contains(e.target) && e.target !== inp) dd.style.display = 'none';
});

async function enterTableNow() {
  if (typeof SFX !== 'undefined') SFX.click();
  const roomId = _pendingRoomId || `bj_${BJ_TABLE.minBet||100}_${Date.now()}`;
  const user   = JSON.parse(sessionStorage.getItem('bj_user') || '{}');

  // Deduct wallet from bank BEFORE entering the game. If this fails, abort —
  // otherwise exit would credit a wallet that was never drawn.
  let enterOk = false;
  try {
    const d = await fetch('/api/game/bj/enter', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+(user.token||igmToken||'')},
      credentials:'include',
      body: JSON.stringify({ tableMinBet: BJ_TABLE.minBet || 100 })
    }).then(r => r.json());
    if (d?.ok) {
      enterOk = true;
      if (typeof igmBank !== 'undefined') igmBank = d.newBankBalance;
    } else {
      showIngameToast('Entry Failed', d?.error || 'Could not draw wallet from bank.');
    }
  } catch(e) {
    showIngameToast('Entry Failed', 'Server error — please try again.');
  }
  if (!enterOk) return;

  window._bjRoomId = roomId;
  document.getElementById('screen-lobby').classList.remove('active');
  document.getElementById('screen-game').classList.add('active');
  document.getElementById('ingame-menu-btn').style.display = 'flex';

  connectWS(user.username || myUsername, user.token || igmToken, roomId);
}

// ─────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────
function connectWS(username, token, roomId) {
  myUsername   = username;
  mySessionId  = 'bj_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  window._bjRoomId = roomId;

  const ov = document.createElement('div');
  ov.id = 'vurglife-connect-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#070e08;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px';
  ov.innerHTML = `
    <div style="font-family:'Cinzel Decorative',serif;font-size:38px;letter-spacing:6px;color:#c9a84c">BLACKJACK</div>
    <div style="color:#7a9ac0;font-size:13px;letter-spacing:2px;text-transform:uppercase">Connecting as ${username}…</div>
    <div style="width:180px;height:2px;background:#1a2a1a;border-radius:2px;overflow:hidden">
      <div id="vl-connect-bar" style="height:100%;width:0%;background:#c9a84c;transition:width .4s ease"></div>
    </div>`;
  document.body.appendChild(ov);
  let pct=0;
  const bar=ov.querySelector('#vl-connect-bar');
  const bt=setInterval(()=>{pct=Math.min(pct+8,85);if(bar)bar.style.width=pct+'%';},200);
  const rmOv=()=>{clearInterval(bt);if(bar)bar.style.width='100%';setTimeout(()=>ov.remove(),300);};

  const tableMinBet = BJ_TABLE.minBet || 100;
  const tokParam = token ? `&token=${encodeURIComponent(token)}` : '';
  const url = `${BJ_WS_URL}/blackjack?roomId=${encodeURIComponent(roomId)}&userId=${encodeURIComponent(username)}&sessionId=${encodeURIComponent(mySessionId)}&minBet=${tableMinBet}${tokParam}`;
  ws = new WebSocket(url);

  const timeout = setTimeout(() => { ws.close(); rmOv(); showIngameToast('Connection Failed','Server not responding.'); }, 10000);

  ws.onopen = () => {
    clearTimeout(timeout);
  ws.onclose   = () => { if (!window._intentionalExit) setTimeout(() => reconnectWS(token,roomId), 3000); };
}

function sendMsg(type, data={}) { if (!ws||ws.readyState!==WebSocket.OPEN) return; ws.send(JSON.stringify({type,...data})); }
// [LINE 544 MISSING — no Read snapshot covers it]
// [LINE 545 MISSING — no Read snapshot covers it]
// [LINE 546 MISSING — no Read snapshot covers it]
// [LINE 547 MISSING — no Read snapshot covers it]
// [LINE 548 MISSING — no Read snapshot covers it]
// [LINE 549 MISSING — no Read snapshot covers it]
// [LINE 550 MISSING — no Read snapshot covers it]
// [LINE 551 MISSING — no Read snapshot covers it]
// [LINE 552 MISSING — no Read snapshot covers it]
// [LINE 553 MISSING — no Read snapshot covers it]
// [LINE 554 MISSING — no Read snapshot covers it]
// [LINE 555 MISSING — no Read snapshot covers it]
// [LINE 556 MISSING — no Read snapshot covers it]
function applyState(state) {
  if (!state) return;
  window._lastBJState = state;

  // While any player is sitting in lobby-step-multi, keep the player list in
  // sync with the server's seat map so everyone sees the same roster.
  const lobbyStep = document.getElementById('lobby-step-multi');
  if (lobbyStep && lobbyStep.style.display !== 'none' && state.seats) {
    const entries = Object.entries(state.seats).sort((a,b)=>(+a[0])-(+b[0]));
    const players = entries.map(([idx,s],i) => ({
      username: s.displayName || s.userId || 'Player',
      isHost: i === 0
    }));
    _renderMultiSeats(players);
  }

  // Find my seat
  mySeatIndex = null;
  for (const [idx,seat] of Object.entries(state.seats||{})) {
    if (seat.isYou) { mySeatIndex = parseInt(idx); break; }
  }

  // Sync wallet
  const mySeat = mySeatIndex !== null ? state.seats?.[mySeatIndex] : null;
  if (mySeat) {
    myChips = mySeat.wallet;
    if (typeof igmWallet !== 'undefined') igmWallet = myChips;
    const ce = document.getElementById('my-chips');
    if (ce) ce.textContent = '$' + myChips.toLocaleString();
    // Keep bet overlay wallet in sync
    const ow = document.getElementById('bet-overlay-wallet');
    if (ow) ow.textContent = '$' + myChips.toLocaleString();
  }

  // Sync tie bet button — amount is tier-specific
  const tieBetVal = mySeat?.tieBet || 0;
  const tieBetAmt = BJ_TABLE.tieBet || 100;
  const tbBtn = document.getElementById('btn-tie-bet');
  if (tbBtn) {
    const amtLabel = '$' + tieBetAmt.toLocaleString();
    tbBtn.classList.toggle('tie-bet-active', tieBetVal > 0);
    tbBtn.textContent = tieBetVal > 0 ? `✓ TIE BET (${amtLabel})` : `🎯 TIE BET — ${amtLabel}`;
  }
  // Sync tie bet hint payout copy
  const hint = document.getElementById('bet-tiebet-hint');
  if (hint) {
    const payout = BJ_TABLE.tieBetPayout || 2000;
    if (BJ_TABLE.label === 'vip') {
      hint.innerHTML = `<strong style="color:#ffd700">$${payout.toLocaleString()} Bonus</strong><br>Wins if your total = dealer's total`;
    } else {
      hint.innerHTML = `<strong style="color:#ffd700">$2,000 Bonus</strong> · $500 main bet: <strong style="color:#ffd700">$3,000 Bonus</strong><br>Wins if your total = dealer's total`;
    }
  }

  if (state.phase === 'betting' && lastPhase !== 'betting') {
    _betPlaced = false; pendingBet = 0; updateBetDisplay();
    // Restore chip section visibility for new round — only if not frozen
  const tableMinBet = BJ_TABLE.minBet || 100;
  const tokParam = token ? `&token=${encodeURIComponent(token)}` : '';
  const url = `${BJ_WS_URL}/blackjack?roomId=${encodeURIComponent(roomId)}&userId=${encodeURIComponent(username)}&sessionId=${encodeURIComponent(mySessionId)}&minBet=${tableMinBet}${tokParam}`;
  ws = new WebSocket(url);

  const timeout = setTimeout(() => { ws.close(); rmOv(); showIngameToast('Connection Failed','Server not responding.'); }, 10000);

  ws.onopen = () => {
    clearTimeout(timeout);
    // NOTE: wallet is server-authoritative (initialized from tier walletSize).
    // We no longer send set_wallet — it was causing wallet resets on reconnect.
    ws.send(JSON.stringify({ type:'set_name',   name:   username }));
    ws.send(JSON.stringify({ type:'set_avatar', avatar: window._myAvatar || '' }));
    rmOv();
    const nameEl = document.getElementById('my-name');
    if (nameEl) nameEl.textContent = (window._myAvatar ? window._myAvatar+' ' : '') + username;
  };

  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch(err) { console.error('[BJ]',err); } };
  ws.onclose   = () => { if (!window._intentionalExit) setTimeout(() => reconnectWS(token,roomId), 3000); };
  ws.onerror   = ()  => { clearTimeout(timeout); rmOv(); };
}

function reconnectWS(token,roomId) {
  if (window._intentionalExit || window._serverSettled) return;
  const tableMinBet = BJ_TABLE.minBet || 100;
  const tokParam = token ? `&token=${encodeURIComponent(token)}` : '';
  const url = `${BJ_WS_URL}/blackjack?roomId=${encodeURIComponent(roomId)}&userId=${encodeURIComponent(myUsername)}&sessionId=${encodeURIComponent(mySessionId)}&minBet=${tableMinBet}${tokParam}`;
  ws = new WebSocket(url);
  ws.onopen    = () => { ws.send(JSON.stringify({type:'set_name',name:myUsername})); };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch(err) {} };
  ws.onclose   = () => { if (!window._intentionalExit) setTimeout(() => reconnectWS(token,roomId), 3000); };
}

function sendMsg(type, data={}) { if (!ws||ws.readyState!==WebSocket.OPEN) return; ws.send(JSON.stringify({type,...data})); }
function sendAction(type) { sendMsg(type); }
  }

  // Sync tie bet button — amount is tier-specific
  const tieBetVal = mySeat?.tieBet || 0;
  const tieBetAmt = BJ_TABLE.tieBet || 100;
  const tbBtn = document.getElementById('btn-tie-bet');
  if (tbBtn) {
    const amtLabel = '$' + tieBetAmt.toLocaleString();
    tbBtn.classList.toggle('tie-bet-active', tieBetVal > 0);
    tbBtn.textContent = tieBetVal > 0 ? `✓ TIE BET (${amtLabel})` : `🎯 TIE BET — ${amtLabel}`;
  }
  // Sync tie bet hint payout copy
  const hint = document.getElementById('bet-tiebet-hint');
  if (hint) {
    const payout = BJ_TABLE.tieBetPayout || 2000;
    if (BJ_TABLE.label === 'vip') {
      hint.innerHTML = `<strong style="color:#ffd700">$${payout.toLocaleString()} Bonus</strong><br>Wins if your total = dealer's total`;
    } else {
      hint.innerHTML = `<strong style="color:#ffd700">$2,000 Bonus</strong> · $500 main bet: <strong style="color:#ffd700">$3,000 Bonus</strong><br>Wins if your total = dealer's total`;
    }
  }

  if (state.phase === 'betting' && lastPhase !== 'betting') {
    _betPlaced = false; pendingBet = 0; updateBetDisplay();
    if (!_bettingHandled) {
      _bettingHandled = true;
      if (BJ_TABLE.label === 'vip') {
        _startVipBettingFlow();
      } else if (_frozenBet === 0) {
        _applyBetUIMode();
      } else {
        setTimeout(() => _applyFreezeIfActive(), 300);
      }
    }
  }

  renderDealer(state);
  renderSeats(state);
  updateUI(state);

  // Drive bet overlay — never show when freeze is active (standard only).
  // VIP: no overlay at all. Main bet auto-places silently. Tie bet is controlled
  // via the merged bottom-bar "Tie Bet Freeze" button, which works in any phase.
  const overlay = document.getElementById('bet-overlay');
  if (overlay) {
    const isVIP = BJ_TABLE.label === 'vip';
    let show;
    if (isVIP) {
      show = false;
    } else {
      show = state.phase==='betting' && mySeatIndex!==null && !_betPlaced && (mySeat?.bet||0)===0 && _frozenBet===0;
    }
    if (show && overlay.style.display !== 'flex') overlay.style.display = 'flex';
    else if (!show && overlay.style.display !== 'none') overlay.style.display = 'none';
  }

  lastPhase = state.phase;
}

  if (mySeat) {
    myChips = mySeat.wallet;
    if (typeof igmWallet !== 'undefined') igmWallet = myChips;
    const ce = document.getElementById('my-chips');
    if (ce) ce.textContent = '$' + myChips.toLocaleString();
    // Keep bet overlay wallet in sync
    const ow = document.getElementById('bet-overlay-wallet');
    if (ow) ow.textContent = '$' + myChips.toLocaleString();
  }

  // Sync tie bet button — amount is tier-specific
  const tieBetVal = mySeat?.tieBet || 0;
  const tieBetAmt = BJ_TABLE.tieBet || 100;
  const tbBtn = document.getElementById('btn-tie-bet');
  if (tbBtn) {
    const amtLabel = '$' + tieBetAmt.toLocaleString();
    tbBtn.classList.toggle('tie-bet-active', tieBetVal > 0);
    tbBtn.textContent = tieBetVal > 0 ? `✓ TIE BET (${amtLabel})` : `🎯 TIE BET — ${amtLabel}`;
  }
  // Sync tie bet hint payout copy
  const hint = document.getElementById('bet-tiebet-hint');
  if (hint) {
    const payout = BJ_TABLE.tieBetPayout || 2000;
    if (BJ_TABLE.label === 'vip') {
      hint.innerHTML = `<strong style="color:#ffd700">$${payout.toLocaleString()} Bonus</strong><br>Wins if your total = dealer's total`;
    } else {
      hint.innerHTML = `<strong style="color:#ffd700">$2,000 Bonus</strong> · $500 main bet: <strong style="color:#ffd700">$3,000 Bonus</strong><br>Wins if your total = dealer's total`;
    }
  }

  if (state.phase === 'betting' && lastPhase !== 'betting') {
    _betPlaced = false; pendingBet = 0; updateBetDisplay();
    if (BJ_TABLE.label === 'vip') {
      // Silent auto-place; overlay stays hidden. Short window for Tie Bet tap.
      setTimeout(() => _autoPlaceFixedBet(), 2500);
    } else if (_frozenBet === 0) {
      _applyBetUIMode();
    } else {
      setTimeout(() => _applyFreezeIfActive(), 300);
    }
  }

  renderDealer(state);
  renderSeats(state);
  updateUI(state);

  // Drive bet overlay — never show when freeze is active (standard only).
  // VIP: no overlay at all. Main bet auto-places silently. Tie bet is controlled
  // via the merged bottom-bar "Tie Bet Freeze" button, which works in any phase.
  const overlay = document.getElementById('bet-overlay');
  if (overlay) {
    const isVIP = BJ_TABLE.label === 'vip';
    let show;
    if (isVIP) {
      show = false;
    } else {
      show = state.phase==='betting' && mySeatIndex!==null && !_betPlaced && (mySeat?.bet||0)===0 && _frozenBet===0;
    }
    if (show && overlay.style.display !== 'flex') overlay.style.display = 'flex';
    else if (!show && overlay.style.display !== 'none') overlay.style.display = 'none';
  }

  lastPhase = state.phase;
}

// ─────────────────────────────────────────────────────
// PHASE HANDLER
// ─────────────────────────────────────────────────────
function handlePhase(msg) {
  // First transition out of the waiting lobby: when the server signals the
  // round is starting (any phase other than 'waiting'), move everyone still on
  // the lobby screen to the game screen.
  if (msg.phase && msg.phase !== 'waiting') {
    const lobby = document.getElementById('screen-lobby');
    if (lobby && lobby.classList.contains('active')) {
      lobby.classList.remove('active');
      const game = document.getElementById('screen-game');
      if (game) game.classList.add('active');
      const menu = document.getElementById('ingame-menu-btn');
      if (menu) menu.style.display = 'flex';
    }
  }

  const gs = document.getElementById('game-status');
  if (gs) gs.textContent = fmtPhase(msg.phase);

  // Phase banner — brief flash for key transitions only (not player_action)
  const bannerMap = {
    deal:'DEALING CARDS', insurance:'INSURANCE?',
    dealer:"DEALER'S TURN", payout:'RESULTS'
  };
  const banner = document.getElementById('phase-banner');
  if (banner) {
    if (bannerMap[msg.phase]) {
      banner.textContent = bannerMap[msg.phase];
      banner.classList.add('visible');
      clearTimeout(banner._t);
      banner._t = setTimeout(() => banner.classList.remove('visible'), 1400);
    } else {
      // Hide immediately for other phases
      banner.classList.remove('visible');
    }
  }

  if (msg.duration) startCountdown(msg.duration / 1000, false);
  else              stopCountdown();

  if (msg.phase === 'betting') {
    _betPlaced = false; pendingBet = 0; updateBetDisplay();
    const rl = document.getElementById('bet-round-label');
    if (rl) rl.textContent = window._lastBJState?.roundNum || '—';

    if (_bettingHandled) {
      // Already initialised by the state-handler path for this round — just
      // refresh UI and bail, do NOT re-send place_tie (server toggles it off).
      _updateFreezeUI();
    } else {
      _bettingHandled = true;
      if (BJ_TABLE.label === 'vip') {
        // VIP: 5s "Place Tie Bet?" overlay at start of each round, unless the
        // player froze their last decision — in which case apply it silently and
        // auto-place the main bet.
        const ov = document.getElementById('bet-overlay');
        if (ov) ov.style.display = 'none';
        _updateFreezeUI();
        _startVipBettingFlow();
      } else if (_frozenBet > 0) {
        // FREEZE IS ACTIVE — never show betting overlay, auto-place silently
        const ov = document.getElementById('bet-overlay');
        if (ov) ov.style.display = 'none';
        _updateFreezeUI();
        setTimeout(() => _applyFreezeIfActive(), 300);
      } else {
        // No freeze — show betting overlay (standard chips)
        _applyBetUIMode();
        const ov = document.getElementById('bet-overlay');
        if (ov) ov.style.display = 'flex';
        _updateFreezeUI();
      }
    }
  } else {
    const ov = document.getElementById('bet-overlay');
    if (ov) ov.style.display = 'none';
    _hideTieBetPrompt();
  }

  if (msg.phase === 'deal' && window._lastBJState) setTimeout(() => runDealAnim(window._lastBJState), 50);
  if (msg.phase === 'player_action') {
    // Countdown is managed per-player by handleYourTurn — don't stop it here
    if (window._lastBJState) showControls(window._lastBJState);
  }
  if (msg.phase === 'dealer') { stopCountdown(); const pa=document.getElementById('player-actions'); if(pa)pa.style.display='none'; }
  if (msg.phase === 'payout') { stopCountdown(); setTimeout(() => { const seat=window._lastBJState?.seats?.[mySeatIndex]; if(seat?.result)flashTable(seat.result[0]); }, 400); }
  if (msg.phase === 'round_end') {
    stopCountdown();
    ['player-actions','insurance-panel'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
    _hideTieBetPrompt();
    // Release the one-shot betting-phase guard so the next round can fire once.
    _bettingHandled = false;
    // Clear per-round VIP tie decision when not frozen so the prompt returns next round.
    if (BJ_TABLE.label === 'vip' && !_tieFrozen) {
      _tieDecision = null;
      _updateFreezeUI();
    }
  }
}

function handleYourTurn(msg) {
  if (mySeatIndex === null && window._lastBJState) {
    for (const [idx,seat] of Object.entries(window._lastBJState.seats||{})) {
      if (seat.isYou) { mySeatIndex = parseInt(idx); break; }
    }
  }

  if (msg.seatIndex === mySeatIndex) {
    // MY TURN — start 10s countdown and show action buttons
    if (msg.duration) startCountdown(msg.duration / 1000, true);
    const gs = document.getElementById('game-status');
    if (gs) gs.textContent = 'Your turn — Hit or Stand';
    if (window._lastBJState) showControls(window._lastBJState);
  } else {
    // ANOTHER PLAYER'S TURN — hide my buttons, stop my countdown, show who is playing
    stopCountdown();
    const pa = document.getElementById('player-actions');
    if (pa) pa.style.display = 'none';
    const allSeats = window._lastBJState?.seats || {};
    const activeName = allSeats[msg.seatIndex]?.displayName || `Player ${msg.seatIndex + 1}`;
    const gs = document.getElementById('game-status');
    if (gs) gs.textContent = `${activeName}'s turn — waiting…`;
  }
}


function handleTieWin(msg) {
  if (typeof SFX !== 'undefined') SFX.bj?.();

  const name  = msg.displayName || 'A player';
  const bonus = msg.bonus ? '$' + msg.bonus.toLocaleString() : '';
// [LINE 860 MISSING — no Read snapshot covers it]
// [LINE 861 MISSING — no Read snapshot covers it]
// [LINE 862 MISSING — no Read snapshot covers it]
// [LINE 863 MISSING — no Read snapshot covers it]
// [LINE 864 MISSING — no Read snapshot covers it]
// [LINE 865 MISSING — no Read snapshot covers it]
// [LINE 866 MISSING — no Read snapshot covers it]
// [LINE 867 MISSING — no Read snapshot covers it]
// [LINE 868 MISSING — no Read snapshot covers it]
// [LINE 869 MISSING — no Read snapshot covers it]
// [LINE 870 MISSING — no Read snapshot covers it]
// [LINE 871 MISSING — no Read snapshot covers it]
// [LINE 872 MISSING — no Read snapshot covers it]
// [LINE 873 MISSING — no Read snapshot covers it]
// [LINE 874 MISSING — no Read snapshot covers it]
// [LINE 875 MISSING — no Read snapshot covers it]
// [LINE 876 MISSING — no Read snapshot covers it]
// [LINE 877 MISSING — no Read snapshot covers it]
// [LINE 878 MISSING — no Read snapshot covers it]
// [LINE 879 MISSING — no Read snapshot covers it]
// [LINE 880 MISSING — no Read snapshot covers it]
// [LINE 881 MISSING — no Read snapshot covers it]
// [LINE 882 MISSING — no Read snapshot covers it]
// [LINE 883 MISSING — no Read snapshot covers it]
// [LINE 884 MISSING — no Read snapshot covers it]
// [LINE 885 MISSING — no Read snapshot covers it]
// [LINE 886 MISSING — no Read snapshot covers it]
// [LINE 887 MISSING — no Read snapshot covers it]
// [LINE 888 MISSING — no Read snapshot covers it]
// [LINE 889 MISSING — no Read snapshot covers it]
// [LINE 890 MISSING — no Read snapshot covers it]
// [LINE 891 MISSING — no Read snapshot covers it]
// [LINE 892 MISSING — no Read snapshot covers it]
// [LINE 893 MISSING — no Read snapshot covers it]
// [LINE 894 MISSING — no Read snapshot covers it]
// [LINE 895 MISSING — no Read snapshot covers it]
// [LINE 896 MISSING — no Read snapshot covers it]
// [LINE 897 MISSING — no Read snapshot covers it]
// [LINE 898 MISSING — no Read snapshot covers it]
// [LINE 899 MISSING — no Read snapshot covers it]
// [LINE 900 MISSING — no Read snapshot covers it]
// [LINE 901 MISSING — no Read snapshot covers it]
// [LINE 902 MISSING — no Read snapshot covers it]
// [LINE 903 MISSING — no Read snapshot covers it]
// [LINE 904 MISSING — no Read snapshot covers it]
// [LINE 905 MISSING — no Read snapshot covers it]
// [LINE 906 MISSING — no Read snapshot covers it]
// [LINE 907 MISSING — no Read snapshot covers it]
// [LINE 908 MISSING — no Read snapshot covers it]
// [LINE 909 MISSING — no Read snapshot covers it]
// [LINE 910 MISSING — no Read snapshot covers it]
// [LINE 911 MISSING — no Read snapshot covers it]
// [LINE 912 MISSING — no Read snapshot covers it]
// [LINE 913 MISSING — no Read snapshot covers it]
// [LINE 914 MISSING — no Read snapshot covers it]
// [LINE 915 MISSING — no Read snapshot covers it]
// [LINE 916 MISSING — no Read snapshot covers it]
// [LINE 917 MISSING — no Read snapshot covers it]
// [LINE 918 MISSING — no Read snapshot covers it]
// [LINE 919 MISSING — no Read snapshot covers it]
// [LINE 920 MISSING — no Read snapshot covers it]
// [LINE 921 MISSING — no Read snapshot covers it]
// [LINE 922 MISSING — no Read snapshot covers it]
// [LINE 923 MISSING — no Read snapshot covers it]
// [LINE 924 MISSING — no Read snapshot covers it]
// [LINE 925 MISSING — no Read snapshot covers it]
// [LINE 926 MISSING — no Read snapshot covers it]
// [LINE 927 MISSING — no Read snapshot covers it]
// [LINE 928 MISSING — no Read snapshot covers it]
// [LINE 929 MISSING — no Read snapshot covers it]
// [LINE 930 MISSING — no Read snapshot covers it]
// [LINE 931 MISSING — no Read snapshot covers it]
// [LINE 932 MISSING — no Read snapshot covers it]
// [LINE 933 MISSING — no Read snapshot covers it]
// [LINE 934 MISSING — no Read snapshot covers it]
// [LINE 935 MISSING — no Read snapshot covers it]
// [LINE 936 MISSING — no Read snapshot covers it]
// [LINE 937 MISSING — no Read snapshot covers it]
// [LINE 938 MISSING — no Read snapshot covers it]
// [LINE 939 MISSING — no Read snapshot covers it]
// [LINE 940 MISSING — no Read snapshot covers it]
// [LINE 941 MISSING — no Read snapshot covers it]
// [LINE 942 MISSING — no Read snapshot covers it]
// [LINE 943 MISSING — no Read snapshot covers it]
// [LINE 944 MISSING — no Read snapshot covers it]
// [LINE 945 MISSING — no Read snapshot covers it]
// [LINE 946 MISSING — no Read snapshot covers it]
// [LINE 947 MISSING — no Read snapshot covers it]
// [LINE 948 MISSING — no Read snapshot covers it]
// [LINE 949 MISSING — no Read snapshot covers it]
// [LINE 950 MISSING — no Read snapshot covers it]
// [LINE 951 MISSING — no Read snapshot covers it]
// [LINE 952 MISSING — no Read snapshot covers it]
// [LINE 953 MISSING — no Read snapshot covers it]
// [LINE 954 MISSING — no Read snapshot covers it]
// [LINE 955 MISSING — no Read snapshot covers it]
// [LINE 956 MISSING — no Read snapshot covers it]
// [LINE 957 MISSING — no Read snapshot covers it]
// [LINE 958 MISSING — no Read snapshot covers it]
// [LINE 959 MISSING — no Read snapshot covers it]
// [LINE 960 MISSING — no Read snapshot covers it]
// [LINE 961 MISSING — no Read snapshot covers it]
// [LINE 962 MISSING — no Read snapshot covers it]
// [LINE 963 MISSING — no Read snapshot covers it]
// [LINE 964 MISSING — no Read snapshot covers it]
// [LINE 965 MISSING — no Read snapshot covers it]
// [LINE 966 MISSING — no Read snapshot covers it]
// [LINE 967 MISSING — no Read snapshot covers it]
// [LINE 968 MISSING — no Read snapshot covers it]
// [LINE 969 MISSING — no Read snapshot covers it]
// [LINE 970 MISSING — no Read snapshot covers it]
// [LINE 971 MISSING — no Read snapshot covers it]
// [LINE 972 MISSING — no Read snapshot covers it]
// [LINE 973 MISSING — no Read snapshot covers it]
// [LINE 974 MISSING — no Read snapshot covers it]
          wrapper.appendChild(box);

          // Per-hand result
          const r = seat.result?.[hi];
          if (r) {
            const rb = document.createElement('div');
            rb.className = 'result-badge-inline ' + r;
            rb.textContent = r==='blackjack'?'BLACKJACK!':(r==='tie'?'TIE!':r.toUpperCase());
            wrapper.appendChild(rb);
          }
          cardsEl.appendChild(wrapper);
        });
      } else {
        // NORMAL MODE — diff render, no full rebuild
        cardsEl.style.cssText = '';
        const flat = (hands[0]||[]).filter(c => c && c.rank);
        const existing = cardsEl.querySelectorAll('.vl-card').length;
        if (flat.length < existing) cardsEl.innerHTML = '';
        const shown = cardsEl.querySelectorAll('.vl-card').length;
        flat.slice(shown).forEach(c => {
          cardsEl.appendChild(makeVLCard(c));
          if (typeof SFX !== 'undefined') SFX.card();
        });
        cardsEl.querySelectorAll('.hand-total').forEach(e => e.remove());
        const {total, bust, bj} = handTotal(hands[0]||[]);
        if (total > 0) {
          const t = document.createElement('div');
          t.className = 'hand-total' + (bust?' bust':bj?' bj':'');
          t.textContent = bj?'BJ!':(bust?'BUST':String(total));
          cardsEl.appendChild(t);
        }
      }
    }

    // Result badge — 'tie' ranks above 'push' so players see they hit the tie bet
    const rs = document.getElementById(`seat${vz}-result`);
    if (rs && seat.result?.some(r => r !== null)) {
      const priority = ['blackjack','win','tie','push','bust','lose'];
      const best = priority.find(p => seat.result.includes(p)) || seat.result.find(r => r);
      if (best) {
        rs.className = 'result-badge-inline ' + best;
        rs.textContent = best==='blackjack'?'BLACKJACK!':(best==='tie'?'TIE!':best.toUpperCase());
      }
    }

    // My payout — show NET profit (credit minus original bet)
    if (isMe && seat.payout) {
      const grossCredit = (seat.payout||[]).reduce((a,b) => a+(b||0), 0);
    const hi   = mySeat.activeHandIdx || 0;
    const hand = (mySeat.hands||[[]])[hi] || [];
    const w    = mySeat.wallet || 0;
    const b    = mySeat.bet || 0;
    const dbl  = document.getElementById('btn-double');
    const spl  = document.getElementById('btn-split');
    const ss   = document.getElementById('split-status');
    if (dbl) dbl.disabled = hand.length !== 2 || w < b;
    if (spl) spl.disabled = hand.length !== 2 || !hand[0] || !hand[1] ||
      cardVal(hand[0]) !== cardVal(hand[1]) ||
      (mySeat.hands||[]).length >= 4 || w < b;
    if (ss) ss.textContent = mySeat.hands?.length > 1 ? `Playing Hand ${hi+1} of ${mySeat.hands.length}` : '';
  }
}

function fmtPhase(p) {
  return {waiting:'Waiting for players…',betting:'Place your bet (10s)',deal:'Dealing…',
    insurance:'Insurance?',player_action:'Your turn — Hit or Stand',dealer:"Dealer's turn",
    payout:'Payouts',round_end:'Round complete'}[p] || (p||'Connecting…');
}

// ─────────────────────────────────────────────────────
// TABLE FLASH
// ─────────────────────────────────────────────────────
// [LINE 1044 MISSING — no Read snapshot covers it]
// [LINE 1045 MISSING — no Read snapshot covers it]
// [LINE 1046 MISSING — no Read snapshot covers it]
// [LINE 1047 MISSING — no Read snapshot covers it]
// [LINE 1048 MISSING — no Read snapshot covers it]
// [LINE 1049 MISSING — no Read snapshot covers it]
// [LINE 1050 MISSING — no Read snapshot covers it]
// [LINE 1051 MISSING — no Read snapshot covers it]
// [LINE 1052 MISSING — no Read snapshot covers it]
// [LINE 1053 MISSING — no Read snapshot covers it]
// [LINE 1054 MISSING — no Read snapshot covers it]
// [LINE 1055 MISSING — no Read snapshot covers it]
// [LINE 1056 MISSING — no Read snapshot covers it]
// [LINE 1057 MISSING — no Read snapshot covers it]
// [LINE 1058 MISSING — no Read snapshot covers it]
// [LINE 1059 MISSING — no Read snapshot covers it]
// [LINE 1060 MISSING — no Read snapshot covers it]
// [LINE 1061 MISSING — no Read snapshot covers it]
// [LINE 1062 MISSING — no Read snapshot covers it]
// [LINE 1063 MISSING — no Read snapshot covers it]
// [LINE 1064 MISSING — no Read snapshot covers it]
// [LINE 1065 MISSING — no Read snapshot covers it]
// [LINE 1066 MISSING — no Read snapshot covers it]
// [LINE 1067 MISSING — no Read snapshot covers it]
// [LINE 1068 MISSING — no Read snapshot covers it]
// [LINE 1069 MISSING — no Read snapshot covers it]
// [LINE 1070 MISSING — no Read snapshot covers it]
// [LINE 1071 MISSING — no Read snapshot covers it]
// [LINE 1072 MISSING — no Read snapshot covers it]
// [LINE 1073 MISSING — no Read snapshot covers it]
// [LINE 1074 MISSING — no Read snapshot covers it]
          // Per-hand result
          const r = seat.result?.[hi];
          if (r) {
            const rb = document.createElement('div');
            rb.className = 'result-badge-inline ' + r;
            rb.textContent = r==='blackjack'?'BLACKJACK!':(r==='tie'?'TIE!':r.toUpperCase());
            wrapper.appendChild(rb);
          }
          cardsEl.appendChild(wrapper);
        });
      } else {
        // NORMAL MODE — diff render, no full rebuild
        cardsEl.style.cssText = '';
        const flat = (hands[0]||[]).filter(c => c && c.rank);
        const existing = cardsEl.querySelectorAll('.vl-card').length;
        if (flat.length < existing) cardsEl.innerHTML = '';
        const shown = cardsEl.querySelectorAll('.vl-card').length;
        flat.slice(shown).forEach(c => {
          cardsEl.appendChild(makeVLCard(c));
          if (typeof SFX !== 'undefined') SFX.card();
        });
        cardsEl.querySelectorAll('.hand-total').forEach(e => e.remove());
        const {total, bust, bj} = handTotal(hands[0]||[]);
        if (total > 0) {
          const t = document.createElement('div');
          t.className = 'hand-total' + (bust?' bust':bj?' bj':'');
          t.textContent = bj?'BJ!':(bust?'BUST':String(total));
          cardsEl.appendChild(t);
        }
      }
    }

    // Result badge — 'tie' ranks above 'push' so players see they hit the tie bet
    const rs = document.getElementById(`seat${vz}-result`);
    if (rs && seat.result?.some(r => r !== null)) {
      const priority = ['blackjack','win','tie','push','bust','lose'];
      const best = priority.find(p => seat.result.includes(p)) || seat.result.find(r => r);
      if (best) {
        rs.className = 'result-badge-inline ' + best;
        rs.textContent = best==='blackjack'?'BLACKJACK!':(best==='tie'?'TIE!':best.toUpperCase());
      }
    }

    // My payout — show NET profit (credit minus original bet)
    if (isMe && seat.payout) {
      const grossCredit = (seat.payout||[]).reduce((a,b) => a+(b||0), 0);
      // Net = what was credited back minus the bet that was already deducted
      // For blackjack ($500 bet): gross=$1,250, net=+$750
      // For win ($500 bet):       gross=$1,000, net=+$500
      // For lose ($500 bet):      gross=$0,     net=-$500

function fmtPhase(p) {
  return {waiting:'Waiting for players…',betting:'Place your bet (10s)',deal:'Dealing…',
    insurance:'Insurance?',player_action:'Your turn — Hit or Stand',dealer:"Dealer's turn",
    payout:'Payouts',round_end:'Round complete'}[p] || (p||'Connecting…');
}

// ─────────────────────────────────────────────────────
// TABLE FLASH
// ─────────────────────────────────────────────────────
function flashTable(result) {
  const oval = document.getElementById('oval-table'); if (!oval) return;
  oval.classList.remove('flash-win','flash-lose','flash-bj');
  if (result==='blackjack') { oval.classList.add('flash-bj'); if(typeof SFX!=='undefined')SFX.bj?.(); }
  else if (result==='win')  { oval.classList.add('flash-win'); if(typeof SFX!=='undefined')SFX.win(); }
  else if (result==='lose'||result==='bust') { oval.classList.add('flash-lose'); if(typeof SFX!=='undefined')SFX.lose(); }
  else if (result==='push') { if(typeof SFX!=='undefined')SFX.push?.(); }
  setTimeout(() => oval.classList.remove('flash-win','flash-lose','flash-bj'), 700);

  const flash = document.getElementById('result-flash');
  const txt   = document.getElementById('result-flash-text');
  // Don't overwrite an active tie win celebration
  if (flash && flash._tieTimer) return;
  if (flash && txt) {
  const txt   = document.getElementById('result-flash-text');
  // Don't overwrite an active tie win celebration
  if (flash && flash._tieTimer) return;
  if (flash && txt) {
    const labels = {blackjack:'BLACKJACK!',win:'WIN',tie:'TIE!',lose:'LOSE',bust:'BUST',push:'PUSH'};
    const colors = {blackjack:'#ffd700',win:'#44ff88',tie:'#ffd700',lose:'#ff5555',bust:'#ff5555',push:'#4ab8ff'};
    txt.textContent = labels[result]||''; txt.style.color = colors[result]||'#fff';
    flash.style.display = 'flex';
    setTimeout(() => flash.style.display = 'none', 1500);
  }
}
  const txt   = document.getElementById('result-flash-text');
  // Don't overwrite an active tie win celebration
  if (flash && flash._tieTimer) return;
  if (flash && txt) {
    const labels = {blackjack:'BLACKJACK!',win:'WIN',tie:'TIE!',lose:'LOSE',bust:'BUST',push:'PUSH'};
    const colors = {blackjack:'#ffd700',win:'#44ff88',tie:'#ffd700',lose:'#ff5555',bust:'#ff5555',push:'#4ab8ff'};
    txt.textContent = labels[result]||''; txt.style.color = colors[result]||'#fff';
    flash.style.display = 'flex';
    setTimeout(() => flash.style.display = 'none', 1500);
  }
}

// ─────────────────────────────────────────────────────
// BET CONTROLS
// ─────────────────────────────────────────────────────

// Configure the betting overlay for the current tier.
// Standard tiers: show chip grid. VIP: hide chips, show fixed-bet display.
function _applyBetUIMode() {
  const chipSection   = document.getElementById('bet-chips-section');
  const betConfirm    = document.getElementById('bet-confirm-section');
  const fixedSection  = document.getElementById('bet-fixed-section');
  const tieBetSection = document.getElementById('bet-tiebet-section');
  const alt           = document.getElementById('bet-alert-text');
  const isVIP = BJ_TABLE.label === 'vip';

  if (chipSection)   chipSection.style.display   = 'flex';
  if (tieBetSection) tieBetSection.style.display = 'flex';

  if (isVIP) {
    if (betConfirm)   betConfirm.style.display   = 'none';
    if (fixedSection) {
      fixedSection.style.display = 'flex';
      const amtEl = document.getElementById('bet-fixed-amount');
      if (amtEl) amtEl.textContent = '$' + (BJ_TABLE.minBet || 0).toLocaleString();
    }
    if (alt) alt.textContent = 'Placing your bet…';
  } else {
    if (betConfirm)   betConfirm.style.display   = 'block';
    if (fixedSection) fixedSection.style.display = 'none';
    if (alt) alt.textContent = 'Tap a chip to bet';
  }
}

// VIP betting flow entry:
// • If the tie decision is frozen, apply it silently and auto-place the main bet.
// • Otherwise show the 5s "Place Tie Bet?" overlay; tieBetDecide() triggers the
//   main-bet auto-place once a choice is made (or on auto-skip).
function _startVipBettingFlow() {
  if (BJ_TABLE.label !== 'vip') return;
  _hideTieBetPrompt();
  if (_tieFrozen && _tieDecision) {
    if (_tieDecision === 'yes' && ws) sendMsg('place_tie');
    _updateFreezeUI();
    setTimeout(() => _autoPlaceFixedBet(), 300);
    return;
  }
  // Fresh decision required this round
  _tieDecision = null;
  _updateFreezeUI();
  _showTieBetPrompt();
}

// VIP auto-placement: bet is fixed, no chip choice — send it immediately.
// Tie bet is NOT auto-placed here; the tie decision is collected via the
// "Place Tie Bet?" overlay (or applied from the frozen decision) before this
// is called.
function _autoPlaceFixedBet() {
  if (_betPlaced) return;
  if (BJ_TABLE.label !== 'vip') return;
  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
  const amt = BJ_TABLE.minBet || 0;
  if (!amt || amt > avail) {
    const alt = document.getElementById('bet-alert-text');
    if (alt) alt.textContent = 'Insufficient wallet for fixed bet';
    return;
  }
  pendingBet = amt;
  updateBetDisplay();
  _sendBet();
}

// ── VIP Tie Bet prompt ───────────────────────────────────────
// Shows the 5s "Place Tie Bet?" overlay at start of betting phase.
// Player picks YES / NO (or lets it auto-skip to NO on timeout).
// After the decision is recorded, the main bet is auto-placed.
function _showTieBetPrompt() {
  const ov = document.getElementById('tie-bet-overlay');
  if (!ov) return;
  const amtEl   = document.getElementById('tie-amount-display');
  const hintEl  = document.getElementById('tie-payout-hint');
  const rEl     = document.getElementById('tie-round-label');
  const cdEl    = document.getElementById('tie-countdown');

  const tieAmt  = BJ_TABLE.tieBet || 100;
  const payout  = BJ_TABLE.tieBetPayout || 2000;
  if (amtEl)  amtEl.textContent  = '$' + tieAmt.toLocaleString();
  if (hintEl) hintEl.innerHTML   = `Wins if your total matches the dealer's — bonus: <strong style="color:#ffd700">$${payout.toLocaleString()}</strong>`;
  if (rEl)    rEl.textContent    = window._lastBJState?.roundNum || '—';

  ov.style.display = 'flex';

  let t = 5;
  if (cdEl) cdEl.textContent = t;
  clearInterval(_tiePromptTimer);
  _tiePromptTimer = setInterval(() => {
    t--;
    if (cdEl) cdEl.textContent = Math.max(0, t);
    if (t <= 0) {
      clearInterval(_tiePromptTimer);
      _tiePromptTimer = null;
      // Auto-skip: default to NO
      tieBetDecide('no', /*auto=*/true);
    }
  }, 1000);
}

function _hideTieBetPrompt() {
  const ov = document.getElementById('tie-bet-overlay');
  if (ov) ov.style.display = 'none';
  if (_tiePromptTimer) { clearInterval(_tiePromptTimer); _tiePromptTimer = null; }
}

function tieBetDecide(choice, auto) {
  if (choice !== 'yes' && choice !== 'no') return;
  _tieDecision = choice;
  _hideTieBetPrompt();
  if (choice === 'yes' && ws) sendMsg('place_tie');
  _updateFreezeUI();
  if (!auto && typeof SFX !== 'undefined') SFX.click?.();
  // Now auto-place the fixed main bet
  setTimeout(() => _autoPlaceFixedBet(), 100);
}

function addChip(val) {
  if (typeof SFX !== 'undefined') SFX.chip();
  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
  if (val > avail) { showIngameToast('Insufficient Chips', `Need $${val.toLocaleString()} to place this bet.`); return; }
  pendingBet = val;
  updateBetDisplay();
  _sendBet();
}

function _sendBet() {
  if (!ws || pendingBet < BJ_TABLE.minBet) return;
  _betPlaced = true;
  sendMsg('place_bet', { amount: pendingBet });
  stopCountdown();

  const ov = document.getElementById('bet-overlay');
  if (!ov) return;

  // Hide chips, keep tie bet visible after bet placed
  const chipSection   = document.getElementById('bet-chips-section');
  const betConfirm    = document.getElementById('bet-confirm-section');
  const fixedSection  = document.getElementById('bet-fixed-section');
  const tieBetSection = document.getElementById('bet-tiebet-section');
  const alt           = document.getElementById('bet-alert-text');

  if (chipSection)   chipSection.style.display   = 'none';
  if (betConfirm)    betConfirm.style.display    = 'none';
  if (fixedSection)  fixedSection.style.display  = 'none';
  if (tieBetSection) tieBetSection.style.display = 'flex';
  if (alt) alt.textContent = `✓ Bet $${pendingBet.toLocaleString()} placed`;

  // Auto-close overlay after 3 seconds — but NOT in VIP: player needs the full
  // betting window to toggle tie bet since the main bet was auto-placed.
  clearTimeout(ov._closeTimer);
  if (BJ_TABLE.label !== 'vip') {
    ov._closeTimer = setTimeout(() => {
      ov.style.display = 'none';
    }, 3000);
  }
}

function placeBet() { _sendBet(); }

function placeTieBet() {
  if (!ws) return;
  sendMsg('place_tie');
  if (typeof SFX !== 'undefined') SFX.chip();
}

function updateBetDisplay() {
  const d = document.getElementById('bet-display');
  const a = document.getElementById('bet-alert-text');
  if (d) d.textContent = pendingBet > 0 ? '$' + pendingBet.toLocaleString() : '';
  if (a) a.textContent = pendingBet >= BJ_TABLE.minBet ? `Bet: $${pendingBet.toLocaleString()}` : 'Tap a chip to bet';
}

function takeInsurance(take) {
  sendMsg('insurance', { take });
  const ip = document.getElementById('insurance-panel');
  if (ip) ip.style.display = 'none';
}

// ─────────────────────────────────────────────────────
// COUNTDOWN
// ─────────────────────────────────────────────────────
let _cdInterval = null;
function startCountdown(secs, showOverlay) {
  stopCountdown();
  let t = Math.floor(secs); const TOTAL = secs;
  const cd      = document.getElementById('cd-number');
  const overlay = document.getElementById('your-turn-overlay');
  const ring    = document.getElementById('bet-ring');
  const bc      = document.getElementById('bet-countdown');

  // Only show the big centred overlay during player action turns, not betting/insurance
  if (overlay) { overlay.style.display = showOverlay ? 'flex' : 'none'; }

  const update = rem => {
    if (cd) { cd.textContent = rem; cd.classList.toggle('urgent', rem > 0 && rem <= 3); }
    if (ring) { ring.style.strokeDashoffset = 213.6*(1-rem/TOTAL); ring.style.stroke = rem<=3?'#ef4444':rem<=5?'#f87171':'#c9a84c'; }
  const alt           = document.getElementById('bet-alert-text');
  const isVIP = BJ_TABLE.label === 'vip';

  if (chipSection)   chipSection.style.display   = 'flex';
  if (tieBetSection) tieBetSection.style.display = 'flex';

  if (isVIP) {
    if (betConfirm)   betConfirm.style.display   = 'none';
    if (fixedSection) {
      fixedSection.style.display = 'flex';
      const amtEl = document.getElementById('bet-fixed-amount');
      if (amtEl) amtEl.textContent = '$' + (BJ_TABLE.minBet || 0).toLocaleString();
    }
    if (alt) alt.textContent = 'Placing your bet…';
  } else {
    if (betConfirm)   betConfirm.style.display   = 'block';
    if (fixedSection) fixedSection.style.display = 'none';
    if (alt) alt.textContent = 'Tap a chip to bet';
  }
}

// VIP auto-placement: bet is fixed, no chip choice — send it immediately.
// Tie bet is NOT auto-placed; the player must opt in each round via the
// bottom-bar "Tie Bet $X" button while the betting timer is running.
function _autoPlaceFixedBet() {
  if (_betPlaced) return;
  if (BJ_TABLE.label !== 'vip') return;
  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
  const amt = BJ_TABLE.minBet || 0;
  if (!amt || amt > avail) {
    const alt = document.getElementById('bet-alert-text');
    if (alt) alt.textContent = 'Insufficient wallet for fixed bet';
    return;
  }
  pendingBet = amt;
  updateBetDisplay();
  _sendBet();
}

function addChip(val) {
  if (typeof SFX !== 'undefined') SFX.chip();
  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
  if (val > avail) { showIngameToast('Insufficient Chips', `Need $${val.toLocaleString()} to place this bet.`); return; }
  pendingBet = val;
  updateBetDisplay();
  _sendBet();
}

function _sendBet() {
  if (!ws || pendingBet < BJ_TABLE.minBet) return;
  _betPlaced = true;
  sendMsg('place_bet', { amount: pendingBet });
  stopCountdown();

  const ov = document.getElementById('bet-overlay');
  if (!ov) return;

  // Hide chips, keep tie bet visible after bet placed
  const chipSection   = document.getElementById('bet-chips-section');
  const betConfirm    = document.getElementById('bet-confirm-section');
  const fixedSection  = document.getElementById('bet-fixed-section');
  const tieBetSection = document.getElementById('bet-tiebet-section');
  const alt           = document.getElementById('bet-alert-text');

  if (chipSection)   chipSection.style.display   = 'none';
  if (betConfirm)    betConfirm.style.display    = 'none';
  if (fixedSection)  fixedSection.style.display  = 'none';
  if (tieBetSection) tieBetSection.style.display = 'flex';
  if (alt) alt.textContent = `✓ Bet $${pendingBet.toLocaleString()} placed`;

  // Auto-close overlay after 3 seconds — but NOT in VIP: player needs the full
  // betting window to toggle tie bet since the main bet was auto-placed.
  clearTimeout(ov._closeTimer);
  if (BJ_TABLE.label !== 'vip') {
    ov._closeTimer = setTimeout(() => {
      ov.style.display = 'none';
    }, 3000);
  }
}

function placeBet() { _sendBet(); }

function placeTieBet() {
  if (!ws) return;
  sendMsg('place_tie');
  if (typeof SFX !== 'undefined') SFX.chip();
}

function updateBetDisplay() {
  const d = document.getElementById('bet-display');
  const a = document.getElementById('bet-alert-text');
  if (d) d.textContent = pendingBet > 0 ? '$' + pendingBet.toLocaleString() : '';
  if (a) a.textContent = pendingBet >= BJ_TABLE.minBet ? `Bet: $${pendingBet.toLocaleString()}` : 'Tap a chip to bet';
}

function takeInsurance(take) {
  sendMsg('insurance', { take });
  const ip = document.getElementById('insurance-panel');
  if (ip) ip.style.display = 'none';
}

// ─────────────────────────────────────────────────────
// COUNTDOWN
// ─────────────────────────────────────────────────────
let _cdInterval = null;
function startCountdown(secs, showOverlay) {
  stopCountdown();
  let t = Math.floor(secs); const TOTAL = secs;
  const cd      = document.getElementById('cd-number');
  const overlay = document.getElementById('your-turn-overlay');
  const ring    = document.getElementById('bet-ring');
  const bc      = document.getElementById('bet-countdown');

  // Only show the big centred overlay during player action turns, not betting/insurance
  if (overlay) { overlay.style.display = showOverlay ? 'flex' : 'none'; }

  const update = rem => {
    if (cd) { cd.textContent = rem; cd.classList.toggle('urgent', rem > 0 && rem <= 3); }
    if (ring) { ring.style.strokeDashoffset = 213.6*(1-rem/TOTAL); ring.style.stroke = rem<=3?'#ef4444':rem<=5?'#f87171':'#c9a84c'; }
    if (bc) bc.textContent = rem;
    if (rem <= 3 && rem > 0 && typeof SFX !== 'undefined') SFX.timer?.();
  };
  update(t);
  _cdInterval = setInterval(() => { t--; if (t <= 0) { stopCountdown(); return; } update(t); }, 1000);
}
function stopCountdown() {
  clearInterval(_cdInterval);
  const cd      = document.getElementById('cd-number');
  const overlay = document.getElementById('your-turn-overlay');
  if (overlay) overlay.style.display = 'none';
  if (cd) cd.classList.remove('urgent');
}

// ─────────────────────────────────────────────────────
// DEAL ANIMATION
// ─────────────────────────────────────────────────────
let _dealActive = false;
function runDealAnim(state) {
  if (_dealActive) return;
  const oval = document.getElementById('oval-table'); if (!oval) return;
  oval.querySelectorAll('.deal-anim-card').forEach(e => e.remove());
  _dealActive = true;
  const deck = document.getElementById('deck-pile');
  if (deck) deck.classList.add('visible');

  const ow=oval.offsetWidth, oh=oval.offsetHeight, cx=ow/2, cy=oh/2;

  // Visual zone positions for 6 seats in semicircle
  const vzPos = [
    {x:ow*0.18, y:oh*0.22},  // vz0 top-left
    {x:ow*0.50, y:oh*0.16},  // vz1 top-centre
    {x:ow*0.82, y:oh*0.22},  // vz2 top-right
    {x:ow*0.22, y:oh*0.72},  // vz3 bottom-left
    {x:ow*0.50, y:oh*0.80},  // vz4 bottom-centre (primary)
    {x:ow*0.78, y:oh*0.72},  // vz5 bottom-right
  ];
  const dealerPos = {x:cx, y:oh*0.12};

  if (!document.getElementById('bj-deal-kf')) {
    const s=document.createElement('style');s.id='bj-deal-kf';
    s.textContent='@keyframes bjDealCard{0%{opacity:1;transform:translate(0,0) rotate(0deg)}100%{opacity:.85;transform:translate(var(--dx),var(--dy)) rotate(var(--dr))}}';
    document.head.appendChild(s);
  }

  const seats    = Object.keys(state.seats||{}).map(Number).sort();
  const allSeats = seats;
  const order    = [];
  for (let r=0; r<2; r++) {
    seats.forEach(si => order.push({si, dealer:false}));
    order.push({si:-1, dealer:true});
  }

  let idx = 0;
  const dealOne = () => {
    if (idx >= order.length) { if(deck)deck.classList.remove('visible'); _dealActive=false; return; }
    const {si, dealer} = order[idx];
    const target = dealer ? dealerPos : (vzPos[getVisualZone(si, allSeats)] || {x:cx,y:cy});

    const card = document.createElement('div');
    card.className = 'deal-anim-card';
    const tx = (target.x - cx + (Math.random()-.5)*12).toFixed(1);
    const ty = (target.y - cy + (Math.random()-.5)*10).toFixed(1);
    const dr = ((Math.random()-.5)*16).toFixed(1)+'deg';
    card.style.cssText = `position:absolute;left:${cx-14}px;top:${cy-20}px;width:28px;height:40px;border-radius:5px;background:#083a7a url('backVurgLife.png') center/80% no-repeat;border:1.5px solid #8b6914;box-shadow:0 2px 8px rgba(0,0,0,.8);--dx:${tx}px;--dy:${ty}px;--dr:${dr};animation:bjDealCard .25s ease-out forwards;z-index:50`;
    oval.appendChild(card);
    if (typeof SFX !== 'undefined') SFX.card();
    card.addEventListener('animationend', () => { card.style.transition='opacity .18s'; card.style.opacity='0'; setTimeout(()=>card.remove(),200); }, {once:true});
    idx++;
    setTimeout(dealOne, 50);
  };
  dealOne();
}

// ─────────────────────────────────────────────────────
// AUTO-LOGIN
// ─────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (window._intentionalExit||window._serverSettled||!igmToken||!myChips) return;
  const mb = BJ_TABLE.minBet || 100;
  navigator.sendBeacon('/api/game/bj/exit-beacon?token='+encodeURIComponent(igmToken),
    new Blob([JSON.stringify({remainingWallet:myChips,tableMinBet:mb})],{type:'application/json'}));
});

window.addEventListener('DOMContentLoaded', () => {
  _loadFreeze();
  _updateFreezeUI();

  // ── Path 1: URL has roomId params (from direct link or invite redirect) ──
  const urlParams = new URLSearchParams(window.location.search);
  const urlRoomId = urlParams.get('roomId');
  const urlMinBet = urlParams.get('minBet');

  if (urlRoomId) {
    // Skip lobby entirely — connect directly to the specified room
    const user = JSON.parse(sessionStorage.getItem('bj_user') || '{}');
    myUsername = user.username || '';
    _isSinglePlayer = urlRoomId.includes('_private');
    _lobbyMode = _isSinglePlayer ? 'single' : 'multi';
    window._bjRoomId = urlRoomId;
    _pendingRoomId   = urlRoomId;

    document.getElementById('screen-lobby').classList.remove('active');
    document.getElementById('screen-game').classList.add('active');
    document.getElementById('ingame-menu-btn').style.display = 'flex';

    if (!user.username) {
      // Not logged in via sessionStorage — try IGM token fallback
      setTimeout(() => {
        const tok = typeof igmToken !== 'undefined' ? igmToken : '';
        const uname = typeof myUsername !== 'undefined' ? myUsername : 'Player';
        connectWS(uname, tok, urlRoomId);
      }, 300);
    } else {
      // Handle table entry if not already done
      if (!JSON.parse(sessionStorage.getItem('bj_table') || '{}').enterHandled) {
        fetch('/api/game/bj/enter', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+user.token},
          credentials:'include', body:JSON.stringify({tableMinBet: Number(urlMinBet) || 100})
        }).catch(() => {});
      }
      sessionStorage.removeItem('bj_user');
      sessionStorage.removeItem('bj_table');
      connectWS(user.username, user.token, urlRoomId);
    }
    return;
  }

  // ── Path 2: sessionStorage set ──────────────────────────────
  try {
    const uj = sessionStorage.getItem('bj_user');