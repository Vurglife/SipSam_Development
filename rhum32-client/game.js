// ============================================
// RHUM32 GAME CLIENT v2.0 — Multiplayer
// - Mode select: Multiplayer / Single Player
// - Browse open tables, quick join, create
// - Invite friends (3-min expiry)
// - In-game menu: invite, chat, send/request chips, replenish, exit
// ============================================

const SERVER_HTTP = "http://localhost:3000";
const SERVER_WS   = "ws://localhost:3003";

let ws             = null;
let mySessionId    = null;
let myUsername     = "";
let currentRoomId  = null;
let gameMode       = "multiplayer";
let lastStatus     = "";
let lastRound      = 0;
let currentFrontBet = 100;
let currentTieBet   = 0;
let selectedRounds  = 0;
let selectedMinBet  = 0;
let tableMinBet     = 100;
let tableMaxBet     = 500;
let tieBetMin       = 50;
let tieBetMax       = 100;
let selectedTransferTarget = null;
let authToken = null;
let tableConfig = null;
let _lobbyFriends = null;

// Single token resolver used everywhere (friends, invite, replenish, exit) —
// mirrors SipSam's igmToken pattern: prefer the captured global, fall back to
// the handoff sessionStorage blob so a cleared/empty authToken never silently
// breaks friends-list loading or wallet settlement.
function rhumToken() {
    if (authToken) return authToken;
    try { return JSON.parse(sessionStorage.getItem('rhum32_user') || '{}').token || null; }
    catch (e) { return null; }
}

// Remaining wallet to return to bank on exit. In-game: live game wallet.
// Pre-game (mode/lobby, no round played yet): the full walletSize the
// dashboard already drew from the bank — returning 0 here would burn it.
function rhumRemainingWallet() {
    const me = lastState && mySessionId ? lastState.players?.[mySessionId] : null;
    if (me && typeof me.wallet === 'number') return me.wallet;
    return Math.max(0, Number(tableConfig?.wallet) || 0);
}

// Fire wallet-return to bank then return to the dashboard (not the landing
// page). Mirrors SipSam: always settle, navigate regardless of result.
async function rhumSettleAndLeave() {
    const token = rhumToken();
    window._intentionalExit = true;
    if (token) {
        try {
            await fetch('/api/game/rhum32/exit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({
                    remainingWallet: rhumRemainingWallet(),
                    tableMinBet: selectedMinBet || tableMinBet
                })
            });
        } catch (e) { console.error('[Rhum32] exit settle error:', e); }
    }
    if (ws) { try { ws.close(); } catch (e) {} }
    ws = null;
    setTimeout(() => { window.location.href = '/'; }, 200);
}

// ============================================
// SOUND SYSTEM — Web Audio API (SipSam-style)
// ============================================
let _audioCtx = null;
let soundEnabled = JSON.parse(localStorage.getItem('vl_sound') ?? 'true');
function getAudioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
}
function playTone(freq, type, duration, vol, delay) {
    type=type||'sine'; duration=duration||0.15; vol=vol||0.18; delay=delay||0;
    if (!soundEnabled) return;
    try {
        const ctx=getAudioCtx(), osc=ctx.createOscillator(), gain=ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type=type; osc.frequency.value=freq;
        const t=ctx.currentTime+delay;
        gain.gain.setValueAtTime(0,t);
        gain.gain.linearRampToValueAtTime(vol,t+0.01);
        gain.gain.exponentialRampToValueAtTime(0.001,t+duration);
        osc.start(t); osc.stop(t+duration+0.05);
    } catch(e){}
}
const SFX = {
    click:   function(){ playTone(880,'sine',0.08,0.1); },
    deal:    function(){ playTone(1200,'sine',0.06,0.12); setTimeout(function(){playTone(1000,'sine',0.06,0.1);},60); },
    chip:    function(){ playTone(700,'triangle',0.1,0.15); },
    win:     function(){ [523,659,784,1047].forEach(function(f,i){playTone(f,'sine',0.3,0.22,i*0.12);}); },
    lose:    function(){ [300,250,200].forEach(function(f,i){playTone(f,'sawtooth',0.18,0.14,i*0.1);}); },
    timer:   function(){ playTone(880,'square',0.05,0.08); },
    chat:    function(){ playTone(880,'sine',0.08,0.1); setTimeout(function(){playTone(1100,'sine',0.08,0.1);},100); },
    confirm: function(){ playTone(600,'sine',0.1,0.12); setTimeout(function(){playTone(800,'sine',0.1,0.12);},100); },
};

