// ============================================
// SIPSAM GAME CLIENT v6.0
// - Table selection in lobby
// - Fixed banker for entire game
// - 10-second bet window with +/-$10 controls
// - 60s arrange + 30s reveal
// ============================================

const SERVER_HTTP = "http://localhost:3000";  // Proxied to poker-server via VurgLife platform
const SERVER_WS   = "ws://localhost:3001";

let ws             = null;
let mySessionId    = null;
var myRoomId       = 'sipsam_main'; // current room — set from matchmake response
var myAvatar       = '';            // emoji avatar for this player
var lastBankerSid  = null;          // track banker changes to rebuild seatMap
var myUsername     = "";  // var so poker-client-index.html inline script can access it
let isBanker       = false;
let draggedCard    = null;
let dropZonesReady = false;
let lastStatus     = "";
let lastRound      = 0;
let currentBet     = 10;
let tableMinBet    = 100; // default to $100 table — overridden by TABLE_CONFIGS lookup

// TABLE_CONFIGS — single source of truth for all table types
// Defined at top so all functions can access it regardless of call order
const TABLE_CONFIGS = {
    100:  { minBet:100,  increment:50,  maxBet:150,   walletSize:3000,  bankRequired:5000  },
    250:  { minBet:250,  increment:50,  maxBet:500,   walletSize:10000, bankRequired:15000 },
    500:  { minBet:500,  increment:100, maxBet:1000,  walletSize:20000, bankRequired:30000 },
    1000: { minBet:1000, increment:500, maxBet:2000,  walletSize:40000, bankRequired:60000 },
    10000:{ minBet:10000,increment:10000,maxBet:50000, walletSize:1000000, bankRequired:2000000 },
};
let selectedRounds = 0;
let selectedMinBet = 0;

let piles = { hand1:[], hand2:[], hand3:[] };
// Stable seat map: sid → zone ('p1'|'p2'|'p3')
// Built once when a round starts; never reshuffled mid-game
let seatMap = {}; // sid → zoneId

// ============================================
// SERVER CONNECTION
// ============================================
async function joinRoom(username, _authToken, _roomId) {
    // Token passed directly from DOMContentLoaded (sessionStorage already cleared by then)
    if (!_authToken) {
        try { _authToken = JSON.parse(sessionStorage.getItem('sipsam_user') || '{}').token || null; } catch(e) {}
    }
    if (!_roomId) _roomId = 'sipsam_main';
    // Try proxied URL first, fall back to direct poker-server if proxy fails
    const matchmakeUrls = [
        `${SERVER_HTTP}/matchmake/joinOrCreate/sipsam_room`,
        `http://localhost:2999/matchmake/joinOrCreate/sipsam_room`
    ];

    let reservation = null;
    let lastError   = null;

    for (const url of matchmakeUrls) {
        try {
            console.log(`[joinRoom] Trying matchmake URL: ${url}`);
            const controller = new AbortController();
            const fetchTimeout = setTimeout(() => {
                console.warn(`[joinRoom] Fetch timed out after 5s: ${url}`);
                controller.abort();
            }, 5000);
            let res;
            try {
                res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, token: _authToken, roomId: _roomId, avatar: window._myAvatar || '', isPrivate: window._isPrivateRoom || false }),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(fetchTimeout);
            }
            console.log(`[joinRoom] Response status: ${res.status} from ${url}`);
            if (!res.ok) {
                const body = await res.text().catch(() => '(no body)');
                console.warn(`[joinRoom] Non-OK response: ${res.status} — ${body}`);
                lastError = new Error(`Matchmake HTTP ${res.status}: ${body}`);
                continue;
            }
            reservation = await res.json();
            console.log("[joinRoom] Reservation received:", reservation);
            break;
        } catch (e) {
            console.warn(`[joinRoom] Fetch failed for ${url}:`, e);
            lastError = e;
        }
    }

    if (!reservation) {
        throw lastError || new Error("All matchmake URLs failed");
    }

    const { sessionId, roomId } = reservation;
    myRoomId = roomId || 'sipsam_main'; // store globally for invite system
    if (!sessionId || !roomId) {
        throw new Error(`Bad reservation — sessionId:${sessionId} roomId:${roomId}`);
    }

    const wsUrl = `${SERVER_WS}/${roomId}?sessionId=${sessionId}`;
    console.log("[joinRoom] Opening WebSocket:", wsUrl);

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        socket.binaryType = "arraybuffer";

        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("WebSocket connection timed out after 10s"));
        }, 10000);

        socket.onopen = () => {
            clearTimeout(timeout);
            console.log("[joinRoom] WebSocket connected! sessionId:", sessionId);
            mySessionId = sessionId;
            resolve(socket);
        };

        socket.onmessage = (event) => {
            if (typeof event.data === "string") {
                try { handleServerMessage(JSON.parse(event.data)); }
                catch(e) { console.log("Parse error:", e); }
            }
        };

        socket.onerror = (e) => {
            clearTimeout(timeout);
            console.error("[joinRoom] WS error:", e);
            reject(new Error("WebSocket connection error — is poker-server running on port 3001?"));
        };

        socket.onclose = (e) => {
            console.log("[joinRoom] WS closed — code:", e.code, "reason:", e.reason);
            const el = document.getElementById("login-status");
            if (el) el.textContent = "Disconnected (" + e.code + ")";
        };
    });
}

// ============================================
// CARD HELPERS
// ============================================
function getSuit(card)        { const m={h:'hearts',d:'diamonds',c:'clubs',s:'spades'}; return m[card[1]]||'spades'; }
function getSuitSymbol(card)  { const m={h:'♥',d:'♦',c:'♣',s:'♠'}; return m[card[1]]||'♠'; }
function getDisplayValue(card){ const m={T:'10',J:'J',Q:'Q',K:'K',A:'A'}; return m[card[0]]||card[0]; }

// ============================================
// SCREENS
// ============================================
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
}

function showGameControls(status, isB) {
    ['bet-controls','banker-wait','banker-arrange',
     'my-raw-cards','my-hands','arrange-controls'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    if (status === 'betting') {
        if (isB) document.getElementById('banker-wait').style.display = 'block';
        else     document.getElementById('bet-controls').style.display = 'block';

    } else if (status === 'arranging') {
        if (isB) document.getElementById('banker-arrange').style.display = 'block';
        document.getElementById('my-raw-cards').style.display     = 'block';
        document.getElementById('my-hands').style.display         = 'flex';
        document.getElementById('arrange-controls').style.display = 'block';

    } else if (status === 'revealing' || status === 'roundEnd') {
        // Keep my hand zones visible face-up during reveal
        document.getElementById('my-hands').style.display = 'flex';
    }
}

// ============================================
// CARD ELEMENTS
// ============================================
function createCardEl(cardCode, draggable=false) {
    const el = document.createElement('div');
    el.classList.add('card', getSuit(cardCode));
    el.dataset.card = cardCode;
    el.innerHTML = '<span class="mc-val">' + getDisplayValue(cardCode) + '</span><span class="mc-suit">' + getSuitSymbol(cardCode) + '</span>';
    if (draggable) {
        el.draggable = true;
        el.addEventListener('dragstart', onDragStart);
        el.addEventListener('dragend',   onDragEnd);
    }
    return el;
}

function createFaceDownCard() {
    const el = document.createElement('div');
    el.classList.add('card','face-down');
    el.textContent = '🂠';
    return el;
}

// ============================================
// DRAG AND DROP — positional insertion
// ============================================
function onDragStart(e) {
    draggedCard = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Track last cursor pos for the magnetic dragend fallback below.
    window._lastDragX = e.clientX;
    window._lastDragY = e.clientY;
    document.addEventListener('dragover', _trackDragPos, true);
}
function _trackDragPos(e) {
    if (e.clientX) window._lastDragX = e.clientX;
    if (e.clientY) window._lastDragY = e.clientY;
}

function onDragEnd(e) {
    document.removeEventListener('dragover', _trackDragPos, true);
    const card = e.target;
    card.classList.remove('dragging');
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());

    // MAGNETIC FALLBACK: if no drop zone caught the card (it would still
    // be in its original parent now because the browser snapped it back),
    // check whether the cursor was over — or near — a hand zone and
    // force-place the card there. Avoids the "drop fizzles, card returns
    // to main pile" frustration the user reported.
    const stillInOriginal = card.parentElement; // browser already returned it
    const x = window._lastDragX, y = window._lastDragY;
    if (typeof x === 'number' && typeof y === 'number') {
        const zones = [...document.querySelectorAll('#raw-card-row, .pile-drop')];
        let bestZone = null, bestDist = Infinity;
        const PAD = 50; // 50px slop around each zone
        for (const z of zones) {
            const r = z.getBoundingClientRect();
            const inside = (x >= r.left - PAD && x <= r.right + PAD &&
                            y >= r.top  - PAD && y <= r.bottom + PAD);
            if (!inside) continue;
            // Distance from cursor to zone center — pick closest if multiple match.
            const cx = r.left + r.width/2, cy = r.top + r.height/2;
            const d  = Math.hypot(x - cx, y - cy);
            if (d < bestDist) { bestDist = d; bestZone = z; }
        }
        if (bestZone && bestZone !== stillInOriginal) {
            const { before } = getDragInsertionPoint(bestZone, x);
            if (before) bestZone.insertBefore(card, before);
            else bestZone.appendChild(card);
            syncPiles();
        }
    }
    draggedCard = null;
}

// Get the card element in a zone that the cursor is closest to,
// and whether we should insert before or after it.
function getDragInsertionPoint(zone, clientX) {
    const cards = [...zone.querySelectorAll('.card:not(.dragging)')];
    if (!cards.length) return { before: null }; // empty zone — just append

    for (const card of cards) {
        const rect   = card.getBoundingClientRect();
        const midX   = rect.left + rect.width / 2;
        if (clientX < midX) return { before: card };
    }
    return { before: null }; // insert at end
}

function setupDropZones() {
    // Re-setup every round
    document.querySelectorAll('.pile-drop, #raw-card-row').forEach(zone => {

        zone.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            zone.classList.add('drag-over');

            // Show insertion indicator
            document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
            const { before } = getDragInsertionPoint(zone, e.clientX);
            const indicator  = document.createElement('div');
            indicator.className = 'drop-indicator';
            if (before) zone.insertBefore(indicator, before);
            else        zone.appendChild(indicator);
        });

        zone.addEventListener('dragleave', e => {
            // Only remove drag-over if leaving the zone entirely (not entering a child)
            if (!zone.contains(e.relatedTarget)) {
                zone.classList.remove('drag-over');
                document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
            }
        });

        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            if (!draggedCard) return;

            // Remove indicator and insert card at that position
            const indicator = zone.querySelector('.drop-indicator');
            if (indicator) {
                zone.insertBefore(draggedCard, indicator);
                indicator.remove();
            } else {
                const { before } = getDragInsertionPoint(zone, e.clientX);
                if (before) zone.insertBefore(draggedCard, before);
                else        zone.appendChild(draggedCard);
            }

            draggedCard.draggable = true;
            syncPiles();
        });
    });
}


// ============================================
// TOUCH SUPPORT — tap to select, tap pile to place
// ============================================
let _touchSelectedCard = null;
let _touchCardsBound = false;
let _magneticTouchBound = false;
let _suppressTouchClick = false;

function isMobile() {
    return window.matchMedia('(max-width: 600px)').matches || 'ontouchstart' in window;
}

// Prevent double-tap zoom on interactive elements (mobile UX)
function preventDoubleTapZoom() {
    if (!isMobile()) return;
    document.querySelectorAll(
        '.btn-primary, .btn-secondary, .pile-drop, .card, #ingame-menu-btn, #chat-fab'
    ).forEach(el => {
        el.style.touchAction = 'manipulation';
    });
}

