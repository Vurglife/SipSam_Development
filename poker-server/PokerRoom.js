// ============================================
// SIPSAM GAME ROOM v6.0
// Pure JS — no Colyseus dependency
// Works with plain WebSocket server in index.js
// ============================================

const Logic = require("./logic.js");

class SipSamRoom {

    constructor() {
        this.clients      = [];
        this.arrangeTimer = null;
        this.betTimer     = null;
        this.revealTimer  = null;

        this.gameState = {
            status:          "waiting",
            round:           0,
            maxRounds:       10,
            pot:             0,
            timer:           0,
            tableMinBet:     10,
            tableMaxBet:     30,
            bankerSessionId: "",
            players:         {},
            message:         ""
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
            case "disqualifyPlayer":  this._onDisqualifyPlayer(client, data);  break;
            case "declareSpecial":    this._onDeclareSpecial(client, data);    break;
            default: console.log("Unknown message:", type);
        }
    }

    _onStartGame(client, data) {
        console.log("startGame:", JSON.stringify(data));
        if (this.gameState.status !== "waiting") return;
        const roundCount = [10,20,30].includes(data.rounds) ? data.rounds : 10;
        const minBet     = [10,25,50,100].includes(data.tableMinBet) ? data.tableMinBet : 10;
        const maxBetMap  = {10:30, 25:75, 50:150, 100:300};
        this.gameState.maxRounds   = roundCount;
        this.gameState.tableMinBet = minBet;
        this.gameState.tableMaxBet = maxBetMap[minBet] || minBet * 3;
        this.beginGame();
    }

