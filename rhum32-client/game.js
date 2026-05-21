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

        // Invited joiner: skip mode-select and go straight to a stripped
        // lobby that just waits for the host to start (mirrors SipSam).
        // The invite payload already locked in tier + rounds.
        if (table && table.isInvitedJoiner === true && table.roomId) {
            enterAsInvitee(table);
            return;
        }

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
    // Multiplayer hosts: create the room on the server NOW (not on Start) so
    // the invite carries a real roomId and invitees join THIS lobby. Single
    // player stays on the click-Start-to-create flow.
    if (gameMode === 'multiplayer') ensureHostRoom();
}

// ── HOST ROOM (eager create) ─────────────────────────────────
// Once the host picks rounds in Multiplayer mode, open the WS room
// immediately. The invite is sent with the real roomId from this call.
// Click-Start later just sends `startGame` on the already-open socket.
let _ensuringHostRoom = null;
async function ensureHostRoom() {
    if (gameMode !== 'multiplayer') return;
    if (currentRoomId && ws && ws.readyState === WebSocket.OPEN) return;
    if (_ensuringHostRoom) return _ensuringHostRoom;
    _ensuringHostRoom = (async () => {
        try {
            console.log('[Rhum32] Host eager-creating room…');
            ws = await joinRoom(myUsername, {
                tableMinBet: selectedMinBet,
                maxRounds:   selectedRounds || 10,
                wallet:      tableConfig?.wallet || 5000,
                mode:        'multiplayer',
                isHost:      true,                  // server creates a fresh room and marks us as host
                token:       rhumToken()
            });
            console.log('[Rhum32] Host room ready:', currentRoomId);
        } catch (e) {
            console.error('[Rhum32] Host room create failed:', e);
            const statusEl = document.getElementById('lobby-status');
            if (statusEl) {
                statusEl.textContent = 'Could not reserve a table: ' + e.message;
                statusEl.style.color = '#fca5a5';
            }
        } finally {
            _ensuringHostRoom = null;
        }
    })();
    return _ensuringHostRoom;
}

function updateLobbyInfo() {
    const info = document.getElementById('lobby-selection-info');
    if (selectedRounds) info.textContent = `$${selectedMinBet} table, ${selectedRounds} rounds`;
    else info.textContent = "Select rounds to begin.";
    document.getElementById('btn-start-game').disabled = !selectedRounds;
    // Enforce: invite controls are dead until rounds are picked, so every
    // invitee is directed to a room with a concrete tier + round count.
    const inviteInput = document.getElementById('invite-username');
    const inviteBtn   = document.querySelector('#invite-section .invite-btn');
    const gateNote    = document.getElementById('invite-gate-note');
    const dd          = document.getElementById('lobby-invite-dropdown');
    const gate        = !selectedRounds;
    if (inviteInput) {
        inviteInput.disabled = gate;
        inviteInput.placeholder = gate ? 'Select rounds first…' : 'Type name or pick from friends...';
        inviteInput.style.opacity = gate ? '0.55' : '';
        if (gate) inviteInput.value = '';
    }
    if (inviteBtn) {
        inviteBtn.disabled = gate;
        inviteBtn.style.opacity = gate ? '0.55' : '';
        inviteBtn.style.cursor = gate ? 'not-allowed' : '';
    }
    if (gateNote) gateNote.style.display = gate ? 'block' : 'none';
    if (gate && dd) dd.style.display = 'none';
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
        // Multiplayer hosts already opened a room on rounds-pick — just kick
        // off the round on the existing socket. Single-player still goes
        // through the create-then-start flow in one shot.
        if (gameMode === 'multiplayer') {
            await ensureHostRoom();
            if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Host room not connected');
        } else {
            console.log('[Rhum32] Single-player joinRoom:', myUsername, selectedMinBet, selectedRounds);
            ws = await joinRoom(myUsername, {
                tableMinBet: selectedMinBet,
                maxRounds:   selectedRounds,
                wallet:      tableConfig?.wallet || 5000,
                mode:        'single',
                isHost:      true,
                token:       rhumToken()
            });
        }
        console.log('[Rhum32] Sending startGame on roomId', currentRoomId);
        showScreen('screen-game');
        ws.send(JSON.stringify({ type: "startGame", tableMinBet: selectedMinBet, rounds: selectedRounds }));
    } catch(e) {
        console.error('[Rhum32] connectAndStart error:', e);
        statusEl.textContent = "Failed: " + e.message;
        document.getElementById('btn-start-game').disabled = false;
    }
}

