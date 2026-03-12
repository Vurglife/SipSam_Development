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
let myUsername     = "";
let isBanker       = false;
let draggedCard    = null;
let dropZonesReady = false;
let lastStatus     = "";
let lastRound      = 0;
let currentBet     = 10;
let tableMinBet    = 10;
let selectedRounds = 0;
let selectedMinBet = 0;

let piles = { hand1:[], hand2:[], hand3:[] };
// Stable seat map: sid → zone ('p1'|'p2'|'p3')
// Built once when a round starts; never reshuffled mid-game
let seatMap = {}; // sid → zoneId

// ============================================
// SERVER CONNECTION
// ============================================
async function joinRoom(username) {
    const res = await fetch(`${SERVER_HTTP}/matchmake/joinOrCreate/sipsam_room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username })
    });
    if (!res.ok) throw new Error("Matchmake failed: " + res.status);
    const reservation = await res.json();
    console.log("Reservation:", reservation);
    const { sessionId, roomId } = reservation;
    const wsUrl = `${SERVER_WS}/${roomId}?sessionId=${sessionId}`;
    console.log("Connecting to:", wsUrl);
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
            console.log("WebSocket connected!");
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
            console.error("WS error:", e);
            reject(new Error("WebSocket error"));
        };

        socket.onclose = (e) => {
            console.log("WS closed — code:", e.code);
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
    el.innerHTML = '<span class="mc-val" style="font-size:inherit;font-weight:800;line-height:1">' + getDisplayValue(cardCode) + '</span><span class="mc-suit" style="font-size:1.15em;line-height:1">' + getSuitSymbol(cardCode) + '</span>';
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
    if (isStraight(h1)&&isStraight(h2)&&isStraight(h3)) return {name:'Straight-Straight-Straight',multiplier:5};
    // Four of a Kind (checked before Straight Flush)
    if (eq > 0) return {name:'Four of a Kind',multiplier:3};
    // Straight Flush in h2 or h3
    const checkSF = h => {
        const vals = [...new Set(h.map(c=>valMap[c[0]]||0))].sort((a,b)=>a-b);
        if (vals.length!==h.length) return false;
        const isSt = vals[vals.length-1]-vals[0]===vals.length-1 || vals.join(',')==='2,3,4,5,14';
        return isSt && h.every(c=>c[1]===h[0][1]);
    };
    if (checkSF(h2)||checkSF(h3)) return {name:'Straight Flush',multiplier:3};
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
                // Normal player badge: WIN / LOSE / TIE + their hand name
                slot.classList.add(r===1?'won':r===-1?'lost':'tied');
                const badge = document.createElement('div');
                badge.className = 'hand-result ' + (r===1?'hr-win': r===-1?'hr-lose':'hr-tie');
                const handName = handNameFor(num);
                badge.innerHTML = (r===1?'WIN':r===-1?'LOSE':'TIE')
                    + (handName ? '<br><span style="font-size:0.75em;font-weight:600;opacity:0.85">'+handName+'</span>' : '');
                if (block) block.appendChild(badge);
                // Also show banker's hand name as a secondary info badge on this player's block
                const bName = bankerHandNameFor(num);
                if (bName) {
                    const bBadge = document.createElement('div');
                    bBadge.className = 'hand-result hr-info';
                    bBadge.innerHTML = '🏦<br><span style="font-size:0.75em;font-weight:600;opacity:0.85">'+bName+'</span>';
                    if (block) block.appendChild(bBadge);
                }
            } else if (isBankerZone && bankerOwnNames) {
                // Banker zone: show their own hand name as an info badge (no win/lose)
                const bName = bankerOwnNames[num==='1'?0:num==='2'?1:2];
                if (bName) {
                    const badge = document.createElement('div');
                    badge.className = 'hand-result hr-info';
                    badge.innerHTML = bName;
                    if (block) block.appendChild(badge);
                }
            }
        } else if (arranged || (hasCards && player.isBot)) {
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
        }
    });
}

// ============================================
// BET CONTROLS
// ============================================
function initBetControls(minBet, myChips) {
    tableMinBet = minBet;
    currentBet  = minBet;
    updateBetDisplay();
    // Show the max bet in the UI
    const state = window._lastState;
    const maxBet = state?.tableMaxBet || minBet * 3;
    const maxEl = document.getElementById('max-bet-label');
    if (maxEl) maxEl.textContent = 'Max: $' + maxBet;
}

function updateBetDisplay() {
    document.getElementById('bet-display').textContent = `$${currentBet}`;
}

function adjustBet(delta) {
    const state = window._lastState;
    const me    = state?.players?.[mySessionId];
    if (!me) return;
    const tableMaxBet = state.tableMaxBet || (tableMinBet * 3);
    const newBet  = currentBet + delta;
    // Clamp between tableMinBet and tableMaxBet
    currentBet = Math.max(tableMinBet, Math.min(newBet, tableMaxBet));
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
    if (cdEl) { cdEl.textContent = t; cdEl.classList.toggle('urgent', t <= 10); }

    // Sync bet countdown in bet controls
    if (state.status === 'betting') {
        const bc = document.getElementById('bet-countdown');
        if (bc) bc.textContent = state.timer || 0;
    }

    const me = state.players?.[mySessionId];
    if (me) {
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
        document.getElementById('my-chips').textContent = `Chips: ${me.chips}`;

        // bet display now shown in side-extras via updateOpponentSeats

        const payoutEl = document.getElementById('my-payout');
        if (me.lastPayout > 0)      { payoutEl.textContent=`+${me.lastPayout}`; payoutEl.className='payout-win'; }
        else if (me.lastPayout < 0) { payoutEl.textContent=`${me.lastPayout}`;  payoutEl.className='payout-loss'; }
        else                        { payoutEl.textContent=''; }
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
        initBetControls(state.tableMinBet || 10, me?.chips || 1000);
        document.getElementById('btn-bet-up').disabled   = false;
        document.getElementById('btn-bet-down').disabled = false;
        document.getElementById('bet-msg').textContent   = '';
        // Build stable seat map if not yet built or if round 1
        if (state.round === 1 || Object.keys(seatMap).length === 0) {
            seatMap = {};
            const zones = ['p1','p2','p3'];
            let zi = 0;
            const bankerSid = Object.entries(state.players||{}).find(([,p])=>p.isBanker)?.[0];
            Object.keys(state.players||{}).forEach(sid => {
                if (sid === bankerSid) return; // banker always goes to banker zone
                if (zi < zones.length) seatMap[sid] = zones[zi++];
            });
        }
        // Show deal animation — cards visually distributed to all seats
        setTimeout(() => runDealAnimation(state), 300);
    }
    const roundChanged = state.round !== lastRound;
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
        else console.warn('No rawCards in state for me:', me);
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

    if (state.status === 'gameOver') showGameOver(state);
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
        const label = '🏦 BANKER: ' + (bp.username||'Banker') + (bp.isBot?' 🤖':'') + (isMe?' (You)':'');

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
        const label     = player.username + (player.isBot?' 🤖':'') + (isMe?' (You)':'');
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
    const m = { waiting:'Waiting...', betting:'Place Bets (10s)', arranging:'Arrange Cards (90s)', revealing:'Revealing Hands (30s)', roundEnd:'Round Complete', gameOver:'Game Over' };
    return m[s] || s;
}

function showGameOver(state) {
    const scoresEl = document.getElementById('final-scores');
    scoresEl.innerHTML = '';
    Object.values(state.players||{})
        .sort((a,b) => b.chips - a.chips)
        .forEach((p, i) => {
            const row = document.createElement('div');
            row.classList.add('score-row');
            if (i===0) row.classList.add('score-winner');
            const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
            row.innerHTML = `<span>${medal} ${p.username}</span><span>${p.chips} chips (${p.wins} wins)</span>`;
            scoresEl.appendChild(row);
        });
    showScreen('screen-gameover');
}

function updateLobbyUI(state) {
    const listEl = document.getElementById('player-list');
    listEl.innerHTML = '';
    Object.values(state.players||{}).forEach(player => {
        const item = document.createElement('div');
        item.classList.add('player-list-item');
        item.textContent = player.username + (player.isBot ? ' 🤖' : '');
        listEl.appendChild(item);
    });
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
async function connect(username) {
    document.getElementById('login-status').textContent = 'Connecting...';
    try {
        ws = await joinRoom(username);
        myUsername = username;
        document.getElementById('my-name').textContent = username;
        document.getElementById('login-status').textContent = '';
        showScreen('screen-lobby');

        // onmessage and onclose are already set inside joinRoom
        // so we don't need to re-set them here
    } catch(err) {
        console.error("Connect error:", err);
        document.getElementById('login-status').textContent = 'Connection failed: ' + err.message;
    }
}

function handleServerMessage(msg) {
    if (msg.type === 'stateUpdate') {
        const state = msg.state;
        const me    = state.players?.[mySessionId];
        if (me) isBanker = me.isBanker;

        if (state.status === 'waiting') {
            showScreen('screen-lobby');
            updateLobbyUI(state);
        } else {
            if (!document.getElementById('screen-game').classList.contains('active') && state.status !== 'gameOver') {
                showScreen('screen-game');
            }
            updateGameUI(state);
        }
    } else if (msg.type === 'error') {
        document.getElementById('arrange-msg').textContent = '⚠️ ' + msg.message;
    } else if (msg.type === 'specialConfirmed') {
        const msgEl = document.getElementById('special-msg');
        if (msgEl) msgEl.textContent = `✅ ${msg.specialName} (${msg.multiplier}x) — CONFIRMED! Waiting for reveal...`;
    } else if (msg.type === 'specialDenied') {
        const msgEl = document.getElementById('special-msg');
        if (msgEl) msgEl.textContent = `❌ Wrong special declared — you are DISQUALIFIED.`;
        // Re-show cards area with face-down cards so table can see
        document.getElementById('btn-arrange').disabled = true;
        document.getElementById('btn-declare-special').disabled = true;
    } else if (msg.type === 'specialAlert') {
        // Show a banner on the table for everyone
        showSpecialAlertBanner(msg.username, msg.specialName, msg.multiplier);
    } else if (msg.type === 'walletDebt') {
        const tmEl = document.getElementById('table-message');
        if (tmEl) tmEl.textContent = `💸 ${msg.reason}`;
        // If it's me, show a prominent alert
        if (msg.username === myUsername) {
            alert(`WALLET PAYMENT REQUIRED\n\nYou owe $${msg.debt} from your wallet outside the game.\nYou have been removed from this game.`);
        }
    } else if (msg.type === 'playerDisqualified') {
        const tmEl = document.getElementById('table-message');
        if (tmEl) { tmEl.textContent = `⚠️ ${msg.username} DISQUALIFIED — ${msg.reason}`; }
        const dqMsg = document.getElementById('dq-msg');
        if (dqMsg) dqMsg.textContent = `✅ ${msg.username} disqualified: ${msg.reason}`;
    } else if (msg.type === 'disqualifyDenied') {
        const dqMsg = document.getElementById('dq-msg');
        if (dqMsg) dqMsg.textContent = `❌ ${msg.message}`;
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
document.getElementById('btn-bet-up')  .addEventListener('click', () => adjustBet(10));
document.getElementById('btn-bet-down').addEventListener('click', () => adjustBet(-10));



// Arrange submit
document.getElementById('btn-arrange').addEventListener('click', () => {
    syncPiles();
    const msg = document.getElementById('arrange-msg');
    if (piles.hand1.length !== 3) { msg.textContent = '⚠️ 1st hand needs exactly 3 cards.'; return; }
    if (piles.hand2.length !== 5) { msg.textContent = '⚠️ 2nd hand needs exactly 5 cards.'; return; }
    if (piles.hand3.length !== 5) { msg.textContent = '⚠️ 3rd hand needs exactly 5 cards.'; return; }
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
    sendMsg("startGame", { rounds: selectedRounds, tableMinBet: selectedMinBet });
}

// ── VURGLIFE PLATFORM AUTO-LOGIN ──────────────
// Runs on DOMContentLoaded — skips login screen if coming from dashboard
window.addEventListener('DOMContentLoaded', function() {
    try {
        const userJson  = sessionStorage.getItem('sipsam_user');
        const tableJson = sessionStorage.getItem('sipsam_table');

        // No session data — show normal login screen as usual
        if (!userJson) return;

        const user  = JSON.parse(userJson);
        const table = tableJson ? JSON.parse(tableJson) : null;
        if (!user || !user.username) return;

        // Clear session storage immediately
        sessionStorage.removeItem('sipsam_user');

        // Show a loading screen while connecting — don't leave black screen
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const loginScreen = document.getElementById('screen-login');
        if (loginScreen) {
            loginScreen.classList.add('active');
            // Show connecting message instead of login form
            const form = loginScreen.querySelector('.login-card, .login-box, form, #login-form');
            if (form) form.style.display = 'none';
            const status = loginScreen.querySelector('#login-status, .status-msg');
            if (status) {
                status.style.display = 'block';
                status.textContent   = 'Connecting as ' + user.username + '...';
            } else {
                loginScreen.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><div style="font-family:serif;font-size:32px;letter-spacing:4px;color:#c9a84c">SIPSAM</div><div style="color:#7a9ac0;font-size:14px;letter-spacing:2px">Connecting as ' + user.username + '...</div></div>';
            }
        }

        // Connect to game server
        connect(user.username).then(() => {
            // connect() calls showScreen('screen-lobby') on success
            if (!table || !table.minBet) return;
            // Auto-click the matching table button in the lobby
            setTimeout(() => {
                document.querySelectorAll('button').forEach(btn => {
                    const txt = btn.textContent || '';
                    const oc  = btn.getAttribute('onclick') || '';
                    if (txt.includes('$' + table.minBet) || oc.includes(table.minBet)) {
                        btn.click();
                    }
                });
            }, 800);
        }).catch(err => {
            console.warn('[VurgLife] Auto-connect failed:', err);
            // Fall back to normal login screen on failure
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById('screen-login')?.classList.add('active');
        });

    } catch(e) {
        console.warn('[VurgLife] Auto-login error:', e);
    }
});
