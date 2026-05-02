// ============================================
// SIPSAM GAME ROOM v6.0
// Pure JS — no Colyseus dependency
// Works with plain WebSocket server in index.js
// ============================================

const Logic = require("./logic.js");
const http  = require("http");

// ── PLATFORM API CALLER ───────────────────────────────────────────
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
            // Manual disqualify removed — system auto-detects violations
            case "declareSpecial":    this._onDeclareSpecial(client, data);    break;
            case "freezeBet":         this._onFreezeBet(client, data);         break;
            case "freezeBet":         this._onFreezeBet(client, data);         break;
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
        // Fill bots for any empty seats now that game is starting
        this.fillBotsIfNeeded();

        const TABLE_CONFIG = {
            100:   { minBet:100,   increment:50,    maxBet:150,   walletSize:3000,    minBank:5000    },
            250:   { minBet:250,   increment:50,    maxBet:500,   walletSize:10000,   minBank:15000   },
            500:   { minBet:500,   increment:100,   maxBet:1000,  walletSize:20000,   minBank:30000   },
            1000:  { minBet:1000,  increment:500,   maxBet:2000,  walletSize:40000,   minBank:60000   },
            10000: { minBet:10000, increment:10000, maxBet:50000, walletSize:1000000, minBank:2000000 }
        };

        const roundCount = [5,10,20,30].includes(data.rounds) ? data.rounds : 10;
        const cfg        = TABLE_CONFIG[data.tableMinBet] || TABLE_CONFIG[100];

        // VIP flag for enhanced bonuses
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

        console.log(`Table: $${cfg.minBet} min / $${cfg.maxBet} max / $${cfg.increment} inc / $${cfg.walletSize} wallet | Rounds: ${roundCount} | Blitz: ${this.gameState.blitz}`);
        this._applyTableConfigFromRoomId(); // ensure config is set
        this.beginGame();
    }

    _onFreezeBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isBanker) return;
        player.frozen = !!data.freeze;
        console.log(`${player.username} freeze bet: ${player.frozen}`);
        this.broadcastState();
    }

    _onFreezeBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || player.isBanker) return;
        player.frozen = !!data.freeze;
        console.log(`${player.username} freeze bet: ${player.frozen}`);
        this.broadcastState();
    }

    _onPlaceBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "betting" || player.isBanker) return;
        if (player.frozen) return; // bet is frozen — reject changes
        if (player.frozen) return; // bet is frozen — reject changes

        // Player with 0 chips cannot bet — they should be a ghost bot
        if (player.chips <= 0) {
            console.log(player.username, 'cannot bet — 0 chips, converting to ghost.');
            player.isGhostBot  = true;
            player.bet         = 0;
            player.hasArranged = true;
            this.broadcastState();
            return;
        }

        // Use TABLE_CONFIG for authoritative min/max — never use tMin * 3 fallback
        const TABLE_CONFIG = {
            100:   { minBet:100,   maxBet:150   },
            250:   { minBet:250,   maxBet:500   },
            500:   { minBet:500,   maxBet:1000  },
            1000:  { minBet:1000,  maxBet:2000  },
            10000: { minBet:10000, maxBet:50000 }
        };
        const tMin  = this.gameState.tableMinBet;
        const tCfg  = TABLE_CONFIG[tMin] || { minBet:tMin, maxBet:tMin * 2 };
        const tMax  = tCfg.maxBet; // authoritative max, never tMin * 3
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

        // If banker is a bot, auto-accept the double request after a short delay
        const banker = this.gameState.players[this.gameState.bankerSessionId];
        if (banker && banker.isBot) {
            setTimeout(() => {
                const target = this.gameState.players[client.sessionId];
                if (!target || this.gameState.status !== "betting") return;
                // Bot banker randomly accepts ~60% of the time
                const accepted = Math.random() < 0.6;
                if (accepted) {
                    target.bet = Math.min(target.bet * 2, target.chips);
                    this.broadcastAll({ type:"doubleAccepted", username:target.username });
                } else {
                    this.broadcastAll({ type:"doubleRejected", username:target.username });
                }
                this.broadcastState();
            }, 1500);
        }
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
            // Invalid arrangement → immediate disqualification (no retry allowed)
            console.log(`${player.username} DISQUALIFIED — invalid hand order: ${orderErr}`);
            player.disqualified     = true;
            player.disqualifyReason = 'Invalid hand arrangement — disqualified.';
            player.lastSpecial      = '❌ DQ — invalid hands';
            player.hasArranged      = true; // mark arranged so game can proceed
            // Assign hands as submitted so cards are visible at reveal
            player.hand1 = h1; player.hand2 = h2; player.hand3 = h3;
            // Deduct 2× bet — DQ'd player owes double their bet to the banker
            const banker = Object.values(this.gameState.players).find(p => p.isBanker);
            if (player.bet > 0) {
                const penalty = player.bet * 2;
                player.chips -= penalty;
                player.lastPayout = -penalty;
                if (banker) banker.chips += penalty;
            }
            this.sendToClient(client, { type:'playerDisqualified', username:player.username, reason:'Invalid hand arrangement — disqualified. Owes 2× bet.' });
            this.broadcast({ type:'playerDisqualified', username:player.username, reason:`${player.username} disqualified — invalid hand arrangement. Owes 2× bet.` });
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

        // Parse intended minBet from roomId (format: sipsam_1000_timestamp)
        // so Live Tables can filter by denomination before game starts
        if (!this.gameState.tableMinBet && client.roomId) {
            const parts = client.roomId.split('_');
            const parsed = parseInt(parts[1]);
            if ([100, 250, 500, 1000, 10000].includes(parsed)) {
                this.gameState.tableMinBet = parsed;
            }
        }

        // Mark room as private if flagged by the joining player
        if (options.isPrivate) {
            this.gameState.isPrivate = true;
        }

        // Guard: max 4 seats. If full, evict a bot to make room for the human.
        const currentCount = Object.keys(this.gameState.players).length;
        if (currentCount >= 4) {
            const botEntries = Object.entries(this.gameState.players)
                .filter(([, p]) => p.isBot && !p.isBanker);
            if (botEntries.length > 0) {
                const [evictSid, evictBot] = botEntries[Math.floor(Math.random() * botEntries.length)];
                console.log(`[JOIN] Evicting bot ${evictBot.username} to make room for ${username}`);
                this.broadcast({ type: "playerEvicted", username: evictBot.username });
                delete this.gameState.players[evictSid];
            } else {
                console.log(username, "REJECTED — room full (4 players max, no bots to evict)");
                this.sendToClient(client, { type:'error', message:'Room is full. Please join another table.' });
                return;
            }
        }

        this.gameState.players[client.sessionId] = {
            username, token, avatar, chips: this.gameState.tableWalletSize || 3000, bet:0,
            isBanker:false, isBot:false, frozen:false,
            hand1:[], hand2:[], hand3:[], rawCards:[],
            hasArranged:false, disqualified:false,
            lastPayout:0, lastSpecial:null, wins:0
        };

        console.log(username, "joined. Total:", Object.keys(this.gameState.players).length);
        // Do NOT fill bots during waiting — real players may still be joining
        // Bots fill only at timer expiry or when host starts game manually

        // Start 3-minute lobby countdown on first real player joining
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

        // ── WAITING PHASE: just remove the player entirely ──────────
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

        // ── ACTIVE GAME: check if any real players remain ────────────
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
            // ── BANKER LEFT — BOT TAKES OVER SEAMLESSLY ────────────
            // Instead of aborting the round, the bot replaces the banker
            // and the round continues normally. If cards are already dealt,
            // the bot gets dealt cards and arranges them immediately.
            const oldUsername = player.username;
            console.log(`[BANKER REPLACE] ${oldUsername} left as Banker — bot takes over seamlessly.`);

            // Remove old banker's player slot entirely — Bot_Banker fills the vacancy
            delete this.gameState.players[client.sessionId];

            // Create a fresh bot as banker with full wallet
            const botBankerId = 'bot_banker_' + Date.now();
            const walletSize  = this.gameState.tableWalletSize || 3000;
            const botBanker = {
                username:      'Bot_Banker',
                avatar:        '🤖',
                token:         null,
                chips:         walletSize,
                bet:           0,
                isBanker:      true,
                isBot:         true,
                isGhostBot:    false,
                frozen:        false,
                hand1:[], hand2:[], hand3:[], rawCards:[],
                hasArranged:   false, disqualified: false,
                lastPayout:    0, lastSpecial: null, wins: 0
            };
            this.gameState.players[botBankerId] = botBanker;
            this.gameState.bankerSessionId = botBankerId;

            // If cards are already dealt (arranging or revealing phase),
            // deal cards to the bot and arrange them immediately so the round continues
            const phase = this.gameState.status;
            if (phase === 'arranging' || phase === 'revealing' || phase === 'roundEnd') {
                const deck = Logic.shuffleDeck(Logic.createDeck());
                botBanker.rawCards = Logic.dealPlayerCards(deck);
                this.botArrange(botBanker);
                console.log(`[BANKER REPLACE] Bot_Banker dealt cards and arranged in phase: ${phase}`);
            }
            // If in betting phase: bot doesn't need cards yet — dealCards() will handle it

            // Notify table
            this.broadcast({
                type:    'playerLeft',
                username: oldUsername,
                message:  `${oldUsername} (Banker) left. Bot_Banker takes over!`
            });
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
        // Guard: prevent double-calling if a stale timer fires after banker forfeit
        if (this.gameState.status === 'betting' || this.gameState.status === 'arranging' || this.gameState.status === 'revealing') {
            console.log('[GUARD] startRound() blocked — already in active phase:', this.gameState.status);
            return;
        }
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
            // If frozen, preserve previous bet; otherwise reset to tableMinBet
            const frozenBet = p.frozen ? p.bet : 0;
            p.bet             = p.isBanker ? 0 : (frozenBet || this.gameState.tableMinBet);
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
                p.isGhostBot        = false;  // no longer sitting out
                p.isBot             = true;
                p._promoteToRealBot = false;
                p.chips             = this.gameState.tableWalletSize || 3000; // fresh wallet
                p.username          = 'Bot_' + botNum++;
                p.avatar            = this._botAvatar(botNum);
                // Clear ALL lingering flags so bot plays normally
                p.debtDqd           = false;
                p.disqualified      = false;
                p.disqualifyReason  = null;
                p.bet               = p.isBanker ? 0 : this.gameState.tableMinBet;
                p.hasArranged       = false;
                p.token             = null;
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

    disqualifyLate() {
        const banker = this.gameState.players[this.gameState.bankerSessionId];

        // If the human banker didn't arrange: DQ banker, pay each player DOUBLE their bet
        // — OR their declared special's multiplier × bet (whichever is higher) + house bonus.
        if (banker && !banker.isBot && !banker.hasArranged) {
            banker.disqualified     = true;
            banker.disqualifyReason = "Banker did not arrange cards in time.";
            banker.lastSpecial      = '❌ DQ — banker too slow';
            const isVip = this.gameState.isVip || false;
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified && p.bet > 0) {
                    const sp         = p.declaredSpecial || null;
                    const mult       = Math.max(2, sp?.multiplier || 2);
                    const bonus      = sp ? Logic.getSpecialBonus(sp.name, isVip) : 0;
                    const fromBanker = p.bet * mult;        // banker owes the bet exchange
                    const prize      = fromBanker + bonus;  // bonus paid by house
                    p.chips         += prize;
                    p.lastPayout     = prize;
                    banker.chips    -= fromBanker;          // only the bet portion comes from banker
                    // Set handResults so WIN badges show on all 3 hands
                    p.handResults = {
                        r1: 1, r2: 1, r3: 1,
                        names: {
                            player: sp ? [sp.name, sp.name, sp.name] : ['—', '—', '—'],
                            banker: ['DQ', 'DQ', 'DQ']
                        }
                    };
                    p.lastSpecial = sp
                        ? `✅ Banker DQ + ${sp.name} — paid ${mult}× bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                        : `✅ Banker DQ — Won 2× bet ($${prize.toLocaleString()})`;
                    p.wins++;
                }
            });
            console.log(banker.username, "BANKER DISQUALIFIED — did not arrange. Players paid 2× bet OR declared-special multiplier + bonus.");
            this.broadcast({ type:"playerDisqualified", username:banker.username, reason:"Banker disqualified — all players win at least 2× their bet (or their special payout)." });
            return;
        }

        // Disqualify players who didn't arrange
        Object.values(this.gameState.players).forEach(p => {
            if (!p.hasArranged && !p.isBot && !p.disqualified && !p.isBanker) {
                p.disqualified     = true;
                p.disqualifyReason = "Did not arrange cards in time.";
                const penalty = p.bet * 2;
                p.chips           -= penalty;
                p.lastPayout       = -penalty;
                p.lastSpecial      = '❌ DQ — too slow (owes 2× bet)';
                // Do NOT auto-assign hands — player loses 2× bet, excluded from scoring
                if (banker) banker.chips += penalty;
                console.log(p.username, "DISQUALIFIED — did not arrange in time. Owes 2× bet.");
                this.broadcast({ type:"playerDisqualified", username:p.username, reason:"Did not arrange cards in time. Owes 2× bet." });
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

    // Verify if a disqualification request is valid
    _verifyDisqualification(target) {
        // Check 1: Invalid hand order — skip if player has a declared special
        // (specials like Straight Flush span all cards and don't need valid hand order)
        if (!target.declaredSpecial) {
            const orderErr = Logic.validateHandOrder(target.hand1, target.hand2, target.hand3);
            if (orderErr) return `Invalid hand arrangement: ${orderErr}`;
        }

        // Check 2: Has a special but did not declare it
        // Use rawCards for detection — specials are identified from all 13 cards
        const rawH1 = target.rawCards ? target.rawCards.slice(0,3) : target.hand1;
        const rawH2 = target.rawCards ? target.rawCards.slice(3,8) : target.hand2;
        const rawH3 = target.rawCards ? target.rawCards.slice(8,13) : target.hand3;
        const actualSpecial = Logic.detectSpecial(rawH1, rawH2, rawH3);
        if (actualSpecial && !target.declaredSpecial) {
            return `Player has ${actualSpecial.name} but did not declare it.`;
        }

        // Check 3: Declared wrong special
        if (target.declaredSpecial && actualSpecial) {
            if (target.declaredSpecial.name !== actualSpecial.name) {
                return `Player declared ${target.declaredSpecial.name} but actually has ${actualSpecial.name}.`;
            }
        }

        // Check 4: Declared a special they don't have
        if (target.declaredSpecial && !actualSpecial) {
            return `Player declared ${target.declaredSpecial.name} but no special found in their hands.`;
        }

        return null; // No violation found
    }

    resolveAllHands() {
        const banker = this.gameState.players[this.gameState.bankerSessionId];
        if (!banker) { console.log('[RESOLVE] No banker found — skipping resolution'); return; }

        console.log(`[RESOLVE] Banker: ${banker.username} | isBot:${banker.isBot} | isGhost:${banker.isGhostBot} | hand1:${banker.hand1?.length || 0} cards | hasArranged:${banker.hasArranged}`);

        // If banker left mid-round (ghost bot) or was DQ'd with no hands
        // treat as banker forfeit — pay all non-DQ players 2× their bet
        // (or their declared special's multiplier + house bonus, whichever is higher)
        if (banker.isGhostBot || (banker.disqualified && !banker.hand1?.length)) {
            const isVip = this.gameState.isVip || false;
            Object.values(this.gameState.players).forEach(p => {
                if (p.isBanker || p.disqualified || p.isGhostBot || p.bet <= 0) return;
                const sp    = p.declaredSpecial || null;
                const mult  = Math.max(2, sp?.multiplier || 2);
                const bonus = sp ? Logic.getSpecialBonus(sp.name, isVip) : 0;
                const prize = (p.bet * mult) + bonus;
                p.chips      += prize;
                p.lastPayout  = prize;
                p.lastSpecial = sp
                    ? `✅ Banker out + ${sp.name} — paid ${mult}× bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                    : `✅ Banker left — Won 2× bet ($${prize.toLocaleString()})`;
                p.wins++;
            });
            console.log('[RESOLVE] Banker ghost/DQ — all players paid 2× bet');
            return;
        }

        if (banker.disqualified || !banker.hand1?.length) {
            console.log(`[RESOLVE] Banker skipped — disqualified:${banker.disqualified} hand1:${banker.hand1?.length || 0}`);
            return;
        }
        const bankerHands = { hand1:banker.hand1, hand2:banker.hand2, hand3:banker.hand3 };

        // House bonus tracking — awarded ONCE per round to the special winner, not per player
                return `Player declared ${target.declaredSpecial.name} but actually has ${actualSpecial.name}.`;
            }
        }

        // Check 4: Declared a special they don't have
        if (target.declaredSpecial && !actualSpecial) {
            return `Player declared ${target.declaredSpecial.name} but no special found in their hands.`;
        }

        return null; // No violation found
    }

    resolveAllHands() {
        const banker = this.gameState.players[this.gameState.bankerSessionId];
        if (!banker) { console.log('[RESOLVE] No banker found — skipping resolution'); return; }

        console.log(`[RESOLVE] Banker: ${banker.username} | isBot:${banker.isBot} | isGhost:${banker.isGhostBot} | hand1:${banker.hand1?.length || 0} cards | hasArranged:${banker.hasArranged}`);

        // If banker left mid-round (ghost bot) or was DQ'd with no hands
        // treat as banker forfeit — pay all non-DQ players 2× their bet
        if (banker.isGhostBot || (banker.disqualified && !banker.hand1?.length)) {
            Object.values(this.gameState.players).forEach(p => {
                if (p.isBanker || p.disqualified || p.isGhostBot || p.bet <= 0) return;
                // Pay bet × max(2, declaredSpecial.multiplier) + flat house bonus.
                const sp    = p.declaredSpecial || null;
                const mult  = Math.max(2, (sp && sp.multiplier) || 2);
                const bonus = sp ? (Logic.SPECIAL_BONUS[sp.name] || 0) : 0;
                const prize = (p.bet * mult) + bonus;
                p.chips      += prize;
                p.lastPayout  = prize;
                p.lastSpecial = sp
                    ? `✅ Banker out + ${sp.name} — paid ${mult}× bet + $${bonus.toLocaleString()} bonus ($${prize.toLocaleString()})`
                    : `✅ Banker left — Won 2× bet ($${prize.toLocaleString()})`;
                p.wins++;
            });
            console.log('[RESOLVE] Banker ghost/DQ — players paid 2× or special');
            return;
        }

        if (banker.disqualified || !banker.hand1?.length) {
            console.log(`[RESOLVE] Banker skipped — disqualified:${banker.disqualified} hand1:${banker.hand1?.length || 0}`);
            return;
        }
        const bankerHands = { hand1:banker.hand1, hand2:banker.hand2, hand3:banker.hand3 };
        const isVip = this.gameState.isVip || false;

        // Banker's ACTUAL special (from their cards) — bonus follows the cards, not declaration
        const bankerActual = Logic.detectSpecial(banker.hand1, banker.hand2, banker.hand3);
        let bankerBonusTotal = bankerActual ? Logic.getSpecialBonus(bankerActual.name, isVip) : 0;

        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (player.isBanker || player.isGhostBot) return;

            // DQ'd players: if banker has a special, they pay the full special amount
            // (they already paid 2x from DQ — pay the difference only if special multiplier > 2)
            if (player.disqualified) {
                if (banker.declaredSpecial && !player.debtDqd) {
                    const specialMultiplier = banker.declaredSpecial.multiplier;
                    const alreadyPaid       = player.bet * 2; // paid 2x during DQ
                    const owedTotal         = player.bet * specialMultiplier;
                    const extraOwed         = owedTotal - alreadyPaid;
                    if (extraOwed > 0) {
                        player.chips  -= extraOwed;
                        banker.chips  += extraOwed;
                        player.lastPayout = -(owedTotal);
                        player.lastSpecial = `❌ DQ + Banker ${banker.declaredSpecial.name} — paid ${specialMultiplier}x`;
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
                isVip
            );

            // payout = pure bet exchange between player and banker
            player.chips      += result.payout;
            player.lastPayout  = result.payout;
            player.handResults = result.handResults || null;
            banker.chips      -= result.payout;

            // ── Award player's special BONUS (house) ────────────────────
            // Bonus is owed for HAVING the special hand, independent of declaration.
            // Multiplier exchange still requires declaration (handled in resolveRound).
            const playerActual = Logic.detectSpecial(player.hand1, player.hand2, player.hand3);
            const pb = playerActual ? Logic.getSpecialBonus(playerActual.name, isVip) : 0;
            const pbName = playerActual ? playerActual.name : null;
            if (pb > 0) {
                player.chips     += pb;
                player.lastPayout += pb;
                const tag = result.playerSpecial ? 'declared' : 'undeclared';
                console.log(`[BONUS] House pays ${player.username} $${pb.toLocaleString()} bonus for ${pbName} (${tag})`);
            }

            if (result.payout > 0) player.wins++;

            if (result.playerSpecial) {
                const bonusStr = pb > 0 ? ` +$${pb.toLocaleString()} house bonus` : '';
                player.lastSpecial = `⭐ ${result.playerSpecial.name} (${result.playerSpecial.multiplier}x)${bonusStr}`;
            } else if (pb > 0) {
                // Player had a special but didn't declare → bonus only, no multiplier claim
                player.lastSpecial = `⭐ Held ${pbName} (+$${pb.toLocaleString()} bonus — not declared, no multiplier)`;
            } else if (result.bankerSpecial) {
                player.lastSpecial = `🏦 Banker: ${result.bankerSpecial.name} (${result.bankerSpecial.multiplier}x)`;
            } else {
                player.lastSpecial = result.playerWins >= 2
                    ? `✅ Won ${result.playerWins}/3 hands`
                    : `❌ Lost ${result.playerWins}/3 hands`;
            }

            const outcome = result.payout >= 0 ? "WIN" : "LOSS";
            const why = result.playerSpecial ? `${result.playerSpecial.name}${pb>0?' +$'+pb+' house bonus':''}`
                      : result.bankerSpecial  ? `Banker: ${result.bankerSpecial.name}${pb>0?' | held '+pbName+' (+$'+pb+' bonus)':''}`
                      : pb > 0 ? `held ${pbName} (+$${pb} bonus, not declared)`
                      : `${result.playerWins}/3 hands`;
            console.log(`${player.username} | Bet:$${player.bet} | ${outcome} $${Math.abs(result.payout)}${pb>0?' (house bonus $'+pb+')':''} | ${why}`);
        });

        // ── Award banker bonus ONCE from the house ────────
        if (bankerBonusTotal > 0) {
            banker.chips += bankerBonusTotal;
            const tag = banker.declaredSpecial ? 'declared' : 'undeclared';
            console.log(`[BONUS] House pays banker $${bankerBonusTotal.toLocaleString()} bonus for ${bankerActual.name} (${tag})`);
        }

        // Store banker's special display
        const bs = banker.declaredSpecial;
        banker.lastSpecial = bs ? `⭐ ${bs.name} (${bs.multiplier}x)` : null;

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
            player.lastSpecial      = `❌ Bust — $${totalOwed.toLocaleString()} from bank`;
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
                console.log(`[REPLENISH] ${player.username} +$${amount} → wallet $${player.chips}`);
            } else {
                this.sendToClient(client, { type:'replenishResult', ok:false, error: res.error || 'Replenish failed' });
            }
        } catch(e) {
            this.sendToClient(client, { type:'replenishResult', ok:false, error:'Server error' });
        }
    }

    endGame() {
        this.gameState.status  = "gameOver";
        this.gameState.message = "Game Over! Final scores:";
        // Clear all freeze bets — must not persist to any future game
        Object.values(this.gameState.players).forEach(p => { p.frozen = false; });
        console.log("=== GAME OVER ===");
        this.broadcastState();
        // Settle: return each player's remaining chips to their bank
        this._settleToBank();
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
                console.error(`[SETTLE] ⚠️  ${player.username} has NO TOKEN — chips cannot be returned to bank!`);
                console.error(`[SETTLE] ⚠️  This means poker-server/index.js is NOT passing token through matchmake.`);
                console.error(`[SETTLE] ⚠️  Deploy the latest poker-server-index.js from outputs to fix this.`);
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
                    console.log(`[SETTLE] ✅ ${player.username}: returned $${returning} → new bank: $${res.newBankBalance}`);
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
                        console.log(`[SETTLE] 📊 ${player.username}: recorded ${isWin?'WIN':'LOSS'} mode=${mode}`);
                    } catch(e) {
                        console.warn(`[SETTLE] Stats recording failed for ${player.username}:`, e.message);
                    }
                    // Broadcast updated bank balance to the player's client
                    const sid = Object.keys(this.gameState.players).find(s => this.gameState.players[s] === player);
                    const c   = this.clients.find(c => c.sessionId === sid);
                    if (c) this.sendToClient(c, { type:'settleComplete', newBankBalance: res.newBankBalance, returned: returning });
                } else {
                    console.error(`[SETTLE] ❌ ${player.username}: exit API failed — ${res.error}`);
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
        const allSpecials = [
            { name:'Full Suit',                  multiplier:10, rank:8 },
            { name:'6½',                         multiplier:8,  rank:7 },
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

        // Server uses rawCards to verify — player hasn't arranged yet.
        // IMPORTANT: We must NOT split rawCards by deal order (0-2, 3-7, 8-12) because
        // the player hasn't arranged their hands yet — cards are in random deal order.
        // detectSpecial must examine all 13 cards as a whole to correctly identify
        // whole-hand specials (FFF, SSS, Full Suit, 6½, No Face, Four of a Kind).
        // For specials that require a specific arrangement (Royal Flush, Straight Flush),
        // we try all valid 3/5/5 splits to see if any arrangement yields the declared special.
        const raw = player.rawCards || [];
        if (raw.length !== 13) {
            this.sendToClient(client, { type:'error', message:'No cards dealt yet.' });
            return;
        }

        // Rule: HIGHEST special wins. detectSpecial returns the single
        // top-ranked special in the hand. The player must declare that exact
        // one — declaring a valid-but-lower special is still a DQ because it
        // violates the "highest special" rule.
        const h1 = raw.slice(0,3), h2 = raw.slice(3,8), h3 = raw.slice(8,13);
        const actual = Logic.detectSpecial(h1, h2, h3);

        if (!actual || actual.name !== specialName) {
            // Wrong declaration — DQ the player, but explain WHY
            player.disqualified     = true;
            const reasonDetail = actual
                ? `Your hand contains ${actual.name} (${actual.multiplier}x) — the highest special, which outranks your ${specialName} declaration.`
                : `Your hand contains no special — ${specialName} was not present.`;
            player.disqualifyReason = reasonDetail;
            player.lastSpecial      = actual
                ? `❌ Wrong — hand had ${actual.name}`
                : `❌ Wrong — no special in hand`;
            const penalty = player.bet * 2;
            player.chips           -= penalty;
            player.lastPayout       = -penalty;
            player.hand1 = h1; player.hand2 = h2; player.hand3 = h3; // reveal their cards
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            if (banker) banker.chips += penalty;
            console.log(`${player.username} DQ — declared ${specialName}, actually ${actual?.name || 'none'}`);
            this.sendToClient(client, {
                type:'specialDenied',
                declared: specialName,
                actual: actual ? actual.name : null,
                actualMultiplier: actual ? actual.multiplier : null,
                message: reasonDetail + ' You are disqualified (owes 2× bet).'
            });
            this.broadcast({ type:'playerDisqualified', username:player.username, reason:player.disqualifyReason });
        } else {
            // Correct! Record the special — payout happens at resolve phase
            player.declaredSpecial = chosen;
            // Auto-arrange cards for specials that need a specific split
            let arr = null;
            if (specialName === 'Straight-Straight-Straight')       arr = Logic.findSSSArrangement(raw);
            else if (specialName === 'Flush-Flush-Flush')           arr = Logic.findFFFArrangement(raw);
            else if (specialName === 'Straight Flush')              arr = Logic.findStraightFlushArrangement(raw);
            else if (specialName === 'Royal Flush')                 arr = Logic.findRoyalFlushArrangement(raw);
            if (arr) { player.hand1 = arr.hand1; player.hand2 = arr.hand2; player.hand3 = arr.hand3; }
            else     { player.hand1 = h1;        player.hand2 = h2;        player.hand3 = h3; }
            player.hasArranged = true;
            console.log(`${player.username} correctly declares special: ${specialName}`);
            this.sendToClient(client, { type:'specialConfirmed', specialName, multiplier: chosen.multiplier });
            // Alert the whole table
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
            target.lastSpecial      = "❌ DQ";
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified) {
                    const refund = p.bet * 2;      // win double on banker DQ
                    p.chips      += refund;
                    p.lastPayout  = refund;
                    target.chips -= refund;
                }
            });
            console.log(`BANKER ${target.username} DISQUALIFIED by ${requester.username}: ${violation}`);
        } else {
            // Player DQ: target owes 2× bet to banker
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            target.disqualified     = true;
            target.disqualifyReason = violation;
            target.lastSpecial      = "❌ DQ — owes 2× bet";
            const penalty = target.bet * 2;
            target.chips           -= penalty;
            target.lastPayout       = -penalty;
            if (banker) banker.chips += penalty;
            console.log(`${target.username} DISQUALIFIED by ${requester.username} — owes 2× bet: ${violation}`);
        }

        this.broadcast({ type:"playerDisqualified", username:target.username, reason:violation });
        this.broadcastState();
    }

    botArrange(p) {
        const best = Logic.findBestBotArrangement(p.rawCards);
        p.hand1 = best.hand1;
        p.hand2 = best.hand2;
        p.hand3 = best.hand3;
        p.hasArranged = true;
        // Auto-detect and declare specials for bots
        const special = Logic.detectSpecial(p.hand1, p.hand2, p.hand3);
        if (special) {
            p.declaredSpecial = special;
            console.log(`${p.username} auto-declares special: ${special.name}`);
        }
    }

    _applyTableConfigFromRoomId() {
        // If table config already set, skip
        if (this.gameState.tableMinBet > 0) return;

        const TABLE_CONFIG = {
            100:   { minBet:100,   increment:50,    maxBet:150,   walletSize:3000,    minBank:5000    },
            250:   { minBet:250,   increment:50,    maxBet:500,   walletSize:10000,   minBank:15000   },
            500:   { minBet:500,   increment:100,   maxBet:1000,  walletSize:20000,   minBank:30000   },
            1000:  { minBet:1000,  increment:500,   maxBet:2000,  walletSize:40000,   minBank:60000   },
            10000: { minBet:10000, increment:10000, maxBet:50000, walletSize:1000000, minBank:2000000 }
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
        console.log(`[ROOM] Table config applied from roomId: $${cfg.minBet} min / $${cfg.increment} inc`);
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
                isBanker:false, isBot:true, frozen:false,
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
        const interval = setInterval(() => {
            remaining--;
            // Guard: if game moved to a different phase, cancel this timer silently
            if (this.gameState.status !== phase) {
                clearInterval(interval);
                return;
            }
            this.gameState.timer = remaining;
            this.broadcastState();
            if (remaining<=0) { clearInterval(interval); onComplete(); }
        }, 1000);
        if (phase==="arranging") this.arrangeTimer = interval;
        if (phase==="betting")   this.betTimer     = interval;
        if (phase==="revealing") this.revealTimer  = interval;
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
    // ── CHAT BROADCAST ─────────────────────────────────────────
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

    // ── REQUEST CHIPS ────────────────────────────────────────
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

    // ── SEND CHIPS ───────────────────────────────────────────
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

        console.log(`[SEND] ${sender.username} → ${target.username}: $${amount}`);
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
