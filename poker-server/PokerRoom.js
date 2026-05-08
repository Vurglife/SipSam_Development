// ============================================
// SIPSAM GAME ROOM v6.0
// Pure JS — no Colyseus dependency
// Works with plain WebSocket server in index.js
// ============================================

const Logic = require("./logic.js");
const http  = require("http");

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
                "Authorization":  "Bearer " + token
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
        this._lobbyTimer  = null;

        this.gameState = {
            status:          "waiting",
            round:           0,
            maxRounds:       10,
            blitz:           false,
            pot:             0,
            timer:           0,
            tableMinBet:     0,
            tableMaxBet:     0,
            tableIncrement:  0,
            tableWalletSize: 0,
            bankerSessionId: "",
            players:         {},
            message:         "",
            lobbyCountdown:  0,
            isPrivate:       false
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
            default: console.log("Unknown message:", type);
        }
    }

    _onStartGame(client, data) {
        console.log("startGame:", JSON.stringify(data));
        if (this.gameState.status !== "waiting") return;
        // Cancel lobby countdown — game is starting manually
        if (this._lobbyTimer) { clearInterval(this._lobbyTimer); this._lobbyTimer = null; }
        this.gameState.lobbyCountdown = 0;
        // Fill bots for any empty seats now that game is starting
        this.fillBotsIfNeeded();

        const TABLE_CONFIG = {
            100:    { minBet:100,    increment:50,     maxBet:150,    walletSize:3000,    minBank:5000    },
            250:    { minBet:250,    increment:50,     maxBet:500,    walletSize:10000,   minBank:15000   },
            500:    { minBet:500,    increment:100,    maxBet:1000,   walletSize:20000,   minBank:30000   },
            1000:   { minBet:1000,   increment:500,    maxBet:2000,   walletSize:40000,   minBank:60000   },
            10000:  { minBet:10000,  increment:10000,  maxBet:50000,  walletSize:1000000, minBank:2000000 },
            100000: { minBet:100000, increment:100000, maxBet:500000, walletSize:3000000, minBank:5000000 }
        };

        const roundCount = [5,10,20,30].includes(data.rounds) ? data.rounds : 10;
        const cfg        = TABLE_CONFIG[data.tableMinBet] || TABLE_CONFIG[100];

        // VIP flag for enhanced bonuses (used by logic.getSpecialBonus).
        // Both VIP ($10K) and Elite ($100K) tables get the bumped bonus.
        this.gameState.isVip = cfg.minBet >= 10000;

        this.gameState.maxRounds       = roundCount;
        this.gameState.blitz           = data.blitz === true || roundCount === 5;
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
        const tMax  = this.gameState.tableMaxBet || (tMin * 2);
        let amount  = parseInt(data.amount) || tMin;
        // Cap bet to table max AND what player can afford
        amount = Math.max(tMin, Math.min(amount, tMax, player.chips));
        amount = Math.round(amount / tMin) * tMin; // round to nearest minBet increment
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
            // Deduct bet — player loses their bet to the banker
            const banker = Object.values(this.gameState.players).find(p => p.isBanker);
            if (player.bet > 0) {
                player.chips -= player.bet;
                player.lastPayout = -player.bet;
                if (banker) banker.chips += player.bet;
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

        // â”€â”€ WAITING PHASE: just remove the player entirely â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Room is still open — real players can still join to fill the seat
        if (this.gameState.status === 'waiting') {
            delete this.gameState.players[client.sessionId];
            console.log(player.username, 'left lobby — seat freed.');
            // Cancel lobby timer if no real players left
            const remaining = Object.values(this.gameState.players)
                .filter(p => !p.isBot && !p.isGhostBot);
            if (remaining.length === 0) {
                if (this._lobbyTimer) { clearInterval(this._lobbyTimer); this._lobbyTimer = null; }
                this.gameState.lobbyCountdown = 0;
            }
            this.broadcastState();
            return;
        }

        // â”€â”€ ACTIVE GAME: check if any real players remain â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const otherRealPlayers = Object.entries(this.gameState.players)
            .filter(([sid, p]) => sid !== client.sessionId && !p.isBot && !p.isGhostBot);

        if (otherRealPlayers.length === 0) {
            // No other real players — reset room completely
            console.log('[ROOM] Last real player left — resetting room.');
            this._resetRoom();
            return;
        }

        // Other real players still in game
        // Current round: convert to ghost so this round resolves cleanly
        // Next round onwards: the ghost becomes a real bot with fresh chips
        //
        // WALLET-ON-DISCONNECT: refund the wallet to the bank BEFORE we
        // null out the token. Without this, players who lose connection
        // (internet drop, browser crash, force-close) lose their wallet.
        // For a human BANKER, settle outstanding bet exchanges first —
        // pulling chips from the bank if necessary so all owed payments
        // process before the wallet is returned.
        const _disconnectedToken = player.token;
        const _disconnectedTier  = this.gameState.tableMinBet;
        const _disconnectedChips = Math.max(0, player.chips || 0);
        // Snapshot for use after we mutate the player object
        const _disconnectedIsBanker = !!player.isBanker;
        if (_disconnectedToken && !player.isBot) {
            // Settle banker debt FIRST, then refund wallet — ordered so a
            // debt-call failure surfaces in logs before the wallet refund.
            // Bank may go negative; player must replenish via ads/purchase.
            const debt        = (player.chips < 0) ? Math.abs(player.chips) : 0;
            const _username   = player.username;
            (async () => {
                if (_disconnectedIsBanker && debt > 0) {
                    try {
                        const r = await callPlatformAPI('/api/game/debt-payment', _disconnectedToken, {
                            amount:      debt,
                            tableMinBet: _disconnectedTier,
                            reason:      'banker_disconnect_owed'
                        });
                        console.log(`[DISCONNECT-REFUND] Banker debt $${debt} pulled from bank:`, r.ok ? `OK (new bank $${r.newBankBalance})` : r.error);
                    } catch(e) { console.warn('[DISCONNECT-REFUND] debt call failed:', e.message); }
                }
                try {
                    const r = await callPlatformAPI('/api/game/exit', _disconnectedToken, {
                        remainingWallet: _disconnectedChips,
                        tableMinBet:     _disconnectedTier
                    });
                    console.log(`[DISCONNECT-REFUND] ${_username} wallet $${_disconnectedChips} → bank:`, r.ok ? `OK (new bank $${r.newBankBalance})` : r.error);
                } catch(e) { console.warn('[DISCONNECT-REFUND] exit call failed:', e.message); }
            })();
        }
        player.token      = null;  // already settled — _settleToBank will skip
        player.isBot      = true;
        player.isGhostBot = true;  // ghost THIS round only
        player.bet        = 0;
        player.hasArranged = true; // prevent DQ for not arranging
        player.chips      = 0;     // zeroed — already returned to bank

        // Schedule conversion to real bot at next round start
        // This gives the seat a proper bot replacement from next round
        player._promoteToRealBot = true;
        // Notify remaining players a bot will replace the leaving player
        this.broadcast({
            type: 'playerLeft',
            username: player.username,
            message: `${player.username} left. A bot will take their seat next round.`
        });

        if (player.isBanker) {
            // Banker left — assign a fresh real bot as banker for remaining rounds
            player.username = 'Bot_Banker';
            console.log('Banker left mid-game — converting to ghost, reassigning banker.');
            // Prefer a real human player as new banker; fall back to bot if needed
            const allSids = Object.keys(this.gameState.players);
            const newBankerId =
                allSids.find(sid => { const p=this.gameState.players[sid]; return !p.isBot && !p.isGhostBot && !p.isBanker; }) ||
                allSids.find(sid => { const p=this.gameState.players[sid]; return !p.isGhostBot && !p.isBanker; });
            // â”€â”€ BANKER FORFEIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            // Banker left mid-game â†’ forfeit rule:
            // 1. Pay each active player 2Ã— their bet immediately
            // 2. End current round
            // 3. A fresh bot takes over as banker with full wallet for remaining rounds

            console.log('[BANKER FORFEIT] Banker left — paying all players 2Ã— bet');

            // Pay each non-DQ, non-ghost, non-banker player 2Ã— their bet
            let totalForfeited = 0;
            Object.values(this.gameState.players).forEach(p => {
                if (p.isBanker || p.isGhostBot || p.disqualified || p.bet <= 0) return;
                const prize = p.bet * 2;
                p.chips      += prize;
                p.lastPayout  = prize;
                p.lastSpecial = `âœ… Banker forfeited — Won 2Ã— bet ($${prize.toLocaleString()})`;
                p.wins++;
                totalForfeited += prize;
                console.log(`[FORFEIT] ${p.username} receives $${prize}`);
            });

            // Deduct from banker's chips (may go negative — handled by debt system)
            player.chips -= totalForfeited;

            // Notify table
            this.broadcast({
                type:    'bankerForfeited',
                username: player.username,
                message:  `${player.username} (Banker) left the game and forfeited — all players receive 2Ã— their bet!`
            });

            // Mark old banker as ghost — but DO promote to a regular player bot next round
            // so their seat isn't left empty (Bot_Banker fills the banker role separately)
            player.isBanker = false;
            player.isGhostBot = true;
            player.chips = 0;
            player._promoteToRealBot = true; // promote to regular player bot next round

            // Assign a fresh bot as banker with full wallet
            const botBankerId = 'bot_banker_' + Date.now();
            const walletSize  = this.gameState.tableWalletSize || 3000;
            this.gameState.players[botBankerId] = {
                username:      'Bot_Banker',
                avatar:        'ðŸ¤–',
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

            // End the current round immediately — skip to roundEnd
            // Clear any running arrange/reveal timers
            if (this.arrangeTimer) { clearInterval(this.arrangeTimer); this.arrangeTimer = null; }
            if (this.revealTimer)  { clearInterval(this.revealTimer);  this.revealTimer  = null; }

            this.gameState.status  = 'roundEnd';
            this.gameState.message = `${player.username} forfeited as Banker. Bot_Banker takes over next round!`;
            console.log('[BANKER FORFEIT] Round ended. Bot_Banker takes over.');
            this.broadcastState();

            // Move to next round after 4 seconds
            setTimeout(() => this.startRound(), 4000);
        } else {
            player.username = '(Left)';
            console.log(player.username, 'left mid-game — converted to ghost bot.');
        }
        this.broadcastState();
    }

    _resetRoom() {
        console.log('[ROOM] Resetting room for next game...');
        // Cancel any running timers
        if (this.arrangeTimer) { clearInterval(this.arrangeTimer); this.arrangeTimer = null; }
        if (this.betTimer)     { clearInterval(this.betTimer);     this.betTimer     = null; }
        if (this.revealTimer)  { clearInterval(this.revealTimer);  this.revealTimer  = null; }
        if (this._lobbyTimer)  { clearInterval(this._lobbyTimer);  this._lobbyTimer  = null; }

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
            message:         ''
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
        setTimeout(() => this.startRound(), 2000);
    }

    startRound() {
        this.gameState.round++;
        if (this.gameState.round > this.gameState.maxRounds) { this.endGame(); return; }
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
        if (this.betTimer) clearInterval(this.betTimer);
        const deck = Logic.shuffleDeck(Logic.createDeck());
        Object.values(this.gameState.players).forEach(p => {
            if (p.isGhostBot) return; // ghost bots get no cards — they sit out visually
            p.rawCards = Logic.dealPlayerCards(deck);
            p.hasArranged = false;
            if (p.isBot) this.botArrange(p);
        });
        const arrangeSecs = this.gameState.blitz ? 40 : 65;
        this.gameState.status  = "arranging";
        this.gameState.timer   = arrangeSecs;
        this.gameState.message = "Cards dealt! Arrange hands. (1st=weakest, 3rd=strongest)";
        this.broadcastState();
        this.startCountdown(arrangeSecs, "arranging", () => {
            this.disqualifyLate();
            this.startRevealPhase();
        });
    }

    disqualifyLate() {
        const banker = this.gameState.players[this.gameState.bankerSessionId];

        // If the human banker didn't arrange: DQ banker, pay each player DOUBLE their bet
        if (banker && !banker.isBot && !banker.hasArranged) {
            banker.disqualified     = true;
            banker.disqualifyReason = "Banker did not arrange cards in time.";
            banker.lastSpecial      = 'âŒ DQ — banker too slow';
            const isVip = this.gameState.isVip || false;
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified && p.bet > 0) {
                    // Banker pays bet Ã— max(2, declaredSpecial.multiplier).
                    // House pays the flat bonus on top (matches normal-round behaviour).
                    const declared   = p.declaredSpecial || null;
                    const actual     = this._actualSpecialFor(p);
                    const sp         = declared || actual;
                    const bonusSp    = actual || declared;
                    const mult       = Math.max(2, (sp && sp.multiplier) || 2);
                    const bonus      = bonusSp ? Logic.getSpecialBonus(bonusSp.name, isVip) : 0;
                    const fromBanker = p.bet * mult;
                    const prize      = fromBanker + bonus;
                    p.chips         += prize;
                    p.lastPayout     = prize;
                    banker.chips    -= fromBanker; // bonus comes from house, not banker
                    // Set handResults so WIN badges show on all 3 hands
                    p.handResults = {
                        r1: 1, r2: 1, r3: 1,
                        names: {
                            player: sp ? [sp.name, sp.name, sp.name] : ['—', '—', '—'],
                            banker: ['DQ', 'DQ', 'DQ']
                        }
                    };
                    p.lastSpecial = sp
                        ? `âœ… Banker DQ + ${sp.name} — paid ${mult}Ã— bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                        : `âœ… Banker DQ — Won 2Ã— bet ($${prize.toLocaleString()})`;
                    p.wins++;
                }
            });
            console.log(banker.username, "BANKER DISQUALIFIED — did not arrange. Players paid 2x bet.");
            this.broadcast({ type:"playerDisqualified", username:banker.username, reason:"Banker disqualified — all players win 2Ã— their bet." });
            return;
        }

        // Disqualify players who didn't arrange
        Object.values(this.gameState.players).forEach(p => {
            if (!p.hasArranged && !p.isBot && !p.disqualified && !p.isBanker) {
                p.disqualified     = true;
                p.disqualifyReason = "Did not arrange cards in time.";
                p.chips           -= p.bet;
                p.lastPayout       = -p.bet;
                p.lastSpecial      = 'âŒ DQ — too slow';
                // Do NOT auto-assign hands — player loses bet, excluded from scoring
                if (banker) banker.chips += p.bet;
                console.log(p.username, "DISQUALIFIED — did not arrange in time.");
                this.broadcast({ type:"playerDisqualified", username:p.username, reason:"Did not arrange cards in time." });
            }
        });
    }

    startRevealPhase() {
        if (this.arrangeTimer) clearInterval(this.arrangeTimer);
        const revealSecs = this.gameState.blitz ? 20 : 30;
        this.gameState.status  = "revealing";
        this.gameState.timer   = revealSecs;
        this.gameState.message = "All hands revealed! Processing payouts...";
        this.resolveAllHands();
        this.broadcastState();
        this.startCountdown(revealSecs, "revealing", () => {
            this.gameState.status  = "roundEnd";
            this.gameState.message = `Round ${this.gameState.round} complete!`;
            this.broadcastState();
            setTimeout(() => this.startRound(), 3000);
        });
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
        const actual = this._actualSpecialFor(player);
        return actual ? Logic.getSpecialBonus(actual.name, this.gameState.isVip || false) : 0;
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
        const banker = this.gameState.players[this.gameState.bankerSessionId];
        if (!banker) return;

        // If banker left mid-round (ghost bot) or was DQ'd with no hands
        // treat as banker forfeit — pay all non-DQ players 2Ã— their bet
        if (banker.isGhostBot || (banker.disqualified && !banker.hand1?.length)) {
            const isVip = this.gameState.isVip || false;
            Object.values(this.gameState.players).forEach(p => {
                if (p.isBanker || p.disqualified || p.isGhostBot || p.bet <= 0) return;
                // Pay bet Ã— max(2, declaredSpecial.multiplier) + flat house bonus.
                const declared = p.declaredSpecial || null;
                const actual   = this._actualSpecialFor(p);
                const sp       = declared || actual;
                const bonusSp  = actual || declared;
                const mult     = Math.max(2, (sp && sp.multiplier) || 2);
                const bonus    = bonusSp ? Logic.getSpecialBonus(bonusSp.name, isVip) : 0;
                const prize    = (p.bet * mult) + bonus;
                p.chips      += prize;
                p.lastPayout  = prize;
                p.lastSpecial = sp
                    ? `âœ… Banker out + ${sp.name} — paid ${mult}Ã— bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                    : `âœ… Banker left — Won 2Ã— bet ($${prize.toLocaleString()})`;
                p.wins++;
            });
            console.log('[RESOLVE] Banker ghost/DQ — players paid 2Ã— or special');
            return;
        }

        if (banker.disqualified || !banker.hand1?.length) return;
        const bankerHands = { hand1:banker.hand1, hand2:banker.hand2, hand3:banker.hand3 };
        const bankerActualSpecial = this._actualSpecialFor(banker);

        // House bonus tracking — awarded ONCE per round to the special winner, not per player
        let roundBonusAwarded = false;
        let roundBonusAmount  = 0;
        let roundBonusWinner  = null; // 'player' or 'banker'
        let roundBonusPlayer  = null; // the player who won (if not banker)

        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (player.isBanker || player.isGhostBot) return;

            // DQ'd players: if banker has a special, they pay the full special amount
            // (they already paid 1x from DQ — pay the difference to make it full special amount)
            if (player.disqualified) {
                const bankerSpecialForDq = banker.declaredSpecial || bankerActualSpecial;
                if (bankerSpecialForDq && !player.debtDqd) {
                    const specialMultiplier = bankerSpecialForDq.multiplier;
                    const alreadyPaid       = player.bet; // paid 1x during DQ
                    const owedTotal         = player.bet * specialMultiplier;
                    const extraOwed         = owedTotal - alreadyPaid;
                    if (extraOwed > 0) {
                        player.chips  -= extraOwed;
                        banker.chips  += extraOwed;
                        player.lastPayout = -(owedTotal);
                        player.lastSpecial = `âŒ DQ + Banker ${bankerSpecialForDq.name} — paid ${specialMultiplier}x`;
                        console.log(`${player.username} DQ + banker special: total paid $${owedTotal}`);
                    }
                }
                return; // skip normal resolution for DQ'd players
            }

            if (!player.hand1?.length) return;

            const result = Logic.resolveRound(
                { hand1:player.hand1, hand2:player.hand2, hand3:player.hand3 },
                bankerHands,
                player.bet,
                player.declaredSpecial || null,
                banker.declaredSpecial || null,
                this.gameState.isVip || false
            );

            // payout is pure bet exchange only — bonuses are awarded INDEPENDENTLY:
            //   • player's own bonus (if they declared a special) is credited now,
            //     regardless of who won the round. Even if the banker has a bigger
            //     special and wins the bet exchange, the player still gets their
            //     declared-special bonus from the house.
            //   • banker's bankerBonus is accumulated and paid ONCE after the loop.
            player.chips      += result.payout;
            player.lastPayout  = result.payout;
            // Player bonus — prefer DECLARED special (what the player committed to).
            // Falls back to actual highest only if no declaration was made.
            const playerBonusSpecial =
                player.declaredSpecial || this._actualSpecialFor(player) || null;
            const playerBonusOwn = playerBonusSpecial
                ? Logic.getSpecialBonus(playerBonusSpecial.name, this.gameState.isVip || false)
                : 0;
            player.lastBonus   = playerBonusOwn;
            player.handResults = result.handResults || null;
            banker.chips      -= result.payout; // banker receives/pays pure bet exchange

            // Per-player bonus: house pays the player their own special bonus
            // even when the banker wins with a bigger special.
            if (playerBonusOwn > 0) {
                player.chips     += playerBonusOwn;
                player.lastPayout = (player.lastPayout || 0) + playerBonusOwn;
            }

            // Track banker bonus once per round (banker plays one hand, multiple players see it).
            const bankerBonusOwn = bankerActualSpecial ? Logic.getSpecialBonus(bankerActualSpecial.name, this.gameState.isVip || false) : 0;
            if (bankerBonusOwn > 0 && !roundBonusAwarded) {
                roundBonusAwarded = true;
                roundBonusAmount  = bankerBonusOwn;
                roundBonusWinner  = 'banker';
            }
            if (result.payout > 0) player.wins++;

            const rb = result.bonus || 0;
            if (result.playerSpecial) {
                const bonusStr = playerActualBonus > 0 ? ` +$${playerActualBonus.toLocaleString()} house bonus` : '';
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

        // Store banker's special display
        const bs = banker.declaredSpecial || bankerActualSpecial;
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
        this.gameState.status    = "gameOver";
        this.gameState.completed = true;   // exclude from quick-join match candidates
        this.gameState.message   = "Game Over! Final scores:";
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
            console.log(`[SETTLE]   ${p.username}: chips=$${p.chips} token=${p.token ? "YES ("+p.token.substring(0,12)+"...)" : "MISSING — will not settle!"}`);
        });

        for (const player of realPlayers) {
            if (!player.token) {
                // Token missing — broadcast a warning so this is visible in client logs too
                console.error(`[SETTLE] âš ï¸  ${player.username} has NO TOKEN — chips cannot be returned to bank!`);
                console.error(`[SETTLE] âš ï¸  This means poker-server/index.js is NOT passing token through matchmake.`);
                console.error(`[SETTLE] âš ï¸  Deploy the latest poker-server-index.js from outputs to fix this.`);
                // Broadcast a settlement failure message so client can fallback
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
            const returning = Math.max(0, player.chips);
            try {
                const res = await callPlatformAPI('/api/game/exit', player.token, {
                    remainingWallet: returning,
                    tableMinBet:     this.gameState.tableMinBet
                });
                if (res.ok) {
                    console.log(`[SETTLE] âœ… ${player.username}: returned $${returning} â†’ new bank: $${res.newBankBalance}`);
                    // Record win/loss + game mode stats
                    const finalChips  = player.chips;
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
                        console.log(`[SETTLE] ðŸ“Š ${player.username}: recorded ${isWin?'WIN':'LOSS'} mode=${mode}`);
                    } catch(e) {
                        console.warn(`[SETTLE] Stats recording failed for ${player.username}:`, e.message);
                    }
                    // Broadcast updated bank balance to the player's client
                    const sid = Object.keys(this.gameState.players).find(s => this.gameState.players[s] === player);
                    const c   = this.clients.find(c => c.sessionId === sid);
                    if (c) this.sendToClient(c, { type:'settleComplete', newBankBalance: res.newBankBalance, returned: returning });
                } else {
                    console.error(`[SETTLE] âŒ ${player.username}: exit API failed — ${res.error}`);
                }
            } catch(e) {
                console.error(`[SETTLE] ${player.username} error:`, e.message);
            }
        }
        console.log(`[SETTLE] ====================================`);
    }

    // ==================== HELPERS ====================

    checkAllArranged() {
        const active = Object.values(this.gameState.players).filter(p => !p.disqualified);
        if (active.every(p => p.hasArranged)) {
            if (this.arrangeTimer) clearInterval(this.arrangeTimer);
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
            player.chips           -= player.bet;
            player.lastPayout       = -player.bet;
            player.hand1 = fallback.hand1;
            player.hand2 = fallback.hand2;
            player.hand3 = fallback.hand3;
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            if (banker) banker.chips += player.bet;
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
            this.broadcast({ type:'specialAlert', username: player.username, specialName, multiplier: chosen.multiplier });
        }
        this.broadcastState();
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
            // Banker DQ: all players get double their bet back
            target.disqualified     = true;
            target.disqualifyReason = violation;
            target.lastSpecial      = "âŒ DQ";
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified) {
                    const declared = p.declaredSpecial || null;
                    const actual   = this._actualSpecialFor(p);
                    const sp       = declared || actual;
                    const bonusSp  = actual || declared;
                    const mult     = Math.max(2, (sp && sp.multiplier) || 2);
                    const bonus    = bonusSp ? Logic.getSpecialBonus(bonusSp.name, this.gameState.isVip || false) : 0;
                    const fromBanker = p.bet * mult;
                    const refund   = fromBanker + bonus;
                    p.chips      += refund;
                    p.lastPayout  = refund;
                    target.chips -= fromBanker;
                }
            });
            console.log(`BANKER ${target.username} DISQUALIFIED by ${requester.username}: ${violation}`);
        } else {
            // Player DQ: target loses bet to banker
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            target.disqualified     = true;
            target.disqualifyReason = violation;
            target.lastSpecial      = "âŒ DQ";
            target.chips           -= target.bet;
            target.lastPayout       = -target.bet;
            if (banker) banker.chips += target.bet;
            console.log(`${target.username} DISQUALIFIED by ${requester.username}: ${violation}`);
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

        const TABLE_CONFIG = {
            100:    { minBet:100,    increment:50,     maxBet:150,    walletSize:3000,    minBank:5000    },
            250:    { minBet:250,    increment:50,     maxBet:500,    walletSize:10000,   minBank:15000   },
            500:    { minBet:500,    increment:100,    maxBet:1000,   walletSize:20000,   minBank:30000   },
            1000:   { minBet:1000,   increment:500,    maxBet:2000,   walletSize:40000,   minBank:60000   },
            10000:  { minBet:10000,  increment:10000,  maxBet:50000,  walletSize:1000000, minBank:2000000 },
            100000: { minBet:100000, increment:100000, maxBet:500000, walletSize:3000000, minBank:5000000 }
        };

        // Parse minBet from roomId (format: sipsam_100_timestamp)
        let minBet = 100; // default
        if (this._roomId) {
            const parts = this._roomId.split('_');
            const parsed = parseInt(parts[1]);
            if (TABLE_CONFIG[parsed]) minBet = parsed;
        }

        const cfg = TABLE_CONFIG[minBet];
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

    startCountdown(seconds, phase, onComplete) {
        let remaining = seconds;
        const phaseStartedAt = Date.now();
        const interval = setInterval(() => {
            try {
                remaining--;
                this.gameState.timer = remaining;
                this.broadcastState();
                if (remaining <= 0) { clearInterval(interval); onComplete(); }
            } catch(e) {
                console.error(`[TIMER] ${phase} tick threw — clearing interval to prevent stall:`, e);
                clearInterval(interval);
                // Auto-recover: jump to the next phase so the room doesn't hang.
                try { onComplete(); } catch(e2) { console.error('[TIMER] onComplete also threw:', e2); }
            }
        }, 1000);
        if (phase==="arranging") this.arrangeTimer = interval;
        if (phase==="betting")   this.betTimer     = interval;
        if (phase==="revealing") this.revealTimer  = interval;

        // Stall watchdog — independent timer that fires if the phase hasn't
        // ended within seconds+5. If status is still in this phase, log it
        // and force onComplete so the room recovers instead of hanging.
        setTimeout(() => {
            if (this.gameState.status === phase) {
                console.warn(`[TIMER] ${phase} stall detected after ${seconds + 5}s — forcing advance. ` +
                    `players: ${Object.entries(this.gameState.players).map(([s,p]) => `${p.username}(arr=${p.hasArranged} dq=${p.disqualified})`).join(', ')}`);
                clearInterval(interval);
                try { onComplete(); } catch(e) { console.error('[TIMER] watchdog onComplete threw:', e); }
            }
        }, (seconds + 5) * 1000);
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