// ============================================
// VURGLIFE AUTO-LOGIN — read session from dashboard
// ============================================
window.addEventListener('DOMContentLoaded', function() {
    console.log('[Rhum32] DOMContentLoaded fired');
    const statusEl = document.getElementById('login-status');
    try {
        const userJson  = sessionStorage.getItem('rhum32_user');
        const tableJson = sessionStorage.getItem('rhum32_table');

        console.log('[Rhum32] sessionStorage rhum32_user:', userJson ? 'FOUND' : 'MISSING');
        console.log('[Rhum32] sessionStorage rhum32_table:', tableJson ? 'FOUND' : 'MISSING');

        if (!userJson) {
            console.log('[Rhum32] No user data — redirecting to dashboard');
            if (statusEl) statusEl.textContent = 'No session found. Redirecting...';
            setTimeout(function() { window.location.href = '/'; }, 500);
            return;
        }

        const user  = JSON.parse(userJson);
        if (!user || !user.username) {
            console.log('[Rhum32] Invalid user data — redirecting');
            if (statusEl) statusEl.textContent = 'Invalid session. Redirecting...';
            setTimeout(function() { window.location.href = '/'; }, 500);
            return;
        }

        const table = tableJson ? JSON.parse(tableJson) : null;

        // Set globals
        myUsername = user.username;
        authToken = user.token || '';
        tableConfig = table;

        if (table && table.minBet) {
            selectedMinBet = table.minBet;
            tableMinBet = table.minBet;
            if (table.maxBet) tableMaxBet = table.maxBet;
            if (table.tieBetMin !== undefined) tieBetMin = table.tieBetMin;
            if (table.tieBetMax !== undefined) tieBetMax = table.tieBetMax;
        }

        console.log('[Rhum32] Auto-login as:', myUsername, '| table:', selectedMinBet);

        // Populate lobby banner
        const wallet = table?.wallet || 0;
        const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        el('lci-table',  '$' + (selectedMinBet || 100).toLocaleString());
        el('lci-minbet', '$' + (selectedMinBet || 100).toLocaleString());
        el('lci-wallet', '$' + wallet.toLocaleString());

        // Clear session storage AFTER successful read
        sessionStorage.removeItem('rhum32_user');
        sessionStorage.removeItem('rhum32_table');
        sessionStorage.removeItem('rhum32_wallet');

        // Go to mode selection
        showScreen('screen-mode');
        console.log('[Rhum32] Mode select screen shown');

    } catch(e) {
        console.error('[Rhum32] Auto-login error:', e);
        if (statusEl) statusEl.textContent = 'Error: ' + e.message + '. Redirecting...';
        setTimeout(function() { window.location.href = '/'; }, 1500);
    }
});

// ============================================
// SERVER CONNECTION
// ============================================
async function joinRoom(username, opts = {}) {
    const body = { username, ...opts };
    console.log('[Rhum32] joinRoom POST body:', JSON.stringify(body));
    let res;
    try {
        res = await fetch(`${SERVER_HTTP}/matchmake/joinOrCreate/rhum32_room`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
    } catch(fetchErr) {
        console.error('[Rhum32] Fetch failed:', fetchErr);
        throw new Error("Cannot reach server: " + fetchErr.message);
    }
    console.log('[Rhum32] Matchmake response status:', res.status);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[Rhum32] Matchmake error:', err);
        throw new Error(err.error || "Matchmake failed: " + res.status);
    }
    const reservation = await res.json();
    console.log("[Rhum32] Reservation:", reservation);
    const { sessionId, roomId } = reservation;
    currentRoomId = roomId;
    const wsUrl = `${SERVER_WS}/${roomId}?sessionId=${sessionId}`;
    console.log('[Rhum32] Connecting WebSocket:', wsUrl);
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
            console.log('[Rhum32] WebSocket OPEN');
            mySessionId = sessionId;
            resolve(socket);
        };
        socket.onmessage = (event) => {
            if (typeof event.data === "string") {
                try { handleServerMessage(JSON.parse(event.data)); }
                catch(e) { console.log("Parse error:", e); }
            }
        };
        socket.onerror = (e) => { console.error("[Rhum32] WS error:", e); reject(new Error("WebSocket error")); };
        socket.onclose = (e) => {
            console.log("[Rhum32] WS closed:", e.code, e.reason);
        };
    });
}

// ============================================
// CARD HELPERS
// ============================================
function getSuitSymbol(card)  { return {h:'\u2665',d:'\u2666',c:'\u2663',s:'\u2660'}[card[1]]||'\u2660'; }
function getSuitClass(card)   { return {h:'hearts',d:'diamonds',c:'clubs',s:'spades'}[card[1]]||'spades'; }
function getDisplayValue(card){ return {T:'10',J:'J',Q:'Q',K:'K',A:'A'}[card[0]]||card[0]; }
function isRedSuit(card)      { return card[1]==='h'||card[1]==='d'; }

function createCardEl(card, options = {}) {
    const el = document.createElement('div');
    if (!card || card === '??') {
        el.className = 'card card-back';
        if (options.animate) el.classList.add('card-deal-anim');
        return el;
    }
    el.className = 'card card-front ' + getSuitClass(card);
    el.dataset.card = card;
    if (options.shown) el.classList.add('shown');
    if (options.zeroed) el.classList.add('zero-card');
    if (options.animate) el.classList.add('card-deal-anim');
    el.innerHTML = '<span class="mc-val">' + getDisplayValue(card) + '</span><span class="mc-suit">' + getSuitSymbol(card) + '</span>';
    return el;
}

// ============================================
// SCREENS
// ============================================
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
}

