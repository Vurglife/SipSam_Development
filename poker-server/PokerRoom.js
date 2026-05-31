// ============================================
// SIPSAM GAME ROOM v6.0
// Pure JS — no Colyseus dependency
// Works with plain WebSocket server in index.js
// ============================================

const Logic    = require("./logic.js");
const http     = require("http");
// Canonical SipSam table tiers — single source of truth.
// See shared/sipsam-tables.js + ARCHITECTURE.md §3.
const SIPSAM_TABLES = require("../shared/sipsam-tables.js");
// Side bets per docs/system-development/sidebets-spec.md.
const SideBets = require("./sideBets.js");

// â”€â”€ PLATFORM API CALLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Calls the VurgLife platform (localhost:3000) to settle bank transactions
function callPlatformAPI(path, token, body) {
    return new Promise((resolve) => {
        if (!token) return resolve({ ok: false, error: "no token" });
        const payload = JSON.stringify(body);
        const opts = {
            hostname: "localhost",
            port:     3000,
            path:     path,
            method:   "POST",
            headers: {
                "Content-Type":   "application/json",
                "Content-Length": Buffer.byteLength(payload),
                "Authorization":  "Bearer " + token,
                "X-Game-Server": "sipsam",
                "X-Game-Server-Secret": process.env.GAME_SERVER_SECRET || "vurglife_local_game_server_secret"
            }
        };
        // 8-second timeout — prevents hanging indefinitely if platform is slow
        const timer = setTimeout(() => {
            console.error("[API] TIMEOUT:", path);
            req.destroy();
            resolve({ ok: false, error: "timeout" });
        }, 8000);

        const req = http.request(opts, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                clearTimeout(timer);
                try { resolve(JSON.parse(data)); }
                catch(e) { resolve({ ok: false, raw: data }); }
            });
        });
        req.on("error", (e) => {
            clearTimeout(timer);
            console.error("[API]", path, e.message);
            resolve({ ok: false, error: e.message });
        });
        req.write(payload);
        req.end();
    });
}

class SipSamRoom {

    constructor() {
        this.clients      = [];
        this.arrangeTimer = null;
        this.betTimer     = null;
        this.revealTimer  = null;
        this.sideBetTimer = null;
        this.arrangeWatchdog = null;
        this.betWatchdog     = null;
        this.revealWatchdog  = null;
        this.sideBetWatchdog = null;
        this._lobbyTimer  = null;
        this._phaseTokens = {};
        this._nextRoundTimer = null;

        this.gameState = {
            status:          "waiting",
            round:           0,
            maxRounds:       10,
            blitz:           false,
            pot:             0,
            timer:           0,
            tableMinBet:     0,
            tableKey:        0,
            tableMaxBet:     0,
            tableIncrement:  0,
            tableWalletSize: 0,
            bankerSessionId: "",
            players:         {},
            message:         "",
            lobbyCountdown:  0,
            isPrivate:       false,
            sideBets:        SideBets.emptyState()
        };

        console.log("SipSam Room Created");
    }

    // Called by index.js for every incoming message
    _dispatchMessage(type, client, data) {
        switch(type) {
            case "startGame":       this._onStartGame(client, data);      break;
            case "placeBet":        this._onPlaceBet(client, data);       break;
            case "doubleBet":       this._onDoubleBet(client, data);      break;
            case "bankerResponse":  this._onBankerResponse(client, data); break;
            case "arrangeHands":      this._onArrangeHands(client, data);      break;
            case "requestState":      this._onRequestState(client, data);      break;
            case "replenishWallet":   this._onReplenishWallet(client, data);   break;
            case "disqualifyPlayer":  this._onDisqualifyPlayer(client, data);  break;
            case "declareSpecial":    this._onDeclareSpecial(client, data);    break;
            case "chatMessage":       this._onChatMessage(client, data);       break;
            case "requestChips":      this._onRequestChips(client, data);      break;
            case "sendChips":         this._onSendChips(client, data);         break;
            case "requestExit":       this._onRequestExit(client);             break;
            case "initiateSideBet":   this._onInitiateSideBet(client, data);   break;
            case "acceptSideBet":     this._onAcceptSideBet(client, data);     break;
            case "declineSideBet":    this._onDeclineSideBet(client, data);    break;
            default: console.log("Unknown message:", type);
        }
    }

    recordSideBetTransaction(player, type, amount, reference, description) {
        if (!player || !player.token) return;
        const signedAmount = Math.trunc(Number(amount) || 0);
        if (!signedAmount) return;
        callPlatformAPI('/api/game/side-bet-transaction', player.token, {
            type,
            amount:      signedAmount,
            reference:   reference || null,
            description: description || null,
            tableMinBet: this.gameState.tableMinBet,
            roomId:      this._roomId || null
        }).then(r => {
            if (!r || !r.ok) console.warn('[SIDEBET][TXN] record failed:', r && r.error);
        }).catch(e => console.warn('[SIDEBET][TXN] record error:', e.message));
    }

    _onStartGame(client, data) {
        console.log("startGame:", JSON.stringify(data));
        if (this.gameState.status !== "waiting") return;
        // Cancel lobby countdown — game is starting manually
        if (this._lobbyTimer) { clearInterval(this._lobbyTimer); this._lobbyTimer = null; }
        this.gameState.lobbyCountdown = 0;
        // Fill bots for any empty seats now that game is starting
        this.fillBotsIfNeeded();

        const TABLE_CONFIG = SIPSAM_TABLES; // single source — shared/sipsam-tables.js

        const roundCount = [5,10,20,30].includes(data.rounds) ? data.rounds : 10;
        const cfg        = TABLE_CONFIG[data.tableMinBet] || TABLE_CONFIG[100];

        // VIP flag for enhanced bonuses (used by logic.getSpecialBonus).
        // Both VIP ($10K) and Elite ($100K) tables get the bumped bonus.
        this.gameState.isVip = cfg.minBet >= 10000;

        this.gameState.maxRounds       = roundCount;
        this.gameState.blitz           = data.blitz === true || roundCount === 5;
        this.gameState.tableKey        = cfg.tableKey || cfg.minBet;
        this.gameState.tableMinBet     = cfg.minBet;
        this.gameState.tableMaxBet     = cfg.maxBet;
        this.gameState.tableIncrement  = cfg.increment;
        this.gameState.tableWalletSize = cfg.walletSize;

        console.log(`Table: $${cfg.minBet} min / $${cfg.maxBet} max / $${cfg.increment} inc / $${cfg.walletSize} wallet | Rounds: ${roundCount} | Blitz: ${this.gameState.blitz}`);
        this._applyTableConfigFromRoomId(); // ensure config is set
        this.beginGame();
    }

