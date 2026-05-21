// ============================================
// RHUM32 GAME ROOM v1.0
// Pure JS — no Colyseus dependency
// Works with plain WebSocket server in index.js
//
// GAME FLOW:
//   waiting → betting (10s) → dealing4 → decision (10s) → dealing5 → revealing → roundEnd
//
// PHASES:
//   betting:   Players place Front Bet + optional Tie Bet (10s)
//   dealing4:  Deal 4 cards, dealer's 4th card face up
//   decision:  Players choose Push (fold) or Bet (back bet = 2x front) (10s)
//   dealing5:  Deal 5th card to remaining players + dealer
//   revealing: Show all hands, calculate payouts
//   roundEnd:  Brief pause before next round
// ============================================

const Logic = require("./logic.js");
const http  = require("http");

// Calls the VurgLife platform (localhost:3000) to settle bank transactions.
// Mirrors poker-server/PokerRoom.js callPlatformAPI so wallet draws stay
// server-authoritative (the client never moves bank money directly).
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
                "X-Game-Server":  "rhum32",
                "X-Game-Server-Secret": process.env.GAME_SERVER_SECRET || "vurglife_local_game_server_secret"
            }
        };
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
                catch (e) { resolve({ ok: false, raw: data }); }
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

class Rhum32Room {

    constructor() {
        this.clients      = [];
        this.betTimer     = null;
        this.decTimer     = null;
        this.revealTimer  = null;
        this.hostUsername = null;   // host-only Start gate

        this.gameState = {
            status:      "waiting",
            round:       0,
            maxRounds:   10,
            timer:       0,
            tableMinBet: 100,
            tableMaxBet: 500,
            tieBetMin:   50,
            tieBetMax:   100,
            players:     {},   // sessionId → player object
            dealer:      null, // { cards, shownCard, value }
            deck:        [],
            message:     ""
        };

        console.log("Rhum32 Room Created");
    }

    // ── TABLE CONFIG (from doc) ────────────────────────────────────
    static TABLE_CONFIG = {
        100:   { minBet: 100,   maxBet: 500,    tieBetMin: 50,   tieBetMax: 100,   minBank: 3000 },
        500:   { minBet: 500,   maxBet: 3000,   tieBetMin: 100,  tieBetMax: 500,   minBank: 15000 },
        1000:  { minBet: 1000,  maxBet: 5000,   tieBetMin: 500,  tieBetMax: 1000,  minBank: 25000 },
        5000:  { minBet: 5000,  maxBet: 10000,  tieBetMin: 1000, tieBetMax: 5000,  minBank: 100000 },
        10000: { minBet: 10000, maxBet: 100000, tieBetMin: 0,    tieBetMax: 999999, minBank: 1000000 }
    };

    // Called by index.js for every incoming message
    _dispatchMessage(type, client, data) {
        switch (type) {
            case "startGame":     this._onStartGame(client, data);     break;
            case "placeBet":      this._onPlaceBet(client, data);      break;
            case "placeTieBet":   this._onPlaceTieBet(client, data);   break;
            case "playerDecision":this._onPlayerDecision(client, data); break;
            case "freezeBet":     this._onFreezeBet(client, data);     break;
            case "requestState":  this._onRequestState(client, data);  break;
            case "sendChips":     this._onSendChips(client, data);     break;
            case "requestChips":  this._onRequestChips(client, data);  break;
            case "replenishWallet": this._onReplenishWallet(client, data); break;
            case "chat":          this._onChat(client, data);          break;
            default: console.log("Unknown message:", type);
        }
    }

    // ── MESSAGE HANDLERS ────────────────────────────────────────────

    _onStartGame(client, data) {
        if (this.gameState.status !== "waiting") return;
        // Only the room's host can start the game. Invitees / late-joiners
        // get ignored — their lobby UI hides the Start button anyway, but
        // a malformed/forged client can't bypass it server-side.
        const starter = this.gameState.players[client.sessionId];
        if (!starter || !starter.isHost) {
            console.log(`Non-host startGame ignored: ${starter ? starter.username : 'unknown'}`);
            return;
        }
        const roundCount = [5, 10, 20, 30].includes(data.rounds) ? data.rounds : 10;
        const minBet     = data.tableMinBet || 100;
        const cfg = Rhum32Room.TABLE_CONFIG[minBet] || Rhum32Room.TABLE_CONFIG[100];

        this.gameState.maxRounds   = roundCount;
        this.gameState.tableMinBet = cfg.minBet;
        this.gameState.tableMaxBet = cfg.maxBet;
        this.gameState.tieBetMin   = cfg.tieBetMin;
        this.gameState.tieBetMax   = cfg.tieBetMax;

        this.gameState.message = `Game starting! ${roundCount} rounds at $${cfg.minBet} table.`;
        this.broadcastState();
        setTimeout(() => this.startRound(), 2000);
    }