function showControls(status) {
    ['bet-controls','decision-controls','my-cards-display','reveal-info'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    if (status === 'betting')  document.getElementById('bet-controls').style.display = 'block';
    else if (status === 'decision') {
        document.getElementById('decision-controls').style.display = 'block';
        document.getElementById('my-cards-display').style.display = 'block';
    } else if (status === 'revealing' || status === 'roundEnd') {
        document.getElementById('my-cards-display').style.display = 'block';
        document.getElementById('reveal-info').style.display = 'block';
    }
}

// ============================================
// MODE SELECT + LOBBY NAVIGATION
// ============================================
function pickMode(mode) {
    gameMode = mode;
    const label = document.getElementById('lobby-mode-label');
    if (label) label.textContent = mode === 'multiplayer' ? 'MULTIPLAYER' : 'SINGLE PLAYER';
    document.getElementById('invite-section').style.display = mode === 'multiplayer' ? 'block' : 'none';
    document.getElementById('lobby-status').textContent = mode === 'multiplayer'
        ? 'Select rounds, invite friends, then start'
        : 'Select rounds, then start solo';
    selectedRounds = 0;
    document.querySelectorAll('.btn-rounds').forEach(b => b.classList.remove('selected'));
    updateLobbyInfo();
    showScreen('screen-lobby');
}

function backToModeSelect() {
    showScreen('screen-mode');
}

function backToDashboard() {
    // Wallet was already drawn from the bank by the dashboard before this
    // page loaded, so leaving the mode/lobby screen must settle it too.
    rhumSettleAndLeave();
}

function selectRounds(rounds, btn) {
    selectedRounds = rounds;
    document.querySelectorAll('.btn-rounds').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    updateLobbyInfo();
}

function updateLobbyInfo() {
    const info = document.getElementById('lobby-selection-info');
    if (selectedRounds) info.textContent = `$${selectedMinBet} table, ${selectedRounds} rounds`;
    else info.textContent = "Select rounds to begin.";
    document.getElementById('btn-start-game').disabled = !selectedRounds;
}

function startGame() {
    if (!selectedRounds) return;
    console.log('[Rhum32] startGame called — mode:', gameMode, 'rounds:', selectedRounds, 'minBet:', selectedMinBet);
    connectAndStart();
}

async function connectAndStart() {
    if (!selectedMinBet || !selectedRounds) {
        console.error('[Rhum32] Missing minBet or rounds:', selectedMinBet, selectedRounds);
        return;
    }
    const statusEl = document.getElementById('lobby-status');
    statusEl.textContent = "Connecting to table...";
    document.getElementById('btn-start-game').disabled = true;
    try {
        console.log('[Rhum32] Calling joinRoom:', myUsername, gameMode, selectedMinBet, selectedRounds);
        ws = await joinRoom(myUsername, {
            tableMinBet: selectedMinBet,
            maxRounds: selectedRounds,
            wallet: tableConfig?.wallet || 5000,
            mode: gameMode
        });
        console.log('[Rhum32] WebSocket connected, sending startGame');
        showScreen('screen-game');
        ws.send(JSON.stringify({ type: "startGame", tableMinBet: selectedMinBet, rounds: selectedRounds }));
    } catch(e) {
        console.error('[Rhum32] connectAndStart error:', e);
        statusEl.textContent = "Failed: " + e.message;
        document.getElementById('btn-start-game').disabled = false;
    }
}

// ── LOBBY INVITE (SipSam-style) ───────────────────────────
async function getLobbyFriends() {
    if (_lobbyFriends) return _lobbyFriends;
    try {
        const token = rhumToken();
        if (!token) return [];
        const res = await fetch('/api/friends', {
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(r => r.json());
        _lobbyFriends = res.friends || [];
        return _lobbyFriends;
    } catch(e) { return []; }
}

async function searchAllPlayers(q) {
    try {
        const token = rhumToken();
        if (!token) return [];
        const res = await fetch('/api/friends/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ query: q })
        }).then(r => r.json());
        return res.users || res.results || [];
    } catch(e) { return []; }
}

let _lobbySearchTimer = null;

function onLobbyInviteInput(val) {
    const dd = document.getElementById('lobby-invite-dropdown');
    if (!dd) return;
    clearTimeout(_lobbySearchTimer);
    const q = val.toLowerCase().trim();
    if (!q) {
        getLobbyFriends().then(friends => renderLobbyDropdown(dd, friends, [], ''));
        return;
    }
    getLobbyFriends().then(friends => {
        const friendMatches = friends.filter(f => f.username.toLowerCase().includes(q));
        renderLobbyDropdown(dd, friendMatches, [], q);
    });
    _lobbySearchTimer = setTimeout(async () => {
        const friends      = await getLobbyFriends();
        const friendNames  = new Set(friends.map(f => f.username.toLowerCase()));
        const all          = await searchAllPlayers(val);
        const friendMatches    = friends.filter(f => f.username.toLowerCase().includes(q));
        const nonFriendMatches = all.filter(u => !friendNames.has(u.username.toLowerCase()));
        renderLobbyDropdown(dd, friendMatches, nonFriendMatches, q);
    }, 350);
}

function renderLobbyDropdown(dd, friends, others, q) {
    if (!friends.length && !others.length) {
        dd.innerHTML = q
            ? '<div style="padding:11px 14px;font-size:12px;color:#7ac08a">No matches. You can still type a full username to invite.</div>'
            : '<div style="padding:11px 14px;font-size:12px;color:#7ac08a">No friends yet. Type any username to search all players.</div>';
        dd.style.display = 'block';
        return;
    }
    const row = (username, label, col) => `
        <div onclick="selectLobbyInvitee('${escapeHtml(username)}')"
             style="padding:9px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(26,74,46,.5)"
             onmouseenter="this.style.background='rgba(26,140,56,.1)'" onmouseleave="this.style.background=''">
          <span style="width:28px;height:28px;border-radius:50%;background:#1a4a2e;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;color:#c9a84c">${username[0].toUpperCase()}</span>
          <span style="flex:1;font-size:13px;color:#f0fff0">${escapeHtml(username)}</span>
          <span style="font-size:10px;color:${col};letter-spacing:.5px">${label}</span>
        </div>`;
    let html = '';
    if (friends.length) {
        html += '<div style="padding:5px 14px 3px;font-size:9px;font-weight:700;letter-spacing:2px;color:#4aab5f;text-transform:uppercase">Friends</div>';
        html += friends.map(f => row(f.username, 'Friend', '#4aab5f')).join('');
    }
    if (others.length) {
        html += '<div style="padding:5px 14px 3px;font-size:9px;font-weight:700;letter-spacing:2px;color:#7ac08a;text-transform:uppercase;border-top:1px solid #1a4a2e;margin-top:2px">Other Players</div>';
        html += others.map(u => row(u.username, 'Player', '#7ac08a')).join('');
    }
    dd.innerHTML = html;
    dd.style.display = 'block';
}

function onLobbyInviteFocus() {
    getLobbyFriends().then(friends => {
        const dd = document.getElementById('lobby-invite-dropdown');
        if (dd) renderLobbyDropdown(dd, friends, [], '');
    });
}

function selectLobbyInvitee(username) {
    const inp = document.getElementById('invite-username');
    if (inp) inp.value = username;
    const dd = document.getElementById('lobby-invite-dropdown');
    if (dd) dd.style.display = 'none';
}

document.addEventListener('click', e => {
    const dd = document.getElementById('lobby-invite-dropdown');
    if (dd && !dd.contains(e.target) && e.target.id !== 'invite-username')
        dd.style.display = 'none';
});

async function sendLobbyInvite() {
    const input    = document.getElementById('invite-username');
    const statusEl = document.getElementById('invite-status');
    if (!input || !statusEl) return;
    const username = input.value.trim();
    if (!username) { statusEl.textContent = 'Enter a username.'; statusEl.style.color = '#fca5a5'; return; }

    statusEl.textContent = 'Sending invite...'; statusEl.style.color = '#7ac08a';

    try {
        const token = rhumToken();
        if (!token) { statusEl.textContent = 'Not authenticated.'; statusEl.style.color = '#fca5a5'; return; }

        const res = await fetch('/api/friends/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                toUsername: username,
                game: 'rhum32',
                roomId: currentRoomId,
                tableMinBet: selectedMinBet || tableMinBet,
                tableConfig: {
                    minBet: selectedMinBet || tableMinBet,
                    maxBet: tableMaxBet,
                    wallet: tableConfig?.wallet || 0,
                    minBank: tableConfig?.minBank || 0,
                    rounds: selectedRounds || 10,
                    roomId: currentRoomId
                }
            })
        });
        const data = await res.json();
        if (data.ok || data.success) {
            statusEl.textContent = 'Invite sent to ' + username + '!'; statusEl.style.color = '#4aab5f';
            input.value = '';
        } else {
            statusEl.textContent = data.error || 'Failed to send invite'; statusEl.style.color = '#fca5a5';
        }
    } catch(e) {
        statusEl.textContent = 'Could not send invite'; statusEl.style.color = '#fca5a5';
    }
}