function setupTouchCards() {
    if (!isMobile()) return;
    setupMagneticTouchDrag();
    if (_touchCardsBound) return;
    _touchCardsBound = true;

    // Show touch hint
    document.querySelectorAll('.touch-hint').forEach(el => el.style.display = 'block');

    // Add tap listener to raw card row — event delegation
    const rawRow = document.getElementById('raw-card-row');
    if (rawRow) {
        rawRow.addEventListener('click', e => {
            if (_suppressTouchClick) { _suppressTouchClick = false; return; }
            const card = e.target.closest('.card');
            if (!card) return;

            // Deselect if tapping same card
            if (_touchSelectedCard === card) {
                card.classList.remove('selected-mobile');
                _touchSelectedCard = null;
                return;
            }

            // Deselect previous
            if (_touchSelectedCard) {
                _touchSelectedCard.classList.remove('selected-mobile');
            }

            // Select new card
            card.classList.add('selected-mobile');
            _touchSelectedCard = card;
        });
    }

    // Add tap listener to pile-drop zones
    document.querySelectorAll('.pile-drop').forEach(pile => {
        pile.addEventListener('click', e => {
            // If a card is selected, drop it here
            if (_touchSelectedCard) {
                pile.appendChild(_touchSelectedCard);
                _touchSelectedCard.classList.remove('selected-mobile');
                _touchSelectedCard.draggable = true;
                _touchSelectedCard = null;
                syncPiles();
                return;
            }

            // If tapping a card already IN a pile, select it for moving
            const card = e.target.closest('.card');
            if (card) {
                if (_touchSelectedCard === card) {
                    card.classList.remove('selected-mobile');
                    _touchSelectedCard = null;
                    return;
                }
                if (_touchSelectedCard) {
                    _touchSelectedCard.classList.remove('selected-mobile');
                }
                card.classList.add('selected-mobile');
                _touchSelectedCard = card;
            }
        });
    });

    // Tap raw row to send selected pile card back to raw row
    if (rawRow) {
        rawRow.addEventListener('click', e => {
            if (!e.target.closest('.card') && _touchSelectedCard) {
                rawRow.appendChild(_touchSelectedCard);
                _touchSelectedCard.classList.remove('selected-mobile');
                _touchSelectedCard = null;
                syncPiles();
            }
        });
    }
}

function getCardOverlapRatio(cardRect, zoneRect) {
    const left = Math.max(cardRect.left, zoneRect.left);
    const right = Math.min(cardRect.right, zoneRect.right);
    const top = Math.max(cardRect.top, zoneRect.top);
    const bottom = Math.min(cardRect.bottom, zoneRect.bottom);
    const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
    const area = Math.max(1, cardRect.width * cardRect.height);
    return overlap / area;
}

function setupMagneticTouchDrag() {
    if (!isMobile() || _magneticTouchBound) return;
    _magneticTouchBound = true;
    let active = null;

    document.addEventListener('pointerdown', e => {
        const card = e.target.closest('.card');
        if (!card || card.classList.contains('face-down')) return;
        if (!card.closest('#raw-card-row, .pile-drop')) return;
        if (document.getElementById('btn-arrange')?.disabled) return;

        const rect = card.getBoundingClientRect();
        active = {
            card,
            startX: e.clientX,
            startY: e.clientY,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            parent: card.parentElement,
            next: card.nextSibling,
            moved: false
        };
        card.setPointerCapture?.(e.pointerId);
        card.classList.add('dragging', 'magnetic-dragging');
        card.style.position = 'fixed';
        card.style.left = rect.left + 'px';
        card.style.top = rect.top + 'px';
        card.style.width = rect.width + 'px';
        card.style.height = rect.height + 'px';
        card.style.zIndex = '10000';
        card.style.pointerEvents = 'none';
        e.preventDefault();
    }, { passive:false });

    document.addEventListener('pointermove', e => {
        if (!active) return;
        const dx = Math.abs(e.clientX - active.startX);
        const dy = Math.abs(e.clientY - active.startY);
        if (dx > 4 || dy > 4) active.moved = true;
        active.card.style.left = (e.clientX - active.offsetX) + 'px';
        active.card.style.top = (e.clientY - active.offsetY) + 'px';
        e.preventDefault();
    }, { passive:false });

    document.addEventListener('pointerup', e => {
        if (!active) return;
        const { card, parent, next, moved } = active;
        const cardRect = card.getBoundingClientRect();
        const zones = [...document.querySelectorAll('#raw-card-row, .pile-drop')];
        let bestZone = null;
        let bestRatio = 0;
        zones.forEach(zone => {
            const ratio = getCardOverlapRatio(cardRect, zone.getBoundingClientRect());
            if (ratio > bestRatio) {
                bestRatio = ratio;
                bestZone = zone;
            }
        });

        card.classList.remove('dragging', 'magnetic-dragging');
        card.style.position = '';
        card.style.left = '';
        card.style.top = '';
        card.style.width = '';
        card.style.height = '';
        card.style.zIndex = '';
        card.style.pointerEvents = '';

        // Magnetic threshold: any meaningful overlap snaps to that zone.
        // Was 0.5 (had to be 50%-over) which felt too strict on mobile —
        // cards regularly bounced back to the main pile when dropped near,
        // but not centered-on, a hand. 0.2 = 20% overlap is enough.
        if (bestZone && bestRatio >= 0.2) {
            const centerX = cardRect.left + cardRect.width / 2;
            const { before } = getDragInsertionPoint(bestZone, centerX);
            if (before) bestZone.insertBefore(card, before);
            else bestZone.appendChild(card);
            syncPiles();
        } else if (bestZone && bestRatio > 0) {
            // Even just touching a zone counts — snap to it as a fallback
            // before resorting to "return to original parent".
            const centerX = cardRect.left + cardRect.width / 2;
            const { before } = getDragInsertionPoint(bestZone, centerX);
            if (before) bestZone.insertBefore(card, before);
            else bestZone.appendChild(card);
            syncPiles();
        } else if (parent) {
            parent.insertBefore(card, next);
        }

        if (moved) _suppressTouchClick = true;
        active = null;
        e.preventDefault();
    }, { passive:false });
}

function syncPiles() {
    ['hand1','hand2','hand3'].forEach(pile => {
        const zone = document.querySelector(`.pile-drop[data-pile="${pile}"]`);
        if (zone) piles[pile] = [...zone.querySelectorAll('.card')].map(el => el.dataset.card);
    });
    // Auto-detect special hint (for display only — declaration doesn't require arrangement)
    const detected = detectSpecialClient(piles.hand1, piles.hand2, piles.hand3);
    const msgEl    = document.getElementById('special-msg');
    if (detected && msgEl && !document.getElementById('btn-declare-special').disabled) {
        msgEl.textContent = `⭐ Special detected: ${detected.name} (${detected.multiplier}x)! Click Declare Special.`;
    } else if (msgEl && !msgEl.textContent.startsWith('✅') && !msgEl.textContent.startsWith('❌')) {
        msgEl.textContent = '';
    }
}

// Detect special from raw (unarranged) cards — tries natural split 3/5/5
function detectSpecialClientFromRaw(raw) {
    if (!raw || raw.length !== 13) return null;
    // Pass full raw split naturally — detectSpecialClient checks all 13 as a whole
    return detectSpecialClient(raw.slice(0,3), raw.slice(3,8), raw.slice(8,13));
}