// ── INVITEE FLOW (SipSam-style stripped lobby) ──────────────
// Invitees skip mode-select entirely. The host's invite already chose tier
// + rounds, so the invitee gets only "Waiting for host…" + Exit Lobby.
async function enterAsInvitee(table) {
    gameMode       = 'multiplayer';
    selectedMinBet = Number(table.minBet) || selectedMinBet;
    selectedRounds = Number(table.rounds) || 10;
    tableMinBet    = selectedMinBet;
    if (table.maxBet) tableMaxBet = Number(table.maxBet);
    const label = document.getElementById('lobby-mode-label');
    if (label) label.textContent = 'MULTIPLAYER';
    showScreen('screen-lobby');
    applyInviteeLobby();

    // Draw bank → wallet via /api/game/rhum32/enter (mirrors the host's
    // confirmEnter path). The platform already ran a HARD min-bank check at
    // /invite/accept; this is the actual chip transfer. On failure (bank
    // raced lower, network blip), surface a message and bounce to dashboard.
    const statusEl = document.getElementById('lobby-status');
    try {
        const token = rhumToken();
        const res = await fetch('/api/game/rhum32/enter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ tableMinBet: selectedMinBet })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) {
            if (statusEl) {
                statusEl.textContent = '✕ Cannot enter: ' + (j.error || ('HTTP ' + res.status));
                statusEl.style.color = '#fca5a5';
            }
            setTimeout(() => { window.location.href = '/'; }, 2200);
            return;
        }
        // Sync wallet so the lobby + IGM bar show the post-draw amount.
        if (typeof j.wallet === 'number') {
            tableConfig = Object.assign({}, tableConfig || {}, { wallet: j.wallet });
            const wEl = document.getElementById('lci-wallet');
            if (wEl) wEl.textContent = '$' + j.wallet.toLocaleString();
        }
    } catch (e) {
        console.error('[Rhum32] Invitee enter error:', e);
        if (statusEl) {
            statusEl.textContent = '✕ Network error entering table.';
            statusEl.style.color = '#fca5a5';
        }
        setTimeout(() => { window.location.href = '/'; }, 2200);
        return;
    }

    connectAsInvitee(table.roomId);
}

function applyInviteeLobby() {
    const hide = id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; };
    hide('rounds-label');
    hide('rounds-row');
    hide('invite-section');
    hide('btn-start-game');
    const info = document.getElementById('lobby-selection-info');
    if (info) {
        info.textContent = `$${(selectedMinBet || 0).toLocaleString()} table · ${selectedRounds} rounds`;
        info.style.color = '#7ac08a';
    }
    const back = document.getElementById('btn-back-lobby');
    if (back) {
        back.textContent = '✕ Exit Lobby';
        back.onclick = () => rhumSettleAndLeave();
    }
    const status = document.getElementById('lobby-status');
    if (status) {
        status.textContent = '⏳ Waiting for the host to start the game…';
        status.style.color = '#7ec8ff';
        status.style.fontWeight = '700';
    }
}