// ============================================
// IN-GAME MENU
// ============================================
function toggleGameMenu() {
    const menu = document.getElementById('game-menu');
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
}

function showInviteOverlay() {
    document.getElementById('game-menu').style.display = 'none';
    document.getElementById('invite-overlay').style.display = 'flex';
    loadFriendsList();
}

async function loadFriendsList() {
    const container = document.getElementById('invite-friends-list');
    if (!container) return;
    container.innerHTML = '<div style="color:#7ac08a;font-size:12px;padding:8px">Loading...</div>';
    const friends = await getLobbyFriends();
    container.innerHTML = '';
    if (!friends.length) {
        container.innerHTML = '<div style="color:#666;font-size:12px;padding:8px">No friends yet.</div>';
        return;
    }
    friends.forEach(f => {
        const div = document.createElement('div');
        div.className = 'friend-invite-item';
        div.innerHTML = `<span class="fi-name">${escapeHtml(f.username)}</span>
            <button class="btn-sm" onclick="inviteFriendToGame('${escapeHtml(f.username)}')">Invite</button>`;
        container.appendChild(div);
    });
}

async function inviteFriendToGame(username) {
    try {
        const res = await fetch('/api/friends/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + rhumToken() },
            body: JSON.stringify({
                toUsername: username, game: 'rhum32', roomId: currentRoomId,
                tableMinBet: selectedMinBet || tableMinBet,
                tableConfig: { minBet: selectedMinBet, maxBet: tableMaxBet, wallet: tableConfig?.wallet || 0, roomId: currentRoomId }
            })
        });
        const data = await res.json();
        if (data.ok || data.success) showSpeechBubble('system', 'System', 'Invite sent to ' + username, mySessionId);
        else showSpeechBubble('system', 'System', data.error || 'Invite failed', mySessionId);
    } catch(e) { showSpeechBubble('system', 'System', 'Could not send invite', mySessionId); }
    document.getElementById('invite-overlay').style.display = 'none';
}