    _onPlaceBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "betting" || player.isBanker) return;

        // Player with 0 chips cannot bet — they should be a ghost bot
        if (player.chips <= 0) {
            console.log(player.username, 'cannot bet — 0 chips, converting to ghost.');
            player.isGhostBot  = true;
            player.bet         = 0;
            player.hasArranged = true;
            this.broadcastState();
            return;
        }

        // Use the authoritative max set when the table config was applied
        // (gameState.tableMaxBet). The old hardcoded local TABLE_CONFIG
        // here was missing the 10000 VIP tier, so VIP bets capped at
        // tMin*2 = $20,000 instead of the configured $50,000.
        const tMin  = this.gameState.tableMinBet;
        const tStep = this.gameState.tableIncrement || tMin;
        const tMax  = this.gameState.tableMaxBet || (tMin * 2);
        let amount  = parseInt(data.amount) || tMin;
        // Cap bet to table max AND what player can afford
        amount = Math.max(tMin, Math.min(amount, tMax, player.chips));
        amount = Math.round(amount / tStep) * tStep; // round to nearest table increment
        player.bet = amount;
        console.log(player.username, "bet:", amount, `(min:${tMin} max:${tMax})`);
        this.broadcastState();
    }

    _onDoubleBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "betting") return;
        this.broadcastAll({ type:"doubleRequest", from:player.username, sessionId:client.sessionId });
    }

    _onBankerResponse(client, data) {
        const banker = this.gameState.players[client.sessionId];
        if (!banker || !banker.isBanker) return;
        const target = this.gameState.players[data.targetSessionId];
        if (!target) return;
        if (data.accepted) {
            target.bet = Math.min(target.bet * 2, target.chips);
            this.broadcastAll({ type:"doubleAccepted", username:target.username });
        } else {
            this.broadcastAll({ type:"doubleRejected", username:target.username });
        }
        this.broadcastState();
    }

    _onArrangeHands(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "arranging") return;
        if (player.disqualified || player.hasArranged) return;
        const h1 = data.hand1 || [];
        const h2 = data.hand2 || [];
        const h3 = data.hand3 || [];
        if (h1.length!==3 || h2.length!==5 || h3.length!==5) {
            this.sendToClient(client, { type:"error", message:"Hand1=3, Hand2=5, Hand3=5 cards." });
            return;
        }
        const allSubmitted = [...h1,...h2,...h3].sort().join(",");
        const allDealt     = [...player.rawCards].sort().join(",");
        if (allSubmitted !== allDealt) {
            this.sendToClient(client, { type:"error", message:"Cards don't match your dealt hand." });
            return;
        }
        const orderErr = Logic.validateHandOrder(h1, h2, h3);
        if (orderErr) {
            // Invalid arrangement â†’ immediate disqualification (no retry allowed)
            console.log(`${player.username} DISQUALIFIED — invalid hand order: ${orderErr}`);
            player.disqualified     = true;
            player.disqualifyReason = 'Invalid hand arrangement — disqualified.';
            player.lastSpecial      = 'âŒ DQ — invalid hands';
            player.hasArranged      = true; // mark arranged so game can proceed
            // Assign hands as submitted so cards are visible at reveal
            player.hand1 = h1; player.hand2 = h2; player.hand3 = h3;
            // DQ penalty: non-bankers pay the banker; a disqualified banker pays the table.
            const banker = Object.values(this.gameState.players).find(p => p.isBanker);
            if (player.isBanker) {
                this._applyBankerDqPayments(player, 'Invalid hand arrangement - disqualified.');
            } else {
                this._applyDqPayment(player, banker, 'Invalid hand arrangement - disqualified.');
            }
            this.sendToClient(client, { type:'playerDisqualified', username:player.username, reason:'Invalid hand arrangement — disqualified.' });
            this.broadcast({ type:'playerDisqualified', username:player.username, reason:`${player.username} disqualified — invalid hand arrangement.` });
            this.broadcastState();
            this.checkAllArranged();
            return;
        }
        player.hand1=h1; player.hand2=h2; player.hand3=h3;
        player.hasArranged = true;
        console.log(player.username, "arranged.");
        this.broadcastState();
        this.checkAllArranged();
    }

    _onRequestState(client, data) {
        this.sendToClient(client, { type:"stateUpdate", state:this.getPublicState(client.sessionId) });
    }

    // ==================== LIFECYCLE ====================

    onJoin(client, options) {
        const username = options.username || ("Player_" + client.sessionId.substring(0,4));
        const token    = options.token || null;
        const avatar   = options.avatar || '';

        // Defensive: reject ANY join into a completed / gameOver room. Once
        // the final round ends, the room is dead — even direct invite links
        // or stale matchmake reservations must NOT land a player here.
        if (this.gameState.completed || this.gameState.status === 'gameOver') {
            console.log(username, "REJECTED — room is completed (game already ended)");
            this.sendToClient(client, { type:'roomClosed', reason:'game_complete' });
            return;
        }

        // Parse intended minBet from roomId (format: sipsam_1000_timestamp)
        // so Live Tables can filter by denomination before game starts
        if (!this.gameState.tableMinBet && client.roomId) {
            this._roomId = client.roomId;
            this._applyTableConfigFromRoomId();
        }

        // Apply rounds preference from dashboard if room hasn't been configured yet.
        // Once a game is in progress, room rounds are sticky — we never overwrite.
        if (!this.gameState.maxRounds || this.gameState.status === 'waiting') {
            if (Number(options.maxRounds) > 0) {
                this.gameState.maxRounds = Number(options.maxRounds);
                this.gameState.blitz     = options.blitz === true;
            }
        }

        // Mark room as private if flagged by the joining player (waiting phase only)
        if (options.isPrivate && this.gameState.status === 'waiting') {
            this.gameState.isPrivate = true;
        }

        const isInProgress = (this.gameState.status !== 'waiting' && this.gameState.status !== 'gameOver');

        // Bot replacement for strangers landing in an in-progress room.
        // Find a non-banker bot to kick — the human takes their seat.
        if (isInProgress) {
            const botEntry = Object.entries(this.gameState.players)
                .find(([, p]) => p.isBot && !p.isGhostBot && !p.isBanker);
            if (!botEntry) {
                console.log(username, "REJECTED — in-progress room has no replaceable bot");
                this.sendToClient(client, { type:'error', message:'Table is full. Please try another room.' });
                return;
            }
            const [botSid, bot] = botEntry;
            console.log(`[BOT-SWAP] ${username} replaces ${bot.username} in ${client.roomId} (status=${this.gameState.status})`);
            delete this.gameState.players[botSid];
            this.broadcast({ type:'botReplaced', username });
        }

        // Capacity guard: never exceed 4 seats.
        if (Object.keys(this.gameState.players).length >= 4) {
            console.log(username, "REJECTED — room full (4 players max)");
            this.sendToClient(client, { type:'error', message:'Room is full. Please join another table.' });
            return;
        }

        const walletSize = this.gameState.tableWalletSize || 3000;
        this.gameState.players[client.sessionId] = {
            username, token, avatar, chips: walletSize, bet:0,
            isBanker:false, isBot:false,
            hand1:[], hand2:[], hand3:[], rawCards:[],
            hasArranged:false, disqualified:false,
            lastPayout:0, lastSpecial:null, wins:0
        };

        // For in-progress joins: skip the rest of the current round so the
        // joiner doesn't owe a bet they never placed.
        if (isInProgress) {
            this.gameState.players[client.sessionId].hasArranged = true;
            this.gameState.players[client.sessionId].disqualified = true;       // sit out current round
            this.gameState.players[client.sessionId].disqualifyReason = 'joined_mid_round';
        }

        console.log(username, "joined. Total:", Object.keys(this.gameState.players).length);

        // Start 3-minute lobby countdown on first real player joining (waiting only)
        if (this.gameState.status === 'waiting' && !this._lobbyTimer) {
            this._startLobbyCountdown();
        }

        this.broadcastState();
    }

    _startLobbyCountdown() {
        const LOBBY_SECONDS = 180; // 3 minutes
        let remaining = LOBBY_SECONDS;
        this.gameState.lobbyCountdown = remaining;

        console.log('[LOBBY] 3-minute countdown started');

        this._lobbyTimer = setInterval(() => {
            remaining--;
            this.gameState.lobbyCountdown = remaining;

            // Broadcast every 10s and in the last 30s every second
            if (remaining % 10 === 0 || remaining <= 30) {
                this.broadcastState();
            }

            if (remaining <= 0) {
                clearInterval(this._lobbyTimer);
                this._lobbyTimer = null;
                this.gameState.lobbyCountdown = 0;

                // Only auto-start if still waiting and there's at least one real player
                if (this.gameState.status === 'waiting') {
                    const realPlayers = Object.values(this.gameState.players)
                        .filter(p => !p.isBot && !p.isGhostBot);
                    if (realPlayers.length > 0) {
                        console.log('[LOBBY] Timer expired — filling bots and starting game');
                        this.fillBotsIfNeeded();
                        // Apply table config from roomId if not already set
                        this._applyTableConfigFromRoomId();
                        this.gameState.message = 'Lobby timer expired — starting with bots!';
                        this.broadcastState();
                        setTimeout(() => this.beginGame(), 1000);
                    }
                }
            }
        }, 1000);
    }

    onLeave(client, consented) {
        const player = this.gameState.players[client.sessionId];
        if (!player) return;
        console.log(player.username, "left. Game status:", this.gameState.status);

        // Waiting/lobby phase: no game payments are owed. Return the current
        // wallet to the bank, then free the seat.
        if (this.gameState.status === 'waiting') {
            this._settleExitedHumanWallet(player, 'left_lobby');
            delete this.gameState.players[client.sessionId];
            console.log(player.username, 'left lobby - wallet returned and seat freed.');
            const remaining = Object.values(this.gameState.players)
                .filter(p => !p.isBot && !p.isGhostBot);
            if (remaining.length === 0) {
                if (this._lobbyTimer) { clearInterval(this._lobbyTimer); this._lobbyTimer = null; }
                this.gameState.lobbyCountdown = 0;
            }
            this.broadcastState();
            return;
        }

        const leavingWasBanker = !!player.isBanker;
        const leavingName = player.username;

        // ── DEFERRED EXIT RULE ───────────────────────────────────────────
        // Per spec: when a player exits mid-round, the round must complete
        // first so chips are assigned correctly via NORMAL game rules. No
        // pre-emptive forfeit penalty. The player's bet rides out the
        // round; if they failed to arrange in time, disqualifyLate applies
        // the standard DQ penalty (lose their bet). Their wallet → bank
        // settlement is deferred to round-end via _finalizePendingExits.
        //
        // Banker leaving mid-round is a special case: the banker is needed
        // for the round to resolve, so we keep the existing forfeit flow
        // (banker pays out 2× every player's bet, round ends immediately).
        if (!leavingWasBanker && this._isMidRoundPhase()) {
            player.pendingExit = true;
            // Keep token so we can settle at round end. DO NOT apply exit
            // payments, DO NOT convert to ghost, DO NOT call /exit yet.
            this.broadcast({
                type: 'playerLeft',
                username: leavingName,
                message: `${leavingName} is leaving — settlement at end of round.`
            });
            console.log(`[EXIT-DEFER] ${leavingName} flagged pendingExit at status=${this.gameState.status}; will settle at round end.`);
            this.broadcastState();
            return;
        }

        // Banker mid-round exit OR end-of-round/gameOver exit: settle now.
        // Side-bet exit semantics first (Beat Hand forfeit / sole-remaining win)
        // so payouts to remaining players are credited before this player's
        // wallet is settled to bank.
        try {
            const r = SideBets.handleExit(this, client.sessionId);
            this._broadcastSideBetEvents(r && r.events);
        } catch(e) { console.error('[SIDEBETS] handleExit threw on immediate exit:', e); }
        this._applyExitPayments(player);
        this._settleExitedHumanWallet(player, leavingWasBanker ? 'banker_left_game' : 'left_game');

        const otherRealPlayers = Object.entries(this.gameState.players)
            .filter(([sid, p]) => sid !== client.sessionId && !p.isBot && !p.isGhostBot);

        if (otherRealPlayers.length === 0) {
            console.log('[ROOM] Last real player left - wallet settled, resetting room.');
            this._resetRoom();
            return;
        }

        // Convert the departing human to a ghost immediately. The wallet was
        // already snapshotted for bank settlement above.
        player.token       = null;
        player.isBot       = true;
        player.isGhostBot  = true;
        player.bet         = 0;
        player.hasArranged = true;
        player.chips       = 0;
        player._promoteToRealBot = true;

        this.broadcast({
            type: 'playerLeft',
            username: leavingName,
            message: `${leavingName} left. A bot will take their seat next round.`
        });

        if (leavingWasBanker) {
            console.log('Banker left mid-game - forfeit payments applied and Bot_Banker takes over.');

            player.isBanker = false;
            player.username = 'Bot_' + Date.now();

            const botBankerId = 'bot_banker_' + Date.now();
            const walletSize  = this.gameState.tableWalletSize || 3000;
            this.gameState.players[botBankerId] = {
                username:      'Bot_Banker',
                avatar:        this._botAvatar(0),
                token:         null,
                chips:         walletSize,
                bet:           0,
                isBanker:      true,
                isBot:         true,
                isGhostBot:    false,
                hand1:[], hand2:[], hand3:[], rawCards:[],
                hasArranged:   false, disqualified: false,
                lastPayout:    0, lastSpecial: null, wins: 0
            };
            this.gameState.bankerSessionId = botBankerId;

            this._clearAllPhaseTimers();

            this.gameState.status  = 'roundEnd';
            this.gameState.message = `${leavingName} forfeited as Banker. Bot_Banker takes over next round.`;
            this.broadcast({
                type:    'bankerForfeited',
                username: leavingName,
                message:  `${leavingName} (Banker) left the game and forfeited - active players receive 2x their bet.`
            });
            this.broadcastState();
            if (this._nextRoundTimer) clearTimeout(this._nextRoundTimer);
            this._nextRoundTimer = setTimeout(() => this.startRound(), 4000);
            return;
        }

        player.username = '(Left)';
        console.log(leavingName, 'left mid-game - converted to ghost bot after wallet settlement.');
        this.broadcastState();
    }

    _isActivePaymentPhase() {
        // 'revealing' is NOT active — resolveAllHands has already run at the
        // start of reveal, so chips already reflect the round outcome. Adding
        // an exit penalty here would double-charge the player (they'd lose
        // their bet to the banker on top of any losses already applied).
        // Only the phases where bets are still in flight and payouts have not
        // yet been computed should trigger a forced-exit forfeit.
        return ['betting', 'arranging'].includes(this.gameState.status);
    }

    // Any phase where a round is in flight. roundEnd is EXCLUDED here because
    // by then the round has fully resolved — exits during roundEnd should
    // settle immediately, not wait for the next round to start.
    _isMidRoundPhase() {
        return ['betting', 'arranging', 'revealing', 'sideBetPhase', 'preRound1SideBets'].includes(this.gameState.status);
    }

    // Player clicked Exit on the client. Behaviour by phase:
    //   • betting / revealing / sideBetPhase → mark pendingExit; round-end finalises
    //   • arranging            → mark pendingExit AND auto-DQ them now so
    //                            the round can advance to reveal without
    //                            waiting on the arrange timer. Natural DQ
    //                            penalty applies (lose bet to banker).
    //   • roundEnd / waiting / gameOver → no defer; caller disconnects and
    //                                     onLeave settles immediately.
    _onRequestExit(client) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isBot) return;
        if (this._isMidRoundPhase() && !player.isBanker) {
            player.pendingExit = true;
            // Speed up arrange-phase exits: apply natural DQ immediately so
            // checkAllArranged isn't blocked waiting on this player. Without
            // this the room sat through the full ~65s arrange timer before
            // disqualifyLate ran, then a further ~30s reveal — total ~95s of
            // overlay wait. With auto-DQ the room can move straight to reveal.
            if (this.gameState.status === 'arranging' && !player.hasArranged && !player.disqualified) {
                const banker = this.gameState.players[this.gameState.bankerSessionId];
                this._applyDqPayment(player, banker, 'Left game during arrange phase.');
                player.hasArranged = true;
                console.log(`[EXIT-REQ] ${player.username} auto-DQ during arrange — round can now advance.`);
                this.broadcast({ type:'playerDisqualified', username:player.username, reason:'Left game during arrange phase.' });
            }
            this.sendToClient(client, { type:'exitPending', message:'Settling at end of round…' });
            console.log(`[EXIT-REQ] ${player.username} requested exit; deferring to round end.`);
            this.broadcastState();
            // Trigger an immediate check — if every remaining player is now
            // arranged (bots arrange synchronously on deal), reveal starts.
            this.checkAllArranged();
            return;
        }
        // Not mid-round (waiting / roundEnd / gameOver) — caller will disconnect
        // and onLeave's immediate-settle path handles it.
        this.sendToClient(client, { type:'exitOk' });
    }

    // Called when a round resolves (end of reveal). Settles each pendingExit
    // player's wallet to bank using the AUTHORITATIVE current chip count, then
    // converts them to ghost bots for subsequent rounds. Also notifies any
    // still-connected WS so the client can navigate away.
    _finalizePendingExits() {
        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (!player || !player.pendingExit || player.isBot || player.isGhostBot) return;
            const name = player.username;
            const chips = Math.max(0, Number(player.chips) || 0);
            console.log(`[EXIT-FINALIZE] ${name}: settling $${chips} → bank`);

            // Side-bet exit semantics — Beat Hand forfeits to opponent;
            // First Special / Best Card sole-remaining gets the pot.
            // Runs BEFORE wallet settle so any payouts already landed in
            // OTHER players' wallets are credited correctly; the leaver's
            // own pot stake is never refunded.
            try {
                const r = SideBets.handleExit(this, sid);
                this._broadcastSideBetEvents(r && r.events);
            } catch(e) { console.error('[SIDEBETS] handleExit threw on finalize:', e); }

            // Settle wallet → bank using the trusted game-server path so the
            // platform credits the full amount, including any post-payout
            // winnings, without the client-side ceiling cap.
            this._settleExitedHumanWallet(player, 'deferred_exit');

            // Notify any WS still connected so the client navigates.
            const cli = this.clients.find(c => c.sessionId === sid);
            if (cli) this.sendToClient(cli, { type:'exitOk', settled: chips });

            // Convert to ghost so subsequent rounds skip this seat.
            player.token       = null;
            player.isBot       = true;
            player.isGhostBot  = true;
            player.bet         = 0;
            player.hasArranged = true;
            player.chips       = 0;
            player._promoteToRealBot = true;
            player.pendingExit = false;
        });
    }

    _applyExitPayments(player) {
        if (!player || player.isBot || player.isGhostBot || !this._isActivePaymentPhase()) return;

        if (player.isBanker) {
            let totalForfeited = 0;
            Object.values(this.gameState.players).forEach(p => {
                if (p === player || p.isBanker || p.isGhostBot || p.disqualified || p.bet <= 0) return;
                const prize = p.bet * 2;
                p.chips      += prize;
                p.lastPayout  = prize;
                p.lastSpecial = `Banker left - won 2x bet ($${prize.toLocaleString()})`;
                p.wins++;
                totalForfeited += prize;
                console.log(`[EXIT-PAYMENT] ${p.username} receives $${prize} from banker forfeit`);
            });
            if (totalForfeited > 0) {
                player.chips -= totalForfeited;
                player.lastPayout = -totalForfeited;
                player.lastSpecial = `Left as banker - forfeited $${totalForfeited.toLocaleString()}`;
                console.log(`[EXIT-PAYMENT] Banker ${player.username} forfeits $${totalForfeited}`);
            }
            return;
        }

        if (player.disqualified || player.bet <= 0) return;
        const banker = this.gameState.players[this.gameState.bankerSessionId];
        const owed = (Number(player.bet) || 0) * 2;
        player.chips -= owed;
        player.lastPayout = -owed;
        player.disqualified = true;
        player.disqualifyReason = 'Left game during active round.';
        player.lastSpecial = `Left game - paid double ($${owed.toLocaleString()})`;
        if (banker && banker !== player) banker.chips += owed;
        console.log(`[EXIT-PAYMENT] ${player.username} pays double $${owed} to ${banker ? banker.username : 'banker'}`);
    }

    _applyDqPayment(player, banker, reason) {
        if (!player) return 0;
        const penalty = Math.max(0, (Number(player.bet) || 0) * 2);
        player.disqualified = true;
        if (reason) player.disqualifyReason = reason;
        if (penalty > 0) {
            player.chips = (Number(player.chips) || 0) - penalty;
            player.lastPayout = -penalty;
            if (banker && banker !== player) {
                banker.chips = (Number(banker.chips) || 0) + penalty;
            }
        } else {
            player.lastPayout = 0;
        }
        player.lastSpecial = `DQ - paid double ($${penalty.toLocaleString()})`;
        // Side-bet DQ semantics — Beat Hand pots instant-forfeit to opponent.
        // First Special / Best Card are unaffected (resolve at own timing).
        try {
            const sid = this._findSidForPlayer ? this._findSidForPlayer(player) : null;
            const useSid = sid || Object.keys(this.gameState.players)
                .find(s => this.gameState.players[s] === player);
            if (useSid) {
                const r = SideBets.handleDQ(this, useSid);
                this._broadcastSideBetEvents(r && r.events);
            }
        } catch(e) { console.error('[SIDEBETS] handleDQ threw on _applyDqPayment:', e); }
        return penalty;
    }

    _applyBankerDqPayments(banker, reason) {
        if (!banker) return 0;
        const bonusTier = this.gameState.tableMinBet || (this.gameState.isVip ? 10000 : 0);
        const specialAnnouncements = [];
        let totalFromBanker = 0;

        Object.values(this.gameState.players).forEach(p => {
            if (p === banker || p.isBanker || p.isGhostBot || p.disqualified || p.bet <= 0) return;
            const declared = p.declaredSpecial || null;
            const sp       = declared;
            const bonusSp  = declared;
            const bonus    = bonusSp ? Logic.getSpecialBonus(bonusSp.name, bonusTier) : 0;
            const fromBanker = (Number(p.bet) || 0) * 2;
            const refund     = fromBanker + bonus;

            p.chips = (Number(p.chips) || 0) + refund;
            p.lastPayout = refund;
            p.lastSpecial = sp
                ? `Banker DQ + ${sp.name} - paid 2x bet + $${bonus.toLocaleString()} bonus ($${refund.toLocaleString()})`
                : `Banker DQ - Won 2x bet ($${fromBanker.toLocaleString()})`;
            p.wins = (Number(p.wins) || 0) + 1;
            totalFromBanker += fromBanker;

            if (sp) specialAnnouncements.push(this._specialAnnouncement(p.username, sp, bonus, fromBanker, false));
        });

        banker.chips = (Number(banker.chips) || 0) - totalFromBanker;
        banker.lastPayout = -totalFromBanker;
        banker.disqualified = true;
        if (reason) banker.disqualifyReason = reason;
        banker.lastSpecial = `DQ - paid double ($${totalFromBanker.toLocaleString()})`;
        // Side-bet DQ semantics for banker — banker can hold First Special
        // pot (banker is allowed initiator per spec), so we still call
        // handleDQ (no-op for Beat Hand since banker can't participate).
        try {
            const bSid = Object.keys(this.gameState.players)
                .find(s => this.gameState.players[s] === banker);
            if (bSid) {
                const r = SideBets.handleDQ(this, bSid);
                this._broadcastSideBetEvents(r && r.events);
            }
        } catch(e) { console.error('[SIDEBETS] handleDQ threw on banker DQ:', e); }
        this._broadcastSpecialAnnouncements(specialAnnouncements);
        return totalFromBanker;
    }

    _specialAnnouncement(username, special, bonus, payment, isBanker) {
        if (!special || !special.name) return null;
        return {
            username: username || 'Player',
            specialName: special.name,
            multiplier: special.multiplier || 0,
            bonus: Math.max(0, Number(bonus) || 0),
            payment: Number(payment) || 0,
            isBanker: !!isBanker
        };
    }

    _broadcastSpecialAnnouncements(announcements) {
        const clean = (announcements || []).filter(Boolean);
        if (!clean.length) return;
        this.broadcast({ type:'specialAnnouncements', announcements: clean });
    }

    // Publicly announce every resolved side-bet pot (First Special, Beat
    // Hand, Best Card). Each broadcast is a sideBetAnnouncement WS message
    // the client renders as a toast + chip-flow to the winner. Best Card's
    // post-deal resolver broadcasts its own events directly (with 2s pause
    // before play continues); this helper covers FS / BH at round-end.
    _broadcastSideBetPayouts(resolvedPots) {
        const pots = (resolvedPots || []).filter(p =>
            p && p.status === 'resolved' && p.type !== 'bestCard'
        );
        if (!pots.length) return;
        for (const pot of pots) {
            const winnerSids = pot.winnerSids && pot.winnerSids.length
                ? pot.winnerSids
                : (pot.winnerSid ? [pot.winnerSid] : []);
            if (!winnerSids.length) continue;
            const winnerNames = winnerSids.map(sid => {
                const p = this.gameState.players[sid];
                return (p && p.username) || 'Player';
            });
            const amount = Number(pot.pot) || 0;
            let eventLabel;
            if (pot.type === 'firstSpecial') {
                const decl = (pot.declarationsThisRound || [])
                    .find(d => winnerSids.includes(d.sid));
                eventLabel = `First Special${decl ? ' — ' + decl.specialName : ''}`;
            } else {
                eventLabel = 'Beat Hand';
            }
            const summary = `${winnerNames.join(' + ')} wins ${eventLabel} — $${amount.toLocaleString()}`;
            this.broadcast({
                type:       'sideBetAnnouncement',
                event:      {
                    type:        pot.type,
                    potId:       pot.id,
                    winnerSids,
                    winnerNames,
                    amount,
                    eventLabel,
                    announceType: 'payout',
                },
                durationMs: 2500,
                message:    summary,
            });
            console.log(`[SIDEBET][ANNOUNCE] ${summary}`);
        }
    }

    // Low-wallet private alert per spec section "Low-wallet alert":
    // fires once per descent below 10% of starting walletSize, re-arms
    // when player recovers above the threshold. Bot players are skipped.
    _checkLowWallets() {
        const walletSize = Number(this.gameState.tableWalletSize) || 0;
        if (walletSize <= 0) return;
        const threshold = Math.floor(walletSize * 0.10);
        const players = this.gameState.players || {};
        for (const sid of Object.keys(players)) {
            const p = players[sid];
            if (!p || p.isBot || p.isGhostBot || p.pendingExit) continue;
            const chips = Number(p.chips) || 0;
            if (chips <= threshold) {
                if (!p._lowWalletAlerted) {
                    p._lowWalletAlerted = true;
                    const cli = this.clients.find(c => c.sessionId === sid);
                    if (cli) {
                        this.sendToClient(cli, {
                            type:           'lowWalletAlert',
                            currentWallet:  chips,
                            walletStart:    walletSize,
                            thresholdPct:   10,
                            threshold:      threshold,
                            message:        `Your wallet is at $${chips.toLocaleString()} — that's 10% or less of your starting $${walletSize.toLocaleString()}. Consider topping up.`,
                        });
                        console.log(`[LOW-WALLET] private alert to ${p.username}: $${chips} / $${walletSize}`);
                    }
                }
            } else if (p._lowWalletAlerted) {
                // Re-arm once the player recovers above threshold
                p._lowWalletAlerted = false;
            }
        }
    }

    // Broadcast announce events emitted by SideBets.handleExit / handleDQ
    // (the helpers already credit wallets — this is the public-facing
    // announce only). Event shape: { type, potId, winnerSids, amount,
    // eventLabel, announceType }.
    _broadcastSideBetEvents(events) {
        const list = (events || []).filter(Boolean);
        if (!list.length) return;
        for (const ev of list) {
            const winnerNames = (ev.winnerSids || []).map(sid => {
                const p = this.gameState.players[sid];
                return (p && p.username) || 'Player';
            });
            const amount = Number(ev.amount) || 0;
            const summary = winnerNames.length
                ? `${winnerNames.join(' + ')} wins ${ev.eventLabel} — $${amount.toLocaleString()}`
                : ev.eventLabel;
            this.broadcast({
                type:       'sideBetAnnouncement',
                event:      Object.assign({}, ev, { winnerNames }),
                durationMs: 2500,
                message:    summary,
            });
            console.log(`[SIDEBET][ANNOUNCE] ${summary}`);
        }
    }

    _settleExitedHumanWallet(player, reason) {
        if (!player || !player.token || player.isBot) return;
        const token = player.token;
        const username = player.username;
        const tableMinBet = this.gameState.tableMinBet;
        const chips = Number(player.chips) || 0;
        const returning = Math.max(0, chips);
        const debt = Math.max(0, -chips);

        (async () => {
            if (debt > 0) {
                try {
                    const debtRes = await callPlatformAPI('/api/game/debt-payment', token, {
                        amount: debt,
                        tableMinBet,
                        reason: reason || 'wallet_shortfall'
                    });
                    console.log(`[EXIT-SETTLE] ${username} debt $${debt} pulled from bank:`, debtRes.ok ? `OK (new bank $${debtRes.newBankBalance})` : debtRes.error);
                } catch(e) {
                    console.warn('[EXIT-SETTLE] debt call failed:', e.message);
                }
            }

            try {
                const res = await callPlatformAPI('/api/game/exit', token, {
                    remainingWallet: returning,
                    tableMinBet,
                    reason: reason || 'left_game'
                });
                console.log(`[EXIT-SETTLE] ${username} wallet $${returning} returned to bank:`, res.ok ? `OK (new bank $${res.newBankBalance})` : res.error);
            } catch(e) {
                console.warn('[EXIT-SETTLE] exit call failed:', e.message);
            }
        })();
    }

    _resetRoom() {
        console.log('[ROOM] Resetting room for next game...');
        // Cancel any running timers
        this._clearAllPhaseTimers();
        if (this._nextRoundTimer) { clearTimeout(this._nextRoundTimer); this._nextRoundTimer = null; }
        if (this._evictTimer)     { clearTimeout(this._evictTimer);     this._evictTimer     = null; }
        if (this._lobbyTimer)     { clearInterval(this._lobbyTimer);    this._lobbyTimer     = null; }

        // Reset game state completely — fresh slate
        this.gameState = {
            status:          'waiting',
            round:           0,
            maxRounds:       10,
            blitz:           false,
            pot:             0,
            timer:           0,
            tableMinBet:     0,
            tableMaxBet:     0,
            tableIncrement:  0,
            tableWalletSize: 0,
            bankerSessionId: '',
            players:         {},
            message:         '',
            sideBets:        SideBets.emptyState()
        };
        this._settled = false;
        console.log('[ROOM] Room reset complete — ready for new game.');
    }

    // ==================== GAME FLOW ====================

    beginGame() {
        this._settled = false; // reset for this game
        this.gameState.round = 0;
        // Once the game starts, the room becomes joinable by strangers
        // replacing bot seats (Zynga-style). Clear isPrivate so quick-join
        // matchmaking can place them here when tier+rounds match.
        this.gameState.isPrivate = false;
        // Mark all pending invites for this room as expired
        // so players don't see stale invites after game starts
        this._expireRoomInvites();
        const walletSize = this.gameState.tableWalletSize || 3000;

        // Reset all player chips to the correct wallet size for this table
        Object.values(this.gameState.players).forEach(p => {
            p.chips = walletSize;
        });

        // Random banker — stays for entire game
        const ids      = Object.keys(this.gameState.players);
        const bankerId = ids[Math.floor(Math.random() * ids.length)];
        this.gameState.players[bankerId].isBanker = true;
        this.gameState.bankerSessionId = bankerId;
        const bankerName = this.gameState.players[bankerId].username;
        console.log(`Banker: ${bankerName} | Wallet: $${walletSize} each`);
        this.gameState.message = `${bankerName} is the Banker for all ${this.gameState.maxRounds} rounds!`;
        this.broadcastState();
        if (this._nextRoundTimer) clearTimeout(this._nextRoundTimer);
        // Pre-round-1 side-bet window: spec inserts a 10s window before
        // round 1's betting where players can initiate AND accept any of
        // the three side-bet types. After the window expires, finalize
        // any pots (refund pending_accept solos, lock the rest), then
        // begin round 1 as normal.
        this._nextRoundTimer = setTimeout(() => this._startPreRound1SideBetWindow(), 2000);
    }

    _startPreRound1SideBetWindow() {
        // Spec: 10s combined initiate+accept window before round 1.
        // Skipped entirely if side bets are disabled at the table level
        // (Blitz) since sideBetsAllowed returns false there.
        const sb = this.gameState.sideBets || (this.gameState.sideBets = SideBets.emptyState());
        if (!SideBets.sideBetsAllowed(this.gameState)) {
            this.startRound();
            return;
        }
        const PHASE_SECS = (SideBets && SideBets.PHASE_DURATION_SECONDS) || 10;
        this.gameState.status  = 'preRound1SideBets';
        this.gameState.timer   = PHASE_SECS;
        this.gameState.message = `Pre-round side bets — ${PHASE_SECS}s to initiate / accept.`;
        // Per-round initiation flags clean: ensures the post-window
        // finalize pass sees only pots created in this window.
        if (sb.initiationsThisRound) {
            sb.initiationsThisRound.firstSpecial = false;
            sb.initiationsThisRound.beatHand     = false;
            sb.initiationsThisRound.bestCard     = false;
        }
        this.broadcastState();
        console.log(`[SIDEBET] pre-round-1 window opened (${PHASE_SECS}s)`);
        this.startCountdown(PHASE_SECS, 'preRound1SideBets', () => {
            // Finalize each bet type — refund unaccepted pots, lock the rest.
            try { SideBets.finalizePhase(this, 'firstSpecial'); } catch(e) { console.error('[SIDEBETS] finalize FS:', e); }
            try { SideBets.finalizePhase(this, 'beatHand');     } catch(e) { console.error('[SIDEBETS] finalize BH:', e); }
            try { SideBets.finalizePhase(this, 'bestCard');     } catch(e) { console.error('[SIDEBETS] finalize BC:', e); }
            this.broadcastState();
            this.startRound();
        });
    }

    startRound() {
        this._clearAllPhaseTimers();
        if (this._nextRoundTimer) { clearTimeout(this._nextRoundTimer); this._nextRoundTimer = null; }
        // Defensive: any pendingExit player that slipped past reveal (e.g.
        // exit requested AFTER _finalizePendingExits already fired during the
        // current roundEnd window) is settled here before the next round.
        if (Object.values(this.gameState.players).some(p => p && p.pendingExit)) {
            this._finalizePendingExits();
        }
        this.gameState.round++;
        if (this.gameState.round > this.gameState.maxRounds) { this.endGame(); return; }
        // Clear per-round side-bet initiation flags + transient phase state.
        // Active multi-round pots (First Special, carry-over Best Card) are
        // preserved — only the "what was initiated this round" book-keeping
        // resets. See docs/system-development/sidebets-spec.md.
        try { SideBets.resetForNewRound(this.gameState.sideBets); } catch(e) {}
        console.log("--- Round", this.gameState.round, "---");

        const banker = this.gameState.players[this.gameState.bankerSessionId];
        if (banker && banker.chips <= 0) {
            const walletSz = this.gameState.tableWalletSize || 3000;
            if (banker.isBot) {
                // Bot_Banker auto-replenishes — never runs dry
                banker.chips = walletSz;
                console.log(`[BOT REPLENISH] Bot_Banker topped up to $${walletSz}`);
            } else {
                // Human banker went broke — convert to Bot_Banker
                banker.isBot = true; banker.username = "Bot_Banker";
                banker.chips = walletSz;
                console.log("Banker bankrupt — Bot_Banker takes over with fresh wallet.");
            }
        }

        Object.values(this.gameState.players).forEach(p => {
            // Preserve debt-disqualification across rounds — debtDqd players stay DQ'd
            const keepDqd = p.debtDqd === true;
            p.bet             = p.isBanker ? 0 : this.gameState.tableMinBet;
            p.lastPayout      = 0; p.lastSpecial = null;
            p.disqualified    = keepDqd;  // debt-DQ'd players stay disqualified
            p.disqualifyReason = keepDqd ? p.disqualifyReason : null;
            p.declaredSpecial = null; p.declaredSpecialName = null;
            p.handResults     = null;
            p.hand1=[]; p.hand2=[]; p.hand3=[];
            p.rawCards=[]; p.hasArranged=false;
        });

        // Side-bet top-ups: active First Special pots charge each remaining
        // participant minBet per round. Failures forfeit their contribution
        // to the pot AND get DQ'd from this round's main game (no main-game
        // chip penalty applied here — bet is zeroed so the banker-debt path
        // doesn't fire for them; they simply sit out).
        try {
            const topup = SideBets.topupAtRoundStart(this);
            const forfeited = (topup && topup.firstSpecial && topup.firstSpecial.forfeited) || [];
            forfeited.forEach(sid => {
                const p = this.gameState.players[sid];
                if (!p) return;
                p.disqualified     = true;
                p.disqualifyReason = 'First Special top-up failed — insufficient wallet.';
                p.lastSpecial      = '❌ Side-bet topup failed';
                p.bet              = 0;
                console.log(`[SIDEBET][FS] ${p.username} forfeited + DQ for top-up failure`);
            });
        } catch(e) { console.error('[SIDEBETS] topupAtRoundStart threw:', e); }

        // Promote ghost bots (left players) to real bots for this round
        // They were ghost last round — now they become a proper bot replacement
        let botNum = Object.values(this.gameState.players).filter(p => p.isBot && !p.isGhostBot).length + 1;
        Object.values(this.gameState.players).forEach(p => {
            if (p._promoteToRealBot) {
                p.isGhostBot       = false;  // no longer sitting out
                p.isBot            = true;
                p._promoteToRealBot = false;
                p.chips            = this.gameState.tableWalletSize || 3000; // fresh wallet
                p.username         = 'Bot_' + botNum++;
                p.avatar           = this._botAvatar(botNum);
                console.log(`[ROUND] Ghost promoted to real bot: ${p.username} with $${p.chips} chips`);
                this.broadcast({ type:'botReplaced', username: p.username });
            }
        });

        // Convert broke real players to ghost bots before round starts
        Object.values(this.gameState.players).forEach(p => {
            if (!p.isBot && !p.isGhostBot && !p.isBanker && p.chips <= 0) {
                console.log(`[ROUND] ${p.username} is broke — converting to ghost bot.`);
                p.isGhostBot  = true;
                p.bet         = 0;
                p.hasArranged = true;
                // Notify table
                this.broadcast({ type:'playerBroke', username: p.username });
            }
        });

        // Auto-replenish bots that have run out of chips
        // Bots never go broke — they always top back up to the table wallet size
        const walletSize = this.gameState.tableWalletSize || 3000;
        Object.values(this.gameState.players).forEach(p => {
            if (p.isBot && !p.isGhostBot && p.chips <= 0) {
                console.log(`[BOT REPLENISH] ${p.username} ran out of chips — topping up to $${walletSize}`);
                p.chips = walletSize;
            }
        });

        Object.values(this.gameState.players).forEach(p => {
            // Normal bots bet tableMinBet; ghost bots (bust players) bet $0
            if (p.isGhostBot) { p.bet = 0; p.hasArranged = true; } // skip arrange for ghost
            else if (p.isBot && !p.isBanker) p.bet = this.gameState.tableMinBet;
        });

        const bankerName = this.gameState.players[this.gameState.bankerSessionId]?.username || "Banker";
        this.gameState.status  = "betting";
        this.gameState.pot     = 0;
        this.gameState.timer   = 10;
        this.gameState.message = `Round ${this.gameState.round} — ${bankerName} banks. Min bet: $${this.gameState.tableMinBet}. 10s to adjust!`;
        this.broadcastState();
        this.startCountdown(10, "betting", () => this.dealCards());
    }

    dealCards() {
        if (this.gameState.status !== 'betting') {
            console.warn(`[DEAL] dealCards called while status=${this.gameState.status} - ignored`);
            return;
        }
        this._clearPhaseTimer('betting');
        const deck = Logic.shuffleDeck(Logic.createDeck());
        Object.values(this.gameState.players).forEach(p => {
            if (p.isGhostBot) return; // ghost bots get no cards — they sit out visually
            p.rawCards = Logic.dealPlayerCards(deck);
            p.hasArranged = false;
            if (p.isBot) this.botArrange(p);
        });

        // ── Best Card resolution (immediately after deal) ──
        // Per revised spec: Best Card pots resolve against this round's
        // freshly dealt cards BEFORE the arranging phase begins. Winners
        // get a 2-second public announcement so the table sees the
        // winning card + payout before play continues.
        let bcEvents = [];
        try {
            const bc = SideBets.resolveBestCardAfterDeal(this);
            bcEvents = (bc && bc.events) || [];
        } catch(e) { console.error('[SIDEBETS] resolveBestCardAfterDeal threw:', e); }

        const goToArranging = () => {
            const arrangeSecs = this.gameState.blitz ? 40 : 65;
            this.gameState.status  = "arranging";
            this.gameState.timer   = arrangeSecs;
            this.gameState.message = "Cards dealt! Arrange hands. (1st=weakest, 3rd=strongest)";
            this.broadcastState();
            this.startCountdown(arrangeSecs, "arranging", () => {
                this.disqualifyLate();
                this.startRevealPhase();
            });
        };

        if (bcEvents.length) {
            // Broadcast the public announcement(s) and pause 2s before
            // transitioning to arranging so all clients have time to render.
            bcEvents.forEach(ev => {
                const summary = ev.winnerNames && ev.winnerNames[0]
                    ? `${ev.winnerNames[0]} wins ${ev.eventLabel} with ${ev.cardLabel} — $${(ev.amount || 0).toLocaleString()}`
                    : ev.eventLabel;
                this.broadcast({
                    type:       'sideBetAnnouncement',
                    event:      ev,
                    durationMs: 2000,
                    message:    summary,
                });
                console.log(`[SIDEBET][ANNOUNCE] ${summary}`);
            });
            // Hold the deal screen briefly so the toast is visible
            this.gameState.message = bcEvents.length === 1
                ? bcEvents[0].winnerNames[0] + ' wins ' + bcEvents[0].eventLabel + '!'
                : `${bcEvents.length} Best Card winners — see announcements`;
            this.gameState.timer = 2;
            this.broadcastState();
            if (this._bestCardAnnounceTimer) clearTimeout(this._bestCardAnnounceTimer);
            this._bestCardAnnounceTimer = setTimeout(() => {
                this._bestCardAnnounceTimer = null;
                goToArranging();
            }, 2000);
        } else {
            goToArranging();
        }
    }

    disqualifyLate() {
        const banker = this.gameState.players[this.gameState.bankerSessionId];

        // If the human banker didn't arrange: DQ banker, pay each player DOUBLE their bet
        if (banker && !banker.isBot && !banker.hasArranged) {
            banker.disqualified     = true;
            banker.disqualifyReason = "Banker did not arrange cards in time.";
            banker.lastSpecial      = 'âŒ DQ — banker too slow';
            const bonusTier = this.gameState.tableMinBet || (this.gameState.isVip ? 10000 : 0);
            const specialAnnouncements = [];
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified && p.bet > 0) {
                    // Banker pays exactly 2x on DQ; house bonus remains separate.
                    const declared   = p.declaredSpecial || null;
                    const sp         = declared;
                    const bonusSp    = declared;
                    const bonus      = bonusSp ? Logic.getSpecialBonus(bonusSp.name, bonusTier) : 0;
                    const fromBanker = p.bet * 2;
                    const prize      = fromBanker + bonus;
                    p.chips         += prize;
                    p.lastPayout     = prize;
                    banker.chips    -= fromBanker; // bonus comes from house, not banker
                    p.handResults = {
                        r1: 1, r2: 1, r3: 1,
                        names: {
                            player: sp ? [sp.name, sp.name, sp.name] : ['-', '-', '-'],
                            banker: ['DQ', 'DQ', 'DQ']
                        }
                    };
                    p.lastSpecial = sp
                        ? `Banker DQ + ${sp.name} - paid 2x bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                        : `Banker DQ - Won 2x bet ($${fromBanker.toLocaleString()})`;
                    if (sp) specialAnnouncements.push(this._specialAnnouncement(p.username, sp, bonus, fromBanker, false));
                    p.wins++;
                }
            });
            this._broadcastSpecialAnnouncements(specialAnnouncements);
            console.log(banker.username, "BANKER DISQUALIFIED — did not arrange. Players paid 2x bet.");
            this.broadcast({ type:"playerDisqualified", username:banker.username, reason:"Banker disqualified — all players win 2Ã— their bet." });
            return;
        }

        // Disqualify players who didn't arrange
        Object.values(this.gameState.players).forEach(p => {
            if (!p.hasArranged && !p.isBot && !p.disqualified && !p.isBanker) {
                p.disqualified     = true;
                p.disqualifyReason = "Did not arrange cards in time.";
                this._applyDqPayment(p, banker, "Did not arrange cards in time.");
                // Do NOT auto-assign hands - player pays double, excluded from scoring
                console.log(p.username, "DISQUALIFIED — did not arrange in time.");
                this.broadcast({ type:"playerDisqualified", username:p.username, reason:"Did not arrange cards in time." });
            }
        });
    }

    startRevealPhase() {
        // Re-entrancy guard: if status is already past arranging, bail.
        if (this.gameState.status !== 'arranging') {
            console.warn(`[REVEAL] startRevealPhase called while status=${this.gameState.status} - skipping`);
            return;
        }
        this._clearPhaseTimer('arranging');
        const revealSecs = this.gameState.blitz ? 20 : 30;
        this.gameState.status  = "revealing";
        this.gameState.timer   = revealSecs;
        this.gameState.message = "All hands revealed! Processing payouts...";
        // Wrap resolveAllHands so a single bad player can't strand the room
        // in 'revealing' with no countdown running.
        try {
            this.resolveAllHands();
        } catch(e) {
            console.error('[REVEAL] resolveAllHands threw:', e);
            // Players who failed to resolve keep their current chips/bets.
            // Game continues — timer fires → roundEnd → startRound as normal.
        }
        this.broadcastState();
        this.startCountdown(revealSecs, "revealing", () => {
            // Resolve side bets that were locked before this reveal.
            // Best Card pots initiated during this reveal resolve after their
            // accept phase, once they have actually locked participants.
            try {
                const r = SideBets.resolveAtRoundEnd(this);
                this._broadcastSideBetPayouts(r && r.resolved);
            }
            catch(e) { console.error('[SIDEBETS] resolveAtRoundEnd threw:', e); }

            // Low-wallet private alert (post-payouts so main + side-bet
            // settlements have landed before we evaluate the threshold).
            try { this._checkLowWallets(); }
            catch(e) { console.error('[LOW-WALLET] check threw:', e); }

            // If players initiated any side bets during this reveal phase,
            // queue 7s accept phases (one per type) before the next round
            // begins. Otherwise go straight to roundEnd as before.
            const sb = this.gameState.sideBets;
            const ini = sb && sb.initiationsThisRound;
            const queue = [];
            if (ini) {
                if (ini.firstSpecial) queue.push('firstSpecial');
                if (ini.beatHand)     queue.push('beatHand');
                if (ini.bestCard)     queue.push('bestCard');
            }
            if (queue.length > 0 && SideBets.sideBetsAllowed(this.gameState)) {
                sb.phaseQueue = queue;
                this._startNextSideBetPhase();
                return;
            }
            this._enterRoundEnd();
        });
    }

    // Drain one queued side-bet phase, or fall through to roundEnd.
    _startNextSideBetPhase() {
        const sb = this.gameState.sideBets;
        if (!sb || !sb.phaseQueue || sb.phaseQueue.length === 0) {
            try {
                if (SideBets.resolveAfterSideBetPhase) SideBets.resolveAfterSideBetPhase(this);
                else if (SideBets.resolveBestCardAfterSideBetPhase) SideBets.resolveBestCardAfterSideBetPhase(this);
            } catch(e) { console.error('[SIDEBETS] resolveAfterSideBetPhase threw:', e); }
            this._enterRoundEnd();
            return;
        }
        const phaseType = sb.phaseQueue.shift();
        const PHASE_SECS = (SideBets && SideBets.PHASE_DURATION_SECONDS) || 10;
        sb.phaseActive = phaseType;
        sb.phaseTimer  = PHASE_SECS;
        this.gameState.status  = 'sideBetPhase';
        this.gameState.timer   = PHASE_SECS;
        this.gameState.message = `Side bet: ${phaseType} (${PHASE_SECS}s to accept)`;
        this.broadcastState();
        this.startCountdown(PHASE_SECS, 'sideBetPhase', () => {
            // Phase timed out — finalize stakes (no-op until per-bet logic
            // lands). Non-responders are treated as decline. Then drain
            // the queue to the next phase, or fall through to roundEnd.
            try { SideBets.finalizePhase && SideBets.finalizePhase(this, phaseType); }
            catch(e) { console.error('[SIDEBETS] finalizePhase threw:', e); }
            sb.phaseActive = null;
            sb.phaseTimer  = 0;
            this._startNextSideBetPhase();
        });
    }

    // Extracted from the old reveal-end inline so both the no-side-bet
    // path and the post-side-bet-phase path use a single transition.
    _enterRoundEnd() {
        this.gameState.status  = "roundEnd";
        this.gameState.message = `Round ${this.gameState.round} complete!`;
        // Deferred-exit rule: any pendingExit players settle here, with
        // their final post-payout chip count, before the next round.
        this._finalizePendingExits();
        this.broadcastState();
        if (this._nextRoundTimer) clearTimeout(this._nextRoundTimer);
        this._nextRoundTimer = setTimeout(() => this.startRound(), 3000);
    }

    // Side-bet message handlers. Per docs/system-development/sidebets-spec.md
    // these are validated by the sideBets module; this layer is the WS
    // dispatch surface only. Behaviour stubs until per-bet commits land.
    _onInitiateSideBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isBot || player.isGhostBot) return;
        if (player.pendingExit) {
            this.sendToClient(client, { type:'sideBetError', message:'You are exiting - side bets disabled.' });
            return;
        }
        if (!['revealing', 'preRound1SideBets'].includes(this.gameState.status)) {
            this.sendToClient(client, { type:'sideBetError', message:'Initiate only during reveal or pre-round-1 phase.' });
            return;
        }
        if (!SideBets.sideBetsAllowed(this.gameState)) {
            this.sendToClient(client, { type:'sideBetError', message:'Side bets disabled this round (Blitz or final round).' });
            return;
        }
        const sideBetType = data && (data.sideBetType || data.betType || data.type);
        const res = SideBets.initiate(sideBetType, this, player, data || {});
        if (!res || !res.ok) {
            this.sendToClient(client, { type:'sideBetError', message:(res && res.error) || 'Cannot initiate side bet.' });
            return;
        }
        this.broadcastState();
        this._sendSideBetOfferNotifications(client.sessionId, sideBetType, res.potId, data || {});
    }

    _sendSideBetOfferNotifications(fromSid, sideBetType, potId, data) {
        const from = this.gameState.players[fromSid];
        if (!from || !potId) return;
        const players = this.gameState.players || {};
        const bankerSid = this.gameState.bankerSessionId;
        const targetSids = [];

        if (sideBetType === 'beatHand') {
            const targetSid = String((data && (data.target || data.targetSid)) || '');
            if (targetSid) targetSids.push(targetSid);
        } else if (sideBetType === 'firstSpecial' || sideBetType === 'bestCard') {
            Object.keys(players).forEach(sid => {
                if (sid !== fromSid) targetSids.push(sid);
            });
        }

        targetSids.forEach(sid => {
            const p = players[sid];
            if (!p || p.isBot || p.isGhostBot || p.pendingExit || p.disqualified) return;
            if (sideBetType === 'beatHand' && sid === bankerSid) return;
            const cli = this.clients.find(c => c.sessionId === sid);
            if (!cli) return;
            this.sendToClient(cli, {
                type:        'sideBetOffer',
                sideBetType,
                potId,
                fromSid,
                fromName:    from.username,
                targetSid:   sid,
                value:       data && data.value,
                stake:       this.gameState.tableMinBet || 0,
                phase:       this.gameState.status
            });
        });
    }

    _onAcceptSideBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isBot || player.isGhostBot) return;
        if (player.pendingExit) return;                                    // auto-declines per spec
        if (!['revealing', 'sideBetPhase', 'preRound1SideBets'].includes(this.gameState.status)) return;
        const sideBetType = data && (data.sideBetType || data.betType || data.type);
        const res = SideBets.accept(sideBetType, this, player, data && data.potId);
        if (!res || !res.ok) {
            this.sendToClient(client, { type:'sideBetError', message:(res && res.error) || 'Cannot accept side bet.' });
            return;
        }
        this.broadcastState();
    }

    _onDeclineSideBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isBot || player.isGhostBot) return;
        if (!['revealing', 'sideBetPhase', 'preRound1SideBets'].includes(this.gameState.status)) return;
        const sideBetType = data && (data.sideBetType || data.betType || data.type);
        SideBets.decline(sideBetType, this, player, data && data.potId);
        this.broadcastState();
    }


    _actualSpecialFor(player) {
        if (!player) return null;
        if (player.rawCards && player.rawCards.length === 13 && Logic.detectSpecialFromRaw) {
            const detected = Logic.detectSpecialFromRaw(player.rawCards);
            if (detected && detected.special) return detected.special;
        }
        if (player.hand1?.length && player.hand2?.length && player.hand3?.length) {
            return Logic.detectSpecial(player.hand1, player.hand2, player.hand3);
        }
        return null;
    }

    _arrangementForActualSpecial(player) {
        if (!player || !player.rawCards || player.rawCards.length !== 13 || !Logic.detectSpecialFromRaw) return null;
        const detected = Logic.detectSpecialFromRaw(player.rawCards);
        return detected && detected.arrangement ? detected.arrangement : null;
    }

    _specialBonusFor(player) {
        const declared = player?.declaredSpecial || null;
        return declared ? Logic.getSpecialBonus(declared.name, this.gameState.tableMinBet || 0) : 0;
    }

    // Verify if a disqualification request is valid
    _verifyDisqualification(target) {
        if (!target.declaredSpecial) {
            const orderErr = Logic.validateHandOrder(target.hand1, target.hand2, target.hand3);
            if (orderErr) return `Invalid hand arrangement: ${orderErr}`;
        }

        const actualSpecial = this._actualSpecialFor(target);
        if (actualSpecial && !target.declaredSpecial) {
            return `Player has ${actualSpecial.name} but did not declare it.`;
        }

        if (target.declaredSpecial && actualSpecial && target.declaredSpecial.name !== actualSpecial.name) {
            return `Player declared ${target.declaredSpecial.name} but actually has ${actualSpecial.name}.`;
        }

        if (target.declaredSpecial && !actualSpecial) {
            return `Player declared ${target.declaredSpecial.name} but no special found in their hands.`;
        }

        return null;
    }

    resolveAllHands() {
        const bankerSid = this.gameState.bankerSessionId;
        const banker = this.gameState.players[bankerSid];
        if (!banker) {
            console.error(`[RESOLVE] FATAL: banker is missing — bankerSid=${bankerSid}`);
            return;
        }

        // Diagnostic snapshot — logs every player's relevant state so a
        // payout bug can be traced from server logs without re-running.
        // Specifically catches the "human banker exits → bot takes over →
        // remaining players not getting paid" class of bugs.
        console.log(`[RESOLVE] === round=${this.gameState.round} bankerSid=${bankerSid} ===`);
        console.log(`[RESOLVE] banker: name=${banker.username} isBanker=${banker.isBanker} isBot=${banker.isBot} isGhost=${banker.isGhostBot} dq=${banker.disqualified} hand1=${banker.hand1?.length || 0} chips=$${banker.chips}`);
        Object.entries(this.gameState.players).forEach(([sid, p]) => {
            console.log(`[RESOLVE]   player ${sid.slice(0,8)} name=${p.username} isBanker=${p.isBanker} isBot=${p.isBot} ghost=${p.isGhostBot} dq=${p.disqualified} bet=$${p.bet} chips=$${p.chips} hand1=${p.hand1?.length || 0} declared=${p.declaredSpecial?.name || '-'}`);
        });

        // If banker left mid-round (ghost bot) or was DQ'd with no hands
        // treat as banker forfeit — pay all non-DQ players 2Ã— their bet
        if (banker.isGhostBot || (banker.disqualified && !banker.hand1?.length)) {
            const bonusTier = this.gameState.tableMinBet || (this.gameState.isVip ? 10000 : 0);
            const specialAnnouncements = [];
            Object.values(this.gameState.players).forEach(p => {
                if (p.isBanker || p.disqualified || p.isGhostBot || p.bet <= 0) return;
                // Banker forfeit/DQ pays exactly 2x; house bonus remains separate.
                const declared = p.declaredSpecial || null;
                const sp       = declared;
                const bonusSp  = declared;
                const bonus    = bonusSp ? Logic.getSpecialBonus(bonusSp.name, bonusTier) : 0;
                const fromBanker = p.bet * 2;
                const prize    = fromBanker + bonus;
                p.chips      += prize;
                p.lastPayout  = prize;
                p.lastSpecial = sp
                    ? `Banker out + ${sp.name} - paid 2x bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                    : `Banker left - Won 2x bet ($${fromBanker.toLocaleString()})`;
                if (sp) specialAnnouncements.push(this._specialAnnouncement(p.username, sp, bonus, fromBanker, false));
                p.wins++;
            });
            this._broadcastSpecialAnnouncements(specialAnnouncements);
            console.log('[RESOLVE] Banker ghost/DQ - players paid 2x or special');
            return;
        }

        if (banker.disqualified || !banker.hand1?.length) return;
        const bankerHands = { hand1:banker.hand1, hand2:banker.hand2, hand3:banker.hand3 };

        // House bonus tracking.
        let roundBonusAwarded = false;
        let roundBonusAmount  = 0;
        let roundBonusWinner  = null; // 'player' or 'banker'
        let roundBonusPlayer  = null; // the player who won (if not banker)
        const specialAnnouncements = [];
        const bankerSpecialForAnnouncement = banker.declaredSpecial || null;
        let bankerSpecialNet = 0;
        let bankerBonusForAnnouncement = bankerSpecialForAnnouncement
            ? Logic.getSpecialBonus(bankerSpecialForAnnouncement.name, this.gameState.tableMinBet || 0)
            : 0;

        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (player.isBanker || player.isGhostBot) {
                console.log(`[RESOLVE] skip ${player.username}: isBanker=${player.isBanker} ghost=${player.isGhostBot}`);
                return;
            }

            // DQ'd players have already paid the fixed double-bet DQ penalty.
            // Do not add more just because the banker also has a special.
            if (player.disqualified) {
                console.log(`[RESOLVE] skip ${player.username}: disqualified`);
                return;
            }

            if (!player.hand1?.length) {
                console.log(`[RESOLVE] skip ${player.username}: no hand1 (length=${player.hand1?.length || 0})`);
                return;
            }

            // CRITICAL SAFETY: if this player's sid somehow equals the
            // banker's sid (state corruption), refuse to apply payouts —
            // doing so would credit + debit the same object and look
            // like "the payout vanished".
            if (sid === bankerSid) {
                console.error(`[RESOLVE] FATAL: player sid === banker sid (${sid}); skipping to avoid net-zero credit/debit on same object`);
                return;
            }

            const result = Logic.resolveRound(
                { hand1:player.hand1, hand2:player.hand2, hand3:player.hand3 },
                bankerHands,
                player.bet,
                player.declaredSpecial || null,
                banker.declaredSpecial || null,
                this.gameState.tableMinBet || 0
            );

            const chipsBefore = player.chips;
            const bankerChipsBefore = banker.chips;
            // payout is pure bet exchange only — bonuses are awarded INDEPENDENTLY:
            //   • player's own bonus (if they declared a special) is credited now,
            //     regardless of who won the round. Even if the banker has a bigger
            //     special and wins the bet exchange, the player still gets their
            //     declared-special bonus from the house.
            //   • banker's bankerBonus is accumulated and paid ONCE after the loop.
            player.chips      += result.payout;
            player.lastPayout  = result.payout;
            console.log(`[RESOLVE-PAY] ${player.username}: bet=$${player.bet} payout=$${result.payout} chips $${chipsBefore} -> $${player.chips}; banker chips $${bankerChipsBefore} -> $${bankerChipsBefore - result.payout}`);
            // Player house bonus is only paid for a declared special.
            const playerBonusSpecial = player.declaredSpecial || null;
            const playerBonusOwn = playerBonusSpecial
                ? Logic.getSpecialBonus(playerBonusSpecial.name, this.gameState.tableMinBet || 0)
                : 0;
            player.lastBonus   = playerBonusOwn;
            player.handResults = result.handResults || null;
            banker.chips      -= result.payout; // banker receives/pays pure bet exchange
            if (bankerSpecialForAnnouncement) bankerSpecialNet += -(Number(result.payout) || 0);

            // Per-player bonus: house pays the player their own special bonus
            // even when the banker wins with a bigger special.
            if (playerBonusOwn > 0) {
                player.chips     += playerBonusOwn;
                player.lastPayout = (player.lastPayout || 0) + playerBonusOwn;
            }
            if (playerBonusSpecial) {
                specialAnnouncements.push(this._specialAnnouncement(
                    player.username,
                    playerBonusSpecial,
                    playerBonusOwn,
                    result.payout || 0,
                    false
                ));
            }

            // Track banker bonus once per round (banker plays one hand, multiple players see it).
            const bankerBonusOwn = banker.declaredSpecial ? Logic.getSpecialBonus(banker.declaredSpecial.name, this.gameState.tableMinBet || 0) : 0;
            if (bankerBonusOwn > 0 && !roundBonusAwarded) {
                roundBonusAwarded = true;
                roundBonusAmount  = bankerBonusOwn;
                roundBonusWinner  = 'banker';
                bankerBonusForAnnouncement = bankerBonusOwn;
            }
            if (result.payout > 0) player.wins++;

            const rb = result.bonus || 0;
            if (result.playerSpecial) {
                const bonusStr = playerBonusOwn > 0 ? ` +$${playerBonusOwn.toLocaleString()} house bonus` : '';
                player.lastSpecial = `Special: ${result.playerSpecial.name} (${result.playerSpecial.multiplier}x)${bonusStr}`;
            } else if (result.bankerSpecial) {
                const bonusStr = rb > 0 ? ` +$${rb.toLocaleString()} house bonus` : '';
                player.lastSpecial = `ðŸ¦ Banker: ${result.bankerSpecial.name}${bonusStr}`;
            } else {
                player.lastSpecial = result.playerWins >= 2
                    ? `âœ… Won ${result.playerWins}/3 hands`
                    : `âŒ Lost ${result.playerWins}/3 hands`;
            }

            const outcome = result.payout >= 0 ? "WIN" : "LOSS";
            const why = result.playerSpecial ? `${result.playerSpecial.name}${rb>0?' +$'+rb+' house bonus':''}`
                      : result.bankerSpecial  ? `Banker: ${result.bankerSpecial.name}${rb>0?' +$'+rb+' house bonus':''}`
                      : `${result.playerWins}/3 hands`;
            console.log(`${player.username} | Bet:$${player.bet} | ${outcome} $${Math.abs(result.payout)}${rb>0?' (house bonus $'+rb+')':''} | ${why}`);
        });

        // â”€â”€ Award banker's house bonus ONCE (player bonuses already credited per-loop) â”€â”€
        if (roundBonusAwarded && roundBonusAmount > 0 && roundBonusWinner === 'banker') {
            banker.chips += roundBonusAmount;
            console.log(`[BONUS] House pays banker $${roundBonusAmount.toLocaleString()} bonus`);
        }

        if (bankerSpecialForAnnouncement) {
            specialAnnouncements.push(this._specialAnnouncement(
                banker.username,
                bankerSpecialForAnnouncement,
                bankerBonusForAnnouncement,
                bankerSpecialNet,
                true
            ));
        }
        this._broadcastSpecialAnnouncements(specialAnnouncements);

        // Store banker's special display
        const bs = banker.declaredSpecial || null;
        banker.lastSpecial = bs ? `â­ ${bs.name} (${bs.multiplier}x)` : null;

        // Wallet debt: if a player's chips hit 0 or go negative after a round —
        // 1. Player is DISQUALIFIED — a ghost bot takes their seat (no bets, no payouts)
        // 2. Outstanding debt is pulled from their bank (bank can go negative)
        // 3. Player cannot play again until bank is cleared
        const debtPromises = [];
        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (player.isBanker || player.disqualified || player.chips > 0) return;
            const debt = Math.abs(player.chips); // could be 0 (exactly bust) or positive (negative chips)
            const totalOwed = debt; // chips went to 0 or below — full shortfall owed

            console.log(`${player.username} bust: chips=$${player.chips} — disqualifying, pulling $${totalOwed} from bank`);

            // Disqualify and convert to ghost bot — no bets, no payouts for remaining rounds
            player.chips           = 0;
            player.disqualified    = true;
            player.debtDqd         = true; // permanent flag — survives round resets
            player.disqualifyReason = `Wallet reached $0 — disqualified. Bank charged $${totalOwed.toLocaleString()}.`;
            player.lastSpecial      = `âŒ Bust — $${totalOwed.toLocaleString()} from bank`;
            player.isGhostBot       = true; // ghost: plays hands but bets $0, receives no payout

            this.broadcast({ type:'walletDebt', username:player.username, debt: totalOwed,
                reason:`${player.username} went bust — disqualified. $${totalOwed.toLocaleString()} pulled from bank.` });
            this.broadcast({ type:'playerDisqualified', username:player.username,
                reason:`Wallet reached $0 — disqualified for remaining rounds.` });

            if (player.token && totalOwed > 0) {
                debtPromises.push(
                    callPlatformAPI('/api/game/debt-payment', player.token, {
                        amount:      totalOwed,
                        tableMinBet: this.gameState.tableMinBet,
                        reason:      'wallet_bust'
                    }).then(r => {
                        console.log(`[DEBT] ${player.username}: -$${totalOwed} from bank —`, r.ok ? `bank now: $${r.newBankBalance}` : r.error);
                        if (r.ok) player.bankBalance = r.newBankBalance;
                    })
                );
            }
        });
        if (debtPromises.length) Promise.all(debtPromises).catch(e => console.error("[DEBT] error:", e));
    }

    async _onReplenishWallet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || !player.token) {
            this.sendToClient(client, { type:'replenishResult', ok:false, error:'Not authorised' });
            return;
        }
        const { amount } = data;
        if (!amount || amount <= 0) {
            this.sendToClient(client, { type:'replenishResult', ok:false, error:'Invalid amount' });
            return;
        }
        try {
            const res = await callPlatformAPI('/api/game/replenish', player.token, {
                amount,
                currentWallet: player.chips,
                tableMinBet:   this.gameState.tableMinBet
            });
            if (res.ok) {
                player.chips += amount;
                this.sendToClient(client, { type:'replenishResult', ok:true, newWallet:player.chips, newBankBalance:res.newBankBalance });
                this.broadcastState();
                console.log(`[REPLENISH] ${player.username} +$${amount} â†’ wallet $${player.chips}`);
            } else {
                this.sendToClient(client, { type:'replenishResult', ok:false, error: res.error || 'Replenish failed' });
            }
        } catch(e) {
            this.sendToClient(client, { type:'replenishResult', ok:false, error:'Server error' });
        }
    }

    endGame() {
        this._clearAllPhaseTimers();
        if (this._nextRoundTimer) { clearTimeout(this._nextRoundTimer); this._nextRoundTimer = null; }
        this.gameState.status    = "gameOver";
        this.gameState.completed = true;   // exclude from quick-join match candidates
        this.gameState.message   = "Game Over! Final scores:";
        // Refund any unwon side-bet pots equally to participants BEFORE the
        // wallet→bank settlement, so refunds land in player.chips and are
        // included in _settleToBank's per-player return amount.
        try { SideBets.refundUnwonAtGameEnd(this); }
        catch(e) { console.error('[SIDEBETS] refundUnwonAtGameEnd threw:', e); }
        console.log("=== GAME OVER ===  room flagged completed");
        this.broadcastState();
        // Settle: return each player's remaining chips to their bank
        this._settleToBank();
        // Auto-evict any remaining clients after stats display window so
        // the room can be cleaned up. 30s is enough to read stats; the
        // client navigates away on its own when the user hits 'Return to
        // Dashboard'. Anyone lingering longer must NOT keep the room alive
        // — the completed flag + onJoin guard ensure no new player can be
        // matched into this room from the moment endGame fires.
        if (this._evictTimer) clearTimeout(this._evictTimer);
        this._evictTimer = setTimeout(() => {
            console.log("[ROOM] Game-over auto-evict — closing remaining clients");
            for (const c of [...this.clients]) {
                try { c.send && c.send(JSON.stringify({ type:'roomClosed', reason:'game_complete' })); } catch(e){}
            }
        }, 30000);
    }

    async _settleToBank() {
        if (this._settled) return; // prevent double-settlement
        this._settled = true;
        const players = Object.values(this.gameState.players);
        const realPlayers = players.filter(p => !p.isBot && !p.isGhostBot);

        console.log(`[SETTLE] ========== SETTLING GAME ==========`);
        console.log(`[SETTLE] Real players: ${realPlayers.length}`);
        realPlayers.forEach(p => {
            console.log(`[SETTLE]   ${p.username}: chips=$${p.chips} token=${p.token ? "YES ("+p.token.substring(0,12)+"...)" : "MISSING - will not settle!"}`);
        });

        for (const player of realPlayers) {
            if (!player.token) {
                console.error(`[SETTLE] ${player.username} has NO TOKEN - chips cannot be returned to bank.`);
                this.clients
                    .filter(c => c.sessionId === Object.keys(this.gameState.players).find(sid => this.gameState.players[sid] === player))
                    .forEach(c => this.sendToClient(c, {
                        type:    'settleFailed',
                        reason:  'no_token',
                        chips:   player.chips,
                        tableMinBet: this.gameState.tableMinBet
                    }));
                continue;
            }

            const finalChips = Number(player.chips) || 0;
            const debt = Math.max(0, -finalChips);
            const returning = Math.max(0, finalChips);

            try {
                if (debt > 0) {
                    const debtRes = await callPlatformAPI('/api/game/debt-payment', player.token, {
                        amount: debt,
                        tableMinBet: this.gameState.tableMinBet,
                        reason: 'game_end_wallet_shortfall'
                    });
                    console.log(`[SETTLE] ${player.username}: debt $${debt} pulled from bank -`, debtRes.ok ? `bank now: $${debtRes.newBankBalance}` : debtRes.error);
                }

                const res = await callPlatformAPI('/api/game/exit', player.token, {
                    remainingWallet: returning,
                    tableMinBet:     this.gameState.tableMinBet,
                    reason:          'game_complete'
                });
                if (res.ok) {
                    console.log(`[SETTLE] ${player.username}: returned $${returning} -> new bank: $${res.newBankBalance}`);
                    const startChips  = this.gameState.tableWalletSize || this.gameState.tableMinBet * 6;
                    const isWin       = finalChips > startChips;
                    const rounds      = this.gameState.maxRounds || 10;
                    const isBlitz     = this.gameState.blitz === true;
                    const mode        = isBlitz ? 'blitz' : String(rounds);
                    try {
                        await callPlatformAPI('/api/game/record-result', player.token, {
                            isWin, mode, rounds,
                            tableMinBet: this.gameState.tableMinBet,
                            finalChips,  startChips
                        });
                        console.log(`[SETTLE] ${player.username}: recorded ${isWin?'WIN':'LOSS'} mode=${mode}`);
                    } catch(e) {
                        console.warn(`[SETTLE] Stats recording failed for ${player.username}:`, e.message);
                    }
                    const sid = Object.keys(this.gameState.players).find(s => this.gameState.players[s] === player);
                    const c   = this.clients.find(c => c.sessionId === sid);
                    if (c) this.sendToClient(c, { type:'settleComplete', newBankBalance: res.newBankBalance, returned: returning });
                } else {
                    console.error(`[SETTLE] ${player.username}: exit API failed - ${res.error}`);
                }
            } catch(e) {
                console.error(`[SETTLE] ${player.username} error:`, e.message);
            }
        }
        console.log(`[SETTLE] ====================================`);
    }

    // ==================== HELPERS ====================

    checkAllArranged() {
        if (this.gameState.status !== 'arranging') return;
        const active = Object.values(this.gameState.players).filter(p => !p.disqualified);
        if (active.length > 0 && active.every(p => p.hasArranged)) {
            this.startRevealPhase();
        }
    }

    _onDeclareSpecial(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player) return;
        if (this.gameState.status !== 'arranging') {
            this.sendToClient(client, { type:'error', message:'Can only declare a special during the arranging phase.' });
            return;
        }
        if (player.hasArranged || player.declaredSpecial) {
            this.sendToClient(client, { type:'error', message:'You have already submitted your hand.' });
            return;
        }
        if (player.disqualified) return;

        const { specialName } = data;
        const allSpecials = Logic.SPECIAL_DEFS || [
            { name:'Full Suit',                  multiplier:10, rank:8 },
            { name:'6Ã‚Â½',                         multiplier:8,  rank:7 },
            { name:'Royal Flush',                multiplier:7,  rank:6 },
            { name:'Flush-Flush-Flush',          multiplier:5,  rank:5 },
            { name:'Straight-Straight-Straight', multiplier:5,  rank:4 },
            { name:'Four of a Kind',             multiplier:3,  rank:2 },
            { name:'Straight Flush',             multiplier:3,  rank:3 },
            { name:'No Face',                    multiplier:2,  rank:1 },
        ];
        const chosen = allSpecials.find(s => s.name === specialName);
        if (!chosen) {
            this.sendToClient(client, { type:'error', message:`Unknown special: ${specialName}` });
            return;
        }

        const raw = player.rawCards || [];
        if (raw.length !== 13) {
            this.sendToClient(client, { type:'error', message:'No cards dealt yet.' });
            return;
        }

        // Accept any declared special the player CAN form, regardless of
        // whether they happen to also have a higher one. Player gets the
        // declared special's multiplier (their choice — they can declare
        // the highest if they want maximum payout).
        const declaredArrangement = Logic.canFormSpecial
            ? Logic.canFormSpecial(raw, specialName)
            : null;

        if (!declaredArrangement) {
            const detected = Logic.detectSpecialFromRaw ? Logic.detectSpecialFromRaw(raw) : null;
            const actual = detected ? detected.special : null;
            const fallback = (detected && detected.arrangement)
                ? detected.arrangement
                : { hand1: raw.slice(0,3), hand2: raw.slice(3,8), hand3: raw.slice(8,13) };
            player.disqualified     = true;
            player.disqualifyReason = `Declared ${specialName} but you cannot form it from your cards.`;
            player.lastSpecial      = 'Wrong special - DQ';
            player.hand1 = fallback.hand1;
            player.hand2 = fallback.hand2;
            player.hand3 = fallback.hand3;
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            const dqPenalty = player.isBanker
                ? this._applyBankerDqPayments(player, player.disqualifyReason)
                : this._applyDqPayment(player, banker, player.disqualifyReason);
            player.lastSpecial = `Wrong special - DQ - paid double ($${dqPenalty.toLocaleString()})`;
            console.log(`${player.username} DQ - declared ${specialName}, cannot be formed (highest available: ${actual?.name || 'none'})`);
            this.sendToClient(client, {
                type:'specialDenied',
                declared:specialName,
                actual:actual ? actual.name : null,
                actualMultiplier:actual ? actual.multiplier : null,
                message: player.disqualifyReason
            });
            this.broadcast({ type:'playerDisqualified', username:player.username, reason:player.disqualifyReason });
        } else {
            player.declaredSpecial = { ...chosen };
            player.hand1 = declaredArrangement.hand1;
            player.hand2 = declaredArrangement.hand2;
            player.hand3 = declaredArrangement.hand3;
            player.hasArranged = true;
            console.log(`${player.username} declares special: ${specialName} (${chosen.multiplier}x) — accepted`);
            this.sendToClient(client, { type:'specialConfirmed', specialName, multiplier: chosen.multiplier });
            // Side-bet hook: if a First Special pot is active and this
            // player is a participant, record their (correct) declaration
            // so reveal-end can pick the highest-rank winner across all
            // declarers this round.
            try { SideBets.recordFirstSpecialDeclaration(this, player, chosen); }
            catch(e) { console.error('[SIDEBETS] recordFirstSpecialDeclaration threw:', e); }
            // Result announcement is broadcast after payout resolution so it can include bonus and payment.
        }
        this.broadcastState();
        // Either branch sets hasArranged=true (DQ also marks). Trigger
        // the all-arranged check so reveal fires immediately when the
        // declarer was the last outstanding human.
        this.checkAllArranged();
    }

    _onDisqualifyPlayer(client, data) {
        const requester = this.gameState.players[client.sessionId];
        if (!requester) return;

        // Only allowed during revealing phase
        if (this.gameState.status !== "revealing") {
            this.sendToClient(client, { type:"disqualifyDenied", message:"Can only disqualify during the reveal phase." });
            return;
        }

        const { targetSessionId } = data;
        const target = this.gameState.players[targetSessionId];
        if (!target) {
            this.sendToClient(client, { type:"disqualifyDenied", message:"Player not found." });
            return;
        }
        if (target.disqualified) {
            this.sendToClient(client, { type:"disqualifyDenied", message:`${target.username} is already disqualified.` });
            return;
        }

        const violation = this._verifyDisqualification(target);
        if (!violation) {
            this.sendToClient(client, { type:"disqualifyDenied", message:`No violation found for ${target.username}.` });
            return;
        }

        // Valid disqualification — penalise the target
        const isBanker = target.isBanker;
        if (isBanker) {
            // Banker DQ: all players get exactly double their bet. House bonus stays separate.
            target.disqualified     = true;
            target.disqualifyReason = violation;
            target.lastSpecial      = "DQ";
            const specialAnnouncements = [];
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified && p.bet > 0) {
                    const declared = p.declaredSpecial || null;
                    const sp       = declared;
                    const bonusSp  = declared;
                    const bonus    = bonusSp ? Logic.getSpecialBonus(bonusSp.name, this.gameState.tableMinBet || 0) : 0;
                    const fromBanker = p.bet * 2;
                    const refund   = fromBanker + bonus;
                    p.chips      += refund;
                    p.lastPayout  = refund;
                    target.chips -= fromBanker;
                    if (sp) specialAnnouncements.push(this._specialAnnouncement(p.username, sp, bonus, fromBanker, false));
                }
            });
            this._broadcastSpecialAnnouncements(specialAnnouncements);
            console.log(`BANKER ${target.username} DISQUALIFIED by ${requester.username}: ${violation}`);
        } else {
            // Player DQ: target pays double their bet to banker.
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            target.disqualified     = true;
            target.disqualifyReason = violation;
            const dqPenalty = this._applyDqPayment(target, banker, violation);
            target.lastSpecial      = `DQ - paid double ($${dqPenalty.toLocaleString()})`;
            console.log(`${target.username} DISQUALIFIED by ${requester.username}: ${violation} - paid $${dqPenalty}`);
        }

        this.broadcast({ type:"playerDisqualified", username:target.username, reason:violation });
        this.broadcastState();
    }

    botArrange(p) {
        try {
            const best = Logic.findBestBotArrangement(p.rawCards);
            if (!best || !best.hand1 || !best.hand2 || !best.hand3) {
                throw new Error('findBestBotArrangement returned ' + JSON.stringify(best));
            }
            p.hand1 = best.hand1;
            p.hand2 = best.hand2;
            p.hand3 = best.hand3;
            p.hasArranged = true;
            const special = Logic.detectSpecial(p.hand1, p.hand2, p.hand3);
            if (special) {
                p.declaredSpecial = special;
                console.log(`${p.username} auto-declares special: ${special.name}`);
            }
        } catch(e) {
            console.error(`[BOT-ARRANGE] ${p.username} failed:`, e.message);
            // Fallback: split the dealt cards 3/5/5 in dealt order so the
            // bot is at least 'arranged' and the round can advance. The
            // arrangement may be invalid; if so the bot will be DQ'd at
            // reveal but the timer won't stall.
            const r = p.rawCards || [];
            p.hand1 = r.slice(0, 3);
            p.hand2 = r.slice(3, 8);
            p.hand3 = r.slice(8, 13);
            p.hasArranged = true;
        }
    }

    _applyTableConfigFromRoomId() {
        // If table config already set, skip
        if (this.gameState.tableMinBet > 0) return;

        const TABLE_CONFIG = SIPSAM_TABLES; // single source — shared/sipsam-tables.js

        // Parse minBet from roomId (format: sipsam_100_timestamp)
        let minBet = 100; // default
        if (this._roomId) {
            const parts = this._roomId.split('_');
            const parsed = parseInt(parts[1]);
            if (TABLE_CONFIG[parsed]) minBet = parsed;
        }

        const cfg = TABLE_CONFIG[minBet];
        this.gameState.tableKey        = cfg.tableKey || minBet;
        this.gameState.tableMinBet     = cfg.minBet;
        this.gameState.tableMaxBet     = cfg.maxBet;
        this.gameState.tableIncrement  = cfg.increment;
        this.gameState.tableWalletSize = cfg.walletSize;
        this.gameState.isVip           = cfg.minBet >= 10000;
        console.log(`[ROOM] Table config applied from roomId: $${cfg.minBet} min / $${cfg.increment} inc${this.gameState.isVip ? ' (VIP)' : ''}`);
    }

    _expireRoomInvites() {
        if (!this._roomId) return;
        // Call platform API to revoke all pending invites for this room
        const http = require('http');
        const body = JSON.stringify({ roomId: this._roomId });
        const req  = http.request({
            hostname: 'localhost',
            port:     3000,
            path:     '/api/game/invites/revoke-room',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, () => {});
        req.on('error', () => {}); // non-critical
        req.write(body);
        req.end();
        console.log('[INVITES] Revoke request sent for room:', this._roomId);
    }

    _botAvatar(n) {
        const BOT_AVATARS = ['🤖','👾','🎮','🃏','🦾','🧠','💻','🎲','👁️','⚡'];
        return BOT_AVATARS[n % BOT_AVATARS.length];
    }

    fillBotsIfNeeded() {
        // Only fill bots before game starts — never during active rounds
        // (removing bots mid-game would wipe their handResults/chips/lastSpecial)
        if (this.gameState.status !== 'waiting') return;

        // Count real players (non-bot, non-ghost)
        const realCount = Object.values(this.gameState.players)
            .filter(p => !p.isBot && !p.isGhostBot).length;
        const needed = Math.max(0, 4 - realCount);

        // Remove any existing bots first — we'll re-add the exact right number
        Object.keys(this.gameState.players).forEach(sid => {
            if (this.gameState.players[sid].isBot && !this.gameState.players[sid].isBanker) {
                delete this.gameState.players[sid];
            }
        });

        // Add exactly the right number of bots
        for (let i=0; i<needed; i++) {
            const botId = "bot_"+i+"_"+Date.now();
            this.gameState.players[botId] = {
                username:"Bot_X", avatar: this._botAvatar(i), token:null,
                chips: this.gameState.tableWalletSize || 3000, bet:0,
                isBanker:false, isBot:true,
                hand1:[], hand2:[], hand3:[], rawCards:[],
                hasArranged:false, disqualified:false,
                lastPayout:0, lastSpecial:null, wins:0
            };
        }
        // Shuffle the seat order so the human player gets a random position
        const entries = Object.entries(this.gameState.players);
        for (let i = entries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [entries[i], entries[j]] = [entries[j], entries[i]];
        }
        // Name bots AFTER shuffle so Bot_1/Bot_2/Bot_3 match their visual seat order
        let botNum = 1;
        entries.forEach(([, p]) => {
            if (p.isBot && !p.isBanker) p.username = 'Bot_' + (botNum++);
        });
        this.gameState.players = Object.fromEntries(entries);
    }

    _phaseTimerKey(phase) {
        return phase === 'arranging'        ? 'arrangeTimer'
             : phase === 'betting'          ? 'betTimer'
             : phase === 'revealing'        ? 'revealTimer'
             : phase === 'sideBetPhase'     ? 'sideBetTimer'
             : phase === 'preRound1SideBets'? 'sideBetTimer'   // reuse
             : null;
    }

    _phaseWatchdogKey(phase) {
        return phase === 'arranging'        ? 'arrangeWatchdog'
             : phase === 'betting'          ? 'betWatchdog'
             : phase === 'revealing'        ? 'revealWatchdog'
             : phase === 'sideBetPhase'     ? 'sideBetWatchdog'
             : phase === 'preRound1SideBets'? 'sideBetWatchdog' // reuse
             : null;
    }

    _clearPhaseTimer(phase) {
        const timerKey = this._phaseTimerKey(phase);
        const watchdogKey = this._phaseWatchdogKey(phase);
        if (!this._phaseTokens) this._phaseTokens = {};
        this._phaseTokens[phase] = (this._phaseTokens[phase] || 0) + 1;

        if (timerKey && this[timerKey]) {
            clearInterval(this[timerKey]);
            this[timerKey] = null;
        }
        if (watchdogKey && this[watchdogKey]) {
            clearTimeout(this[watchdogKey]);
            this[watchdogKey] = null;
        }
    }

    _clearAllPhaseTimers() {
        ['betting', 'arranging', 'revealing', 'sideBetPhase', 'preRound1SideBets'].forEach(phase => this._clearPhaseTimer(phase));
    }

    startCountdown(seconds, phase, onComplete) {
        this._clearPhaseTimer(phase);
        if (!this._phaseTokens) this._phaseTokens = {};
        const token = (this._phaseTokens[phase] || 0) + 1;
        this._phaseTokens[phase] = token;
        const roundStarted = this.gameState.round;
        let remaining = seconds;
        let completed = false;

        const timerKey = this._phaseTimerKey(phase);
        const watchdogKey = this._phaseWatchdogKey(phase);

        const isCurrent = () =>
            !completed &&
            this._phaseTokens &&
            this._phaseTokens[phase] === token &&
            this.gameState.status === phase &&
            this.gameState.round === roundStarted;

        const complete = (source) => {
            if (!isCurrent()) return;
            completed = true;
            this._clearPhaseTimer(phase);
            try { onComplete(); }
            catch(e) { console.error(`[TIMER] ${phase} ${source} onComplete threw:`, e); }
        };

        const interval = setInterval(() => {
            try {
                if (!isCurrent()) {
                    clearInterval(interval);
                    if (timerKey && this[timerKey] === interval) this[timerKey] = null;
                    return;
                }
                remaining--;
                this.gameState.timer = Math.max(0, remaining);
                this.broadcastState();
                if (remaining <= 0) complete('countdown');
            } catch(e) {
                console.error(`[TIMER] ${phase} tick threw - clearing interval to prevent stall:`, e);
                complete('error');
            }
        }, 1000);

        if (timerKey) this[timerKey] = interval;

        const watchdog = setTimeout(() => {
            if (!isCurrent()) return;
            console.warn(`[TIMER] ${phase} stall detected after ${seconds + 5}s - forcing advance. ` +
                `round=${roundStarted} players: ${Object.entries(this.gameState.players).map(([s,p]) => `${p.username}(arr=${p.hasArranged} dq=${p.disqualified})`).join(', ')}`);
            complete('watchdog');
        }, Math.max(1, seconds + 5) * 1000);

        if (watchdogKey) this[watchdogKey] = watchdog;
    }

    getPublicState(forSessionId) {
        const state = JSON.parse(JSON.stringify(this.gameState));
        const isRevealPhase = ['revealing','roundEnd','gameOver'].includes(state.status);
        Object.entries(state.players).forEach(([sid, player]) => {
            // Always expose whether this player has been dealt cards (for table display)
            player.hasCards = player.rawCards && player.rawCards.length > 0;
            if (sid !== forSessionId) {
                player.rawCards=[];
                // Hide hands during betting/arranging — show ALL during reveal
                if (!isRevealPhase) {
                    player.hand1=[]; player.hand2=[]; player.hand3=[];
                }
                // During reveal: banker hands always visible to everyone
                // Player hands also visible (face-up cards + WIN/LOSE badges)
            }
        });
        return state;
    }

    broadcastState() {
        this.clients.forEach(c => this.sendToClient(c, {
            type:"stateUpdate", state:this.getPublicState(c.sessionId)
        }));
    }

    broadcastAll(msg)  { this.clients.forEach(c => this.sendToClient(c, msg)); }
    // â”€â”€ CHAT BROADCAST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _onChatMessage(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isGhostBot) return;
        const message = String(data.message || '').trim().slice(0, 120);
        if (!message) return;

        // Broadcast sessionId + isBanker flag — client resolves position from its own seatMap
        console.log(`[CHAT] ${player.username}: ${message}`);
        this.broadcast({
            type:      'chatMessage',
            sessionId: client.sessionId,
            username:  player.username,
            message,
            isBanker:  !!player.isBanker
        });
    }

    // â”€â”€ REQUEST CHIPS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _onRequestChips(client, data) {
        const requester = this.gameState.players[client.sessionId];
        if (!requester || requester.isGhostBot || requester.isBot) return;
        if (this.gameState.status === 'waiting') return; // no transfers in lobby

        const targetSid = data.targetSid;
        const target = this.gameState.players[targetSid];
        if (!target) {
            this.sendToClient(client, { type:'error', message:'Player not found.' });
            return;
        }
        if (target.isGhostBot || target.disqualified) {
            this.sendToClient(client, { type:'error', message:'Cannot request chips from a disqualified player.' });
            return;
        }
        const amount = this.gameState.tableMaxBet; // always table max bet

        console.log(`[REQUEST] ${requester.username} requests $${amount} from ${target.username}`);
        // Notify the target player
        this.broadcast({
            type:            'chipRequest',
            sessionId:       client.sessionId,
            username:        requester.username,
            targetSessionId: targetSid,
            amount
        });
        this.sendToClient(client, { type:'chipRequestSent', toUsername: target.username, amount });
    }

    // â”€â”€ SEND CHIPS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _onSendChips(client, data) {
        const sender = this.gameState.players[client.sessionId];
        if (!sender || sender.isGhostBot || sender.isBot) return;
        if (this.gameState.status === 'waiting') return;

        const targetSid = data.targetSid;
        const target = this.gameState.players[targetSid];
        if (!target) {
            this.sendToClient(client, { type:'error', message:'Player not found.' });
            return;
        }
        if (target.isGhostBot || target.disqualified) {
            this.sendToClient(client, { type:'error', message:'Cannot send chips to a disqualified player.' });
            return;
        }
        // Use client-specified amount, capped at tableMaxBet
        const maxBet = this.gameState.tableMaxBet;
        const amount = Math.min(data.amount || maxBet, maxBet);
        if (!amount || amount <= 0) {
            this.sendToClient(client, { type:'error', message:'Invalid amount.' });
            return;
        }
        if (sender.chips < amount) {
            this.sendToClient(client, { type:'error', message:`Insufficient wallet. You have $${sender.chips.toLocaleString()}, need $${amount.toLocaleString()}.` });
            return;
        }

        // Deduct from WALLET (not bank)
        sender.chips -= amount;
        target.chips += amount;

        console.log(`[SEND] ${sender.username} â†’ ${target.username}: $${amount}`);
        this.broadcast({
            type:            'chipSent',
            sessionId:       client.sessionId,
            username:        sender.username,
            targetSessionId: targetSid,
            amount
        });
        this.broadcastState();
    }

        broadcast(msg)     { this.clients.forEach(c => this.sendToClient(c, msg)); }

    sendToClient(client, msg) {
        try { client.send(JSON.stringify(msg)); }
        catch(e) { console.error("sendToClient error:", e.message); }
    }
}

exports.SipSamRoom = SipSamRoom;