async function connectAsInvitee(roomId) {
    const statusEl = document.getElementById('lobby-status');
    try {
        ws = await joinRoom(myUsername, {
            tableMinBet: selectedMinBet,
            maxRounds:   selectedRounds,
            wallet:      tableConfig?.wallet || 5000,
            mode:        'multiplayer',
            roomId:      roomId,           // direct join to host's specific room
            token:       rhumToken()
        });
        // Intentionally do NOT send startGame — only the host starts the
        // round. The renderState 'waiting' → active transition will flip us
        // to screen-game once the host starts (or immediately if the game is
        // already in progress, supporting mid-game join).
        console.log('[Rhum32] Invitee connected to room', roomId);
    } catch (e) {
        console.error('[Rhum32] Invitee connect error:', e);
        if (statusEl) {
            statusEl.textContent = 'Could not join host: ' + e.message;
            statusEl.style.color = '#fca5a5';
        }
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
    if (!selectedRounds) {
        // Hard-gate: invites carry tier + rounds — never send without one.
        statusEl.textContent = 'Pick rounds first so your invitee joins the right room.';
        statusEl.style.color = '#fca5a5';
        return;
    }
    const username = input.value.trim();
    if (!username) { statusEl.textContent = 'Enter a username.'; statusEl.style.color = '#fca5a5'; return; }

    statusEl.textContent = 'Sending invite...'; statusEl.style.color = '#7ac08a';

    // Make sure the host's room exists on the server BEFORE issuing an invite,
    // otherwise the invite carries a null roomId and the invitee's matchmake
    // call falls through to joinOrCreate and lands in a different room.
    await ensureHostRoom();
    if (!currentRoomId) {
        statusEl.textContent = 'Could not reserve a table — try again.';
        statusEl.style.color = '#fca5a5';
        return;
    }

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
// SipSam-style slide-in accordion. One section expanded at a time.
let igmOpen = false, igmActiveSub = null, igmSelectedPlayer = null;
let igmBank = 0, _igmFriends = [], _igmInvited = new Set();

function _fmt(n) { return '$' + (Number(n) || 0).toLocaleString(); }
function _igmWallet() {
    const me = lastState && mySessionId ? lastState.players?.[mySessionId] : null;
    return (me && typeof me.wallet === 'number') ? me.wallet : (Number(tableConfig?.wallet) || 0);
}

function toggleIngameMenu() { igmOpen ? closeIngameMenu() : openIngameMenu(); }

function openIngameMenu() {
    igmOpen = true;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('igm-username', myUsername || '—');
    set('igm-avatar', (myUsername || '?')[0].toUpperCase());
    set('igm-table-label', '♣ Rhum32 — $' + ((selectedMinBet || tableMinBet) || 0).toLocaleString() + ' Table');
    set('igm-send-desc', 'Max ' + _fmt(tableMaxBet || tableConfig?.maxBet || 0) + ' per transfer');
    set('igm-rep-desc', 'Draw up to ' + _fmt(tableConfig?.wallet || 0) + ' from bank');
    const token = rhumToken();
    if (token) {
        fetch('/api/game/balance', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(r => r.json())
            .then(d => { if (d && d.ok && d.user) igmBank = d.user.bankBalance ?? d.user.bank_balance ?? igmBank; syncWalletDisplay(); })
            .catch(() => syncWalletDisplay());
    } else syncWalletDisplay();
    document.getElementById('igm-panel').style.transform = 'translateX(0)';
    document.getElementById('igm-overlay').style.display = 'block';
}

function closeIngameMenu() {
    igmOpen = false;
    igmBack();
    document.getElementById('igm-panel').style.transform = 'translateX(100%)';
    document.getElementById('igm-overlay').style.display = 'none';
}

function igmOverlayClick() { closeIngameMenu(); }

function igmBack() {
    document.querySelectorAll('.igm-sec.expanded').forEach(s => s.classList.remove('expanded'));
    igmActiveSub = null; igmSelectedPlayer = null;
}

function syncWalletDisplay() {
    const w = _igmWallet();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('igm-wallet', 'Wallet: ' + _fmt(w));
    set('igm-bank', _fmt(igmBank));
    set('rep-cur-wallet', _fmt(w));
    set('rep-cur-bank', _fmt(igmBank));
    const limit = Number(tableConfig?.wallet) || 0;
    set('rep-limit', _fmt(limit));
    set('rep-max', _fmt(Math.min(igmBank, Math.max(0, limit - w))));
}

// ── ACCORDION ──────────────────────────────────────────────
function igmExpand(key) {
    const sec = document.querySelector('.igm-sec[data-key="' + key + '"]');
    if (!sec) return;
    const wasOpen = sec.classList.contains('expanded');
    document.querySelectorAll('.igm-sec.expanded').forEach(s => s.classList.remove('expanded'));
    igmActiveSub = null; igmSelectedPlayer = null;
    if (wasOpen) return;
    sec.classList.add('expanded');
    igmActiveSub = key;
    if (key === 'invite')    _igmPopulateInvite();
    if (key === 'replenish') syncWalletDisplay();
    if (key === 'request')   _igmPopulateRequest();
    if (key === 'send')      _igmPopulateSend();
    setTimeout(() => sec.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
}

// ── INVITE ─────────────────────────────────────────────────
async function _igmLoadFriends() {
    const token = rhumToken();
    if (!token) { _igmFriends = []; return; }
    try {
        const r = await fetch('/api/friends', { headers: { 'Authorization': 'Bearer ' + token } });
        const d = await r.json();
        _igmFriends = (d && d.friends) || [];
    } catch (e) { _igmFriends = []; }
}
function _igmSeated() {
    const out = new Set();
    Object.values(lastState?.players || {}).forEach(p => { if (p && p.username) out.add(String(p.username).toLowerCase()); });
    return out;
}
function _igmPopulateInvite() {
    const input = document.getElementById('igm-invite-input');
    const msg = document.getElementById('igm-invite-msg');
    if (input) input.value = '';
    if (msg) msg.textContent = '';
    _igmLoadFriends().then(() => igmInviteRender(''));
    setTimeout(() => { if (input) input.focus(); }, 80);
}
function igmInviteOnFocus() { igmInviteRender(document.getElementById('igm-invite-input')?.value || ''); }
function igmInviteOnInput(v) { igmInviteRender(v || ''); }
function igmInviteEnter() {
    const first = document.getElementById('igm-invite-list')?.querySelector('[data-friend]');
    if (first) first.click();
}
function igmInviteRender(query) {
    const list = document.getElementById('igm-invite-list');
    if (!list) return;
    const seated = _igmSeated();
    const q = (query || '').trim().toLowerCase();
    const cands = _igmFriends.filter(f => {
        const n = String(f.username || '').toLowerCase();
        if (!n || seated.has(n) || _igmInvited.has(n)) return false;
        if (q && !n.includes(q)) return false;
        return true;
    });
    if (!cands.length) {
        list.innerHTML = '<div style="padding:14px;font-size:13px;color:#7ac08a;text-align:center">' +
            (q ? 'No matching friends available.' : (_igmFriends.length ? 'No friends available to invite.' : 'No friends yet. Add some from the dashboard.')) + '</div>';
        return;
    }
    list.innerHTML = cands.map(f => {
        const name = String(f.username || '');
        const safe = escapeHtml(name);
        const init = (name[0] || '?').toUpperCase();
        return '<div data-friend="' + safe + '" onclick="igmDoInvite(\'' + safe.replace(/'/g, "\\'") + '\')" ' +
            'style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer" ' +
            'onmouseover="this.style.background=\'rgba(76,175,80,.1)\'" onmouseout="this.style.background=\'\'">' +
            '<div style="width:28px;height:28px;border-radius:50%;background:#0d2a18;border:1px solid #1a4a2e;display:flex;align-items:center;justify-content:center;color:#4caf50;font-weight:700;font-size:12px">' + init + '</div>' +
            '<div style="flex:1;font-size:13px;color:#f0fff0;font-weight:600">' + safe + '</div>' +
            '<span style="font-size:11px;color:#4caf50">Invite ›</span></div>';
    }).join('');
}
async function igmDoInvite(username) {
    if (!username) return;
    const msg = document.getElementById('igm-invite-msg');
    if (msg) { msg.textContent = 'Sending invite to ' + username + '…'; msg.style.color = '#7ac08a'; }
    const token = rhumToken();
    if (!token) { if (msg) { msg.textContent = '⚠️ Not authenticated.'; msg.style.color = '#fca5a5'; } return; }
    try {
        const res = await fetch('/api/friends/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                toUsername: username, game: 'rhum32', roomId: currentRoomId,
                tableMinBet: selectedMinBet || tableMinBet,
                tableConfig: {
                    minBet: selectedMinBet || tableMinBet, maxBet: tableMaxBet,
                    wallet: tableConfig?.wallet || 0, minBank: tableConfig?.minBank || 0,
                    rounds: selectedRounds || 10, roomId: currentRoomId
                }
            })
        });
        const data = await res.json();
        if (data.ok || data.success) {
            _igmInvited.add(username.toLowerCase());
            if (msg) { msg.textContent = '✅ Invite sent to ' + username + '.'; msg.style.color = '#4caf50'; }
            igmInviteRender(document.getElementById('igm-invite-input')?.value || '');
        } else {
            if (msg) { msg.textContent = '❌ ' + (data.error || 'Failed to send invite.'); msg.style.color = '#fca5a5'; }
        }
    } catch (e) {
        if (msg) { msg.textContent = '⚠️ Network error.'; msg.style.color = '#fca5a5'; }
    }
}

// ── PLAYER LIST (request / send) ────────────────────────────
function getActivePlayers() {
    try {
        const ps = lastState?.players;
        if (!ps) return [];
        const out = [];
        Object.entries(ps).forEach(([sid, p]) => {
            if (sid === mySessionId || p.disqualified) return;
            out.push({ sid, name: p.username, wallet: p.wallet || 0 });
        });
        return out;
    } catch (e) { return []; }
}
function populatePlayerList(containerId) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    const players = getActivePlayers();
    if (!players.length) {
        c.innerHTML = '<div style="color:#7ac08a;font-size:13px;text-align:center;padding:12px">No other players at this table.</div>';
        return;
    }
    players.forEach(p => {
        const b = document.createElement('div');
        b.className = 'player-select-btn';
        b.innerHTML = '<span style="font-size:18px">\u{1F464}</span>' +
            '<div style="flex:1"><div style="font-weight:700;font-size:13px;color:#f0fff0">' + escapeHtml(p.name) + '</div>' +
            '<div style="font-size:11px;color:#7ac08a">Player · $' + (p.wallet || 0).toLocaleString() + '</div></div>';
        b.dataset.sid = p.sid;
        b.dataset.username = p.name;
        b.onclick = () => {
            c.querySelectorAll('.player-select-btn').forEach(x => x.classList.remove('sel'));
            b.classList.add('sel');
            igmSelectedPlayer = p;
        };
        c.appendChild(b);
    });
}
function _igmPopulateRequest() {
    igmSelectedPlayer = null;
    populatePlayerList('req-players');
    const mb = tableMaxBet || tableConfig?.maxBet || 0;
    const l = document.getElementById('req-amount-label'); if (l) l.textContent = _fmt(mb);
    const pe = document.getElementById('req-pending'); if (pe) pe.textContent = '';
}
function _igmPopulateSend() {
    igmSelectedPlayer = null;
    populatePlayerList('send-players');
    const mb = tableMaxBet || tableConfig?.maxBet || 0;
    const sl = document.getElementById('send-limit'); if (sl) sl.textContent = _fmt(mb);
    const ai = document.getElementById('send-amount-input'); if (ai) ai.value = mb;
    const notice = document.getElementById('req-notice');
    const pr = window._pendingChipRequest;
    if (pr && notice) {
        notice.style.display = 'block';
        notice.textContent = '\u{1F4AC} ' + pr.from + ' requested ' + _fmt(pr.amount) + ' — select them below to fulfil.';
        setTimeout(() => {
            document.querySelectorAll('#send-players .player-select-btn').forEach(btn => { if (btn.dataset.username === pr.from) btn.click(); });
        }, 100);
    } else if (notice) {
        notice.style.display = 'none';
    }
}

// ── REPLENISH (server-authoritative via WS) ─────────────────
function igmFillMax() {
    const limit = Number(tableConfig?.wallet) || 0;
    const i = document.getElementById('rep-amount');
    if (i) i.value = Math.min(igmBank, Math.max(0, limit - _igmWallet()));
}
function doReplenish() {
    const amtEl = document.getElementById('rep-amount');
    const errEl = document.getElementById('rep-err');
    if (errEl) errEl.style.display = 'none';
    const showErr = t => { if (errEl) { errEl.textContent = t; errEl.style.display = 'block'; } };
    const amt = Number(amtEl?.value);
    const limit = Number(tableConfig?.wallet) || 0;
    const space = limit - _igmWallet();
    if (!amt || amt <= 0) return showErr('Enter a valid amount.');
    if (amt > igmBank)    return showErr('Insufficient bank balance (' + _fmt(igmBank) + ').');
    if (space <= 0)       return showErr('Wallet is already at the limit (' + _fmt(limit) + ').');
    if (amt > space)      return showErr('Max you can draw is ' + _fmt(space) + '.');
    if (!ws)              return showErr('Not connected.');
    ws.send(JSON.stringify({ type: 'replenishWallet', amount: amt }));
    const btn = document.querySelector('.igm-sec[data-key="replenish"] .igm-action-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Processing...'; }
}
function onReplenishResult(msg) {
    const errEl = document.getElementById('rep-err');
    const btn = document.querySelector('.igm-sec[data-key="replenish"] .igm-action-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = '\u{1F4B0} Draw to Wallet'; }
    if (!msg.ok) { if (errEl) { errEl.textContent = msg.error || 'Replenish failed.'; errEl.style.display = 'block'; } return; }
    if (typeof msg.newBankBalance === 'number') igmBank = msg.newBankBalance;
    syncWalletDisplay();
    showSpeechBubble('system', 'System', 'Wallet replenished: +' + _fmt(msg.added || 0), mySessionId);
    igmBack();
}

// ── REQUEST / SEND CHIPS ────────────────────────────────────
function doRequestChips() {
    if (!igmSelectedPlayer) { showSpeechBubble('system', 'System', 'Select a player from the list.', mySessionId); return; }
    if (!ws) return;
    const amount = tableMaxBet || tableConfig?.maxBet || 0;
    ws.send(JSON.stringify({ type: 'requestChips', targetSessionId: igmSelectedPlayer.sid, amount }));
    const pe = document.getElementById('req-pending');
    if (pe) pe.textContent = '✅ Request sent to ' + igmSelectedPlayer.name + ' for ' + _fmt(amount);
    igmSelectedPlayer = null;
    document.querySelectorAll('#req-players .player-select-btn').forEach(b => b.classList.remove('sel'));
}
function doSendChips() {
    const errEl = document.getElementById('send-err');
    const amtEl = document.getElementById('send-amount-input');
    if (errEl) errEl.style.display = 'none';
    const showErr = t => { if (errEl) { errEl.textContent = t; errEl.style.display = 'block'; } };
    if (!igmSelectedPlayer) { showSpeechBubble('system', 'System', 'Select a recipient first.', mySessionId); return; }
    const maxBet = tableMaxBet || tableConfig?.maxBet || 0;
    const amount = amtEl && Number(amtEl.value) > 0 ? Math.min(Number(amtEl.value), maxBet) : maxBet;
    if (!amount || amount <= 0) return showErr('Enter a valid amount.');
    if (_igmWallet() < amount)  return showErr('Insufficient wallet (' + _fmt(_igmWallet()) + ').');
    if (!ws)                    return showErr('Not connected.');
    ws.send(JSON.stringify({ type: 'sendChips', targetSessionId: igmSelectedPlayer.sid, amount }));
    window._pendingChipRequest = null;
    showSpeechBubble('system', 'System', 'Sent ' + _fmt(amount) + ' to ' + igmSelectedPlayer.name, mySessionId);
    if (typeof SFX !== 'undefined' && SFX.confirm) SFX.confirm();
    igmBack();
}

function igmExit() {
    if (!confirm('Exit game? Your remaining wallet will be returned to your bank.')) return;
    closeIngameMenu();
    rhumSettleAndLeave();
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
    // Hard-gate: only accept changes while the betting window is open.
    // Without this, a click that lands ~ms after the server flips status to
    // 'decision' is silently dropped — the UI shows the amount, but the
    // server's stored tieBet stays 0 and the player loses out on a tie.
    if (lastStatus && lastStatus !== 'betting') {
        console.warn('[Rhum32] adjustTieBet ignored — betting closed (status=' + lastStatus + ')');
        return;
    }
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
            // Stash so the Send Chips section can pre-select the requester.
            window._pendingChipRequest = { from: msg.from, amount: msg.amount };
            showSpeechBubble('system', 'System', `${msg.from} requests $${msg.amount} from you`, mySessionId);
            break;
        case "replenishResult":
            onReplenishResult(msg);
            break;
        case "playerDisqualified":
            showSpeechBubble('system', 'System', `${msg.username}: ${msg.reason}`, mySessionId);
            break;
        case "tieBetRejected": {
            // Server refused the tie-bet placement (most often: betting
            // window closed). Roll the on-screen displayed amount back to
            // the value the server actually stored, so the player can SEE
            // their bet wasn't accepted instead of waiting for a payout
            // that won't come.
            const stored = Number(msg.tieBet) || 0;
            currentTieBet = stored;
            const disp = document.getElementById('tie-bet-display');
            if (disp) disp.textContent = stored > 0 ? '$' + stored.toLocaleString() : '$0';
            showSpeechBubble('system', 'Tie Bet', msg.reason || 'Bet refused.', mySessionId);
            break;
        }
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
    // Lobby player list (status === 'waiting' + lobby visible).
    renderLobbyPlayers(state);
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

// ── LOBBY PLAYER LIST ────────────────────────────────────────
// Renders state.players into #lobby-players while status === 'waiting' so
// both the host and invitees can see who has joined the same room before
// the host starts the round. Hidden in any other status / screen.
function renderLobbyPlayers(state) {
    const wrap = document.getElementById('lobby-players-wrap');
    const list = document.getElementById('lobby-players');
    if (!wrap || !list) return;
    const lobbyVisible = document.getElementById('screen-lobby')?.classList.contains('active');
    if (!lobbyVisible || state.status !== 'waiting') {
        wrap.style.display = 'none';
        return;
    }
    const players = Object.values(state.players || {});
    list.innerHTML = '';
    players.sort((a, b) => (b.isHost ? 1 : 0) - (a.isHost ? 1 : 0) || (a.seat - b.seat));
    players.forEach(p => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(20,80,40,0.18);border:1px solid rgba(122,192,138,0.25);border-radius:8px;font-size:13px';
        const me = p.username === myUsername;
        const tag = p.isHost ? '<span style="color:#c9a84c;font-size:10px;font-weight:800;letter-spacing:1px">HOST</span>' : '<span style="color:#7ac08a;font-size:10px;letter-spacing:1px">READY</span>';
        row.innerHTML = `<span style="font-weight:600">${escapeHtml(p.username)}${me ? ' (you)' : ''}</span>${tag}`;
        if (me) row.style.outline = '1px solid #c9a84c';
        list.appendChild(row);
    });
    if (players.length === 0) {
        list.innerHTML = '<div style="color:#888;font-size:12px;text-align:center;padding:8px">Just you so far…</div>';
    }
    wrap.style.display = 'block';
}

function showGameOver(state) {
    showScreen('screen-gameover');
    const container = document.getElementById('final-results');
    container.innerHTML = '';
    // Sort by NET game change (wallet - startingWallet - replenishTotal) so
    // standings reflect who actually made money this game, not who walked in
    // with the most chips or replenished the deepest.
    const netFor = p => (Number(p.wallet)||0) - (Number(p.startingWallet)||0) - (Number(p.replenishTotal)||0);
    const sorted = Object.values(state.players).sort((a, b) => netFor(b) - netFor(a));
    sorted.forEach((p, i) => {
        const div  = document.createElement('div');
        div.className = 'final-player';
        const isMe = p.username === myUsername;
        const net  = netFor(p);
        const medal = i === 0 ? '\u{1F3C6} ' : i === 1 ? '\u{1F948} ' : i === 2 ? '\u{1F949} ' : `#${i+1} `;
        const netColor = net > 0 ? '#44ff88' : net < 0 ? '#ff7676' : '#c9a84c';
        const netSign  = net > 0 ? '+' : net < 0 ? '−' : '';
        const netStr   = '$' + Math.abs(net).toLocaleString();
        div.innerHTML =
            `<span class="fp-name">${medal}${escapeHtml(p.username)}${isMe ? ' (you)' : ''}</span>` +
            `<span class="fp-wallet" style="display:flex;flex-direction:column;align-items:flex-end;line-height:1.2">` +
                `<span style="color:${netColor};font-weight:800">${netSign}${netStr}</span>` +
                `<span style="font-size:11px;color:#9ad3a8;opacity:.75">wallet $${(p.wallet||0).toLocaleString()}</span>` +
            `</span>`;
        if (isMe) div.style.outline = '1px solid #c9a84c';
        container.appendChild(div);
    });
    // Headline result for the local player.
    const resEl = document.getElementById('gameover-result');
    if (resEl) {
        const meIdx = sorted.findIndex(p => p.username === myUsername);
        if (meIdx >= 0) {
            const me  = sorted[meIdx];
            const net = netFor(me);
            // "YOU WON" / "YOU LOST" / "YOU BROKE EVEN" — past tense, no `!`
            // so the gold serif font doesn't render the bang as a capital I.
            let headline, color;
            if (net > 0)      { headline = 'YOU WON';        color = '#44ff88'; }
            else if (net < 0) { headline = 'YOU LOST';       color = '#ff7676'; }
            else              { headline = 'YOU BROKE EVEN'; color = '#c9a84c'; }
            const netSign = net > 0 ? '+' : net < 0 ? '−' : '';
            const netStr  = '$' + Math.abs(net).toLocaleString();
            resEl.innerHTML = `${headline} <span style="color:${color}">${netSign}${netStr}</span> ` +
                              `<span style="opacity:.65;font-weight:500">· finished #${meIdx + 1} of ${sorted.length} · wallet $${(me.wallet||0).toLocaleString()}</span>`;
            resEl.style.color = color;
        } else {
            resEl.textContent = '';
        }
    }
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