function showChipTransfer() {
    document.getElementById('game-menu').style.display = 'none';
    document.getElementById('chip-transfer-overlay').style.display = 'flex';
    renderTransferPlayers();
}

function renderTransferPlayers() {
    const container = document.getElementById('transfer-players-list');
    container.innerHTML = '';
    if (!lastState || !lastState.players) return;
    Object.entries(lastState.players).forEach(([sid, p]) => {
        if (sid === mySessionId) return;
        const div = document.createElement('div');
        div.className = 'transfer-player-item' + (selectedTransferTarget === sid ? ' selected' : '');
        div.textContent = p.username;
        div.onclick = () => { selectedTransferTarget = sid; renderTransferPlayers(); };
        container.appendChild(div);
    });
}

function doSendChips() {
    if (!selectedTransferTarget || !ws) return;
    const amount = parseInt(document.getElementById('transfer-amount').value) || 0;
    if (amount <= 0) return;
    ws.send(JSON.stringify({ type: 'sendChips', targetSessionId: selectedTransferTarget, amount }));
    document.getElementById('chip-transfer-overlay').style.display = 'none';
}

function doRequestChips() {
    if (!selectedTransferTarget || !ws) return;
    const amount = parseInt(document.getElementById('transfer-amount').value) || 0;
    ws.send(JSON.stringify({ type: 'requestChips', targetSessionId: selectedTransferTarget, amount }));
    document.getElementById('chip-transfer-overlay').style.display = 'none';
}

function replenishWallet() {
    document.getElementById('game-menu').style.display = 'none';
    const walletLimit = tableConfig?.wallet || 25000;
    const me = lastState?.players?.[mySessionId];
    const currentWallet = me?.wallet || 0;
    const space = walletLimit - currentWallet;
    if (space <= 0) {
        showSpeechBubble('system', 'System', 'Wallet is already at the limit.', mySessionId);
        return;
    }
    const amount = Math.min(space, walletLimit);
    // Call platform API to draw from bank. game:'rhum32' so the server uses
    // RHUM32_TABLE_CONFIG (without it the wallet limit is computed from the
    // SipSam table config and the top-up is wrong).
    fetch('/api/game/replenish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + rhumToken() },
        body: JSON.stringify({ game: 'rhum32', tableMinBet: selectedMinBet, currentWallet, amount })
    }).then(r => r.json()).then(data => {
        if (data.ok) {
            const added = data.topUp || amount;
            // Tell game server to add chips
            if (ws) ws.send(JSON.stringify({ type: 'replenishWallet', amount: added }));
            showSpeechBubble('system', 'System', 'Wallet replenished: +$' + added.toLocaleString(), mySessionId);
        } else {
            showSpeechBubble('system', 'System', data.error || 'Replenish failed.', mySessionId);
        }
    }).catch(() => {
        showSpeechBubble('system', 'System', 'Could not reach server.', mySessionId);
    });
}

async function exitGame() {
    rhumSettleAndLeave();
}

// ============================================
// BETTING / DECISIONS
// ============================================
// Bet increment based on table tier
function getBetIncrement() {
    if (tableMinBet >= 10000) return 10000;
    if (tableMinBet >= 5000)  return 1000;
    if (tableMinBet >= 1000)  return 500;
    if (tableMinBet >= 500)   return 100;
    return 50;
}

function adjustBet(delta) {
    const inc = getBetIncrement();
    const step = delta > 0 ? inc : -inc;
    currentFrontBet = Math.max(tableMinBet, Math.min(tableMaxBet, currentFrontBet + step));
    document.getElementById('bet-display').textContent = '$' + currentFrontBet.toLocaleString();
    // Update button labels
    const upBtn = document.querySelector('#bet-controls .btn-secondary:last-of-type');
    const dnBtn = document.querySelector('#bet-controls .btn-secondary:first-of-type');
    if (upBtn) upBtn.textContent = '+$' + inc.toLocaleString();
    if (dnBtn) dnBtn.textContent = '-$' + inc.toLocaleString();
    if (ws) ws.send(JSON.stringify({ type: "placeBet", amount: currentFrontBet }));
}

function adjustTieBet(delta) {
    const newVal = currentTieBet + delta;
    currentTieBet = newVal <= 0 ? 0 : Math.max(tieBetMin, Math.min(tieBetMax, newVal));
    document.getElementById('tie-bet-display').textContent = currentTieBet > 0 ? '$' + currentTieBet.toLocaleString() : '$0';
    if (ws) ws.send(JSON.stringify({ type: "placeTieBet", amount: currentTieBet }));
}

function toggleFreeze() {
    const frozen = document.getElementById('freeze-checkbox').checked;
    if (ws) ws.send(JSON.stringify({ type: "freezeBet", freeze: frozen }));
}

function makeDecision(decision) {
    if (ws) ws.send(JSON.stringify({ type: "playerDecision", decision }));
    document.querySelectorAll('#decision-controls button').forEach(b => b.disabled = true);
    SFX.confirm();
}

function sendChat() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg || !ws) return;
    ws.send(JSON.stringify({ type: "chat", message: msg }));
    input.value = '';
}