    _onPlaceBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "betting") return;
        if (player.frozen) return; // bet is frozen

        let amount = parseInt(data.amount) || this.gameState.tableMinBet;
        amount = Math.max(this.gameState.tableMinBet, Math.min(amount, this.gameState.tableMaxBet));
        // Clamp to wallet
        amount = Math.min(amount, Math.floor(player.wallet / 3)); // need 3x (front + 2x back)
        amount = Math.max(this.gameState.tableMinBet, amount);

        if (player.wallet < amount * 3) {
            this.sendToClient(client, { type: "error", message: "Insufficient wallet for this bet." });
            return;
        }

        player.frontBet = amount;
        player.hasBet   = true;
        this.broadcastState();
    }

    _onPlaceTieBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player) return;
        if (this.gameState.status !== "betting") {
            // Most common cause: client click landed ~ms after the betting
            // timer expired and dealFourCards() flipped status to 'decision'.
            // Tell the client so the UI can roll the displayed tie bet back
            // to the actually-recorded value, instead of leaving the player
            // believing the bet was placed.
            console.log(`[Rhum32] placeTieBet rejected (status=${this.gameState.status}) for ${player.username}, amount=${data?.amount}`);
            this.sendToClient(client, { type: "tieBetRejected", reason: "Betting window closed.", tieBet: player.tieBet || 0 });
            return;
        }

        let amount = parseInt(data.amount) || 0;
        if (amount === 0) { player.tieBet = 0; this.broadcastState(); return; }

        amount = Math.max(this.gameState.tieBetMin, Math.min(amount, this.gameState.tieBetMax));
        if (amount > player.wallet) {
            this.sendToClient(client, { type: "error", message: "Insufficient wallet for tie bet." });
            this.sendToClient(client, { type: "tieBetRejected", reason: "Insufficient wallet.", tieBet: player.tieBet || 0 });
            return;
        }
        player.tieBet = amount;
        this.broadcastState();
    }

    _onPlayerDecision(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || this.gameState.status !== "decision") return;
        if (player.folded || player.decided) return;

        const decision = data.decision; // "bet" or "push"
        if (decision === "push") {
            player.folded  = true;
            player.decided = true;
            // Surrender front bet
            player.wallet -= player.frontBet;
            player.totalPayout = -player.frontBet;
            player.result = "folded";
            player.description = "Folded. Front bet lost.";
            console.log(`${player.username} folds, loses front bet $${player.frontBet}`);
        } else if (decision === "bet") {
            const backBet = player.frontBet * 2;
            if (player.wallet < player.frontBet + backBet + player.tieBet) {
                // Cannot afford back bet — disqualify
                player.disqualified = true;
                player.decided = true;
                player.wallet -= player.frontBet;
                player.totalPayout = -player.frontBet;
                player.result = "disqualified";
                player.description = "Cannot afford back bet. Disqualified.";
                player.observeRounds = 1;
                console.log(`${player.username} can't afford back bet — DQ`);
                this.broadcast({ type: "playerDisqualified", username: player.username, reason: "Wallet depleted — cannot pay back bet." });
            } else {
                player.backBet = backBet;
                player.decided = true;
                player.result  = "playing";
                console.log(`${player.username} stays in, back bet $${backBet}`);
            }
        }

        this.broadcastState();
        this.checkAllDecided();
    }

    _onFreezeBet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player) return;
        player.frozen = !!data.freeze;
        this.broadcastState();
    }

    _onRequestState(client) {
        this.sendToClient(client, { type: "stateUpdate", state: this.getPublicState(client.sessionId) });
    }

    _onSendChips(client, data) {
        const sender   = this.gameState.players[client.sessionId];
        const receiver = this.gameState.players[data.targetSessionId];
        if (!sender || !receiver) return;
        const amount = parseInt(data.amount) || 0;
        if (amount <= 0 || amount > sender.wallet) return;
        sender.wallet   -= amount;
        receiver.wallet += amount;
        this.broadcast({ type: "chipTransfer", from: sender.username, to: receiver.username, amount });
        this.broadcastState();
    }

    _onRequestChips(client, data) {
        const requester = this.gameState.players[client.sessionId];
        const target    = this.gameState.players[data.targetSessionId];
        if (!requester || !target) return;
        this.sendToClient(this.findClient(data.targetSessionId), {
            type: "chipRequest", from: requester.username, fromSessionId: client.sessionId, amount: data.amount || 0
        });
    }

    // Server-authoritative wallet top-up (mirrors poker-server _onReplenishWallet).
    // The game server — not the client — calls the platform so the bank draw
    // and the in-game wallet stay in lock-step. Credits the platform's
    // authoritative topUp (may be < requested if wallet/bank-capped).
    async _onReplenishWallet(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || !player.token) {
            this.sendToClient(client, { type: "replenishResult", ok: false, error: "Not authorised" });
            return;
        }
        const amount = parseInt(data.amount) || 0;
        if (amount <= 0) {
            this.sendToClient(client, { type: "replenishResult", ok: false, error: "Invalid amount" });
            return;
        }
        try {
            const res = await callPlatformAPI('/api/game/replenish', player.token, {
                game:         'rhum32',
                amount,
                currentWallet: player.wallet,
                tableMinBet:   this.gameState.tableMinBet
            });
            if (res && res.ok) {
                const added = Number(res.topUp) || 0;
                player.wallet += added;
                // Track replenishes so the game-over net win/loss subtracts
                // every bank top-up rather than counting it as game winnings.
                player.replenishTotal = (player.replenishTotal || 0) + added;
                this.sendToClient(client, {
                    type: "replenishResult", ok: true,
                    added, newWallet: player.wallet, newBankBalance: res.newBankBalance
                });
                this.broadcastState();
                console.log(`[REPLENISH] ${player.username} +$${added} -> wallet $${player.wallet}`);
            } else {
                this.sendToClient(client, { type: "replenishResult", ok: false, error: (res && res.error) || "Replenish failed" });
            }
        } catch (e) {
            this.sendToClient(client, { type: "replenishResult", ok: false, error: "Server error" });
        }
    }

    _onChat(client, data) {
        const player = this.gameState.players[client.sessionId];
        if (!player || !data.message) return;
        const msg = String(data.message).substring(0, 200);
        this.broadcast({ type: "chat", username: player.username, message: msg });
    }

    // ── LIFECYCLE ───────────────────────────────────────────────────

    onJoin(client, options) {
        const username = options.username || ("Player_" + client.sessionId.substring(0, 4));
        const wallet   = options.wallet || 5000;
        const token    = options.token || null;
        // Only the FIRST joiner that explicitly claims host actually becomes
        // the host. Late-joiners / invitees never claim host.
        const claimsHost = options.isHost === true;
        const isHost     = claimsHost && !this.hostUsername;
        if (isHost) this.hostUsername = username;

        // Assign random seat (1-6)
        const takenSeats = Object.values(this.gameState.players).map(p => p.seat);
        const available  = [1, 2, 3, 4, 5, 6].filter(s => !takenSeats.includes(s));
        const seat = available.length > 0
            ? available[Math.floor(Math.random() * available.length)]
            : Object.keys(this.gameState.players).length + 1;

        this.gameState.players[client.sessionId] = {
            username,
            wallet,
            // Net game-over win/loss = wallet - startingWallet - replenishTotal.
            // startingWallet is the wallet at the moment the player joined the
            // room; replenishTotal sums every top-up drawn from bank during
            // play so the comparison stays honest.
            startingWallet: wallet,
            replenishTotal: 0,
            seat,
            isHost,
            frontBet:    0,
            backBet:     0,
            tieBet:      0,
            hasBet:      false,
            frozen:      false,
            folded:      false,
            decided:     false,
            disqualified:false,
            observeRounds: 0,
            cards:       [],
            totalPayout: 0,
            result:      "",
            description: "",
            tier:        null,
            playerValue: null,
            isBot:       false,
            token:       token
        };

        console.log(`${username} joined Rhum32 (seat ${seat}${isHost ? ', HOST' : ''}). Total: ${Object.keys(this.gameState.players).length}`);
        this.broadcastState();
    }

    onLeave(client) {
        const player = this.gameState.players[client.sessionId];
        if (!player) return;
        const wasHost = player.isHost;
        console.log(`${player.username} left Rhum32${wasHost ? ' (was host)' : ''}.`);
        // Return wallet to bank would happen via platform API
        delete this.gameState.players[client.sessionId];
        // If the host bails before the game starts, promote the next remaining
        // human so the table stays usable. After startGame, isHost becomes
        // informational only (start gate already passed).
        if (wasHost && this.gameState.status === 'waiting') {
            const next = Object.values(this.gameState.players).find(p => !p.isBot);
            if (next) {
                next.isHost = true;
                this.hostUsername = next.username;
                console.log(`Host promoted to ${next.username}.`);
            } else {
                this.hostUsername = null;
            }
        }
        this.broadcastState();
    }

    // ── GAME FLOW ───────────────────────────────────────────────────

    startRound() {
        // Clear ALL timers to prevent any leaks from previous round
        if (this.betTimer)    { clearInterval(this.betTimer);    this.betTimer    = null; }
        if (this.decTimer)    { clearInterval(this.decTimer);    this.decTimer    = null; }
        if (this.revealTimer) { clearInterval(this.revealTimer); this.revealTimer = null; }

        this.gameState.round++;
        if (this.gameState.round > this.gameState.maxRounds) { this.endGame(); return; }
        console.log(`--- Rhum32 Round ${this.gameState.round} ---`);

        // Check observer status — remove players who didn't replenish
        Object.entries(this.gameState.players).forEach(([sid, p]) => {
            if (p.observeRounds > 0) {
                p.observeRounds--;
                if (p.observeRounds <= 0 && p.disqualified) {
                    // Still can't play — terminate
                    const minNeeded = this.gameState.tableMinBet * 3;
                    if (p.wallet < minNeeded) {
                        console.log(`${p.username} terminated — wallet not replenished.`);
                        this.broadcast({ type: "playerTerminated", username: p.username, reason: "Wallet not replenished." });
                        delete this.gameState.players[sid];
                        return;
                    }
                    p.disqualified = false;
                }
            }
        });

        // Reset round state for all players
        Object.values(this.gameState.players).forEach(p => {
            // Freeze applies to BOTH the round (front) bet and the tie bet —
            // a frozen player wants the same wagers locked in across rounds.
            // Non-frozen players get a fresh round (front=tableMinBet, tie=0).
            p.frontBet    = p.frozen ? p.frontBet : this.gameState.tableMinBet;
            p.backBet     = 0;
            p.tieBet      = p.frozen ? (p.tieBet || 0) : 0;
            p.hasBet      = true; // all active players have a bet (frozen keeps previous, others get tableMinBet)
            p.folded      = false;
            p.decided     = false;
            p.cards       = [];
            p.totalPayout = 0;
            p.result      = "";
            p.description = "";
            p.tier        = null;
            p.playerValue = null;
            if (p.disqualified && p.observeRounds > 0) {
                p.hasBet = false; // observers don't bet
            }
        });

        this.gameState.dealer = { cards: [], shownCard: null, value: null };
        this.gameState.deck   = Logic.shuffleDeck(Logic.createDeck());

        // Betting phase
        this.gameState.status  = "betting";
        this.gameState.timer   = 10;
        this.gameState.message = `Round ${this.gameState.round} — Place your Front Bet! (${this.gameState.timer}s)`;
        this.broadcastState();

        this.startCountdown(10, "betting", () => this.dealFourCards());
    }

    dealFourCards() {
        if (this.betTimer) { clearInterval(this.betTimer); this.betTimer = null; }

        // Players who didn't bet in time miss this round
        Object.values(this.gameState.players).forEach(p => {
            if (!p.hasBet && !p.disqualified && !p.isBot) {
                p.folded = true;
                p.result = "missed";
                p.description = "Missed betting window.";
            }
        });

        const deck    = this.gameState.deck;
        const active  = Object.values(this.gameState.players).filter(p => !p.folded && !p.disqualified);

        // Deal 4 cards to each active player, one at a time, left to right, then dealer
        // (Simplified: deal 4 to each)
        active.forEach(p => {
            p.cards = Logic.dealCards(deck, 4);
        });

        // Dealer gets 4 cards, 4th is face up
        const dealerCards = Logic.dealCards(deck, 4);
        this.gameState.dealer = {
            cards:     dealerCards,
            shownCard: dealerCards[3], // 4th card shown
            value:     null
        };

        this.gameState.status  = "decision";
        this.gameState.timer   = 10;
        this.gameState.message = `Dealer shows: ${this.formatCard(dealerCards[3])}. Stay or fold? (${this.gameState.timer}s)`;
        this.broadcastState();

        this.startCountdown(10, "decision", () => this.autoDecide());
    }

    autoDecide() {
        if (this.decTimer) { clearInterval(this.decTimer); this.decTimer = null; }

        // Players who didn't decide: auto-fold
        Object.values(this.gameState.players).forEach(p => {
            if (!p.folded && !p.disqualified && !p.decided) {
                p.folded  = true;
                p.decided = true;
                p.wallet -= p.frontBet;
                p.totalPayout = -p.frontBet;
                p.result = "auto_fold";
                p.description = "Auto-folded (no decision made).";
                console.log(`${p.username} auto-folded`);
            }
        });

        // Check if ALL players folded
        const remaining = Object.values(this.gameState.players).filter(
            p => !p.folded && !p.disqualified && p.result === "playing"
        );

        // Always deal 5th card — even if all players folded
        this.dealFifthCard();
    }

    dealFifthCard() {
        const deck = this.gameState.deck;

        // Deal 5th card to remaining players
        Object.values(this.gameState.players).forEach(p => {
            if (!p.folded && !p.disqualified && p.result === "playing") {
                const fifth = Logic.dealCards(deck, 1);
                p.cards = [...p.cards, ...fifth];
            }
        });

        // Dealer gets 5th card
        const dealerFifth = Logic.dealCards(deck, 1);
        this.gameState.dealer.cards = [...this.gameState.dealer.cards, ...dealerFifth];
        this.gameState.dealer.value = Logic.calculateHandValue(this.gameState.dealer.cards);

        // Reveal and resolve
        this.resolveRound();
    }

    resolveRound() {
        const dealer      = this.gameState.dealer;
        const dealerValue = dealer.value;
        const dealerCrossed = dealerValue > 32;

        console.log(`Dealer hand: ${Logic.formatHand(dealer.cards)} = ${dealerValue}${dealerCrossed ? ' (BUST)' : ''}`);

        Object.values(this.gameState.players).forEach(p => {
            if (p.folded || p.disqualified || p.result !== "playing") return;

            const resolution = Logic.resolvePlayerVsDealer(
                p.cards, dealer.cards, p.frontBet, p.backBet, p.tieBet
            );

            p.playerValue = resolution.playerValue;
            p.tier        = resolution.tier;
            p.result      = resolution.result;
            p.description = resolution.description;

            // Calculate net wallet change
            if (resolution.result === "dealer_bust") {
                // Dealer bust: front 1:1, bonus for value specials, back for face specials (47-50),
                // AND tie bet pays 20:1 (player did not fold — stayed in to reach here).
                p.wallet     += resolution.frontPayout + resolution.backPayout + resolution.bonus + resolution.tiePayout;
                p.totalPayout = resolution.frontPayout + resolution.backPayout + resolution.bonus + resolution.tiePayout;
            } else if (resolution.result === "tie") {
                // Tie: bets returned, only tie bet pays
                p.totalPayout = resolution.tiePayout;
                p.wallet += resolution.tiePayout;
                if (p.tieBet > 0 && resolution.tiePayout === 0) {
                    p.wallet -= p.tieBet; // tie bet lost
                    p.totalPayout -= p.tieBet;
                }
            } else if (resolution.result === "player_win") {
                // Win: front 1:1 + back at multiplier + bonus
                p.wallet     += resolution.frontPayout + resolution.backPayout + resolution.bonus;
                p.totalPayout = resolution.frontPayout + resolution.backPayout + resolution.bonus;
                if (p.tieBet > 0) {
                    p.wallet -= p.tieBet; // tie bet lost (didn't tie)
                    p.totalPayout -= p.tieBet;
                }
            } else if (resolution.result === "dealer_win") {
                // Lose: lose front + back bets
                p.wallet     += resolution.frontPayout + resolution.backPayout; // negative values
                p.totalPayout = resolution.frontPayout + resolution.backPayout;
                if (p.tieBet > 0) {
                    p.wallet -= p.tieBet; // tie bet also lost
                    p.totalPayout -= p.tieBet;
                }
            }

            const sign = p.totalPayout >= 0 ? '+' : '';
            console.log(`${p.username} | Hand: ${p.playerValue} | ${p.result} | ${sign}$${p.totalPayout}`);
        });

        this.gameState.status  = "revealing";
        this.gameState.timer   = 15;
        this.gameState.message = dealerCrossed
            ? `Dealer BUSTED with ${dealerValue}! All staying players win front bet.`
            : `Dealer has ${dealerValue}. Results are in!`;
        this.broadcastState();

        this.startCountdown(15, "revealing", () => {
            this.gameState.status  = "roundEnd";
            this.gameState.message = `Round ${this.gameState.round} complete.`;
            this.broadcastState();
            setTimeout(() => this.startRound(), 3000);
        });
    }

    endGame() {
        this.gameState.status  = "gameOver";
        this.gameState.message = "Game Over! Final wallets:";
        console.log("=== RHUM32 GAME OVER ===");
        Object.values(this.gameState.players).forEach(p => {
            console.log(`  ${p.username}: $${p.wallet}`);
        });
        this.broadcastState();
    }

    // ── HELPERS ──────────────────────────────────────────────────────

    checkAllDecided() {
        const undecided = Object.values(this.gameState.players).filter(
            p => !p.folded && !p.disqualified && !p.decided && p.hasBet
        );
        if (undecided.length === 0) {
            if (this.decTimer) { clearInterval(this.decTimer); this.decTimer = null; }
            this.autoDecide();
        }
    }

    startCountdown(seconds, phase, onComplete) {
        let remaining = seconds;
        const interval = setInterval(() => {
            remaining--;
            this.gameState.timer = remaining;
            this.broadcastState();
            if (remaining <= 0) { clearInterval(interval); onComplete(); }
        }, 1000);
        if (phase === "betting")   this.betTimer    = interval;
        if (phase === "decision")  this.decTimer    = interval;
        if (phase === "revealing") this.revealTimer  = interval;
    }

    formatCard(card) {
        const rank = card[0] === 'T' ? '10' : card[0];
        const suitMap = { h: '\u2665', d: '\u2666', c: '\u2663', s: '\u2660' };
        return rank + (suitMap[card[1]] || card[1]);
    }

    getPublicState(forSessionId) {
        const state = JSON.parse(JSON.stringify(this.gameState));
        // Remove deck from public state
        delete state.deck;

        Object.entries(state.players).forEach(([sid, player]) => {
            // Never broadcast the platform JWT to any client.
            delete player.token;
            // Hide other players' cards during betting/decision phases
            if (sid !== forSessionId) {
                if (state.status === "betting" || state.status === "decision") {
                    player.cards = player.cards.map(() => "??");
                }
            }
        });

        // Dealer: only show the shownCard until revealing phase
        if (state.dealer && state.status !== "revealing" && state.status !== "roundEnd" && state.status !== "gameOver") {
            const shown = state.dealer.shownCard;
            state.dealer.cards = state.dealer.cards.map((c, i) => i === 3 ? c : "??");
            state.dealer.value = null; // hide until reveal
        }

        return state;
    }

    broadcastState() {
        this.clients.forEach(c => this.sendToClient(c, {
            type: "stateUpdate", state: this.getPublicState(c.sessionId)
        }));
    }

    broadcast(msg) {
        this.clients.forEach(c => this.sendToClient(c, msg));
    }

    sendToClient(client, msg) {
        if (!client) return;
        try { client.send(JSON.stringify(msg)); }
        catch (e) { console.error("sendToClient error:", e.message); }
    }

    findClient(sessionId) {
        return this.clients.find(c => c.sessionId === sessionId) || null;
    }
}

exports.Rhum32Room = Rhum32Room;