// Client-side special detection (mirrors server logic for hint display only)
function detectSpecialClient(h1, h2, h3) {
    const all = [...h1,...h2,...h3];
    if (all.length !== 13) return null;
    // Full Suit
    const fs = all[0]?.[1];
    if (fs && all.every(c=>c[1]===fs)) return {name:'Full Suit',multiplier:10};
    // 6½ — count exact pairs/trips
    const valMap = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14};
    const vc = {};
    all.forEach(c=>{ const v=valMap[c[0]]||0; vc[v]=(vc[v]||0)+1; });
    const ep = Object.values(vc).filter(c=>c===2).length;
    const et = Object.values(vc).filter(c=>c===3).length;
    const eq = Object.values(vc).filter(c=>c===4).length;
    if (ep===6||(ep===5&&et===1)) return {name:'6½',multiplier:8};
    // Royal Flush in h2 or h3
    const checkRoyal = h => {
        const vals = h.map(c=>({'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14}[c[0]]||0));
        return h.every(c=>c[1]===h[0][1]) && [10,11,12,13,14].every(v=>vals.includes(v));
    };
    if (checkRoyal(h2)||checkRoyal(h3)) return {name:'Royal Flush',multiplier:7};
    // Flush-Flush-Flush
    if (h1.every(c=>c[1]===h1[0][1])&&h2.every(c=>c[1]===h2[0][1])&&h3.every(c=>c[1]===h3[0][1]))
        return {name:'Flush-Flush-Flush',multiplier:5};
    // Straight-Straight-Straight
    const isStraight = cards => {
        const vals = [...new Set(cards.map(c=>({'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14}[c[0]]||0)))].sort((a,b)=>a-b);
        if (vals.length!==cards.length) return false;
        return vals[vals.length-1]-vals[0]===vals.length-1||vals.join(',')==='2,3,4,5,14'||vals.join(',')==='2,3,14';
    };
    const canFormSSS = cards => {
        const combo = (arr, n, start=0, pref=[], out=[]) => {
            if (pref.length === n) { out.push([...pref]); return out; }
            for (let i=start; i<=arr.length-(n-pref.length); i++) {
                pref.push(arr[i]); combo(arr, n, i+1, pref, out); pref.pop();
            }
            return out;
        };
        const rem = (arr, used) => arr.filter(c => !new Set(used).has(c));
        for (const a of combo(cards, 3)) {
            if (!isStraight(a)) continue;
            const r10 = rem(cards, a);
            for (const b of combo(r10, 5)) {
                const c = rem(r10, b);
                if (isStraight(b) && isStraight(c)) return true;
            }
        }
        return false;
    };
    if ((isStraight(h1)&&isStraight(h2)&&isStraight(h3)) || canFormSSS(all)) return {name:'Straight-Straight-Straight',multiplier:5};
    // Four of a Kind (checked before Straight Flush)
    if (eq > 0) return {name:'Four of a Kind',multiplier:3};
    // Royal Flush from all 13 raw cards — A,K,Q,J,10 of same suit
    const royalInRaw = (() => {
        const bySuit = {};
        all.forEach(c => { if (!bySuit[c[1]]) bySuit[c[1]]=[]; bySuit[c[1]].push(c); });
        return Object.values(bySuit).some(sc => {
            const vs = new Set(sc.map(c=>valMap[c[0]]||0));
            return [10,11,12,13,14].every(v=>vs.has(v));
        });
    })();
    if (royalInRaw) return {name:'Royal Flush',multiplier:7};
    // Straight Flush — 5+ consecutive same-suit cards anywhere in all 13
    const sfInRaw = (() => {
        const bySuit = {};
        all.forEach(c => { if (!bySuit[c[1]]) bySuit[c[1]]=[]; bySuit[c[1]].push(c); });
        for (const sc of Object.values(bySuit)) {
            if (sc.length < 5) continue;
            const vals = [...new Set(sc.map(c=>valMap[c[0]]||0))].sort((a,b)=>a-b);
            let run = 1;
            for (let i=1;i<vals.length;i++) {
                if (vals[i]===vals[i-1]+1) { run++; if (run>=5) return true; }
                else run=1;
            }
            // Ace-low
            if (vals.includes(14)) {
                const low = [...new Set(vals.map(v=>v===14?1:v))].sort((a,b)=>a-b);
                run=1;
                for (let i=1;i<low.length;i++) {
                    if (low[i]===low[i-1]+1) { run++; if (run>=5) return true; }
                    else run=1;
                }
            }
        }
        return false;
    })();
    if (sfInRaw) return {name:'Straight Flush',multiplier:3};
    // No Face
    if (!all.some(c=>['J','Q','K'].includes(c[0]))) return {name:'No Face',multiplier:2};
    return null;
}

// ============================================
// RENDER
// ============================================
function renderMyCards(cards) {
    const row = document.getElementById('raw-card-row');
    row.innerHTML = '';
    piles.hand1=[]; piles.hand2=[]; piles.hand3=[];
    document.querySelectorAll('.pile-drop').forEach(p => p.innerHTML='');
    cards.forEach(card => row.appendChild(createCardEl(card, true)));
}

function renderOpponentHands(zoneId, player, revealed=false) {
    // Ghost bots (left players) — clear their zones entirely
    if (player.isGhostBot) {
        ['1','2','3'].forEach(num => {
            const slot = document.getElementById(`${zoneId}-cards-${num}`);
            if (slot) slot.innerHTML = '';
            const block = slot?.closest('.hand-block');
            if (block) block.querySelectorAll('.hand-result').forEach(b => b.remove());
        });
        return;
    }
    const hasCards = player.hasCards || (player.rawCards && player.rawCards.length > 0);
    const arranged = player.hasArranged;

    // Per-hand results: r1/r2/r3 from player.handResults (only for non-banker players)
    const hr = player.handResults || null;
    const isBankerZone = player.isBanker;
    // Banker's own hand names (attached by updateOpponentSeats from a player's handResults)
    const bankerOwnNames = player._bankerNames || null;

    const resultFor = (num) => {
        if (!hr) return null;
        return num==='1' ? hr.r1 : num==='2' ? hr.r2 : hr.r3;
    };
    // Player's hand name (from player perspective)
    const handNameFor = (num) => {
        if (!hr || !hr.names) return '';
        const idx = num==='1' ? 0 : num==='2' ? 1 : 2;
        return hr.names.player ? hr.names.player[idx] : '';
    };
    // Banker's hand name (stored in names.banker on the PLAYER's handResults)
    const bankerHandNameFor = (num) => {
        if (!hr || !hr.names) return '';
        const idx = num==='1' ? 0 : num==='2' ? 1 : 2;
        return hr.names.banker ? hr.names.banker[idx] : '';
    };

    [['1',3],['2',5],['3',5]].forEach(([num, count]) => {
        const slot = document.getElementById(`${zoneId}-cards-${num}`);
        if (!slot) return;
        slot.innerHTML = '';
        slot.classList.remove('won','lost','tied');

        // Remove ALL old badges appended as siblings after the slot
        const block = slot.closest('.hand-block');
        if (block) {
            block.querySelectorAll('.hand-result').forEach(b => b.remove());
        }

        const handKey = num==='1'?'hand1':num==='2'?'hand2':'hand3';
        const cards   = player[handKey] || [];

        if (revealed && cards.length > 0) {
            cards.forEach(c => {
                const m = document.createElement('div');
                m.className = 'mini-card face-up ' + getSuit(c);
                m.innerHTML = '<span class="mc-val">' + getDisplayValue(c) + '</span><span class="mc-suit">' + getSuitSymbol(c) + '</span>';
                slot.appendChild(m);
            });
            const r = resultFor(num);
            if (r !== null) {
                // Normal hand result: WIN / LOSE / TIE + hand name badges
                slot.classList.add(r===1?'won':r===-1?'lost':'tied');
                const badge = document.createElement('div');
                badge.className = 'hand-result ' + (r===1?'hr-win': r===-1?'hr-lose':'hr-tie');
                const handName = handNameFor(num);
                badge.innerHTML = (r===1?'WIN':r===-1?'LOSE':'TIE')
                    + (handName ? '<br><span style="font-size:0.75em;font-weight:600;opacity:0.85">'+handName+'</span>' : '');
                if (block) block.appendChild(badge);
                // Also show banker's hand name as a secondary info badge
                const bName = bankerHandNameFor(num);
                if (bName) {
                    const bBadge = document.createElement('div');
                    bBadge.className = 'hand-result hr-info';
                    bBadge.innerHTML = '🏦<br><span style="font-size:0.75em;font-weight:600;opacity:0.85">'+bName+'</span>';
                    if (block) block.appendChild(bBadge);
                }
            } else if (!isBankerZone && num === '1' && player.lastSpecial) {
                // Special round or DQ — show outcome badge on the 1st hand block only
                const isWin  = player.lastSpecial.startsWith('⭐') || player.lastSpecial.startsWith('✅');
                const isLoss = player.lastSpecial.startsWith('🏦') || player.lastSpecial.startsWith('❌');
                const badge  = document.createElement('div');
                badge.className = 'hand-result ' + (isWin ? 'hr-win' : isLoss ? 'hr-lose' : 'hr-info');
                badge.style.cssText = 'max-width:90px;font-size:9px;text-align:center;padding:3px 5px;white-space:normal;word-break:break-word;line-height:1.3';
                badge.textContent = player.lastSpecial;
                if (block) block.appendChild(badge);
            } else if (isBankerZone && bankerOwnNames) {
                // Banker zone: show their own hand name as an info badge
                const bName = bankerOwnNames[num==='1'?0:num==='2'?1:2];
                if (bName) {
                    const badge = document.createElement('div');
                    badge.className = 'hand-result hr-info';
                    badge.innerHTML = bName;
                    if (block) block.appendChild(badge);
                }
            }
        } else if (arranged || hasCards) {
            // Show face-down cards for any player who has been dealt cards
            // (whether bot or real human who hasn't arranged yet)
            for (let i = 0; i < count; i++) {
                const m = document.createElement('div');
                m.className = 'mini-card face-down';
                slot.appendChild(m);
            }
        }
    });
}


// Render my own arranged cards face-up in the pile-drop zones during reveal
function renderMyRevealHands(me) {
    if (!me) return;
    const hr = me.handResults || null;
    const resultFor = (key) => {
        if (!hr) return null;
        return key==='hand1' ? hr.r1 : key==='hand2' ? hr.r2 : hr.r3;
    };
    const handNameFor = (key) => {
        if (!hr || !hr.names || !hr.names.player) return '';
        const idx = key==='hand1' ? 0 : key==='hand2' ? 1 : 2;
        return hr.names.player[idx] || '';
    };

    [['hand1', 3], ['hand2', 5], ['hand3', 5]].forEach(([key, count]) => {
        const zone = document.querySelector(`.pile-drop[data-pile="${key}"]`);
        if (!zone) return;
        zone.innerHTML = '';
        zone.classList.remove('won','lost','tied');

        // Remove old result badge that sits below the drop zone (in hand-pile)
        const pile = zone.closest('.hand-pile');
        if (pile) {
            const old = pile.querySelector('.pile-drop-result');
            if (old) old.remove();
        }

        const cards = me[key] || [];
        if (cards.length > 0) {
            cards.forEach(c => {
                const el = document.createElement('div');
                el.classList.add('card', getSuit(c));
                el.dataset.card = c;
                el.innerHTML = '<span class="mc-val">' + getDisplayValue(c) + '</span><span class="mc-suit">' + getSuitSymbol(c) + '</span>';
                zone.appendChild(el);
            });
        }

        // Win/lose/tie badge placed BELOW the pile-drop, inside hand-pile
        const r = resultFor(key);
        if (r !== null) {
            zone.classList.add(r===1?'won':r===-1?'lost':'tied');
            const badge = document.createElement('div');
            badge.className = 'pile-drop-result ' + (r===1?'hr-win': r===-1?'hr-lose':'hr-tie');
            const handName = handNameFor(key);
            badge.innerHTML = (r===1?'WIN':r===-1?'LOSE':'TIE')
                + (handName ? '&nbsp;<span style="font-size:0.85em;opacity:0.85">'+handName+'</span>' : '');
            if (pile) pile.appendChild(badge);
        } else if (key === 'hand1' && me.lastSpecial) {
            // Special round or DQ — show outcome on first hand only
            const isWin = me.lastSpecial.startsWith('⭐') || me.lastSpecial.startsWith('✅');
            const badge = document.createElement('div');
            badge.className = 'pile-drop-result ' + (isWin ? 'hr-win' : 'hr-lose');
            badge.style.cssText = 'font-size:10px;max-width:160px;text-align:center;white-space:normal;word-break:break-word;line-height:1.3';
            badge.textContent = me.lastSpecial;
            if (pile) pile.appendChild(badge);
        }
    });
}

// ============================================
// BET CONTROLS
// ============================================
function initBetControls(minBet, startingChips) {
    // Always derive config from TABLE_CONFIGS to prevent bad defaults
    const cfg    = TABLE_CONFIGS[minBet] || TABLE_CONFIGS[100];
    tableMinBet  = cfg.minBet;
    // Effective max = table max OR what the player can afford (whichever is lower)
    const chips  = startingChips || 0;
    const effMax = chips > 0 ? Math.min(cfg.maxBet, chips) : cfg.maxBet;
    currentBet   = Math.min(cfg.minBet, effMax);
    updateBetDisplay();
    const maxEl  = document.getElementById('max-bet-label');
    if (maxEl) maxEl.textContent = 'Max: $' + effMax.toLocaleString();
}

function updateBetDisplay() {
    document.getElementById('bet-display').textContent = `$${currentBet}`;
}

function adjustBet(delta) {
    const state = window._lastState;
    const me    = state?.players?.[mySessionId];
    if (!me) return;
    const tableMaxBet = state.tableMaxBet || (tableMinBet * 3);
    // Use the table's actual increment from game state
    const resolvedBetCfg = TABLE_CONFIGS[state?.tableMinBet || tableMinBet] || TABLE_CONFIGS[100];
    const step    = resolvedBetCfg.increment;
    const newBet  = currentBet + (delta > 0 ? step : -step);
    // Cap to what player can actually afford (chips), and table max
    const myChipsNow = me?.chips || 0;
    const effectiveMax = myChipsNow > 0 ? Math.min(tableMaxBet, myChipsNow) : tableMaxBet;
    currentBet = Math.max(tableMinBet, Math.min(newBet, effectiveMax));
    updateBetDisplay();
    sendMsg("placeBet", { amount: currentBet });
}

// ============================================
// GAME UI
// ============================================
function updateGameUI(state) {
    window._lastState = state;
    document.getElementById('game-round').textContent     = `Round ${state.round} / ${state.maxRounds}`;
    document.getElementById('game-status').textContent    = formatStatus(state.status);
    const msgEl = document.getElementById('table-message'); if(msgEl) msgEl.textContent = state.message || '';

    const timerEl = document.getElementById('game-timer');
    const cdEl    = document.getElementById('cd-number');
    const t = state.timer || 0;
    timerEl.textContent = t;
    timerEl.classList.toggle('urgent', t <= 10);
    // Timer warning beep in last 10 seconds during arranging phase
    if (t <= 10 && t > 0 && state.status === 'arranging' && typeof SFX !== 'undefined') SFX.timer();
    if (cdEl) { cdEl.textContent = t; cdEl.classList.toggle('urgent', t <= 10); }

    // Sync bet countdown overlay
    if (state.status === 'betting') {
        const t    = state.timer || 0;
        const TOTAL = 10;
        const bc   = document.getElementById('bet-countdown');
        const ring = document.getElementById('bet-ring');
        const alertText = document.getElementById('bet-alert-text');
        const urgent = t <= 3;
        const warn   = t <= 6;

        if (bc) bc.textContent = t;

        // Drive SVG countdown ring
        if (ring) {
            const circumference = 213.6;
            const offset = circumference * (1 - t / TOTAL);
            ring.style.strokeDashoffset = offset;
            ring.style.stroke = urgent ? '#ef4444' : warn ? '#f87171' : '#c9a84c';
        }

        // Urgency effects on text
        if (alertText) {
            alertText.style.animationDuration = urgent ? '0.35s' : '1.1s';
            alertText.style.color       = urgent ? '#ef4444' : '#c9a84c';
            alertText.style.textShadow  = urgent
                ? '0 0 30px rgba(239,68,68,.8), 0 0 60px rgba(239,68,68,.4)'
                : '0 0 30px rgba(201,168,76,.6), 0 0 60px rgba(201,168,76,.25)';
            if (urgent && t !== (state.timer - 1)) alertText.textContent = 'BET NOW!';
            else if (!urgent)                       alertText.textContent = 'Place Your Bet';
        }

        if (bc) {
            bc.style.color = urgent ? '#ef4444' : '#f0f6ff';
        }
    }

    const me = state.players?.[mySessionId];
    if (me) {
        const wasBanker = isBanker;
        isBanker = me.isBanker;
        // Apply banker perspective — repositions zones via CSS class
        const oval = document.querySelector('.oval-table');
        if (oval) oval.classList.toggle('banker-pov', isBanker);
        // In banker-pov, reverse the flex direction of banker zone so
        // nametag appears above hands (zone is now at bottom of table)
        const bankerZone = document.querySelector('.zone-banker');
        if (bankerZone) {
            bankerZone.style.flexDirection = isBanker ? 'column-reverse' : 'column';
        }
        // In banker-pov, zone-p1 moves to LEFT and zone-p3 moves to RIGHT
        // but the side-extras (outside the oval) stay physically left/right.
        // Swap their IDs so the correct player data always matches the correct side.
        // In banker-pov: CSS moves zone-p1 to LEFT and zone-p3 to RIGHT.
        // Remap ALL element IDs in side-extras so they match the visual zones.
        // Do this on EVERY update (not just on transition) to handle page reloads.
        const sideLeft  = document.querySelector('.side-extras.side-left');
        const sideRight = document.querySelector('.side-extras.side-right');
        if (sideLeft && sideRight) {
            const L = isBanker ? 'p1' : 'p3'; // zone visually on LEFT
            const R = isBanker ? 'p3' : 'p1'; // zone visually on RIGHT
            // Left side-extras
            sideLeft.querySelector('.side-name').id      = L + '-name';
            sideLeft.querySelector('.side-balance').id   = L + '-balance';
            sideLeft.querySelector('.special-box').id    = L + '-special';
            const lPill = sideLeft.querySelector('.bet-pill');
            if (lPill) {
                lPill.id = L + '-bet-pill';
                const lAmt = lPill.querySelector('.bp-amt');
                if (lAmt) lAmt.id = L + '-bet-amt';
            }
            // Right side-extras
            sideRight.querySelector('.side-name').id     = R + '-name';
            sideRight.querySelector('.side-balance').id  = R + '-balance';
            sideRight.querySelector('.special-box').id   = R + '-special';
            const rPill = sideRight.querySelector('.bet-pill');
            if (rPill) {
                rPill.id = R + '-bet-pill';
                const rAmt = rPill.querySelector('.bp-amt');
                if (rAmt) rAmt.id = R + '-bet-amt';
            }
        }
        document.getElementById('my-chips').textContent = `Chips: ${me.chips}`;
        // Keep module-level myChips in sync with live game state
        if (typeof myChips !== 'undefined') myChips = me.chips;
        if (typeof igmWallet !== 'undefined') igmWallet = me.chips;

        // bet display now shown in side-extras via updateOpponentSeats

        const payoutEl = document.getElementById('my-payout');
        if (me.lastPayout > 0) {
            payoutEl.textContent=`+${me.lastPayout}`; payoutEl.className='payout-win';
            if (window._lastPayout !== me.lastPayout && typeof SFX !== 'undefined') SFX.win();
        } else if (me.lastPayout < 0) {
            payoutEl.textContent=`${me.lastPayout}`; payoutEl.className='payout-loss';
            if (window._lastPayout !== me.lastPayout && typeof SFX !== 'undefined') SFX.lose();
        } else { payoutEl.textContent=''; }
        window._lastPayout = me.lastPayout;
    }

    showGameControls(state.status, isBanker);

    // If we've already arranged this round, keep the arrange controls locked
    if (state.status === 'arranging' && me?.hasArranged) {
        document.getElementById('btn-arrange').disabled = true;
        document.getElementById('btn-declare-special').disabled = true;
        document.getElementById('my-raw-cards').style.display = 'none';
        document.getElementById('my-hands').style.display = 'none';
    }

    // Transitions
    if (state.status === 'betting' && lastStatus !== 'betting') {
        // Resolve minBet from multiple reliable sources — never use bare state.tableMinBet
        // because it may still be 0 if the state hasn't propagated yet
        const resolvedMinBet = state.tableMinBet
            || igmTableCfg?.minBet
            || (()=>{ try { return JSON.parse(sessionStorage.getItem('sipsam_table'))?.minBet; } catch(e){} return null; })()
            || 100; // absolute fallback — $100 table
        initBetControls(resolvedMinBet, me?.chips || 1000);
        document.getElementById('btn-bet-up').disabled   = false;
        document.getElementById('btn-bet-down').disabled = false;
        // Update button labels from TABLE_CONFIGS — single source of truth
        const resolvedCfg  = TABLE_CONFIGS[resolvedMinBet] || TABLE_CONFIGS[100];
        const inc = resolvedCfg.increment;
        const upBtn   = document.getElementById('btn-bet-up');
        const downBtn = document.getElementById('btn-bet-down');
        if (upBtn)   upBtn.textContent   = '+$' + inc.toLocaleString();
        if (downBtn) downBtn.textContent = '-$' + inc.toLocaleString();
        // Update max label to reflect player's actual chips vs table max
        const myChipsForMax = me?.chips || 0;
        const effMaxBet = myChipsForMax > 0 ? Math.min(resolvedCfg.maxBet, myChipsForMax) : resolvedCfg.maxBet;
        const maxLbl = document.getElementById('max-bet-label');
        if (maxLbl) maxLbl.textContent = 'Max: $' + effMaxBet.toLocaleString();
        document.getElementById('bet-msg').textContent   = '';
        // Show full-screen bet overlay for non-bankers
        const overlay = document.getElementById('bet-overlay');
        const roundLbl = document.getElementById('bet-round-label');
        if (overlay && !isBanker) {
            if (roundLbl) roundLbl.textContent = `${state.round} of ${state.maxRounds}`;
            overlay.style.display = 'flex';
            overlay.style.animation = 'betOverlayIn .3s ease';
        }
        // Build/rebuild seatMap excluding the current banker
        // Rebuilds on round 1, when empty, OR when banker changed
        const bankerSidNow = Object.entries(state.players||{}).find(([,p])=>p.isBanker)?.[0];
        const seatMapHasBanker = bankerSidNow && seatMap[bankerSidNow];
        const bankerChanged   = bankerSidNow !== lastBankerSid;
        if (state.round === 1 || Object.keys(seatMap).length === 0 || seatMapHasBanker || bankerChanged) {
            seatMap = {};
            const zones = ['p1','p2','p3'];
            let zi = 0;
            Object.keys(state.players||{}).forEach(sid => {
                if (sid === bankerSidNow) return; // banker always goes to banker zone
                if (zi < zones.length) seatMap[sid] = zones[zi++];
            });
            lastBankerSid = bankerSidNow;
        }
        // Show deal animation — cards visually distributed to all seats
        setTimeout(() => runDealAnimation(state), 300);
    }
    const roundChanged = state.round !== lastRound;
    // Hide bet overlay when betting phase ends
    if (state.status !== 'betting') {
        const overlay = document.getElementById('bet-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    // Show validation overlay on arranging → revealing transition
    if (state.status === 'revealing' && lastStatus === 'arranging') {
        const revOverlay = document.getElementById('reveal-overlay');
        if (revOverlay) {
            revOverlay.style.display = 'flex';
            // Auto-dismiss after 3 seconds so hands become visible
            setTimeout(() => {
                if (revOverlay) {
                    revOverlay.style.transition = 'opacity .5s ease';
                    revOverlay.style.opacity    = '0';
                    setTimeout(() => {
                        revOverlay.style.display  = 'none';
                        revOverlay.style.opacity  = '1';
                        revOverlay.style.transition = '';
                    }, 500);
                }
            }, 3000);
        }
    }

    // Always hide reveal overlay when phase moves past revealing
    if (state.status !== 'revealing' && state.status !== 'arranging') {
        const revOverlay = document.getElementById('reveal-overlay');
        if (revOverlay && revOverlay.style.display !== 'none') {
            revOverlay.style.display = 'none';
        }
    }

    if (state.status === 'arranging' && (lastStatus !== 'arranging' || roundChanged)) {
        lastRound = state.round;
        // Fully reset piles and card areas for the new round
        piles = {hand1:[], hand2:[], hand3:[]};
        // Clear all 3 hand drop zones
        ['hand1','hand2','hand3'].forEach(pile => {
            const zone = document.querySelector(`.pile-drop[data-pile="${pile}"]`);
            if (zone) zone.innerHTML = '';
        });
        // Clear raw card row
        const rawRow = document.getElementById('raw-card-row');
        if (rawRow) rawRow.innerHTML = '';
        setupDropZones();
        if (me && me.rawCards && me.rawCards.length > 0) renderMyCards(me.rawCards);
        // Set up touch interaction for mobile players
        setTimeout(() => setupTouchCards(), 100);
        // On mobile, scroll my-area into view so player sees their cards
        if (isMobile()) {
            setTimeout(() => {
                const myArea = document.querySelector('.my-area');
                if (myArea) myArea.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }, 300);
        }
        else console.warn('No rawCards in state for me:', me);
        // Close the Declare Special modal if it's open from a previous round
        const existingModal = document.getElementById('special-modal-backdrop');
        if (existingModal) existingModal.remove();

        document.getElementById('btn-arrange').disabled         = false;
        document.getElementById('btn-declare-special').disabled  = false;
        document.getElementById('btn-declare-special').style.display = 'inline-block';
        document.getElementById('arrange-msg').textContent  = '';
        document.getElementById('special-msg').textContent  = '';
        const dqMsgEl = document.getElementById('dq-msg');
        if (dqMsgEl) dqMsgEl.textContent = '';
        const dqPanel = document.getElementById('disqualify-panel');
        if (dqPanel) dqPanel.style.display = 'none';
    }
    if (state.status === 'betting' && roundChanged) {
        lastRound = state.round;
    }
    lastStatus = state.status;

    const revealed = (state.status === 'revealing' || state.status === 'roundEnd' || state.status === 'gameOver');
    updateOpponentSeats(state, revealed);
    if (revealed) {
        renderMyRevealHands(me);
        buildDisqualifyPanel(state);
    }
    else {
        const dqPanel = document.getElementById('disqualify-panel');
        if (dqPanel) dqPanel.style.display = 'none';
    }

    if (state.status === 'gameOver') {
        showGameOver(state);
        // Server settled chips to bank — update local display
        const myState = state.players ? Object.values(state.players).find(p => p.username === myUsername) : null;
        if (myState && typeof igmBank !== 'undefined') {
            // igmBank will be refreshed next time menu opens via fetchIgmBank
        }
    }
}

function updateOpponentSeats(state, revealed) {
    const players  = state.players || {};
    const zones    = ['p1','p2','p3'];
    let   bankerSid = null;

    Object.entries(players).forEach(([sid, p]) => { if (p.isBanker) bankerSid = sid; });

    // ── Banker zone ──
    if (bankerSid) {
        const bp   = players[bankerSid];
        const isMe = bankerSid === mySessionId;
        const bAv  = bp.avatar ? bp.avatar + ' ' : '';
        const label = '🏦 BANKER: ' + bAv + (bp.username||'Banker') + (bp.isBot?' 🤖':'') + (isMe?' (You)':'');

        const nameEl    = document.getElementById('banker-name');
        const chipsEl   = document.getElementById('banker-chips');
        const betDispEl = document.getElementById('banker-bet-display');
        const specEl    = document.getElementById('banker-special');
        if (nameEl)    nameEl.textContent    = label;
        if (chipsEl)   chipsEl.textContent   = '$' + bp.chips;
        if (betDispEl) betDispEl.textContent  = bp.bet > 0 ? 'BET $' + bp.bet : '';
        if (specEl)    specEl.textContent     = bp.lastSpecial || '';
        // Find banker hand names from any player's handResults.names.banker
        if (revealed) {
            let bankerNames = null;
            Object.values(players).forEach(p => {
                if (!p.isBanker && p.handResults && p.handResults.names && p.handResults.names.banker) {
                    bankerNames = p.handResults.names.banker;
                }
            });
            bp._bankerNames = bankerNames; // attach so renderOpponentHands can use it
        }
        renderOpponentHands('banker', bp, revealed);
    }

    // ── All non-banker players → p1, p2, p3 using stable seatMap ──
    const others = Object.entries(players).filter(([sid]) => sid !== bankerSid);

    // Refresh seatMap if empty (e.g. page reload mid-game)
    if (Object.keys(seatMap).length === 0 && others.length > 0) {
        let zi = 0;
        others.forEach(([sid]) => { if (zi < zones.length) seatMap[sid] = zones[zi++]; });
    }

    const usedZones = new Set();
    others.forEach(([sid, player]) => {
        const zId = seatMap[sid] || zones[others.findIndex(([s])=>s===sid)];
        if (!zId) return;
        usedZones.add(zId);
        const isMe      = sid === mySessionId;
        const nameEl    = document.getElementById(zId + '-name');
        const betEl     = document.getElementById(zId + '-bet-amt');
        const specEl    = document.getElementById(zId + '-special');
        const balanceEl = document.getElementById(zId + '-balance');
        // Grey out zones for players who left mid-game
        const zoneEl = document.getElementById('zone-' + zId) || document.querySelector('.zone-' + zId);
        if (zoneEl) zoneEl.style.opacity = player.isGhostBot ? '0.35' : '';
        const pAv   = (player.avatar && !player.isGhostBot) ? player.avatar + ' ' : '';
        const label = player.isGhostBot
            ? (player._promoteToRealBot ? '🤖 Bot joining next round...' : '🚪 (Left)')
            : pAv + player.username + (player.isBot?' 🤖':'') + (isMe?' (You)':'');
        if (nameEl)    nameEl.textContent    = label;
        if (betEl)     betEl.textContent     = '$'+(player.bet||0);
        if (specEl)    specEl.textContent    = player.lastSpecial || '';
        if (balanceEl) balanceEl.textContent = '$'+player.chips;
        renderOpponentHands(zId, player, revealed);
    });

    // Hide unused zones
    zones.forEach(z => {
        if (!usedZones.has(z)) {
            const nameEl = document.getElementById(z + '-name');
            if (nameEl) nameEl.textContent = '—';
        }
    });
}

function formatStatus(s) {
    const m = { waiting:'Waiting...', betting:'Place Bets (10s)', arranging:'Arrange Cards (65s)', revealing:'Revealing Hands (30s)', roundEnd:'Round Complete', gameOver:'Game Over' };
    return m[s] || s;
}

function showGameOver(state) {
    const scoresEl = document.getElementById('final-scores');
    scoresEl.innerHTML = '';

    const me = state.players?.[mySessionId];
    const startChips = state.tableWalletSize || state.tableMinBet * 6 || 0;
    const myFinalChips = me ? me.chips : 0;
    const isWin = myFinalChips > startChips;
    const mode  = state.blitz ? 'blitz' : String(state.maxRounds || 10);

    // Build scores table — ghost bots (left players) shown separately at bottom
    const activePlayers = Object.values(state.players||{}).filter(p => !p.isGhostBot);
    const ghostPlayers  = Object.values(state.players||{}).filter(p =>  p.isGhostBot);
    const sorted = [...activePlayers.sort((a,b) => b.chips - a.chips), ...ghostPlayers];

    sorted.forEach((p, i) => {
        if (p.isGhostBot) {
            // Show left players as a greyed-out note
            const row = document.createElement('div');
            row.classList.add('score-row');
            row.style.opacity = '0.45';
            row.innerHTML = `<span>🚪 ${p.username || '(Left)'}</span><span style="font-size:11px;color:#7a9ac0">Left game early</span>`;
            scoresEl.appendChild(row);
            return;
        }
        const row = document.createElement('div');
        row.classList.add('score-row');
        const isMe = state.players && Object.entries(state.players).find(([sid,pl])=>pl===p)?.[0] === mySessionId;
        if (i===0) row.classList.add('score-winner');
        if (isMe)  row.classList.add('score-me');
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'🏅';
        const tag   = (p.isBot && !p.isGhostBot) ? ' 🤖' : (isMe ? ' (You)' : '');
        const diff  = p.chips - startChips;
        const diffStr = diff >= 0 ? `+$${diff.toLocaleString()}` : `-$${Math.abs(diff).toLocaleString()}`;
        const diffColor = diff >= 0 ? '#4ade80' : '#f87171';
        row.innerHTML = `
            <span>${medal} ${p.username}${tag}</span>
            <span>$${p.chips.toLocaleString()} &nbsp;<span style="font-size:11px;color:${diffColor}">(${diffStr})</span>&nbsp; ${p.wins} round wins</span>`;
        scoresEl.appendChild(row);
    });

    // Determine if this player is the table winner (most chips among ALL players including bots)
    // Game Winner Bonus only applies when there's at least one other real human player
    const allPlayers      = Object.values(state.players || {});
    const humanPlayers    = allPlayers.filter(p => !p.isBot && !p.isGhostBot);
    // Table winner = human with most chips (bots excluded from winner calculation)
    const sortedHumans    = [...humanPlayers].sort((a, b) => b.chips - a.chips);
    const chipLeader      = sortedHumans[0];
    const chipLeaderSid   = Object.entries(state.players || {}).find(([,p]) => p === chipLeader)?.[0];
    const isTableWinner   = chipLeaderSid === mySessionId && humanPlayers.length >= 1;

    // Record stats — only for real human player, only once
    if (me && !me.isBot && !window._statsRecorded) {
        window._statsRecorded = true;
        const token = igmToken;
        if (token) {
            fetch('/api/game/record-result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                credentials: 'include',
                body: JSON.stringify({
                    isWin,
                    isTableWinner,
                    mode,
                    rounds:      state.maxRounds || 10,
                    tableMinBet: state.tableMinBet,
                    finalChips:  myFinalChips,
                    startChips
                })
            })
            .then(r => r.json())
            .then(d => {
                if (d.ok) {
                    console.log('[STATS] ✅ Recorded:', mode, isWin ? 'WIN' : 'LOSS',
                        isTableWinner ? '👑 TABLE WINNER +$1,000' : '');
                    // Show winner bonus toast
                    if (d.winnerBonusPaid && typeof showIngameToast === 'function') {
                        showIngameToast('👑 Game Winner Bonus!', '+$1,000 added to your bank!');
                    }
                    // Show milestone unlocked toast
                    if (d.milestonesUnlocked?.length && typeof showIngameToast === 'function') {
                        d.milestonesUnlocked.forEach(m => {
                            setTimeout(() => {
                                showIngameToast('🏆 Milestone Reached!',
                                    `${m.label} unlocked — $${m.reward.toLocaleString()} ready to claim!`);
                            }, 2000);
                        });
                    }
                }
            })
            .catch(e => console.warn('[STATS] record-result failed:', e.message));
        }
    }

    // Update win/loss banner
    const resultEl = document.getElementById('gameover-result');
    if (resultEl && me && !me.isBot) {
        resultEl.textContent  = isWin ? '🏆 You Won!' : '💸 Better luck next time';
        resultEl.style.color  = isWin ? '#4ade80' : '#f87171';
    }

    // Store state for Play Again
    window._gameOverState = state;

    showScreen('screen-gameover');
}

// ── INVITE FRIENDS FROM LOBBY ──────────────────────────────
let _lobbyFriends = null; // cached friends list

async function getLobbyFriends() {
    if (_lobbyFriends) return _lobbyFriends;
    try {
        const token = igmToken;
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
        const token = igmToken;
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
            ? '<div style="padding:11px 14px;font-size:12px;color:#7a9ac0">No matches. You can still type a full username to invite.</div>'
            : '<div style="padding:11px 14px;font-size:12px;color:#7a9ac0">No friends yet. Type any username to search all players.</div>';
        dd.style.display = 'block';
        return;
    }
    const row = (username, label, col) => `
        <div onclick="selectLobbyInvitee('${username}')"
             style="padding:9px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(26,45,80,.5)"
             onmouseenter="this.style.background='rgba(26,140,255,.08)'" onmouseleave="this.style.background=''">
          <span style="width:28px;height:28px;border-radius:50%;background:#1a2d50;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;color:#c9a84c">${username[0].toUpperCase()}</span>
          <span style="flex:1;font-size:13px;color:#f0f6ff">${username}</span>
          <span style="font-size:10px;color:${col};letter-spacing:.5px">${label}</span>
        </div>`;
    let html = '';
    if (friends.length) {
        html += '<div style="padding:5px 14px 3px;font-size:9px;font-weight:700;letter-spacing:2px;color:#4aabff;text-transform:uppercase">Friends</div>';
        html += friends.map(f => row(f.username, '🤝 Friend', '#4aabff')).join('');
    }
    if (others.length) {
        html += '<div style="padding:5px 14px 3px;font-size:9px;font-weight:700;letter-spacing:2px;color:#7a9ac0;text-transform:uppercase;border-top:1px solid #1a2d50;margin-top:2px">Other Players</div>';
        html += others.map(u => row(u.username, '👤 Player', '#7a9ac0')).join('');
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
    const dd  = document.getElementById('lobby-invite-dropdown');
    if (dd)  dd.style.display = 'none';
}

document.addEventListener('click', e => {
    const dd = document.getElementById('lobby-invite-dropdown');
    if (dd && !dd.contains(e.target) && e.target.id !== 'invite-username')
        dd.style.display = 'none';
});

// SipSam max table size = 4 humans (banker + 3 others). Player can invite
// up to 3 friends from the lobby. Track sent invites locally; server-side
// enforcement happens via room membership.
window._lobbyInviteCount = window._lobbyInviteCount || 0;
const SIPSAM_MAX_INVITES = 3;

// Cancel from lobby — return to dashboard, refund wallet to bank.
function cancelLobby() {
    if (!confirm('Cancel and return to the dashboard? Your wallet will be returned to your bank.')) return;
    try {
        const token = igmToken || (() => { try { return JSON.parse(sessionStorage.getItem('sipsam_user')||'{}').token || null; } catch(e){ return null; }})();
        if (token) {
            // Fire wallet-return; navigate regardless of result so user isn't stuck
            fetch('/api/game/exit', {
                method: 'POST',
                headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
                body: JSON.stringify({ remainingWallet: (typeof myChips==='number' ? myChips : 0), tableMinBet: (igmTableCfg?.minBet || selectedMinBet || 0) })
            }).catch(()=>{});
        }
    } catch(e) {}
    window._intentionalExit = true;
    setTimeout(() => { window.location.href = '/'; }, 200);
}

async function sendLobbyInvite() {
    const input    = document.getElementById('invite-username');
    const statusEl = document.getElementById('invite-status');
    if (!input || !statusEl) return;
    if (window._lobbyInviteCount >= SIPSAM_MAX_INVITES) {
        statusEl.textContent = `⚠️ Maximum ${SIPSAM_MAX_INVITES} invites — table is capped at 4 players.`;
        statusEl.style.color = '#fca5a5';
        return;
    }
    const username = input.value.trim();
    if (!username) { statusEl.textContent = '⚠️ Enter a username.'; statusEl.style.color = '#fca5a5'; return; }

    statusEl.textContent = 'Sending invite...'; statusEl.style.color = '#7a9ac0';

    try {
        const token = igmToken || (()=>{ try { return JSON.parse(sessionStorage.getItem('sipsam_user')||'{}').token||null; } catch(e){ return null; } })();
        if (!token) { statusEl.textContent = '⚠️ Not authenticated.'; statusEl.style.color = '#fca5a5'; return; }

        const tableConfig = igmTableCfg || {};
        const res = await fetch('/api/friends/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            credentials: 'include',
            body: JSON.stringify({
                toUsername:  username,
                game:        'sipsam',
                roomId:      myRoomId,
                tableMinBet: tableConfig.minBet || selectedMinBet,
                tableConfig: {
                    minBet:     tableConfig.minBet     || selectedMinBet,
                    maxBet:     tableConfig.maxBet,
                    walletSize: tableConfig.walletSize  || tableConfig.wallet,
                    wallet:     tableConfig.walletSize  || tableConfig.wallet,
                    inc:        tableConfig.increment   || tableConfig.inc,
                    minBank:    tableConfig.minBank     || tableConfig.bankRequired,
                    rounds:     window._gameOverState?.maxRounds || selectedRounds || 10,
                    blitz:      false,
                    roomId:     myRoomId
                }
            })
        });
        const data = await res.json();
        if (data.ok) {
            window._lobbyInviteCount = (window._lobbyInviteCount || 0) + 1;
            const remaining = SIPSAM_MAX_INVITES - window._lobbyInviteCount;
            statusEl.textContent = remaining > 0
                ? `✅ Invite sent to ${username}! (${remaining} more allowed)`
                : `✅ Invite sent to ${username}! Maximum reached — table is capped at 4 players.`;
            statusEl.style.color = '#22c55e';
            input.value = '';
            if (window._lobbyInviteCount >= SIPSAM_MAX_INVITES) {
                input.disabled = true;
                const sendBtn = input.parentElement?.querySelector('button');
                if (sendBtn) sendBtn.disabled = true;
            }
            setTimeout(() => { if (statusEl && remaining > 0) statusEl.textContent = ''; }, 4000);
            // Mark this room as private now that an invite has been sent
            if (myRoomId && myRoomId !== 'sipsam_main') {
                fetch('/room/' + myRoomId + '/make-private', { method: 'POST' }).catch(()=>{});
                window._isPrivateRoom = true;
            }
        } else {
            statusEl.textContent = '❌ ' + (data.error || 'Failed to send.');
            statusEl.style.color = '#fca5a5';
        }
    } catch(e) {
        statusEl.textContent = '⚠️ Server error.'; statusEl.style.color = '#fca5a5';
    }
}

function playAgain() {
    const state = window._gameOverState;
    const token = igmToken;

    if (!token) { window.location.replace('/'); return; }

    // Build table config from multiple reliable sources
    const cfg = igmTableCfg || {};
    const minBet = cfg.minBet || state?.tableMinBet;
    if (!minBet) { window.location.replace('/'); return; }

    // TABLE_CONFIGS is defined in game.js — use it as authoritative source
    const tableCfg = TABLE_CONFIGS[minBet] || {};
    const walletSize = tableCfg.walletSize || cfg.walletSize || cfg.wallet || 0;

    sessionStorage.setItem('sipsam_user', JSON.stringify({
        username: myUsername || '—',
        token:    token,
        avatar:   myAvatar || window._myAvatar || ''
    }));
    sessionStorage.setItem('sipsam_table', JSON.stringify({
        minBet:     minBet,
        maxBet:     tableCfg.maxBet     || cfg.maxBet,
        walletSize: walletSize,
        wallet:     walletSize,
        inc:        tableCfg.increment  || cfg.increment || cfg.inc,
        minBank:    tableCfg.bankRequired || cfg.minBank || cfg.bankRequired,
        rounds:     state?.maxRounds || 10,
        blitz:      state?.blitz || false
    }));
    window._statsRecorded  = false;
    window._serverSettled  = true;  // server already settled at game end — no beacon needed
    window._intentionalExit = true; // prevent beforeunload beacon
    myChips   = 0;
    igmWallet = 0;
    setTimeout(() => window.location.reload(), 300);
}

function updateLobbyUI(state) {
    const listEl = document.getElementById('player-list');
    listEl.innerHTML = '';
    const allPlayers  = Object.values(state.players || {});
    const realPlayers = allPlayers.filter(p => !p.isBot && !p.isGhostBot);
    const openSeats   = Math.max(0, 4 - realPlayers.length);

    // Show real players
    realPlayers.forEach(player => {
        const item = document.createElement('div');
        item.classList.add('player-list-item');
        const av = (player.avatar && player.avatar !== 'default') ? player.avatar + ' ' : '';
        item.textContent = av + player.username;
        listEl.appendChild(item);
    });

    // Show open seat slots
    for (let i = 0; i < openSeats; i++) {
        const item = document.createElement('div');
        item.classList.add('player-list-item');
        item.style.cssText = 'opacity:0.4;font-style:italic;color:#7a9ac0';
        item.textContent = '— Open Seat —';
        listEl.appendChild(item);
    }

    // Show lobby countdown timer
    const countdown = state.lobbyCountdown || 0;
    let timerEl = document.getElementById('lobby-timer');
    if (!timerEl) {
        timerEl = document.createElement('div');
        timerEl.id = 'lobby-timer';
        timerEl.style.cssText = 'margin-top:12px;text-align:center;font-size:12px;color:#7a9ac0';
        const statusEl = document.getElementById('lobby-status');
        if (statusEl) statusEl.after(timerEl);
    }
    if (countdown > 0) {
        const mins = Math.floor(countdown / 60);
        const secs = String(countdown % 60).padStart(2, '0');
        const urgent = countdown <= 30;
        timerEl.style.color = urgent ? '#f87171' : '#7a9ac0';
        timerEl.innerHTML = `⏱ Game starts in <strong style="color:${urgent?'#f87171':'#c9a84c'}">${mins}:${secs}</strong> — invite friends or wait for bots to fill seats`;
    } else if (countdown === 0 && state.players && Object.keys(state.players).length > 0) {
        timerEl.textContent = '';
    }
}

// TABLE CONFIG MAP — mirrors dashboard table definitions


// Apply a pre-selected table+rounds config to the lobby (called from auto-login)
function applyLobbyPreselect(table, rounds) {
    const cfg = TABLE_CONFIGS[table.minBet] || table;

    // Show the config banner. Hide ONLY the table-tier picker; keep the
    // rounds picker visible — players still pick rounds in the lobby
    // (round count is independent of table tier).
    const preEl    = document.getElementById('lobby-preselected');
    const manualEl = document.getElementById('lobby-manual-select');
    if (preEl) preEl.style.display = 'block';
    if (manualEl) {
        manualEl.style.display = 'block';
        const labels = manualEl.querySelectorAll('.lobby-section-label');
        const tableButtons = manualEl.querySelector('.table-buttons');
        if (tableButtons) tableButtons.style.display = 'none';
        // First label is the "Select Table" caption — hide it. Keep "Select rounds" label.
        if (labels[0]) labels[0].style.display = 'none';
    }
    // Invited joiner: lock down all host-only controls. Only the table info
    // and an Exit button remain visible.
    const isInvited = table.isInvitedJoiner === true;
    if (isInvited) {
        // Hide rounds buttons + label
        if (manualEl) manualEl.style.display = 'none';
        // Hide invite-friend section
        const inviteSec = document.getElementById('invite-section');
        if (inviteSec) inviteSec.style.display = 'none';
        // Hide Start Game button (host-only)
        const startBtn = document.getElementById('btn-start-game');
        if (startBtn) startBtn.style.display = 'none';
        // Re-label Cancel as "Exit Lobby"
        const cancelBtn = document.getElementById('btn-cancel-lobby');
        if (cancelBtn) {
            cancelBtn.textContent = 'Exit Lobby';
            cancelBtn.style.flex = '1';
        }
        // Status message: waiting for host
        const status = document.getElementById('lobby-selection-info');
        if (status) {
            status.textContent = '⏳ Waiting for the host to start the game…';
            status.style.color = '#7ec8ff';
            status.style.fontSize = '14px';
            status.style.fontWeight = '700';
        }
    } else {
        // Auto-select the rounds button matching the chosen rounds (visual + state)
        setTimeout(() => {
            const targetRounds = (table.blitz === true) ? 5 : (rounds || 10);
            document.querySelectorAll('.btn-rounds').forEach(b => {
                const m = b.textContent.match(/(\d+)/);
                const n = m ? parseInt(m[1]) : 0;
                if (n === targetRounds) {
                    b.classList.add('selected');
                    if (typeof selectRounds === 'function') selectRounds(n, b);
                } else {
                    b.classList.remove('selected');
                }
            });
        }, 0);
    }

    // Populate banner values
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const isBlitz = table.blitz === true;
    setEl('lci-table',  '$' + cfg.minBet + ' Table');
    setEl('lci-minbet', '$' + cfg.minBet);
    setEl('lci-rounds', isBlitz ? '⚡ BLITZ (5)' : rounds + ' rounds');
    setEl('lci-wallet', '$' + Number(cfg.walletSize || cfg.wallet || 0).toLocaleString());
    // Style rounds value orange for blitz
    const roundsEl = document.getElementById('lci-rounds');
    if (roundsEl) roundsEl.style.color = isBlitz ? '#ff9a3c' : '';

    // Programmatically set the selection variables
    selectedMinBet = cfg.minBet;
    selectedRounds = rounds;

    checkCanStart();
    const info = document.getElementById('lobby-selection-info');
    if (info) info.textContent = '';
}

// ============================================
// SEND MESSAGE — plain JSON
// ============================================
function sendMsg(type, data={}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("sendMsg: WS not open, state:", ws?.readyState);
        return;
    }
    const msg = JSON.stringify({ type, ...data });
    console.log("Sending:", type, data);
    ws.send(msg);
}
// ============================================
// CONNECT
// ============================================
async function connect(username, authToken, _roomId) {
    // Update login-status if it exists and is visible; otherwise it's fine
    const statusEl = document.getElementById('login-status');
    if (statusEl) statusEl.textContent = 'Connecting...';
    try {
        ws = await joinRoom(username, authToken, _roomId);
        myUsername = username;
        const myAv = window._myAvatar || '';
        document.getElementById('my-name').textContent = (myAv ? myAv + ' ' : '') + username;
        if (statusEl) statusEl.textContent = '';
        showScreen('screen-lobby');

        // onmessage and onclose are already set inside joinRoom
        // so we don't need to re-set them here
    } catch(err) {
        console.error("[connect] Error:", err);
        // Always make screen-login visible with a clear error — never leave black screen
        showScreen('screen-login');
        const loginCard = document.querySelector('.login-card, .login-box, #login-form');
        if (loginCard) loginCard.style.display = '';
        const errEl = document.getElementById('login-status');
        if (errEl) {
            errEl.style.display = 'block';
            errEl.style.color   = '#ff6b6b';
            errEl.textContent   = '⚠️ ' + err.message;
        } else {
            // Worst case: inject a visible error message
            document.body.insertAdjacentHTML('afterbegin',
                `<div style="position:fixed;top:20px;left:50%;transform:translateX(-50%);
                background:#1a0a0a;border:1px solid #ff6b6b;color:#ff6b6b;padding:16px 24px;
                border-radius:8px;z-index:9999;font-family:monospace;font-size:14px">
                ⚠️ Connection failed: ${err.message}</div>`
            );
        }
    }
}

function handleServerMessage(msg) {
    if (msg.type === 'stateUpdate') {
        const state = msg.state;
        const me    = state.players?.[mySessionId];
        if (me) isBanker = me.isBanker;

        // Sound triggers on status change
        if (typeof SFX !== 'undefined') {
            if (state.status === 'arranging' && window._lastStatus !== 'arranging') SFX.deal();
            if (state.status === 'betting'   && window._lastStatus !== 'betting')   SFX.chip();
        }
        window._lastStatus = state.status;

        if (state.status === 'waiting') {
            showScreen('screen-lobby');
            updateLobbyUI(state);
        } else {
            if (!document.getElementById('screen-game').classList.contains('active') && state.status !== 'gameOver') {
                showScreen('screen-game');
                // Always keep in-game menu button visible during gameplay
                const menuBtn = document.getElementById('ingame-menu-btn');
                if (menuBtn) menuBtn.style.display = 'flex';
            }
            updateGameUI(state);
        }
    } else if (msg.type === 'error') {
        // General errors (chip transfers, etc.) — shown in relevant panel
        // Note: invalid hand arrangement now results in DQ, not an error message
    } else if (msg.type === 'specialConfirmed') {
        const msgEl = document.getElementById('special-msg');
        if (msgEl) msgEl.textContent = `✅ ${msg.specialName} (${msg.multiplier}x) — CONFIRMED! Waiting for reveal...`;
    } else if (msg.type === 'specialDenied') {
        const msgEl = document.getElementById('special-msg');
        if (msgEl) msgEl.textContent = msg.message || 'Wrong special declared - you are DISQUALIFIED.';
        showSpecialDeniedModal(msg);
        document.getElementById('btn-arrange').disabled = true;
        document.getElementById('btn-declare-special').disabled = true;
    } else if (msg.type === 'specialAlert') {
        // Show a banner on the table for everyone
        showSpecialAlertBanner(msg.username, msg.specialName, msg.multiplier);
        if (typeof SFX !== 'undefined') SFX.special();
    } else if (msg.type === 'walletDebt') {
        const tmEl = document.getElementById('table-message');
        if (tmEl) tmEl.textContent = `💸 ${msg.reason}`;
        if (msg.username === myUsername) {
            // Update igmBank — can go negative
            if (typeof igmBank !== 'undefined') igmBank = igmBank - msg.debt;
            const bankStr = igmBank < 0
                ? `Bank: -$${Math.abs(igmBank).toLocaleString()} (in debt)`
                : `Bank: $${igmBank.toLocaleString()}`;
            showIngameToast('💸 Bank Hit', `$${msg.debt.toLocaleString()} pulled from your bank. ${bankStr}`);
        }
    } else if (msg.type === 'replenishResult') {
        if (typeof onReplenishResult === 'function') onReplenishResult(msg);
    } else if (msg.type === 'playerDisqualified') {
        const tmEl = document.getElementById('table-message');
        if (tmEl) { tmEl.textContent = `⚠️ ${msg.username} DISQUALIFIED — ${msg.reason}`; }
        const dqMsg = document.getElementById('dq-msg');
        if (dqMsg) dqMsg.textContent = `✅ ${msg.username} disqualified: ${msg.reason}`;
    } else if (msg.type === 'disqualifyDenied') {
        const dqMsg = document.getElementById('dq-msg');
        if (dqMsg) dqMsg.textContent = `❌ ${msg.message}`;

    } else if (msg.type === 'bankerChanged') {
        showIngameToast('🏦 Banker Changed', `${msg.username} is now the Banker.`);

    } else if (msg.type === 'playerBroke') {
        showIngameToast('💸 Player Eliminated', `${msg.username} ran out of chips and has been removed.`);

    } else if (msg.type === 'gameAborted') {
        showIngameToast('🚪 Game Ended', msg.message || 'Not enough players to continue.');
        setTimeout(() => { window._serverSettled = true; window._intentionalExit = true; window.location.href = '/'; }, 4000);

    } else if (msg.type === 'bankerForfeited') {
        showIngameToast('🏦 Banker Forfeited!', msg.message || 'Banker left — you receive 2× your bet!');
        if (typeof SFX !== 'undefined') SFX.win();

    } else if (msg.type === 'playerLeft') {
        showIngameToast('🚪 Player Left', msg.message || `${msg.username} has left the game.`);

    } else if (msg.type === 'botReplaced') {
        showIngameToast('🤖 Bot Joined', `${msg.username} has taken the empty seat.`);

    } else if (msg.type === 'chipRequestSent') {
        showIngameToast('💸 Chip Request Sent', `Request sent to ${msg.toUsername} for $${msg.amount?.toLocaleString()}.`);

    } else if (msg.type === 'doubleRequest') {
        // Another player wants to double — show notification to banker
        if (isBanker) {
            showIngameToast('⚡ Double Request', `${msg.from} wants to double their bet.`);
        }

    } else if (msg.type === 'doubleAccepted') {
        showIngameToast('✅ Double Accepted', `${msg.username}'s double bet was accepted.`);

    } else if (msg.type === 'doubleRejected') {
        showIngameToast('❌ Double Rejected', `${msg.username}'s double bet was rejected.`);

    } else if (msg.type === 'chatMessage') {
        // Resolve position from client's own seatMap (server's guess is unreliable)
        if (typeof showSpeechBubble === 'function') {
            let position;
            if (msg.isBanker) {
                position = 'banker';
            } else if (msg.sessionId === mySessionId) {
                // I am the sender — always show at my own zone (bottom = p2 by convention,
                // but use seatMap to be exact)
                position = seatMap[msg.sessionId] || 'p2';
            } else {
                position = seatMap[msg.sessionId] || 'p1';
            }
            showSpeechBubble(msg.sessionId, msg.username, msg.message, position);
        }

    } else if (msg.type === 'chipRequest') {
        // Another player is requesting chips from me
        if (msg.targetSessionId === mySessionId) {
            if (typeof showIngameToast === 'function') {
                showIngameToast(
                    `🙏 Chip Request`,
                    `${msg.username} requests $${msg.amount.toLocaleString()}. Open menu to respond.`
                );
            }
            // Store pending request so the Send Chips panel can auto-fill it
            window._pendingChipRequest = { from: msg.username, fromSid: msg.sessionId, amount: msg.amount };
        }

    } else if (msg.type === 'chipSent') {
        // Chips were sent to me
        if (msg.targetSessionId === mySessionId) {
            if (typeof showIngameToast === 'function') {
                showIngameToast(`💰 Chips Received`, `${msg.username} sent you $${msg.amount.toLocaleString()}!`);
            }
            if (typeof SFX !== 'undefined') SFX.chipIn();
            // Update local chip count
            if (typeof myChips !== 'undefined') myChips = (myChips || 0) + msg.amount;
            if (typeof igmWallet !== 'undefined') igmWallet = (igmWallet || 0) + msg.amount;
        }

    } else if (msg.type === 'settleComplete') {
        // Server confirmed chips returned to bank — update local bank display
        console.log(`[SETTLE] ✅ Server settled — returned $${msg.returned}, new bank: $${msg.newBankBalance}`);
        if (typeof igmBank !== 'undefined') igmBank = msg.newBankBalance;
        window._serverSettled = true; // flag: server already handled exit

    } else if (msg.type === 'settleFailed') {
        // Server could not settle (missing token) — client must call exit directly
        console.warn('[SETTLE] ⚠️ Server settle failed (no_token) — client falling back to direct exit call');
        (async () => {
            try {
                // igmToken is captured at game load BEFORE sessionStorage is cleared
                const token = (typeof igmToken !== 'undefined' && igmToken)
                    ? igmToken
                    : (()=>{ try { return JSON.parse(sessionStorage.getItem('sipsam_user')||'{}').token||null; } catch(e){ return null; } })();
                const tableMinBet = (typeof igmTableCfg !== 'undefined' && igmTableCfg?.minBet)
                    ? igmTableCfg.minBet
                    : 0;
                const chips = msg.chips || 0;
                if (!token) { console.error('[SETTLE] No token available anywhere — chips lost!'); return; }
                const res = await fetch('/api/game/exit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    credentials: 'include',
                    body: JSON.stringify({ remainingWallet: chips, tableMinBet })
                });
                const data = await res.json();
                if (data.ok) {
                    console.log(`[SETTLE] ✅ Client fallback settle OK — new bank: $${data.newBankBalance}`);
                    if (typeof igmBank !== 'undefined') igmBank = data.newBankBalance;
                    window._serverSettled = true;
                } else {
                    console.error('[SETTLE] ❌ Client fallback also failed:', data.error);
                }
            } catch(e) { console.error('[SETTLE] Client fallback error:', e.message); }
        })();

    } else if (msg.type === 'error') {
        // Show in whichever panel is visible
        const panels = ['special-msg','arrange-msg','bet-msg','dq-msg'];
        for (const id of panels) {
            const el = document.getElementById(id);
            if (el && el.offsetParent !== null) { el.textContent = '⚠️ ' + msg.message; break; }
        }
    }
}

// ── SPECIAL ALERT BANNER ─────────────────────────────────────────
function showSpecialAlertBanner(username, specialName, multiplier) {
    // Remove existing banner
    const existing = document.querySelector('.special-alert-banner');
    if (existing) existing.remove();

    const oval = document.querySelector('.oval-table');
    if (!oval) return;

    const banner = document.createElement('div');
    banner.className = 'special-alert-banner';
    banner.innerHTML = `⭐ ${username} declares <strong>${specialName}</strong> — ${multiplier}x payout!`;
    oval.appendChild(banner);

    // Auto-remove after 5 seconds
    setTimeout(() => banner.remove(), 5000);
}

// ── DISQUALIFY PANEL ──────────────────────────────────────────────
function buildDisqualifyPanel(state) {
    const panel = document.getElementById('disqualify-panel');
    const btns  = document.getElementById('dq-buttons');
    if (!panel || !btns) return;

    const me = state.players?.[mySessionId];
    if (!me) return;

    // Build list of targets:
    // - Non-banker players can ONLY attempt to DQ the Banker (for rule violations)
    // - Banker can DQ any non-banker player
    const targets = [];
    Object.entries(state.players || {}).forEach(([sid, p]) => {
        if (sid === mySessionId) return;
        if (p.disqualified) return;
        if (!me.isBanker && p.isBanker) {
            // Player trying to DQ the banker
            targets.push({sid, name: p.username + ' (Banker)'});
        } else if (me.isBanker && !p.isBanker) {
            // Banker trying to DQ a player
            targets.push({sid, name: p.username + (p.isBot ? ' 🤖' : '')});
        }
    });

    if (targets.length === 0) { panel.style.display = 'none'; return; }

    panel.style.display = 'block';
    btns.innerHTML = '';
    targets.forEach(({sid, name}) => {
        const btn = document.createElement('button');
        btn.className = 'btn-dq';
        btn.textContent = `Disqualify ${name}`;
        btn.onclick = () => {
            if (!confirm(`Request disqualification of ${name}? Server will verify.`)) return;
            sendMsg('disqualifyPlayer', { targetSessionId: sid });
            btn.disabled = true;
            btn.textContent = `Requested...`;
        };
        btns.appendChild(btn);
    });
}


// ============================================
// DEAL ANIMATION
// ============================================
let _dealAnimActive = false;

// VALUE_MAP used for flip card display
const DEAL_VALUE_MAP = {'2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9','T':'10','J':'J','Q':'Q','K':'K','A':'A'};
const DEAL_SUIT_SYM  = {'h':'♥','s':'♠','d':'♦','c':'♣'};
const DEAL_SUIT_COLOR= {'h':'#cc2200','s':'#111','d':'#cc2200','c':'#111'};

// Seat order determines who gets dealt to first.
// SipSam deal rule — flipped card determines first recipient:
//   Banker : A, 5, 9, K
//   P1     : 2, 6, 10 (T)
//   P2     : 3, 7, J
//   P3     : 4, 8, Q
// zoneOrder = ['banker','p1','p2','p3'] → indices 0,1,2,3
function dealStartZone(flipCardCode) {
    if (!flipCardCode) return 1; // default P1
    const face = flipCardCode[0];
    const bankerCards = ['A','5','9','K'];
    const p1Cards     = ['2','6','T'];
    const p2Cards     = ['3','7','J'];
    // P3 = ['4','8','Q']
    if (bankerCards.includes(face)) return 0; // banker
    if (p1Cards.includes(face))     return 1; // p1
    if (p2Cards.includes(face))     return 2; // p2
    return 3;                                  // p3
}

function runDealAnimation(state) {
    if (_dealAnimActive) return;
    const oval = document.querySelector('.oval-table');
    if (!oval) return;

    oval.querySelectorAll('.deal-anim-container,.deck-pile,.flip-card-reveal').forEach(el => el.remove());
    _dealAnimActive = true;

    // ── Deck pile in centre ──
    const deckPile = document.createElement('div');
    deckPile.className = 'deck-pile';
    for (let i = 5; i >= 0; i--) {
        const dc = document.createElement('div');
        dc.className = 'deck-pile-card';
        dc.style.cssText = 'top:' + (-i*1.5) + 'px; left:' + (i*0.5) + 'px;';
        deckPile.appendChild(dc);
    }
    oval.appendChild(deckPile);

    const container = document.createElement('div');
    container.className = 'deal-anim-container';
    oval.appendChild(container);

    const ow = oval.offsetWidth, oh = oval.offsetHeight;
    const cx = ow / 2, cy = oh / 2;
    const cardW = Math.max(24, Math.min(38, ow * 0.04));
    const cardH = cardW * 1.45;

    // Zone targets (centre of each seat area within the oval)
    // Order matches zoneOrder: ['banker','p1','p2','p3']
    const zoneTargets = {
        banker: { x: cx,        y: oh * 0.12 },
        p1:     { x: ow * 0.86, y: cy        },
        p2:     { x: cx,        y: oh * 0.82 },
        p3:     { x: ow * 0.14, y: cy        },
    };

    // ── Step 1: Flip top card to reveal starting player ──
    const flipValues = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const flipSuits  = ['h','s','d','c'];
    const flipCode   = flipValues[Math.floor(Math.random()*flipValues.length)]
                     + flipSuits [Math.floor(Math.random()*flipSuits.length)];

    const flipEl = document.createElement('div');
    flipEl.className = 'flip-card-reveal';
    flipEl.style.cssText =
        'position:absolute;' +
        'left:' + (cx - cardW*1.2) + 'px;' +
        'top:'  + (cy - cardH*1.2) + 'px;' +
        'width:' + (cardW*2.4) + 'px;' +
        'height:' + (cardH*2.4) + 'px;' +
        'border-radius:8px; background:#fff;' +
        'border:2px solid #c9a84c;' +
        'display:flex; flex-direction:column; align-items:center; justify-content:center;' +
        'font-weight:800; font-size:' + (cardW*0.9) + 'px;' +
        'color:' + DEAL_SUIT_COLOR[flipCode[1]] + ';' +
        'box-shadow:0 4px 20px rgba(0,0,0,0.7);' +
        'z-index:60; animation:flipReveal 0.4s ease-out forwards;';
    flipEl.innerHTML =
        '<span style="line-height:1">' + (DEAL_VALUE_MAP[flipCode[0]]||flipCode[0]) + '</span>' +
        '<span style="line-height:1;font-size:1.2em">' + (DEAL_SUIT_SYM[flipCode[1]]||flipCode[1]) + '</span>';

    // Label which zone starts
    const startIdx = dealStartZone(flipCode);
    const zoneOrder = ['banker','p1','p2','p3'];
    const startZone = zoneOrder[startIdx];
    const zoneLabel = { banker:'Banker', p1:'Right player', p2:'Bottom player', p3:'Left player' };
    const subLabel  = document.createElement('div');
    subLabel.style.cssText =
        'position:absolute; bottom:-24px; left:50%; transform:translateX(-50%);' +
        'color:#f0d080; font-size:11px; font-weight:700; white-space:nowrap;' +
        'background:rgba(0,0,0,0.7); border-radius:4px; padding:2px 8px;';
    subLabel.textContent = 'Dealing starts: ' + (zoneLabel[startZone] || startZone);
    flipEl.appendChild(subLabel);

    oval.appendChild(flipEl);

    // After 1.4s, remove flip card and start dealing round-robin from startIdx
    setTimeout(() => {
        flipEl.style.transition = 'opacity 0.3s';
        flipEl.style.opacity    = '0';
        setTimeout(() => {
            flipEl.remove();
            startDealing(startIdx);
        }, 320);
    }, 1400);

    // ── Step 2: Deal cards round-robin from startIdx ──
    function startDealing(si) {
        const totalSeats = 4;
        const cardsPerSeat = 13;
        const totalCards   = totalSeats * cardsPerSeat;
        let cardIdx = 0;

        function dealOne() {
            if (cardIdx >= totalCards) {
                deckPile.style.transition = 'opacity 0.5s';
                deckPile.style.opacity    = '0';
                setTimeout(() => {
                    deckPile.remove();
                    container.remove();
                    _dealAnimActive = false;
                }, 600);
                return;
            }

            // Round-robin from startIdx
            const seatIdx  = (si + cardIdx) % totalSeats;
            const zKey     = zoneOrder[seatIdx];
            const target   = zoneTargets[zKey];

            const spread = 18;
            const tx = target.x + (Math.random()-0.5)*spread - cx - cardW/2;
            const ty = target.y + (Math.random()-0.5)*spread - cy - cardH/2;
            const dr = ((Math.random()-0.5)*20).toFixed(1) + 'deg';

            const card = document.createElement('div');
            card.className = 'deal-anim-card';
            card.style.cssText =
                'left:' + (cx - cardW/2) + 'px;' +
                'top:'  + (cy - cardH/2) + 'px;' +
                'width:' + cardW + 'px;' +
                'height:' + cardH + 'px;' +
                '--dx:' + tx.toFixed(1) + 'px;' +
                '--dy:' + ty.toFixed(1) + 'px;' +
                '--dr:' + dr + ';' +
                'animation: dealIn 0.3s ease-out forwards;';
            container.appendChild(card);

            card.addEventListener('animationend', () => {
                card.style.transition = 'opacity 0.18s 0.12s';
                card.style.opacity    = '0';
                setTimeout(() => card.remove(), 320);
            }, {once:true});

            cardIdx++;
            setTimeout(dealOne, 48);
        }

        dealOne();
    }
}

// ============================================
// BUTTON EVENTS
// ============================================

// Enter key on login input
document.getElementById('username-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') connect(document.getElementById('username-input').value.trim());
});

// Bet controls
document.getElementById('btn-bet-up')  .addEventListener('click', () => adjustBet(1));
document.getElementById('btn-bet-down').addEventListener('click', () => adjustBet(-1));



// Arrange submit
document.getElementById('btn-arrange').addEventListener('click', () => {
    syncPiles();
    const msg = document.getElementById('arrange-msg');
    if (piles.hand1.length !== 3) { msg.textContent = '⚠️ 1st hand needs exactly 3 cards.'; return; }
    if (piles.hand2.length !== 5) { msg.textContent = '⚠️ 2nd hand needs exactly 5 cards.'; return; }
    if (piles.hand3.length !== 5) { msg.textContent = '⚠️ 3rd hand needs exactly 5 cards.'; return; }
    // Clear any previous error styling before submitting
    const arrangeMsgEl = document.getElementById('arrange-msg');
    if (arrangeMsgEl) { arrangeMsgEl.textContent = ''; arrangeMsgEl.classList.remove('arrange-error'); }
    sendMsg("arrangeHands", { hand1:piles.hand1, hand2:piles.hand2, hand3:piles.hand3 });
    msg.textContent = '✅ Arrangement submitted! Waiting for others...';
    document.getElementById('btn-arrange').disabled = true;
    document.getElementById('btn-declare-special').style.display = 'none';
});

// Declare Special — shows modal to pick which special, no arrangement needed first
document.getElementById('btn-declare-special').addEventListener('click', () => {
    showSpecialModal();
});

// All specials with descriptions (same order as server detectSpecial priority)
const ALL_SPECIALS = [
    { name: 'Full Suit',               multiplier: 10, desc: 'All 13 cards in one suit' },
    { name: '6½',                      multiplier:  8, desc: '6 pairs, or 5 pairs + 1 trips' },
    { name: 'Royal Flush',             multiplier:  7, desc: 'Royal Flush in 2nd or 3rd hand' },
    { name: 'Flush-Flush-Flush',       multiplier:  5, desc: 'All three hands are flushes' },
    { name: 'Straight-Straight-Straight', multiplier: 5, desc: 'All three hands are straights' },
    { name: 'Four of a Kind',          multiplier:  3, desc: 'Four of the same rank' },
    { name: 'Straight Flush',          multiplier:  3, desc: 'Straight Flush in 2nd or 3rd hand' },
    { name: 'No Face',                 multiplier:  2, desc: 'No J, Q, or K in any hand' },
];


function showSpecialDeniedModal(msg) {
    const existing = document.getElementById('special-denied-backdrop');
    if (existing) existing.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'special-modal-backdrop';
    backdrop.id = 'special-denied-backdrop';
    const actual = msg.actual
        ? '<strong>' + msg.actual + '</strong>' + (msg.actualMultiplier ? ' (' + msg.actualMultiplier + 'x)' : '')
        : '<strong>No special found</strong>';
    const modal = document.createElement('div');
    modal.className = 'special-modal';
    modal.innerHTML =
        '<h3>Special Declined</h3>' +
        '<p class="modal-sub">' + (msg.message || 'Wrong special declared.') + '</p>' +
        '<div style="font-size:13px;line-height:1.6;color:#c7d7ef;margin:10px 0">' +
        'Declared: <strong>' + (msg.declared || 'Unknown') + '</strong><br>' +
        'Actual highest special: ' + actual +
        '</div>';
    const close = document.createElement('button');
    close.className = 'btn-cancel-special';
    close.textContent = 'Close';
    close.onclick = () => backdrop.remove();
    modal.appendChild(close);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
}

function showSpecialModal() {
    // Auto-detect what special (if any) the player currently has
    syncPiles();
    const detectedSpecial = detectSpecialClient(piles.hand1, piles.hand2, piles.hand3)
        || detectSpecialClientFromRaw(window._lastState?.players?.[mySessionId]?.rawCards || []);

    // Remove any existing modal
    const existing = document.getElementById('special-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'special-modal-backdrop';
    backdrop.id = 'special-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'special-modal';
    modal.innerHTML = `
        <h3>⭐ Declare Special</h3>
        <p class="modal-sub">Choose your special hand. <strong>Wrong declaration = Disqualification.</strong><br>Your cards will be revealed as dealt — no arrangement needed.</p>
    `;

    ALL_SPECIALS.forEach(sp => {
        const btn = document.createElement('button');
        btn.className = 'special-option-btn' + (detectedSpecial && detectedSpecial.name === sp.name ? ' special-option-detected' : '');
        btn.innerHTML = sp.name + ' <span class="multiplier">' + sp.multiplier + 'x — ' + sp.desc + '</span>';
        if (detectedSpecial && detectedSpecial.name === sp.name) {
            btn.title = 'Detected in your current hand!';
        }
        btn.onclick = () => {
            backdrop.remove();
            sendMsg('declareSpecial', { specialName: sp.name });
            document.getElementById('special-msg').textContent = '⭐ Declared: ' + sp.name + ' (' + sp.multiplier + 'x) — awaiting server verdict...';
            document.getElementById('btn-declare-special').disabled = true;
            document.getElementById('btn-arrange').disabled = true;
            document.getElementById('my-raw-cards').style.display = 'none';
            document.getElementById('my-hands').style.display = 'none';
        };
        modal.appendChild(btn);
    });

    const cancel = document.createElement('button');
    cancel.className = 'btn-cancel-special';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => backdrop.remove();
    modal.appendChild(cancel);

    backdrop.appendChild(modal);
    // Close on backdrop click
    backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
}

// ============================================
// LOBBY INLINE ONCLICK FUNCTIONS
// (called directly from HTML onclick attributes)
// ============================================

function selectTable(minBet, btn) {
    selectedMinBet = minBet;
    document.querySelectorAll('.btn-table').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    checkCanStart();
}

function selectRounds(rounds, btn) {
    selectedRounds = rounds;
    document.querySelectorAll('.btn-rounds').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    checkCanStart();
}

function checkCanStart() {
    const canStart = selectedRounds > 0 && selectedMinBet > 0;
    document.getElementById('btn-start-game').disabled = !canStart;
    const info = document.getElementById('lobby-selection-info');
    if (info) info.textContent = canStart ? `$${selectedMinBet} table, ${selectedRounds} rounds selected.` : '';
}

function startGame() {
    if (!selectedRounds || !selectedMinBet) return;
    const tableJson = sessionStorage.getItem('sipsam_table');
    const table     = tableJson ? JSON.parse(tableJson) : {};
    // Blitz fires when the dashboard preselected blitz OR the lobby picked 5 rounds.
    const isBlitz = (table.blitz === true) || (selectedRounds === 5);
    sendMsg("startGame", { rounds: selectedRounds, tableMinBet: selectedMinBet, blitz: isBlitz });
}

// ── VURGLIFE PLATFORM AUTO-LOGIN ──────────────
// Runs on DOMContentLoaded — skips login screen if coming from dashboard
// ── CRASH / CLOSE RECOVERY ──────────────────────────────────────
// If the page closes or crashes mid-game, return chips to bank via beacon API
// sendBeacon works even during page unload (unlike fetch)
window.addEventListener('beforeunload', function() {
    // Only fire beacon on true crash/unexpected close
    // intentionalExit is set by exitToLobby() and playAgain() before navigating
    if (window._intentionalExit) return;
    if (window._serverSettled) return;
    if (!igmToken || !myChips) return;
    const wallet      = myChips || 0;
    const tableMinBet = igmTableCfg?.minBet || 0;
    const payload = JSON.stringify({ remainingWallet: wallet, tableMinBet });
    const blob    = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon('/api/game/exit-beacon?token=' + encodeURIComponent(igmToken), blob);
});

window.addEventListener('DOMContentLoaded', function() {
    try {
        const userJson  = sessionStorage.getItem('sipsam_user');
        const tableJson = sessionStorage.getItem('sipsam_table');

        // Only auto-connect if BOTH sipsam_user AND sipsam_table exist.
        // Both are only set when the player explicitly clicks "Enter Table" on the dashboard.
        // If either is missing, redirect back to the dashboard — the old "Enter your name"
        // screen should never be shown; all access must come through the dashboard.
        if (!userJson || !tableJson) {
            window.location.replace('/');
            return;
        }

        const user  = JSON.parse(userJson);
        const table = JSON.parse(tableJson);
        if (!user || !user.username || !table || !table.minBet) {
            window.location.replace('/');
            return;
        }

        // Clear session storage immediately
        sessionStorage.removeItem('sipsam_user');
        sessionStorage.removeItem('sipsam_table');

        console.log('[VurgLife] Auto-login as:', user.username, '| table:', table);

        // Hide the redirect overlay — we have a valid session
        const redirectOverlay = document.getElementById('screen-redirect');
        if (redirectOverlay) redirectOverlay.remove();

        // Show a connecting overlay — DON'T destroy the DOM, just cover it
        // This keeps all elements (login-status, username-input, etc.) intact
        const overlay = document.createElement('div');
        overlay.id = 'vurglife-connect-overlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:9999',
            'background:#0a0f1a',
            'display:flex', 'flex-direction:column',
            'align-items:center', 'justify-content:center', 'gap:20px'
        ].join(';');
        overlay.innerHTML = `
            <div style="font-family:'Bebas Neue',serif;font-size:42px;letter-spacing:6px;color:#c9a84c">SIPSAM</div>
            <div id="vl-connect-msg" style="color:#7a9ac0;font-size:13px;letter-spacing:2px;text-transform:uppercase">
                Connecting as ${user.username}…
            </div>
            <div style="width:180px;height:2px;background:#1a2a3a;border-radius:2px;overflow:hidden">
                <div id="vl-connect-bar" style="height:100%;width:0%;background:#c9a84c;transition:width 0.4s ease"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Animate the progress bar while connecting
        let pct = 0;
        const barEl = overlay.querySelector('#vl-connect-bar');
        const barTick = setInterval(() => {
            pct = Math.min(pct + 8, 85); // stops at 85% until connect resolves
            if (barEl) barEl.style.width = pct + '%';
        }, 200);

        const removeOverlay = () => {
            clearInterval(barTick);
            if (barEl) barEl.style.width = '100%';
            setTimeout(() => overlay.remove(), 300);
        };

        // Connect to game server — pass token directly since sessionStorage is already cleared
        // Guard against 'default' placeholder from old DB rows
        const rawAvatar = user.avatar || '';
        window._myAvatar     = (rawAvatar === 'default' || rawAvatar === 'null') ? '' : rawAvatar;
        myAvatar             = window._myAvatar;
        window._isPrivateRoom = table.isPrivate || false;
        // Default room is per-tier so different bet tiers don't collide in
        // a single 'sipsam_main' pool (which was bucketing all players into
        // the $100 default config). Invites still use their explicit roomId.
        const defaultRoomForTier = table.minBet ? `sipsam_${table.minBet}` : 'sipsam_main';
        connect(user.username, user.token, table.roomId || defaultRoomForTier).then(() => {
            // connect() calls showScreen('screen-lobby') on success
            removeOverlay();

            if (!table || !table.minBet) return;

            // Call /api/game/enter to deduct wallet from bank
            // Skip if dashboard already called it (enterHandled flag)
            if (!table.enterHandled) {
                fetch('/api/game/enter', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + user.token },
                    credentials: 'include',
                    body: JSON.stringify({ tableMinBet: table.minBet })
                })
                .then(r => r.json())
                .then(d => {
                    if (d.ok) {
                        console.log(`[ENTER] ✅ Wallet funded: $${d.walletSize} | Bank: $${d.newBankBalance}`);
                        igmBank = d.newBankBalance;
                    } else {
                        console.warn('[ENTER] Enter API:', d.error);
                    }
                })
                .catch(e => console.warn('[ENTER] Enter API failed:', e.message));
            } else {
                console.log('[ENTER] Enter already handled by dashboard — skipping.');
            }

            // Apply pre-selected table + rounds from dashboard
            const rounds = table.rounds || 10;
            setTimeout(() => {
                applyLobbyPreselect(table, rounds);
            }, 300);
        }).catch(err => {
            console.warn('[VurgLife] Auto-connect failed:', err);
            removeOverlay();
            // connect() already handles showing the login screen + error message
        });

    } catch(e) {
        console.warn('[VurgLife] Auto-login error:', e);
        // Make sure something is visible
        showScreen('screen-login');
    }
});