// ============================================
// CHAT FAB + POPUP (SipSam-style)
// ============================================
function toggleChatPopup() {
    const popup = document.getElementById('chat-popup');
    const fab = document.getElementById('chat-fab');
    if (!popup) return;
    const open = popup.style.display === 'flex';
    popup.style.display = open ? 'none' : 'flex';
    if (fab) fab.style.background = open ? '#1a4a2e' : '#0d3a1e';
    if (!open) setTimeout(() => { const i = document.getElementById('chat-bar-input'); if (i) i.focus(); }, 50);
}

document.addEventListener('click', function(e) {
    const popup = document.getElementById('chat-popup');
    const fab = document.getElementById('chat-fab');
    if (popup && popup.style.display === 'flex' && !popup.contains(e.target) && e.target !== fab) {
        popup.style.display = 'none';
        if (fab) fab.style.background = '#1a4a2e';
    }
});

function chatBarSend() {
    const input = document.getElementById('chat-bar-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg || !ws) return;
    ws.send(JSON.stringify({ type: "chat", message: msg }));
    input.value = '';
}

// ============================================
// SPEECH BUBBLES (SipSam-style)
// ============================================
let bubbleTimers = {};

function showSpeechBubble(sessionId, username, message, anchorSessionId) {
    const bubbleId = 'sb-' + (sessionId || 'sys');
    const existing = document.getElementById(bubbleId);
    if (existing) existing.remove();
    clearTimeout(bubbleTimers[sessionId]);

    // Find the seat nametag to anchor the bubble to
    let nameEl = null;
    if (anchorSessionId && lastState?.players) {
        const p = lastState.players[anchorSessionId];
        if (p && p.seat >= 1 && p.seat <= 6) {
            nameEl = document.getElementById('seat-' + p.seat + '-name');
        }
    }
    // Fallback: find by sessionId
    if (!nameEl && lastState?.players) {
        const p = lastState.players[sessionId];
        if (p && p.seat >= 1 && p.seat <= 6) {
            nameEl = document.getElementById('seat-' + p.seat + '-name');
        }
    }
    // Final fallback: my seat
    if (!nameEl && lastState?.players?.[mySessionId]) {
        const me = lastState.players[mySessionId];
        if (me.seat >= 1 && me.seat <= 6) nameEl = document.getElementById('seat-' + me.seat + '-name');
    }
    if (!nameEl) return;

    const bubble = document.createElement('div');
    bubble.id = bubbleId;
    bubble.className = 'speech-bubble';
    bubble.innerHTML = '<div class="sb-sender">' + escapeHtml(username) + '</div>' + escapeHtml(message);

    const rect = nameEl.getBoundingClientRect();
    // Position bubble above the nametag
    bubble.style.left = Math.round(rect.left + rect.width / 2) + 'px';
    bubble.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
    bubble.style.transform = 'translateX(-50%)';

    const arrow = document.createElement('div');
    arrow.className = 'sb-arrow-down';
    bubble.appendChild(arrow);
    document.body.appendChild(bubble);

    bubbleTimers[sessionId] = setTimeout(() => {
        const el = document.getElementById(bubbleId);
        if (el) { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }
    }, 5000);
}

// ============================================
// SERVER MESSAGE HANDLER
// ============================================
let lastState = null;

function handleServerMessage(msg) {
    switch(msg.type) {
        case "stateUpdate":
            lastState = msg.state;
            renderState(msg.state);
            break;
        case "chat":
            showSpeechBubble(msg.sessionId || msg.username, msg.username, msg.message, msg.sessionId);
            SFX.chat();
            break;
        case "chipTransfer":
            showSpeechBubble('system', 'System', `${msg.from} sent $${msg.amount} to ${msg.to}`, mySessionId);
            break;
        case "chipRequest":
            showSpeechBubble('system', 'System', `${msg.from} requests $${msg.amount} from you`, mySessionId);
            break;
        case "playerDisqualified":
            showSpeechBubble('system', 'System', `${msg.username}: ${msg.reason}`, mySessionId);
            break;
        case "playerTerminated":
            showSpeechBubble('system', 'System', `${msg.username} removed: ${msg.reason}`, mySessionId);
            break;
        case "error":
            showSpeechBubble('system', 'Error', msg.message, mySessionId);
            break;
    }
}

function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ============================================
// RENDER STATE
// ============================================
function renderState(state) {
    if (!state) return;
    tableMinBet = state.tableMinBet || 100;
    tableMaxBet = state.tableMaxBet || 500;
    tieBetMin   = state.tieBetMin || 50;
    tieBetMax   = state.tieBetMax || 100;

    // Capture previous status BEFORE updating
    const prevStatus = lastStatus;
    const prevRound  = lastRound;

    if (state.status !== 'waiting' && document.getElementById('screen-lobby').classList.contains('active')) {
        showScreen('screen-game');
    }
    if (state.status === 'gameOver' && prevStatus !== 'gameOver') showGameOver(state);

    document.getElementById('game-round').textContent  = `Round ${state.round||'--'}/${state.maxRounds||'--'}`;
    document.getElementById('game-status').textContent  = formatStatus(state.status);

    // Enhanced timer display with SVG ring
    const timerEl = document.getElementById('game-timer');
    const ringEl  = document.getElementById('timer-ring');
    const t = state.timer || 0;
    const urgent = t > 0 && t <= 5;
    timerEl.textContent = t > 0 ? t : '--';
    timerEl.classList.toggle('urgent', urgent);
    if (ringEl) {
        ringEl.classList.toggle('urgent', urgent);
        const TOTAL = (state.status === 'betting' || state.status === 'decision') ? 10 : 15;
        const pct = t > 0 ? (1 - t / TOTAL) * 100 : 0;
        ringEl.style.strokeDashoffset = pct;
    }

    // Timer beep in last 5 seconds
    if (t <= 5 && t > 0 && (state.status === 'betting' || state.status === 'decision')) SFX.timer();

    document.getElementById('table-message').textContent = state.message || '';

    showControls(state.status);
    if (state.status === 'betting') {
        const cdEl = document.getElementById('bet-countdown');
        if (cdEl) {
            cdEl.textContent = t;
            cdEl.classList.toggle('urgent', t <= 5);
        }
        // Auto-place default bet when betting phase starts (check PREVIOUS status)
        if (prevStatus !== 'betting') {
            currentFrontBet = tableMinBet;
            document.getElementById('bet-display').textContent = '$' + currentFrontBet.toLocaleString();
            const inc = getBetIncrement();
            const upBtn = document.querySelector('#bet-controls .btn-secondary:last-of-type');
            const dnBtn = document.querySelector('#bet-controls .btn-secondary:first-of-type');
            if (upBtn) upBtn.textContent = '+$' + inc.toLocaleString();
            if (dnBtn) dnBtn.textContent = '-$' + inc.toLocaleString();
            if (ws) ws.send(JSON.stringify({ type: "placeBet", amount: currentFrontBet }));
            SFX.chip();
        }
    } else if (state.status === 'decision') {
        const cdEl = document.getElementById('dec-countdown');
        if (cdEl) {
            cdEl.textContent = t;
            cdEl.classList.toggle('urgent', t <= 5);
        }
    }

    // Play sound on phase transitions
    if (state.status !== prevStatus) {
        if (state.status === 'decision') {
            SFX.deal();
            // Re-enable Push/Bet each new decision phase (they were disabled
            // after the previous round's decision and never reset → dead
            // buttons from round 2 on, causing timeout auto-fold/DQ).
            document.querySelectorAll('#decision-controls button').forEach(b => b.disabled = false);
        }
        if (state.status === 'revealing') SFX.deal();
    }

    // Update AFTER all checks
    lastStatus = state.status;
    lastRound  = state.round;

    renderDealer(state.dealer, state.status);
    renderSeats(state.players, state.status);
    renderMyArea(state.players, state.status);
}

function formatStatus(status) {
    const map = { waiting:'Waiting', betting:'Betting', dealing4:'Dealing', decision:'Decision',
                  dealing5:'Final Card', revealing:'Results', roundEnd:'Round Over', gameOver:'Game Over' };
    return map[status] || status || '--';
}

function renderDealer(dealer, status) {
    const container = document.getElementById('dealer-cards');
    const valueEl   = document.getElementById('dealer-value');
    container.innerHTML = '';
    valueEl.textContent = '';
    if (!dealer || !dealer.cards || dealer.cards.length === 0) return;
    dealer.cards.forEach((card, i) => {
        const isShown = (dealer.shownCard && card === dealer.shownCard && i === 3);
        container.appendChild(createCardEl(card, { shown: isShown }));
    });
    if (dealer.value !== null && dealer.value !== undefined) {
        const crossed = dealer.value > 32;
        valueEl.textContent = `Value: ${dealer.value}${crossed ? ' (BUST!)' : ''}`;
        valueEl.style.color = crossed ? '#cc2200' : '#4caf50';
    }
}

function renderSeats(players, status) {
    for (let s = 1; s <= 6; s++) {
        const el = document.getElementById(`seat-${s}`);
        el.className = `bj-seat bj-seat-${s-1} empty`;
        document.getElementById(`seat-${s}-name`).textContent = '--';
        document.getElementById(`seat-${s}-cards`).innerHTML = '';
        document.getElementById(`seat-${s}-info`).textContent = '';
        const res = document.getElementById(`seat-${s}-result`);
        if (res) { res.className = 'seat-result'; res.textContent = ''; }
    }
    if (!players) return;
    Object.entries(players).forEach(([sid, p]) => {
        const n = p.seat;
        if (n < 1 || n > 6) return;
        const el = document.getElementById(`seat-${n}`);
        el.className = `bj-seat bj-seat-${n-1}`;
        if (sid === mySessionId) el.classList.add('is-me');
        if (p.folded) el.classList.add('folded');
        if (p.result === 'player_win' || p.result === 'dealer_bust') el.classList.add('winner');
        if (p.result === 'dealer_win') el.classList.add('loser');

        document.getElementById(`seat-${n}-name`).textContent = p.username;
        const cardsEl = document.getElementById(`seat-${n}-cards`);
        cardsEl.innerHTML = '';
        if (p.cards?.length) p.cards.forEach(c => cardsEl.appendChild(createCardEl(c)));

        let info = `$${(p.wallet||0).toLocaleString()}`;
        if (p.frontBet > 0) info += ` | Bet:$${p.frontBet}`;
        if (p.tieBet > 0)   info += ` | Tie:$${p.tieBet}`;
        if (p.folded) info = 'FOLDED';
        if (p.disqualified) info = 'DQ';
        if ((status==='revealing'||status==='roundEnd') && p.totalPayout) {
            info += ` | ${p.totalPayout>0?'+':''}$${p.totalPayout}`;
            if (p.tier) info += ` (${p.tier.name})`;
        }
        document.getElementById(`seat-${n}-info`).textContent = info;

        // Hand value display (like dealer's value)
        let valueEl = document.getElementById(`seat-${n}-value`);
        if (!valueEl) {
            valueEl = document.createElement('div');
            valueEl.id = `seat-${n}-value`;
            valueEl.className = 'seat-hand-value';
            cardsEl.parentElement.appendChild(valueEl);
        }
        if (p.playerValue != null) {
            const crossed = p.playerValue > 32;
            valueEl.textContent = `Value: ${p.playerValue}${crossed ? ' (BUST!)' : ''}`;
            valueEl.style.color = crossed ? '#cc2200' : '#4caf50';
        } else {
            valueEl.textContent = '';
        }

        // Result badge
        const res = document.getElementById(`seat-${n}-result`);
        if (res && (status === 'revealing' || status === 'roundEnd')) {
            if (p.result === 'player_win' || p.result === 'dealer_bust') {
                res.className = 'seat-result win'; res.textContent = 'WIN';
            } else if (p.result === 'dealer_win') {
                res.className = 'seat-result lose'; res.textContent = 'LOSE';
            } else if (p.folded) {
                res.className = 'seat-result fold'; res.textContent = 'FOLD';
            } else if (p.result === 'tie') {
                res.className = 'seat-result win'; res.textContent = 'TIE';
            }
        }
    });
}

function renderMyArea(players, status) {
    if (!players || !mySessionId) return;
    const me = players[mySessionId];
    if (!me) return;

    document.getElementById('my-name').textContent  = me.username;
    document.getElementById('my-wallet').textContent = '$' + (me.wallet||0).toLocaleString();

    const payoutEl = document.getElementById('my-payout');
    if (me.totalPayout && me.totalPayout !== 0) {
        payoutEl.textContent = (me.totalPayout>0?'+':'') + '$' + me.totalPayout.toLocaleString();
        payoutEl.className = me.totalPayout > 0 ? 'payout-pos' : 'payout-neg';
    } else payoutEl.textContent = '';

    const myCardsEl = document.getElementById('my-cards');
    myCardsEl.innerHTML = '';
    if (me.cards?.length && me.cards[0] !== '??') me.cards.forEach(c => myCardsEl.appendChild(createCardEl(c)));

    const hvEl = document.getElementById('my-hand-value');
    if (me.playerValue != null) hvEl.textContent = 'Hand Value: ' + me.playerValue;
    else if (me.cards?.length && me.cards[0] !== '??') hvEl.textContent = 'Cards dealt — awaiting 5th card';
    else hvEl.textContent = '';

    if (status === 'decision') {
        document.getElementById('back-bet-amount').textContent = '$' + (me.frontBet * 2).toLocaleString();
    }

    if (status === 'revealing' || status === 'roundEnd') {
        const rEl = document.getElementById('reveal-result');
        const dEl = document.getElementById('reveal-description');
        if (me.result === 'player_win' || me.result === 'dealer_bust') {
            rEl.textContent = 'YOU WIN!'; rEl.style.color = '#44ff88';
            if (lastStatus !== 'revealing' && lastStatus !== 'roundEnd') SFX.win();
        } else if (me.result === 'dealer_win') {
            rEl.textContent = 'DEALER WINS'; rEl.style.color = '#ff5555';
            if (lastStatus !== 'revealing' && lastStatus !== 'roundEnd') SFX.lose();
        } else if (me.result === 'tie') {
            rEl.textContent = 'TIE'; rEl.style.color = '#c9a84c';
            if (lastStatus !== 'revealing' && lastStatus !== 'roundEnd') SFX.confirm();
        } else if (me.result === 'folded' || me.result === 'auto_fold') {
            rEl.textContent = 'FOLDED'; rEl.style.color = '#999';
        } else rEl.textContent = '';
        dEl.textContent = me.description || '';
    }
}

function showGameOver(state) {
    showScreen('screen-gameover');
    const container = document.getElementById('final-results');
    container.innerHTML = '';
    Object.values(state.players).sort((a,b) => b.wallet - a.wallet).forEach(p => {
        const div = document.createElement('div');
        div.className = 'final-player';
        div.innerHTML = `<span class="fp-name">${escapeHtml(p.username)}</span><span class="fp-wallet">$${(p.wallet||0).toLocaleString()}</span>`;
        container.appendChild(div);
    });
}

// ============================================
// UNLOAD SETTLEMENT (SipSam-style beacon)
// sendBeacon survives page unload where fetch does not. Skipped when the
// player used Exit (rhumSettleAndLeave already returned the wallet); the
// server's exit lock makes a double-fire harmless regardless.
// ============================================
window.addEventListener('beforeunload', function() {
    if (window._intentionalExit) return;
    const token = rhumToken();
    if (!token) return;
    try {
        const blob = new Blob([JSON.stringify({
            remainingWallet: rhumRemainingWallet(),
            tableMinBet: selectedMinBet || tableMinBet
        })], { type: 'application/json' });
        navigator.sendBeacon('/api/game/rhum32/exit-beacon?token=' + encodeURIComponent(token), blob);
    } catch (e) {}
});
