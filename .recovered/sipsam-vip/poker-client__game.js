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
var myRoomId       = null; // current room — set from matchmake response
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
    100:   { minBet:100,   increment:50,    maxBet:150,   walletSize:3000,    bankRequired:5000    },
    250:   { minBet:250,   increment:50,    maxBet:500,   walletSize:10000,   bankRequired:15000   },
    500:   { minBet:500,   increment:100,   maxBet:1000,  walletSize:20000,   bankRequired:30000   },
    1000:  { minBet:1000,  increment:500,   maxBet:2000,  walletSize:40000,   bankRequired:60000   },
    10000: { minBet:10000, increment:10000, maxBet:50000, walletSize:1000000, bankRequired:2000000 },
};
let selectedRounds = 0;
let _isInvitedJoiner = false; // true when player joined via friend invite (not the host)
let _isInvitedJoiner = false; // true when player joined via friend invite (not the host)
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
    // Resolve the table tier from config so matchmaking routes to the right room
    const _tableMinBet = (typeof igmTableCfg !== 'undefined' && igmTableCfg?.minBet)
        ? igmTableCfg.minBet
        : (typeof selectedMinBet !== 'undefined' ? selectedMinBet : 100);
    const _maxRounds = (typeof selectedRounds !== 'undefined' && selectedRounds)
        ? selectedRounds : 10;

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
                    body: JSON.stringify({
                        username,
                        token: _authToken,
                        roomId: _roomId || null,
                        avatar: window._myAvatar || '',
                        isPrivate: window._isPrivateRoom || false,
                        tableMinBet: _tableMinBet,
                        maxRounds: _maxRounds
                    }),
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
    myRoomId = roomId; // store globally for invite system
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
}

function onDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
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

    // Show touch hint
    document.querySelectorAll('.touch-hint').forEach(el => el.style.display = 'block');

    // Add tap listener to raw card row — event delegation
    const rawRow = document.getElementById('raw-card-row');
    if (rawRow) {
        rawRow.addEventListener('click', e => {
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

// ============================================
// MAGNETIC TOUCH DRAG
// Finger-drag a card; if ≥50% overlaps a drop zone on release, snap into it.
// Works for cards in raw-row AND cards already in piles (player stays in control
// until they declare special or submit hands).
// ============================================
let _magDrag = null; // { card, startX, startY, offsetX, offsetY, active, placeholder, lastTouchX, lastTouchY }
const MAG_DRAG_THRESHOLD = 6;     // px of movement before drag activates
const MAG_SNAP_RATIO     = 0.5;   // ≥50% card area over zone → snap in
let _magDragInstalled = false;

function setupMagneticTouchDrag() {
    if (_magDragInstalled) return;
    _magDragInstalled = true;

    document.addEventListener('touchstart', onMagTouchStart, { passive: false });
    document.addEventListener('touchmove',  onMagTouchMove,  { passive: false });
    document.addEventListener('touchend',   onMagTouchEnd,   { passive: false });
    document.addEventListener('touchcancel', onMagTouchEnd,  { passive: false });
}

function isArrangeActive() {
    // Arrange phase active while declare/arrange buttons are enabled
    const b = document.getElementById('btn-declare-special');
    return b && !b.disabled;
}

function rectOverlapArea(a, b) {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return w * h;
}

function findBestDropZone(card) {
    const zones = document.querySelectorAll('.pile-drop, #raw-card-row');
    const cr = card.getBoundingClientRect();
    const area = Math.max(1, cr.width * cr.height);
    let best = null, bestOverlap = 0;
    zones.forEach(z => {
        const zr = z.getBoundingClientRect();
        const ov = rectOverlapArea(cr, zr);
        if (ov > bestOverlap) { bestOverlap = ov; best = z; }
    });
    // Only count as a match if ≥50% of the card is inside the zone
    return (bestOverlap / area) >= MAG_SNAP_RATIO ? best : null;
}

function onMagTouchStart(e) {
    if (e.touches.length !== 1) return;
    const card = e.target.closest('.card');
    if (!card || !card.draggable) return;
    if (!isArrangeActive()) return;

    const t = e.touches[0];
    const rect = card.getBoundingClientRect();
    _magDrag = {
        card,
        startX: t.clientX,
        startY: t.clientY,
        offsetX: t.clientX - rect.left,
        offsetY: t.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        active: false,
        placeholder: null,
        lastTouchX: t.clientX,
        lastTouchY: t.clientY,
    };
}

function onMagTouchMove(e) {
    if (!_magDrag || !_magDrag.card) return;
    const t = e.touches[0];
    const dx = t.clientX - _magDrag.startX;
    const dy = t.clientY - _magDrag.startY;

    if (!_magDrag.active) {
        if (Math.abs(dx) < MAG_DRAG_THRESHOLD && Math.abs(dy) < MAG_DRAG_THRESHOLD) return;
        // Activate drag now
        beginMagDrag();
    }

    // Prevent scrolling while dragging
    e.preventDefault();

    const card = _magDrag.card;
    card.style.left = (t.clientX - _magDrag.offsetX) + 'px';
    card.style.top  = (t.clientY - _magDrag.offsetY) + 'px';
    _magDrag.lastTouchX = t.clientX;
    _magDrag.lastTouchY = t.clientY;

    // Highlight the magnetic target zone (≥50% overlap)
    const target = findBestDropZone(card);
    document.querySelectorAll('.pile-drop.drag-over, #raw-card-row.drag-over')
        .forEach(z => { if (z !== target) z.classList.remove('drag-over'); });
    if (target) target.classList.add('drag-over');
}

function beginMagDrag() {
    const card = _magDrag.card;
    _magDrag.active = true;

    // Insert a sized placeholder so surrounding cards don't shift
    const ph = document.createElement('div');
    ph.className = 'card-placeholder';
    ph.style.cssText = `display:inline-block;width:${_magDrag.width}px;height:${_magDrag.height}px;flex-shrink:0;`;
    card.parentNode.insertBefore(ph, card);
    _magDrag.placeholder = ph;

    // Float the card above everything
    const rect = card.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.left = rect.left + 'px';
    card.style.top  = rect.top + 'px';
    card.style.width = _magDrag.width + 'px';
    card.style.height = _magDrag.height + 'px';
    card.style.zIndex = '9999';
    card.style.pointerEvents = 'none';
    card.style.transition = 'transform 0.08s ease';
    card.classList.add('touch-dragging');
}

function onMagTouchEnd(e) {
    if (!_magDrag || !_magDrag.card) return;
    const card = _magDrag.card;

    // Not a real drag (just a tap) — let the existing tap-select handler deal with it
    if (!_magDrag.active) {
        _magDrag = null;
        return;
    }

    e.preventDefault();

    const target = findBestDropZone(card);

    // Clear styling
    const cardCenterX = (card.getBoundingClientRect().left + card.getBoundingClientRect().right) / 2;
    card.style.position = '';
    card.style.left = '';
    card.style.top = '';
    card.style.width = '';
    card.style.height = '';
    card.style.zIndex = '';
    card.style.pointerEvents = '';
    card.style.transition = '';
    card.classList.remove('touch-dragging');
    document.querySelectorAll('.pile-drop.drag-over, #raw-card-row.drag-over')
        .forEach(z => z.classList.remove('drag-over'));

    const ph = _magDrag.placeholder;

    if (target) {
        // Snap into zone at positional insertion point (by horizontal center of card)
        const { before } = getDragInsertionPoint(target, cardCenterX);
        if (before) target.insertBefore(card, before);
        else        target.appendChild(card);
        if (ph) ph.remove();
        card.draggable = true; // keep draggable so they can move it again
        syncPiles();
    } else {
        // No valid target — return to origin (replace placeholder)
        if (ph) { ph.parentNode.insertBefore(card, ph); ph.remove(); }
    }

    _magDrag = null;
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
// [LINE 430 MISSING — no Read snapshot covers it]
// [LINE 431 MISSING — no Read snapshot covers it]
// [LINE 432 MISSING — no Read snapshot covers it]
// [LINE 433 MISSING — no Read snapshot covers it]
// [LINE 434 MISSING — no Read snapshot covers it]
// [LINE 435 MISSING — no Read snapshot covers it]
// [LINE 436 MISSING — no Read snapshot covers it]
// [LINE 437 MISSING — no Read snapshot covers it]
// [LINE 438 MISSING — no Read snapshot covers it]
// [LINE 439 MISSING — no Read snapshot covers it]
// [LINE 440 MISSING — no Read snapshot covers it]
// [LINE 441 MISSING — no Read snapshot covers it]
// [LINE 442 MISSING — no Read snapshot covers it]
// [LINE 443 MISSING — no Read snapshot covers it]
// [LINE 444 MISSING — no Read snapshot covers it]
// [LINE 445 MISSING — no Read snapshot covers it]
// [LINE 446 MISSING — no Read snapshot covers it]
// [LINE 447 MISSING — no Read snapshot covers it]
// [LINE 448 MISSING — no Read snapshot covers it]
// [LINE 449 MISSING — no Read snapshot covers it]
// [LINE 450 MISSING — no Read snapshot covers it]
// [LINE 451 MISSING — no Read snapshot covers it]
// [LINE 452 MISSING — no Read snapshot covers it]
// [LINE 453 MISSING — no Read snapshot covers it]
// [LINE 454 MISSING — no Read snapshot covers it]
// [LINE 455 MISSING — no Read snapshot covers it]
// [LINE 456 MISSING — no Read snapshot covers it]
// [LINE 457 MISSING — no Read snapshot covers it]
// [LINE 458 MISSING — no Read snapshot covers it]
// [LINE 459 MISSING — no Read snapshot covers it]
// [LINE 460 MISSING — no Read snapshot covers it]
// [LINE 461 MISSING — no Read snapshot covers it]
// [LINE 462 MISSING — no Read snapshot covers it]
// [LINE 463 MISSING — no Read snapshot covers it]
// [LINE 464 MISSING — no Read snapshot covers it]
// [LINE 465 MISSING — no Read snapshot covers it]
// [LINE 466 MISSING — no Read snapshot covers it]
// [LINE 467 MISSING — no Read snapshot covers it]
// [LINE 468 MISSING — no Read snapshot covers it]
// [LINE 469 MISSING — no Read snapshot covers it]
// [LINE 470 MISSING — no Read snapshot covers it]
// [LINE 471 MISSING — no Read snapshot covers it]
// [LINE 472 MISSING — no Read snapshot covers it]
// [LINE 473 MISSING — no Read snapshot covers it]
// [LINE 474 MISSING — no Read snapshot covers it]
// [LINE 475 MISSING — no Read snapshot covers it]
// [LINE 476 MISSING — no Read snapshot covers it]
// [LINE 477 MISSING — no Read snapshot covers it]
// [LINE 478 MISSING — no Read snapshot covers it]
// [LINE 479 MISSING — no Read snapshot covers it]
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
// [LINE 530 MISSING — no Read snapshot covers it]
// [LINE 531 MISSING — no Read snapshot covers it]
// [LINE 532 MISSING — no Read snapshot covers it]
// [LINE 533 MISSING — no Read snapshot covers it]
// [LINE 534 MISSING — no Read snapshot covers it]
// [LINE 535 MISSING — no Read snapshot covers it]
// [LINE 536 MISSING — no Read snapshot covers it]
// [LINE 537 MISSING — no Read snapshot covers it]
// [LINE 538 MISSING — no Read snapshot covers it]
// [LINE 539 MISSING — no Read snapshot covers it]
// [LINE 540 MISSING — no Read snapshot covers it]
// [LINE 541 MISSING — no Read snapshot covers it]
// [LINE 542 MISSING — no Read snapshot covers it]
// [LINE 543 MISSING — no Read snapshot covers it]
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
// [LINE 557 MISSING — no Read snapshot covers it]
// [LINE 558 MISSING — no Read snapshot covers it]
// [LINE 559 MISSING — no Read snapshot covers it]
// [LINE 560 MISSING — no Read snapshot covers it]
// [LINE 561 MISSING — no Read snapshot covers it]
// [LINE 562 MISSING — no Read snapshot covers it]
// [LINE 563 MISSING — no Read snapshot covers it]
// [LINE 564 MISSING — no Read snapshot covers it]
// [LINE 565 MISSING — no Read snapshot covers it]
// [LINE 566 MISSING — no Read snapshot covers it]
// [LINE 567 MISSING — no Read snapshot covers it]
// [LINE 568 MISSING — no Read snapshot covers it]
// [LINE 569 MISSING — no Read snapshot covers it]
// [LINE 570 MISSING — no Read snapshot covers it]
// [LINE 571 MISSING — no Read snapshot covers it]
// [LINE 572 MISSING — no Read snapshot covers it]
// [LINE 573 MISSING — no Read snapshot covers it]
// [LINE 574 MISSING — no Read snapshot covers it]
// [LINE 575 MISSING — no Read snapshot covers it]
// [LINE 576 MISSING — no Read snapshot covers it]
// [LINE 577 MISSING — no Read snapshot covers it]
// [LINE 578 MISSING — no Read snapshot covers it]
// [LINE 579 MISSING — no Read snapshot covers it]
// [LINE 580 MISSING — no Read snapshot covers it]
// [LINE 581 MISSING — no Read snapshot covers it]
// [LINE 582 MISSING — no Read snapshot covers it]
// [LINE 583 MISSING — no Read snapshot covers it]
// [LINE 584 MISSING — no Read snapshot covers it]
// [LINE 585 MISSING — no Read snapshot covers it]
// [LINE 586 MISSING — no Read snapshot covers it]
// [LINE 587 MISSING — no Read snapshot covers it]
// [LINE 588 MISSING — no Read snapshot covers it]
// [LINE 589 MISSING — no Read snapshot covers it]
// [LINE 590 MISSING — no Read snapshot covers it]
// [LINE 591 MISSING — no Read snapshot covers it]
// [LINE 592 MISSING — no Read snapshot covers it]
// [LINE 593 MISSING — no Read snapshot covers it]
// [LINE 594 MISSING — no Read snapshot covers it]
// [LINE 595 MISSING — no Read snapshot covers it]
// [LINE 596 MISSING — no Read snapshot covers it]
// [LINE 597 MISSING — no Read snapshot covers it]
// [LINE 598 MISSING — no Read snapshot covers it]
// [LINE 599 MISSING — no Read snapshot covers it]
// [LINE 600 MISSING — no Read snapshot covers it]
// [LINE 601 MISSING — no Read snapshot covers it]
// [LINE 602 MISSING — no Read snapshot covers it]
// [LINE 603 MISSING — no Read snapshot covers it]
// [LINE 604 MISSING — no Read snapshot covers it]
// [LINE 605 MISSING — no Read snapshot covers it]
// [LINE 606 MISSING — no Read snapshot covers it]
// [LINE 607 MISSING — no Read snapshot covers it]
// [LINE 608 MISSING — no Read snapshot covers it]
// [LINE 609 MISSING — no Read snapshot covers it]
// [LINE 610 MISSING — no Read snapshot covers it]
// [LINE 611 MISSING — no Read snapshot covers it]
// [LINE 612 MISSING — no Read snapshot covers it]
// [LINE 613 MISSING — no Read snapshot covers it]
// [LINE 614 MISSING — no Read snapshot covers it]
// [LINE 615 MISSING — no Read snapshot covers it]
// [LINE 616 MISSING — no Read snapshot covers it]
// [LINE 617 MISSING — no Read snapshot covers it]
// [LINE 618 MISSING — no Read snapshot covers it]
// [LINE 619 MISSING — no Read snapshot covers it]
// [LINE 620 MISSING — no Read snapshot covers it]
// [LINE 621 MISSING — no Read snapshot covers it]
// [LINE 622 MISSING — no Read snapshot covers it]
// [LINE 623 MISSING — no Read snapshot covers it]
// [LINE 624 MISSING — no Read snapshot covers it]
// [LINE 625 MISSING — no Read snapshot covers it]
// [LINE 626 MISSING — no Read snapshot covers it]
// [LINE 627 MISSING — no Read snapshot covers it]
// [LINE 628 MISSING — no Read snapshot covers it]
// [LINE 629 MISSING — no Read snapshot covers it]
// [LINE 630 MISSING — no Read snapshot covers it]
// [LINE 631 MISSING — no Read snapshot covers it]
// [LINE 632 MISSING — no Read snapshot covers it]
// [LINE 633 MISSING — no Read snapshot covers it]
// [LINE 634 MISSING — no Read snapshot covers it]
// [LINE 635 MISSING — no Read snapshot covers it]
// [LINE 636 MISSING — no Read snapshot covers it]
// [LINE 637 MISSING — no Read snapshot covers it]
// [LINE 638 MISSING — no Read snapshot covers it]
// [LINE 639 MISSING — no Read snapshot covers it]
// [LINE 640 MISSING — no Read snapshot covers it]
// [LINE 641 MISSING — no Read snapshot covers it]
// [LINE 642 MISSING — no Read snapshot covers it]
// [LINE 643 MISSING — no Read snapshot covers it]
// [LINE 644 MISSING — no Read snapshot covers it]
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
    if (_frozenBet > 0) return; // bet is frozen — reject changes
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
// FREEZE BET
// ============================================
let _frozenBet = 0;

function toggleFreezeBet() {
    if (_frozenBet > 0) { _unfreezebet(); } else { _freezeBet(); }
}
function _freezeBet() {
    _frozenBet = currentBet;
    _updateFreezeUI();
    if (ws) sendMsg("freezeBet", { freeze: true });
    if (typeof SFX !== 'undefined') SFX.confirm?.();
}
function _unfreezebet() {
    _frozenBet = 0;
    _updateFreezeUI();
    if (ws) sendMsg("freezeBet", { freeze: false });
    if (typeof SFX !== 'undefined') SFX.click?.();
}
function _updateFreezeUI() {
    const btn = document.getElementById('btn-freeze');
    const ind = document.getElementById('freeze-indicator');
    if (_frozenBet > 0) {
        if (btn) { btn.innerHTML = '&#x1F513; Unfreeze ($' + _frozenBet.toLocaleString() + ')'; btn.style.borderColor = '#38bdf8'; btn.style.color = '#38bdf8'; }
        if (ind) { ind.textContent = '\u2744 $' + _frozenBet.toLocaleString(); ind.style.display = 'inline-block'; }
    } else {
        if (btn) { btn.innerHTML = '&#x1F512; Freeze Bet'; btn.style.borderColor = '#334155'; btn.style.color = '#7a9ac0'; }
        if (ind) { ind.style.display = 'none'; }
    }
    // Disable +/- buttons while frozen
    const upBtn   = document.getElementById('btn-bet-up');
    const downBtn = document.getElementById('btn-bet-down');
    if (upBtn)   upBtn.disabled   = _frozenBet > 0;
    if (downBtn) downBtn.disabled = _frozenBet > 0;
}
function _applyFreezeIfActive() {
    if (_frozenBet <= 0) return;
    const me = window._lastState?.players?.[mySessionId];
    if (!me || me.chips < _frozenBet) { _unfreezebet(); return; }
    const cfg = TABLE_CONFIGS[tableMinBet] || TABLE_CONFIGS[100];
    currentBet = Math.max(cfg.minBet, Math.min(cfg.maxBet, _frozenBet, me.chips));
    updateBetDisplay();
    sendMsg("placeBet", { amount: currentBet });
}
function _clearFreezeBet() {
    _frozenBet = 0;
    _updateFreezeUI();
    if (ws) sendMsg("freezeBet", { freeze: false });
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
// [LINE 775 MISSING — no Read snapshot covers it]
// [LINE 776 MISSING — no Read snapshot covers it]
// [LINE 777 MISSING — no Read snapshot covers it]
// [LINE 778 MISSING — no Read snapshot covers it]
// [LINE 779 MISSING — no Read snapshot covers it]
// [LINE 780 MISSING — no Read snapshot covers it]
// [LINE 781 MISSING — no Read snapshot covers it]
// [LINE 782 MISSING — no Read snapshot covers it]
// [LINE 783 MISSING — no Read snapshot covers it]
// [LINE 784 MISSING — no Read snapshot covers it]
// [LINE 785 MISSING — no Read snapshot covers it]
// [LINE 786 MISSING — no Read snapshot covers it]
// [LINE 787 MISSING — no Read snapshot covers it]
// [LINE 788 MISSING — no Read snapshot covers it]
// [LINE 789 MISSING — no Read snapshot covers it]
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
        // Refresh freeze UI state and apply frozen bet if active
        _updateFreezeUI();
        setTimeout(() => _applyFreezeIfActive(), 200);
        // Show deal animation — cards visually distributed to all seats
        setTimeout(() => runDealAnimation(state), 300);
// [LINE 935 MISSING — no Read snapshot covers it]
// [LINE 936 MISSING — no Read snapshot covers it]
// [LINE 937 MISSING — no Read snapshot covers it]
    if (state.status === 'betting' && roundChanged) {
        lastRound = state.round;
    }
    lastStatus = state.status;

    const revealed = (state.status === 'revealing' || state.status === 'roundEnd' || state.status === 'gameOver');
    updateOpponentSeats(state, revealed);
    if (revealed) {
        renderMyRevealHands(me);
    }

    if (state.status === 'gameOver') {
        // Clear freeze bet on game end — must not persist to future games
        _clearFreezeBet();
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
        // Magnetic touch-drag — works across all cards (raw + piles) on every device with touch
        setupMagneticTouchDrag();
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
    }
    if (state.status === 'betting' && roundChanged) {
        lastRound = state.round;
    }
    lastStatus = state.status;

    const revealed = (state.status === 'revealing' || state.status === 'roundEnd' || state.status === 'gameOver');
    updateOpponentSeats(state, revealed);
    if (revealed) {
        renderMyRevealHands(me);
    }

    if (state.status === 'gameOver') {
        // Clear freeze bet on game end — must not persist to future games
        _clearFreezeBet();
        showGameOver(state);
    else {
        const dqPanel = document.getElementById('disqualify-panel');
        if (dqPanel) dqPanel.style.display = 'none';
    }

    if (state.status === 'gameOver') {
        // Clear freeze bet on game end — must not persist to future games
        _clearFreezeBet();
        showGameOver(state);
        // Server settled chips to bank — update local display

function updateOpponentSeats(state, revealed) {
    const players  = state.players || {};
    const zones    = ['p1','p2','p3'];
    let   bankerSid = null;
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

    // Refresh seatMap if empty, stale, or has the banker in it
    // "Stale" = any sid in seatMap no longer exists in current players, or
    // a non-banker player sid is missing from seatMap
    const seatMapSids = Object.keys(seatMap);
    const otherSids   = others.map(([sid]) => sid);
    const hasStale    = seatMapSids.some(sid => !players[sid] || sid === bankerSid);
    const hasMissing  = otherSids.some(sid => !seatMap[sid]);
    if (seatMapSids.length === 0 || hasStale || hasMissing) {
        // Rebuild seatMap preserving existing assignments where possible
        const newMap = {};
        const usedZ  = new Set();
        // Keep existing valid assignments
        otherSids.forEach(sid => {
            if (seatMap[sid] && !usedZ.has(seatMap[sid])) {
                newMap[sid] = seatMap[sid];
                usedZ.add(seatMap[sid]);
            }
        });
        // Assign remaining players to free zones
        let zi = 0;
        otherSids.forEach(sid => {
            if (!newMap[sid]) {
                while (zi < zones.length && usedZ.has(zones[zi])) zi++;
                if (zi < zones.length) { newMap[sid] = zones[zi]; usedZ.add(zones[zi]); zi++; }
            }
        });
        seatMap = newMap;
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
    const canStart = selectedRounds > 0 && selectedMinBet > 0;
    document.getElementById('btn-start-game').disabled = !canStart;
    const info = document.getElementById('lobby-selection-info');
    if (info) info.textContent = canStart ? `$${selectedMinBet} table, ${selectedRounds} rounds selected.` : '';
}

function startGame() {
    if (!selectedRounds || !selectedMinBet) return;
    sendMsg("startGame", { rounds: selectedRounds, tableMinBet: selectedMinBet });
}

// ── VURGLIFE PLATFORM AUTO-LOGIN ──────────────
// [LINE 1132 MISSING — no Read snapshot covers it]
// [LINE 1133 MISSING — no Read snapshot covers it]
// [LINE 1134 MISSING — no Read snapshot covers it]
// [LINE 1135 MISSING — no Read snapshot covers it]
// [LINE 1136 MISSING — no Read snapshot covers it]
// [LINE 1137 MISSING — no Read snapshot covers it]
// [LINE 1138 MISSING — no Read snapshot covers it]
// [LINE 1139 MISSING — no Read snapshot covers it]
// [LINE 1140 MISSING — no Read snapshot covers it]
// [LINE 1141 MISSING — no Read snapshot covers it]
// [LINE 1142 MISSING — no Read snapshot covers it]
// [LINE 1143 MISSING — no Read snapshot covers it]
// [LINE 1144 MISSING — no Read snapshot covers it]
// [LINE 1145 MISSING — no Read snapshot covers it]
// [LINE 1146 MISSING — no Read snapshot covers it]
// [LINE 1147 MISSING — no Read snapshot covers it]
// [LINE 1148 MISSING — no Read snapshot covers it]
// [LINE 1149 MISSING — no Read snapshot covers it]
// [LINE 1150 MISSING — no Read snapshot covers it]
// [LINE 1151 MISSING — no Read snapshot covers it]
// [LINE 1152 MISSING — no Read snapshot covers it]
// [LINE 1153 MISSING — no Read snapshot covers it]
// [LINE 1154 MISSING — no Read snapshot covers it]

async function getLobbyFriends() {
    if (_lobbyFriends) return _lobbyFriends;
    try {
        const token = igmToken;
        if (!token) return [];
        const res = await fetch('/api/game/friends', {
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
        const res = await fetch('/api/game/friends/search?q=' + encodeURIComponent(q), {
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(r => r.json());
        return res.results || [];
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
let _lobbyFriends = null; // cached friends list

async function getLobbyFriends() {
    if (_lobbyFriends) return _lobbyFriends;
    try {
        const token = igmToken;
        if (!token) return [];
        const res = await fetch('/api/game/friends', {
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
        const res = await fetch('/api/game/friends/search?q=' + encodeURIComponent(q), {
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(r => r.json());
        return res.results || [];
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

async function sendLobbyInvite() {
    const input    = document.getElementById('invite-username');
    const statusEl = document.getElementById('invite-status');
    if (!input || !statusEl) return;
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
            statusEl.textContent = `✅ Invite sent to ${username}!`;
            statusEl.style.color = '#22c55e';
            input.value = '';
            setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
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

    // Show the config banner, hide manual TABLE selector (rounds stay visible)
    const preEl    = document.getElementById('lobby-preselected');
    const manualEl = document.getElementById('lobby-manual-select');
    if (preEl)    preEl.style.display    = 'block';
    if (manualEl) manualEl.style.display = 'none';

    // Populate banner values (rounds shows "Select below")
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('lci-table',  '$' + cfg.minBet + ' Table');
    setEl('lci-minbet', '$' + cfg.minBet);
    setEl('lci-rounds', '—');
    setEl('lci-wallet', '$' + Number(cfg.walletSize || cfg.wallet || 0).toLocaleString());

    // Set table but NOT rounds — player must select rounds
    selectedMinBet = cfg.minBet;
    selectedRounds = 0;

    // Ensure round selector is visible
    const roundEl = document.getElementById('lobby-round-select');
    if (roundEl) roundEl.style.display = 'block';

    // Clear any previous round selection and unlock round buttons
    document.querySelectorAll('.btn-rounds').forEach(b => { b.classList.remove('selected'); b.disabled = false; b.style.opacity = ''; });

    // Hide invite section until rounds are picked
    const inviteSec = document.getElementById('invite-section');
    if (inviteSec) inviteSec.style.display = 'none';

    checkCanStart();
    const info = document.getElementById('lobby-selection-info');
    if (info) info.textContent = 'Select number of rounds to start.';
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

        if (state.status === 'waiting') {
            showScreen('screen-lobby');
            updateLobbyUI(state);
        } else {
            if (!document.getElementById('screen-game').classList.contains('active') && state.status !== 'gameOver') {
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
        const detail = msg.actual
            ? `❌ DISQUALIFIED — you declared ${msg.declared}, but your hand actually contains ${msg.actual} (${msg.actualMultiplier}x). The highest special always wins.`
            : `❌ DISQUALIFIED — you declared ${msg.declared || 'a special'}, but your hand contains no special.`;
        if (msgEl) msgEl.textContent = detail;
        // Also pop a modal so the reason is unmissable
        showSpecialDeniedModal(msg.declared, msg.actual, msg.actualMultiplier);
        // Re-show cards area with face-down cards so table can see
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
    } else if (msg.type === 'bankerChanged') {
        showIngameToast('🏦 Banker Changed', `${msg.username} is now the Banker.`);
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
// [LINE 1667 MISSING — no Read snapshot covers it]
// [LINE 1668 MISSING — no Read snapshot covers it]
// [LINE 1669 MISSING — no Read snapshot covers it]
// [LINE 1670 MISSING — no Read snapshot covers it]
// [LINE 1671 MISSING — no Read snapshot covers it]
// [LINE 1672 MISSING — no Read snapshot covers it]
// [LINE 1673 MISSING — no Read snapshot covers it]
// [LINE 1674 MISSING — no Read snapshot covers it]
// [LINE 1675 MISSING — no Read snapshot covers it]
// [LINE 1676 MISSING — no Read snapshot covers it]
// [LINE 1677 MISSING — no Read snapshot covers it]
// [LINE 1678 MISSING — no Read snapshot covers it]
// [LINE 1679 MISSING — no Read snapshot covers it]
// [LINE 1680 MISSING — no Read snapshot covers it]
// [LINE 1681 MISSING — no Read snapshot covers it]
// [LINE 1682 MISSING — no Read snapshot covers it]
// [LINE 1683 MISSING — no Read snapshot covers it]
// [LINE 1684 MISSING — no Read snapshot covers it]
// [LINE 1685 MISSING — no Read snapshot covers it]
// [LINE 1686 MISSING — no Read snapshot covers it]
// [LINE 1687 MISSING — no Read snapshot covers it]
// [LINE 1688 MISSING — no Read snapshot covers it]
// [LINE 1689 MISSING — no Read snapshot covers it]
// [LINE 1690 MISSING — no Read snapshot covers it]
// [LINE 1691 MISSING — no Read snapshot covers it]
// [LINE 1692 MISSING — no Read snapshot covers it]
// [LINE 1693 MISSING — no Read snapshot covers it]
// [LINE 1694 MISSING — no Read snapshot covers it]
// [LINE 1695 MISSING — no Read snapshot covers it]
// [LINE 1696 MISSING — no Read snapshot covers it]
// [LINE 1697 MISSING — no Read snapshot covers it]
// [LINE 1698 MISSING — no Read snapshot covers it]
// [LINE 1699 MISSING — no Read snapshot covers it]
// [LINE 1700 MISSING — no Read snapshot covers it]
// [LINE 1701 MISSING — no Read snapshot covers it]
// [LINE 1702 MISSING — no Read snapshot covers it]
// [LINE 1703 MISSING — no Read snapshot covers it]
// [LINE 1704 MISSING — no Read snapshot covers it]
// [LINE 1705 MISSING — no Read snapshot covers it]
// [LINE 1706 MISSING — no Read snapshot covers it]
// [LINE 1707 MISSING — no Read snapshot covers it]
// [LINE 1708 MISSING — no Read snapshot covers it]
// [LINE 1709 MISSING — no Read snapshot covers it]
// [LINE 1710 MISSING — no Read snapshot covers it]
// [LINE 1711 MISSING — no Read snapshot covers it]
// [LINE 1712 MISSING — no Read snapshot covers it]
// [LINE 1713 MISSING — no Read snapshot covers it]
// [LINE 1714 MISSING — no Read snapshot covers it]
// [LINE 1715 MISSING — no Read snapshot covers it]
// [LINE 1716 MISSING — no Read snapshot covers it]
// [LINE 1717 MISSING — no Read snapshot covers it]
// [LINE 1718 MISSING — no Read snapshot covers it]
// [LINE 1719 MISSING — no Read snapshot covers it]
// [LINE 1720 MISSING — no Read snapshot covers it]
// [LINE 1721 MISSING — no Read snapshot covers it]
// [LINE 1722 MISSING — no Read snapshot covers it]
// [LINE 1723 MISSING — no Read snapshot covers it]
// [LINE 1724 MISSING — no Read snapshot covers it]
// [LINE 1725 MISSING — no Read snapshot covers it]
// [LINE 1726 MISSING — no Read snapshot covers it]
// [LINE 1727 MISSING — no Read snapshot covers it]
// [LINE 1728 MISSING — no Read snapshot covers it]
// [LINE 1729 MISSING — no Read snapshot covers it]
// [LINE 1730 MISSING — no Read snapshot covers it]
// [LINE 1731 MISSING — no Read snapshot covers it]
// [LINE 1732 MISSING — no Read snapshot covers it]
// [LINE 1733 MISSING — no Read snapshot covers it]
// [LINE 1734 MISSING — no Read snapshot covers it]
// [LINE 1735 MISSING — no Read snapshot covers it]
// [LINE 1736 MISSING — no Read snapshot covers it]
// [LINE 1737 MISSING — no Read snapshot covers it]
// [LINE 1738 MISSING — no Read snapshot covers it]
// [LINE 1739 MISSING — no Read snapshot covers it]
// [LINE 1740 MISSING — no Read snapshot covers it]
// [LINE 1741 MISSING — no Read snapshot covers it]
// [LINE 1742 MISSING — no Read snapshot covers it]
// [LINE 1743 MISSING — no Read snapshot covers it]
// [LINE 1744 MISSING — no Read snapshot covers it]
// [LINE 1745 MISSING — no Read snapshot covers it]
// [LINE 1746 MISSING — no Read snapshot covers it]
// [LINE 1747 MISSING — no Read snapshot covers it]
// [LINE 1748 MISSING — no Read snapshot covers it]
// [LINE 1749 MISSING — no Read snapshot covers it]
// [LINE 1750 MISSING — no Read snapshot covers it]
// [LINE 1751 MISSING — no Read snapshot covers it]
// [LINE 1752 MISSING — no Read snapshot covers it]
// [LINE 1753 MISSING — no Read snapshot covers it]
// [LINE 1754 MISSING — no Read snapshot covers it]
// [LINE 1755 MISSING — no Read snapshot covers it]
// [LINE 1756 MISSING — no Read snapshot covers it]
// [LINE 1757 MISSING — no Read snapshot covers it]
// [LINE 1758 MISSING — no Read snapshot covers it]
// [LINE 1759 MISSING — no Read snapshot covers it]
// [LINE 1760 MISSING — no Read snapshot covers it]
// [LINE 1761 MISSING — no Read snapshot covers it]
// [LINE 1762 MISSING — no Read snapshot covers it]
// [LINE 1763 MISSING — no Read snapshot covers it]
// [LINE 1764 MISSING — no Read snapshot covers it]
// [LINE 1765 MISSING — no Read snapshot covers it]
// [LINE 1766 MISSING — no Read snapshot covers it]
// [LINE 1767 MISSING — no Read snapshot covers it]
// [LINE 1768 MISSING — no Read snapshot covers it]
// [LINE 1769 MISSING — no Read snapshot covers it]
// [LINE 1770 MISSING — no Read snapshot covers it]
// [LINE 1771 MISSING — no Read snapshot covers it]
// [LINE 1772 MISSING — no Read snapshot covers it]
// [LINE 1773 MISSING — no Read snapshot covers it]
// [LINE 1774 MISSING — no Read snapshot covers it]
// [LINE 1775 MISSING — no Read snapshot covers it]
// [LINE 1776 MISSING — no Read snapshot covers it]
// [LINE 1777 MISSING — no Read snapshot covers it]
// [LINE 1778 MISSING — no Read snapshot covers it]
// [LINE 1779 MISSING — no Read snapshot covers it]
// [LINE 1780 MISSING — no Read snapshot covers it]
// [LINE 1781 MISSING — no Read snapshot covers it]
// [LINE 1782 MISSING — no Read snapshot covers it]
// [LINE 1783 MISSING — no Read snapshot covers it]
// [LINE 1784 MISSING — no Read snapshot covers it]
// [LINE 1785 MISSING — no Read snapshot covers it]
// [LINE 1786 MISSING — no Read snapshot covers it]



// ============================================
// DEAL ANIMATION
// [LINE 1832 MISSING — no Read snapshot covers it]
// [LINE 1833 MISSING — no Read snapshot covers it]
// [LINE 1834 MISSING — no Read snapshot covers it]
// [LINE 1835 MISSING — no Read snapshot covers it]
// [LINE 1836 MISSING — no Read snapshot covers it]
// [LINE 1837 MISSING — no Read snapshot covers it]
// [LINE 1838 MISSING — no Read snapshot covers it]
// [LINE 1839 MISSING — no Read snapshot covers it]
// [LINE 1840 MISSING — no Read snapshot covers it]
// [LINE 1841 MISSING — no Read snapshot covers it]
// [LINE 1842 MISSING — no Read snapshot covers it]
// [LINE 1843 MISSING — no Read snapshot covers it]
// [LINE 1844 MISSING — no Read snapshot covers it]
// [LINE 1845 MISSING — no Read snapshot covers it]
// [LINE 1846 MISSING — no Read snapshot covers it]
// [LINE 1847 MISSING — no Read snapshot covers it]
// [LINE 1848 MISSING — no Read snapshot covers it]
// [LINE 1849 MISSING — no Read snapshot covers it]
// [LINE 1850 MISSING — no Read snapshot covers it]
// [LINE 1851 MISSING — no Read snapshot covers it]
// [LINE 1852 MISSING — no Read snapshot covers it]
// [LINE 1853 MISSING — no Read snapshot covers it]
// [LINE 1854 MISSING — no Read snapshot covers it]
// [LINE 1855 MISSING — no Read snapshot covers it]
// [LINE 1856 MISSING — no Read snapshot covers it]
// [LINE 1857 MISSING — no Read snapshot covers it]
// [LINE 1858 MISSING — no Read snapshot covers it]
// [LINE 1859 MISSING — no Read snapshot covers it]
// [LINE 1860 MISSING — no Read snapshot covers it]
// [LINE 1861 MISSING — no Read snapshot covers it]
// [LINE 1862 MISSING — no Read snapshot covers it]
// [LINE 1863 MISSING — no Read snapshot covers it]
// [LINE 1864 MISSING — no Read snapshot covers it]
// [LINE 1865 MISSING — no Read snapshot covers it]
// [LINE 1866 MISSING — no Read snapshot covers it]
// [LINE 1867 MISSING — no Read snapshot covers it]
// [LINE 1868 MISSING — no Read snapshot covers it]
// [LINE 1869 MISSING — no Read snapshot covers it]
// [LINE 1870 MISSING — no Read snapshot covers it]
// [LINE 1871 MISSING — no Read snapshot covers it]
// [LINE 1872 MISSING — no Read snapshot covers it]
// [LINE 1873 MISSING — no Read snapshot covers it]
// [LINE 1874 MISSING — no Read snapshot covers it]
// [LINE 1875 MISSING — no Read snapshot covers it]
// [LINE 1876 MISSING — no Read snapshot covers it]
// [LINE 1877 MISSING — no Read snapshot covers it]
// [LINE 1878 MISSING — no Read snapshot covers it]
// [LINE 1879 MISSING — no Read snapshot covers it]
// [LINE 1880 MISSING — no Read snapshot covers it]
// [LINE 1881 MISSING — no Read snapshot covers it]
// [LINE 1882 MISSING — no Read snapshot covers it]
// [LINE 1883 MISSING — no Read snapshot covers it]
// [LINE 1884 MISSING — no Read snapshot covers it]
// [LINE 1885 MISSING — no Read snapshot covers it]
// [LINE 1886 MISSING — no Read snapshot covers it]
// [LINE 1887 MISSING — no Read snapshot covers it]
// [LINE 1888 MISSING — no Read snapshot covers it]
// [LINE 1889 MISSING — no Read snapshot covers it]
// [LINE 1890 MISSING — no Read snapshot covers it]
// [LINE 1891 MISSING — no Read snapshot covers it]
// [LINE 1892 MISSING — no Read snapshot covers it]
// [LINE 1893 MISSING — no Read snapshot covers it]
// [LINE 1894 MISSING — no Read snapshot covers it]
// [LINE 1895 MISSING — no Read snapshot covers it]
// [LINE 1896 MISSING — no Read snapshot covers it]
// [LINE 1897 MISSING — no Read snapshot covers it]
// [LINE 1898 MISSING — no Read snapshot covers it]
// [LINE 1899 MISSING — no Read snapshot covers it]
// [LINE 1900 MISSING — no Read snapshot covers it]
// [LINE 1901 MISSING — no Read snapshot covers it]
// [LINE 1902 MISSING — no Read snapshot covers it]
// [LINE 1903 MISSING — no Read snapshot covers it]
// [LINE 1904 MISSING — no Read snapshot covers it]
// [LINE 1905 MISSING — no Read snapshot covers it]
// [LINE 1906 MISSING — no Read snapshot covers it]
// [LINE 1907 MISSING — no Read snapshot covers it]
// [LINE 1908 MISSING — no Read snapshot covers it]
// [LINE 1909 MISSING — no Read snapshot covers it]
// [LINE 1910 MISSING — no Read snapshot covers it]
// [LINE 1911 MISSING — no Read snapshot covers it]
// [LINE 1912 MISSING — no Read snapshot covers it]
// [LINE 1913 MISSING — no Read snapshot covers it]
// [LINE 1914 MISSING — no Read snapshot covers it]
// [LINE 1915 MISSING — no Read snapshot covers it]
// [LINE 1916 MISSING — no Read snapshot covers it]
// [LINE 1917 MISSING — no Read snapshot covers it]
// [LINE 1918 MISSING — no Read snapshot covers it]
// [LINE 1919 MISSING — no Read snapshot covers it]
// [LINE 1920 MISSING — no Read snapshot covers it]
// [LINE 1921 MISSING — no Read snapshot covers it]
// [LINE 1922 MISSING — no Read snapshot covers it]
// [LINE 1923 MISSING — no Read snapshot covers it]
// [LINE 1924 MISSING — no Read snapshot covers it]
// [LINE 1925 MISSING — no Read snapshot covers it]
// [LINE 1926 MISSING — no Read snapshot covers it]
// [LINE 1927 MISSING — no Read snapshot covers it]
// [LINE 1928 MISSING — no Read snapshot covers it]
// [LINE 1929 MISSING — no Read snapshot covers it]
// [LINE 1930 MISSING — no Read snapshot covers it]
// [LINE 1931 MISSING — no Read snapshot covers it]
// [LINE 1932 MISSING — no Read snapshot covers it]
// [LINE 1933 MISSING — no Read snapshot covers it]
// [LINE 1934 MISSING — no Read snapshot covers it]
// [LINE 1935 MISSING — no Read snapshot covers it]
// [LINE 1936 MISSING — no Read snapshot covers it]
// [LINE 1937 MISSING — no Read snapshot covers it]
// [LINE 1938 MISSING — no Read snapshot covers it]
// [LINE 1939 MISSING — no Read snapshot covers it]
// [LINE 1940 MISSING — no Read snapshot covers it]
// [LINE 1941 MISSING — no Read snapshot covers it]
// [LINE 1942 MISSING — no Read snapshot covers it]
// [LINE 1943 MISSING — no Read snapshot covers it]
// [LINE 1944 MISSING — no Read snapshot covers it]
// [LINE 1945 MISSING — no Read snapshot covers it]
// [LINE 1946 MISSING — no Read snapshot covers it]
// [LINE 1947 MISSING — no Read snapshot covers it]
// [LINE 1948 MISSING — no Read snapshot covers it]
// [LINE 1949 MISSING — no Read snapshot covers it]
// [LINE 1950 MISSING — no Read snapshot covers it]
// [LINE 1951 MISSING — no Read snapshot covers it]
// [LINE 1952 MISSING — no Read snapshot covers it]
// [LINE 1953 MISSING — no Read snapshot covers it]
// [LINE 1954 MISSING — no Read snapshot covers it]
// [LINE 1955 MISSING — no Read snapshot covers it]
// [LINE 1956 MISSING — no Read snapshot covers it]
// [LINE 1957 MISSING — no Read snapshot covers it]
// [LINE 1958 MISSING — no Read snapshot covers it]
// [LINE 1959 MISSING — no Read snapshot covers it]
// [LINE 1960 MISSING — no Read snapshot covers it]
// [LINE 1961 MISSING — no Read snapshot covers it]
// [LINE 1962 MISSING — no Read snapshot covers it]
// [LINE 1963 MISSING — no Read snapshot covers it]
// [LINE 1964 MISSING — no Read snapshot covers it]
// [LINE 1965 MISSING — no Read snapshot covers it]
// [LINE 1966 MISSING — no Read snapshot covers it]
// [LINE 1967 MISSING — no Read snapshot covers it]
// [LINE 1968 MISSING — no Read snapshot covers it]
// [LINE 1969 MISSING — no Read snapshot covers it]
// [LINE 1970 MISSING — no Read snapshot covers it]
// [LINE 1971 MISSING — no Read snapshot covers it]
// [LINE 1972 MISSING — no Read snapshot covers it]
// [LINE 1973 MISSING — no Read snapshot covers it]
// [LINE 1974 MISSING — no Read snapshot covers it]
// [LINE 1975 MISSING — no Read snapshot covers it]
// [LINE 1976 MISSING — no Read snapshot covers it]
// [LINE 1977 MISSING — no Read snapshot covers it]
// [LINE 1978 MISSING — no Read snapshot covers it]
// [LINE 1979 MISSING — no Read snapshot covers it]
// [LINE 1980 MISSING — no Read snapshot covers it]
// [LINE 1981 MISSING — no Read snapshot covers it]
// [LINE 1982 MISSING — no Read snapshot covers it]
// [LINE 1983 MISSING — no Read snapshot covers it]
// [LINE 1984 MISSING — no Read snapshot covers it]
// [LINE 1985 MISSING — no Read snapshot covers it]
// [LINE 1986 MISSING — no Read snapshot covers it]
// [LINE 1987 MISSING — no Read snapshot covers it]
// [LINE 1988 MISSING — no Read snapshot covers it]
// [LINE 1989 MISSING — no Read snapshot covers it]
// [LINE 1990 MISSING — no Read snapshot covers it]
// [LINE 1991 MISSING — no Read snapshot covers it]
// [LINE 1992 MISSING — no Read snapshot covers it]
// [LINE 1993 MISSING — no Read snapshot covers it]
// [LINE 1994 MISSING — no Read snapshot covers it]
// [LINE 1995 MISSING — no Read snapshot covers it]
// [LINE 1996 MISSING — no Read snapshot covers it]
// [LINE 1997 MISSING — no Read snapshot covers it]
// [LINE 1998 MISSING — no Read snapshot covers it]
// [LINE 1999 MISSING — no Read snapshot covers it]
// [LINE 2000 MISSING — no Read snapshot covers it]
// [LINE 2001 MISSING — no Read snapshot covers it]
// [LINE 2002 MISSING — no Read snapshot covers it]
// [LINE 2003 MISSING — no Read snapshot covers it]
function selectTable(minBet, btn) {
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
    cancel.textContent = 'Cancel';
    cancel.onclick = () => backdrop.remove();
    modal.appendChild(cancel);

    backdrop.appendChild(modal);
    // Close on backdrop click
    backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
}

// Modal shown when the server rejects the player's special declaration.
// Explains WHY — i.e. either no special present, or a higher special exists.
function showSpecialDeniedModal(declared, actual, actualMultiplier) {
    // Remove existing
    const existing = document.getElementById('special-denied-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'special-modal-backdrop';
    backdrop.id = 'special-denied-backdrop';

    const modal = document.createElement('div');
    modal.className = 'special-modal';
    const body = actual
        ? `<p style="margin:8px 0 4px"><strong>You declared:</strong> ${declared}</p>
           <p style="margin:4px 0"><strong>Your hand actually contains:</strong> ${actual} (${actualMultiplier}x)</p>
           <p style="margin:8px 0 0;color:#c9a84c;font-size:13px">Rule: the <em>highest</em> special in the hand must always be declared. Declaring a lower special = disqualification.</p>`
        : `<p style="margin:8px 0 4px"><strong>You declared:</strong> ${declared || 'a special'}</p>
           <p style="margin:4px 0"><strong>Your hand contains no special.</strong></p>`;
    modal.innerHTML = `
        <h3 style="color:#ff6b6b">❌ Wrong Special — Disqualified</h3>
        ${body}
        <p style="margin:10px 0 4px;color:#ff9090;font-size:12px">Penalty: 2× your bet paid to the banker.</p>
    `;
    const ok = document.createElement('button');
    ok.className = 'btn-cancel-special';
    ok.textContent = 'OK';
    ok.onclick = () => backdrop.remove();
    modal.appendChild(ok);

    backdrop.appendChild(modal);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
}

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
    // Update the config banner if visible
    const lciRounds = document.getElementById('lci-rounds');
    if (lciRounds) {
        lciRounds.textContent = rounds === 5 ? '⚡ BLITZ (5)' : rounds + ' rounds';
        lciRounds.style.color = rounds === 5 ? '#ff9a3c' : '';
    }
    // Show invite section + lock rounds (Rhum32-style lobby flow)
    const inviteSec = document.getElementById('invite-section');
    if (inviteSec) inviteSec.style.display = 'block';
    // Lock round buttons after selection
    document.querySelectorAll('.btn-rounds').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
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
    sendMsg("startGame", { rounds: selectedRounds, tableMinBet: selectedMinBet, blitz: selectedRounds === 5 });
}

// When an invited friend joins via roomId, hide all host controls
// They should only see the player list and a waiting message
function setupInvitedJoinerLobby() {
    _isInvitedJoiner = true;
    // Hide round selection
    const roundEl = document.getElementById('lobby-round-select');
    if (roundEl) roundEl.style.display = 'none';
    // Hide invite section (only host can invite)
    const inviteSec = document.getElementById('invite-section');
    if (inviteSec) inviteSec.style.display = 'none';
    // Hide start game button
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) startBtn.style.display = 'none';
    // Update status text
    const statusEl = document.getElementById('lobby-status');
    if (statusEl) statusEl.textContent = 'Waiting for host to start the game…';
    const info = document.getElementById('lobby-selection-info');
    if (info) info.textContent = 'You joined via invite. The host controls the game.';
}

// When an invited friend joins via roomId, hide all host controls
// They should only see the player list and a waiting message
function setupInvitedJoinerLobby() {
    _isInvitedJoiner = true;
    // Hide round selection
    const roundEl = document.getElementById('lobby-round-select');
    if (roundEl) roundEl.style.display = 'none';
    // Hide invite section (only host can invite)
    const inviteSec = document.getElementById('invite-section');
    if (inviteSec) inviteSec.style.display = 'none';
    // Hide start game button
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) startBtn.style.display = 'none';
    // Update status text
    const statusEl = document.getElementById('lobby-status');
    if (statusEl) statusEl.textContent = 'Waiting for host to start the game…';
    const info = document.getElementById('lobby-selection-info');
    if (info) info.textContent = 'You joined via invite. The host controls the game.';
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
        connect(user.username, user.token, table.roomId || null).then(() => {
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
                // If joining via invite (roomId set), hide host controls
                if (table.roomId) {
                    setupInvitedJoinerLobby();
                }
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