    _onPlaceBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "betting" || player.isBanker) return;
        const tMin = this.gameState.tableMinBet;
        let amount = parseInt(data.amount) || tMin;
        const tMax = this.gameState.tableMaxBet || (tMin * 3);
        amount = Math.max(tMin, Math.min(amount, tMax));
        amount = Math.round(amount / 10) * 10;
        player.bet = amount;
        console.log(player.username, "bet:", amount);
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
        if (orderErr) { this.sendToClient(client, { type:"error", message:orderErr }); return; }
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
        this.gameState.players[client.sessionId] = {
            username, chips:1000, bet:0,
            isBanker:false, isBot:false,
            hand1:[], hand2:[], hand3:[], rawCards:[],
            hasArranged:false, disqualified:false,
            lastPayout:0, lastSpecial:null, wins:0
        };
        console.log(username, "joined. Total:", Object.keys(this.gameState.players).length);
        this.fillBotsIfNeeded();
        this.broadcastState();
    }

    onLeave(client, consented) {
        const player = this.gameState.players[client.sessionId];
        if (!player) return;
        console.log(player.username, "left.");
        if (player.isBanker) {
            player.isBot = true; player.username = "Bot_Banker";
            console.log("Banker left — bot takes over.");
        } else {
            player.isBot = true;
            player.username = "Bot_" + client.sessionId.substring(0,4);
        }
        this.broadcastState();
    }

    // ==================== GAME FLOW ====================

    beginGame() {
        this.gameState.round = 0;
        // Random banker — stays for entire game
        const ids      = Object.keys(this.gameState.players);
        const bankerId = ids[Math.floor(Math.random() * ids.length)];
        this.gameState.players[bankerId].isBanker = true;
        this.gameState.bankerSessionId = bankerId;
        const bankerName = this.gameState.players[bankerId].username;
        console.log("Banker for this game:", bankerName);
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
            banker.isBot = true; banker.username = "Bot_Banker";
            console.log("Banker bankrupt — bot takes over.");
        }

        Object.values(this.gameState.players).forEach(p => {
            p.bet            = p.isBanker ? 0 : this.gameState.tableMinBet;
            p.lastPayout     = 0; p.lastSpecial = null;
            p.disqualified   = false; p.disqualifyReason = null;
            p.declaredSpecial = null; p.declaredSpecialName = null;
            p.handResults = null;
            p.hand1=[]; p.hand2=[]; p.hand3=[];
            p.rawCards=[]; p.hasArranged=false;
        });
        Object.values(this.gameState.players).forEach(p => {
            if (p.isBot && !p.isBanker) p.bet = this.gameState.tableMinBet;
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
            p.rawCards = Logic.dealPlayerCards(deck);
            p.hasArranged = false;
            if (p.isBot) this.botArrange(p);
        });
        this.gameState.status  = "arranging";
        this.gameState.timer   = 90;
        this.gameState.message = "Cards dealt! Arrange hands. (1st=weakest, 3rd=strongest)";
        this.broadcastState();
        this.startCountdown(90, "arranging", () => {
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
            banker.lastSpecial      = '❌ DQ — banker too slow';
            Object.values(this.gameState.players).forEach(p => {
                if (!p.isBanker && !p.disqualified && p.bet > 0) {
                    const prize  = p.bet * 2;
                    p.chips      += prize;
                    p.lastPayout  = prize;
                    banker.chips -= prize;
                }
            });
            console.log(banker.username, "BANKER DISQUALIFIED — did not arrange. Players paid 2x bet.");
            this.broadcast({ type:"playerDisqualified", username:banker.username, reason:"Banker disqualified — all players win 2× their bet." });
            return;
        }

        // Disqualify players who didn't arrange
        Object.values(this.gameState.players).forEach(p => {
            if (!p.hasArranged && !p.isBot && !p.disqualified && !p.isBanker) {
                p.disqualified     = true;
                p.disqualifyReason = "Did not arrange cards in time.";
                p.chips           -= p.bet;
                p.lastPayout       = -p.bet;
                p.lastSpecial      = '❌ DQ — too slow';
                // Do NOT auto-assign hands — player loses bet, excluded from scoring
                if (banker) banker.chips += p.bet;
                console.log(p.username, "DISQUALIFIED — did not arrange in time.");
                this.broadcast({ type:"playerDisqualified", username:p.username, reason:"Did not arrange cards in time." });
            }
        });
    }

    startRevealPhase() {
        if (this.arrangeTimer) clearInterval(this.arrangeTimer);
        this.gameState.status  = "revealing";
        this.gameState.timer   = 30;
        this.gameState.message = "All hands revealed! Processing payouts...";
        this.resolveAllHands();
        this.broadcastState();
        this.startCountdown(30, "revealing", () => {
            this.gameState.status  = "roundEnd";
            this.gameState.message = `Round ${this.gameState.round} complete!`;
            this.broadcastState();
            setTimeout(() => this.startRound(), 3000);
        });
    }

    // Verify if a disqualification request is valid
    _verifyDisqualification(target) {
        // Check 1: Invalid hand order
        const orderErr = Logic.validateHandOrder(target.hand1, target.hand2, target.hand3);
        if (orderErr) return `Invalid hand arrangement: ${orderErr}`;

        // Check 2: Has a special but did not declare it
        const actualSpecial = Logic.detectSpecial(target.hand1, target.hand2, target.hand3);
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
        if (!banker || banker.disqualified || !banker.hand1?.length) return;
        const bankerHands = { hand1:banker.hand1, hand2:banker.hand2, hand3:banker.hand3 };

        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (player.isBanker || player.disqualified || !player.hand1?.length) return;

            const result = Logic.resolveRound(
                { hand1:player.hand1, hand2:player.hand2, hand3:player.hand3 },
                bankerHands,
                player.bet,
                player.declaredSpecial || null,
                banker.declaredSpecial || null
            );

            player.chips     += result.payout;
            player.lastPayout = result.payout;
            player.handResults = result.handResults || null;
            banker.chips     -= result.payout;
            if (result.payout > 0) player.wins++;

            if (result.playerSpecial) {
                player.lastSpecial = `⭐ ${result.playerSpecial.name} (${result.playerSpecial.multiplier}x)`;
            } else if (result.bankerSpecial) {
                player.lastSpecial = `🏦 Banker: ${result.bankerSpecial.name}`;
            } else {
                player.lastSpecial = result.playerWins >= 2
                    ? `✅ Won ${result.playerWins}/3 hands`
                    : `❌ Lost ${result.playerWins}/3 hands`;
            }

            const outcome = result.payout >= 0 ? "WIN" : "LOSS";
            const why = result.playerSpecial ? result.playerSpecial.name
                      : result.bankerSpecial  ? "Banker: "+result.bankerSpecial.name
                      : `${result.playerWins}/3 hands`;
            console.log(`${player.username} | Bet:$${player.bet} | ${outcome} $${Math.abs(result.payout)} | ${why}`);
        });

        // Store banker's special display
        const bs = banker.declaredSpecial;
        banker.lastSpecial = bs ? `⭐ ${bs.name} (${bs.multiplier}x)` : null;

        // Wallet debt: if a player ends with negative chips, they owe the remainder
        // from their wallet outside the game. They are removed from the game.
        Object.entries(this.gameState.players).forEach(([sid, player]) => {
            if (player.isBanker || player.disqualified || player.chips >= 0) return;
            const debt = Math.abs(player.chips);
            banker.chips += debt; // wallet payment goes to banker
            player.chips = 0;
            player.disqualified     = true;
            player.disqualifyReason = `Wallet debt: owes $${debt} outside game.`;
            player.lastSpecial      = `❌ Owes $${debt} from wallet`;
            console.log(`${player.username} wallet debt: $${debt} — removed from game.`);
            this.broadcast({ type:'walletDebt', username:player.username, debt,
                reason:`${player.username} owes $${debt} from their wallet and has been removed.` });
        });
    }

    endGame() {
        this.gameState.status="gameOver"; this.gameState.message="Game Over! Final scores:";
        console.log("=== GAME OVER ===");
        this.broadcastState();
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

        // Server uses rawCards to verify — player hasn't arranged yet
        // Detect what special they actually have across their raw cards
        // For declaration, we split rawCards the natural way: first 3, next 5, last 5
        const raw = player.rawCards || [];
        if (raw.length !== 13) {
            this.sendToClient(client, { type:'error', message:'No cards dealt yet.' });
            return;
        }
        const h1 = raw.slice(0,3), h2 = raw.slice(3,8), h3 = raw.slice(8,13);
        const actual = Logic.detectSpecial(h1, h2, h3);

        if (!actual || actual.name !== specialName) {
            // Wrong declaration — DQ the player
            player.disqualified     = true;
            player.disqualifyReason = `Declared ${specialName} but ${actual ? 'has ' + actual.name : 'no special found'}.`;
            player.lastSpecial      = '❌ Wrong special — DQ';
            player.chips           -= player.bet;
            player.lastPayout       = -player.bet;
            player.hand1 = h1; player.hand2 = h2; player.hand3 = h3; // reveal their cards
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            if (banker) banker.chips += player.bet;
            console.log(`${player.username} DQ — declared ${specialName}, actually ${actual?.name || 'none'}`);
            this.sendToClient(client, { type:'specialDenied', message:`Wrong special. You are disqualified.` });
            this.broadcast({ type:'playerDisqualified', username:player.username, reason:player.disqualifyReason });
        } else {
            // Correct! Record the special — payout happens at resolve phase
            player.declaredSpecial = chosen;
            player.hand1 = h1; player.hand2 = h2; player.hand3 = h3;
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
            // Player DQ: target loses bet to banker
            const banker = this.gameState.players[this.gameState.bankerSessionId];
            target.disqualified     = true;
            target.disqualifyReason = violation;
            target.lastSpecial      = "❌ DQ";
            target.chips           -= target.bet;
            target.lastPayout       = -target.bet;
            if (banker) banker.chips += target.bet;
            console.log(`${target.username} DISQUALIFIED by ${requester.username}: ${violation}`);
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

    fillBotsIfNeeded() {
        const needed = 4 - Object.keys(this.gameState.players).length;
        for (let i=0; i<needed; i++) {
            const botId = "bot_"+i+"_"+Date.now();
            this.gameState.players[botId] = {
                username:"Bot_"+(i+1), chips:1000, bet:0,
                isBanker:false, isBot:true,
                hand1:[], hand2:[], hand3:[], rawCards:[],
                hasArranged:false, disqualified:false,
                lastPayout:0, lastSpecial:null, wins:0
            };
        }
        // Shuffle the seat order so the human player gets a random position
        // (JS object insertion order determines seat assignment on the client)
        const entries = Object.entries(this.gameState.players);
        for (let i = entries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [entries[i], entries[j]] = [entries[j], entries[i]];
        }
        this.gameState.players = Object.fromEntries(entries);
    }

    startCountdown(seconds, phase, onComplete) {
        let remaining = seconds;
        const interval = setInterval(() => {
            remaining--;
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
        Object.entries(state.players).forEach(([sid, player]) => {
            // Always expose whether this player has been dealt cards (for table display)
            player.hasCards = player.rawCards && player.rawCards.length > 0;
            if (sid !== forSessionId) {
                player.rawCards=[];
                if (state.status==="arranging"||state.status==="betting") {
                    player.hand1=[]; player.hand2=[]; player.hand3=[];
                }
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
    broadcast(msg)     { this.clients.forEach(c => this.sendToClient(c, msg)); }

    sendToClient(client, msg) {
        try { client.send(JSON.stringify(msg)); }
        catch(e) { console.error("sendToClient error:", e.message); }
    }
}

exports.SipSamRoom = SipSamRoom;
