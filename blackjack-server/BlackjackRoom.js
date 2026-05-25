'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Blackjack — BlackjackRoom.js
// Supports: up to 6 players, chat, player-financed bots, invites.
// Owner: Amit Ramoutar
// ─────────────────────────────────────────────────────────────

const {
  buildDeck, buildShoe, calcHandFull, isBlackjack, isAcePair,
  isTenValuePair, dealerShouldHit, resolveHand, calcPayout,
  evalSpecialBet, evalDealerBustBonus,
} = require('./logic');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:3000';
const MAX_SEATS    = 6;
const SIDE_BETS    = ['island_blackjack','triple_7s','rum_runner','dealer_bust_bonus','tie_bet'];
const INSURANCE_AMOUNT  = 50;   // Fixed $50 insurance

// Bot plays basic strategy: hit < 17, stand >= 17
function botDecide(hand) {
  return calcHandFull(hand).total < 17 ? 'hit' : 'stand';
}

const PHASE_MS = {
  betting: 10000,       // 10s to place bets
  deal: 800,            // Fast deal — cards appear quickly
  insurance: 7000,      // 7s to decide insurance
  player_action: 10000, // 10s per player turn
  dealer: 200,          // Dealer draws fast
  payout: 3000,         // Show results 3s
  round_end: 2000,      // Brief pause before next round
};

class BlackjackRoom {
  constructor(roomId, tableConfig) {
    this.roomId      = roomId;
    this.config      = tableConfig;
    this.phase       = 'waiting';
    this.deck        = buildDeck(); // Fresh deck each round
    this.dealerCards = [];
    this.seats       = {};
    this.activeSeat  = null;
    this.phaseTimer  = null;
    this.roundNum    = 0;
    this.clients     = new Map();
    this._recentExits = new Map();
    this.chatHistory  = [];
    this.createdAt    = Date.now();
  }
  addClient(ws, userId, sessionId, token, join = {}) {
    const joinRole = join.joinRole === 'guest' ? 'guest' : 'player';
    let si = this._findSeatForSession(sessionId) ?? this._claimSeat(userId, sessionId, joinRole);
    if (si === null) { ws.close(1008, 'Table full'); return; }

    // Store the JWT on the seat so server-side settle calls can authenticate
    if (token && this.seats[si]) this.seats[si].token = token;
    if (this.seats[si] && joinRole === 'guest') {
      this.seats[si].joinRole = 'guest';
      this.seats[si].isInvitedGuest = true;
    }

    this.clients.set(ws, { userId, sessionId, seatIndex: si });
    ws.on('message', raw => { try { this._handleMsg(ws, JSON.parse(raw)); } catch(e) {} });
    ws.on('close',   ()  => this._onDisconnect(ws));

    this._sendTo(ws, { type:'state',       state: this._state(userId) });
    this._sendTo(ws, { type:'chatHistory', messages: this.chatHistory });
    // Tell everyone else at the table that a new seat was filled
    this._broadcast({ type:'state', state: this._state() });
  }

  _findSeatForSession(sid) {
    for (const [i,s] of Object.entries(this.seats)) if (s.sessionId===sid) return +i;
    return null;
  }

  _claimSeat(userId, sessionId, joinRole='player') {
    // Find all available seats
    const available = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      if (!this.seats[i]) available.push(i);
    }
    if (!available.length) return null;
    // Pick a random available seat — no sequential bias
    const i = available[Math.floor(Math.random() * available.length)];
    this.seats[i] = this._newSeat(userId, sessionId, i, false, null, joinRole);
    return i;
  }

  _newSeat(userId, sessionId, index, isBot=false, ownerIdx=null, joinRole='player') {
    // Humans start with the configured walletSize; bots hold no chips.
    const initialWallet = isBot ? 0 : (this.config.walletSize || 0);
    const normalizedRole = isBot ? 'bot' : (joinRole === 'guest' ? 'guest' : 'player');
    return {
      userId, sessionId, index, isBot, ownerIdx, token:null,
      joinRole:normalizedRole, isInvitedGuest:normalizedRole==='guest', joinedAt:Date.now(),
      wallet:initialWallet, bet:0, handBets:[0], insuranceBet:0, insuranceDeclined:false, tieBet:0, sideBet:null, sideBetAmt:0,
      hands:[[]], activeHandIdx:0,
      doubled:[false], stood:[false], busted:[false], splitAces:false,
      result:[null], payout:[0], sideBetResult:null,
      acted:false, connected:true,
      displayName: isBot ? `Bot_${index+1}` : `Player ${index+1}`,
      avatar:'', streakWins:0,
    };
  }

  _baseBet(seat) {
    return Math.max(0, Number(seat?.bet) || 0);
  }

  _ensureHandBets(seat) {
    const hands = (Array.isArray(seat?.hands) && seat.hands.length) ? seat.hands : [[]];
    const base = this._baseBet(seat);
    if (!Array.isArray(seat.handBets)) seat.handBets = [];
    for (let hi = 0; hi < hands.length; hi++) {
      if (!(Number(seat.handBets[hi]) > 0)) seat.handBets[hi] = base;
    }
    seat.handBets.length = hands.length;
    return seat.handBets;
  }

  _handBet(seat, hi) {
    const bets = this._ensureHandBets(seat);
    return Math.max(0, Number(bets[hi]) || this._baseBet(seat));
  }

  _mainStake(seat) {
    return this._ensureHandBets(seat).reduce((sum, bet) => sum + (Number(bet) || 0), 0);
  }

  _onDisconnect(ws) {
    const info = this.clients.get(ws);
    if (!info) return;
    this.clients.delete(ws);
    const { userId, seatIndex: si } = info;
    const seat = this.seats[si];
    if (!seat) return;

    // Auto-stand if it was their turn
    if (this.phase === 'player_action' && this.activeSeat === si) {
      this._autoStand(si);
    }

    if (this.phase === 'waiting' || this.phase === 'betting' || this.phase === 'round_end') {
      // Safe to remove immediately — not mid-round
      if (seat.wallet > 0 && seat.token) {
        this._callPlatform('/api/game/bj/exit', {
          remainingWallet: seat.wallet, tableMinBet: this.config.minBet
        }, seat.token).catch(e => console.error('[BJ] exit on disconnect:', e.message));
      }
      // Remove owned bots
      for (const [i,b] of Object.entries(this.seats)) {
        if (b.isBot && b.ownerIdx === si) delete this.seats[i];
      }
      delete this.seats[si];
      console.log(`[BJ] Seat ${si} (${userId}) removed on disconnect`);
    } else {
      // Mid-round — mark disconnected but keep seat until round ends
      seat.connected = false;
    }

    this._broadcast({ type:'state', state:this._state() });
  }

  _hostSeatIndex() {
    const host = Object.entries(this.seats)
      .filter(([, s]) => s && !s.isBot && s.joinRole !== 'guest' && !s.isInvitedGuest)
      .sort((a, b) => ((a[1].joinedAt || 0) - (b[1].joinedAt || 0)) || ((+a[0]) - (+b[0])))[0];
    return host ? Number(host[0]) : null;
  }

  _isHost(si) {
    return this._hostSeatIndex() === si;
  }

  // ── Message Router ───────────────────────────────────────────

  _handleMsg(ws, msg) {
    const info = this.clients.get(ws);
    if (!info) return;
    const { userId, seatIndex: si } = info;
    switch (msg.type) {
      case 'place_bet':   this._placeBet(si, msg.amount); break;
      case 'place_side':  this._placeSide(si, msg.bet, msg.amount); break;
      case 'place_tie':   this._placeTieBet(si); break;
      case 'insurance':   this._insurance(si, msg.take); break;
      case 'hit':         this._hit(si); break;
      case 'stand':       this._stand(si); break;
      case 'double':      this._double(si); break;
      case 'split':       this._split(si); break;
      // set_wallet is IGNORED — wallet is server-authoritative. Kept for backward
      // compat with old clients that still emit it on connect; silently drop.
      case 'set_wallet':  break;
      // add_wallet: used by the replenish flow. Platform route /api/game/replenish
      // already deducted the bank, so we trust a bounded positive delta here.
      case 'add_wallet': {
        const s = this.seats[si]; if (!s) break;
        const delta = Math.max(0, Math.min(Number(msg.amount)||0, 1_000_000));
        if (delta > 0) {
          s.wallet += delta;
          this._broadcast({ type:'state', state:this._state() });
        }
        break;
      }
      case 'set_name':    { const s=this.seats[si]; if(s&&!s.isBot) { s.displayName=String(msg.name||'').slice(0,20); this._broadcast({type:'state',state:this._state()}); } break; }
      case 'set_avatar':  { const s=this.seats[si]; if(s) { s.avatar=String(msg.avatar||'').slice(0,10); this._broadcast({type:'state',state:this._state()}); } break; }
      case 'add_bot':     this._addBot(ws, si); break;
      case 'chatMessage': this._chat(info, msg.message); break;
      case 'leave':       this._leave(ws, userId, si); break;
      case 'startGame':
        if (this.phase === 'waiting') {
          if (this._isHost(si)) this._startBetting();
          else this._sendTo(ws, { type:'toast', title:'Host Only', message:'Only the host can start this table.' });
        }
        break;
    }
  }

  // ── Chat ─────────────────────────────────────────────────────

  _chat(info, rawMessage) {
    const seat = this.seats[info.seatIndex];
    if (!seat || seat.isBot) return;
    const message = String(rawMessage||'').trim().slice(0,120);
    if (!message) return;

    const m = { sessionId:info.sessionId, seatIndex:info.seatIndex,
                username:seat.displayName, avatar:seat.avatar||'', message, ts:Date.now() };
    this.chatHistory.push(m);
    if (this.chatHistory.length > 50) this.chatHistory.shift();
    this._broadcast({ type:'chatMessage', ...m });
  }

  // ── Bots ─────────────────────────────────────────────────────

  _addBot(ws, ownerIdx) {
    if (Object.keys(this.seats).length >= MAX_SEATS) {
      this._sendTo(ws, { type:'toast', title:'Table Full', message:'Cannot add bot — all seats taken.' });
      return;
    }
    const owner = this.seats[ownerIdx];
    if (!owner || owner.isBot) return;

    let botIdx = null;
    for (let i=0; i<MAX_SEATS; i++) { if (!this.seats[i]) { botIdx=i; break; } }
    if (botIdx===null) return;

    const bot = this._newSeat(`bot_${botIdx}`, `bot_sess_${botIdx}`, botIdx, true, ownerIdx);
    bot.displayName = `${owner.displayName}_Bot`;
    bot.wallet      = 0;
    this.seats[botIdx] = bot;

    this._broadcast({ type:'state', state:this._state() });
    this._broadcast({ type:'toast', title:'Bot Added', message:`${bot.displayName} joined` });
  }

  _botAutoPlay(si) {
    setTimeout(() => {
      if (this.phase!=='player_action') return;
      const seat = this.seats[si];
      if (!seat?.isBot) return;
      const hi = seat.activeHandIdx;
      if (seat.stood[hi] || seat.busted[hi]) return; // already done
      if (botDecide(seat.hands[hi])==='hit') this._hit(si);
      else                                    this._stand(si);
    }, 800 + Math.random()*1000);
  }

  _botAutoBet(si) {
    const bot   = this.seats[si];
    const owner = bot?.ownerIdx!=null ? this.seats[bot.ownerIdx] : null;
    if (!bot || !owner) return;
    const bet = this.config.minBet;
    if (owner.wallet < bet) return;
    owner.wallet -= bet;
    bot.bet    = bet;
    bot.handBets = [bet];
    bot.wallet = 0; // bot wallet tracks only its current round chips, not owner's balance
    this._broadcast({ type:'state', state:this._state() });
  }

  // ── Phase: Betting ───────────────────────────────────────────

  _startBetting() {
    this._clearTimer();
    this.phase = 'betting';
    this.roundNum++;

    // Fresh 52-card deck every round — guaranteed no duplicates
    this.deck = buildDeck();
    console.log('[BJ] Fresh deck built for round ' + this.roundNum);

    for (const s of Object.values(this.seats)) {
      Object.assign(s, {
        bet:0, handBets:[0], insuranceBet:0, insuranceDeclined:false, tieBet:0, sideBet:null, sideBetAmt:0,
        hands:[[]], activeHandIdx:0, doubled:[false], stood:[false], busted:[false],
        splitAces:false, result:[null], payout:[0], sideBetResult:null, acted:false,
      });
    }
    this.dealerCards = [];
    this.activeSeat  = null;

    this._broadcast({ type:'phase', phase:'betting', duration:PHASE_MS.betting });
    this._broadcast({ type:'state', state:this._state() });

    for (const [i,s] of Object.entries(this.seats)) if (s.isBot) this._botAutoBet(+i);

    this.phaseTimer = setTimeout(() => this._deal(), PHASE_MS.betting);
  }

  // ── Phase: Deal ──────────────────────────────────────────────

  _deal() {
    this._clearTimer();

    // Auto-bet minimum for any human who didn't place a bet before timer expired
    for (const [i,s] of Object.entries(this.seats)) {
      if (!s.isBot && s.bet===0) {
        const autoBet = this.config.minBet;
        if (s.wallet >= autoBet) {
          s.bet = autoBet;
          s.handBets = [autoBet];
          s.wallet -= autoBet;
        } else {
          // Can't afford min bet — settle ($0) and remove completely
          if (s.token) {
            this._callPlatform('/api/game/bj/exit', {
              remainingWallet: 0, tableMinBet: this.config.minBet
            }, s.token).catch(() => {});
          }
          // Remove owned bots
          for (const [j,b] of Object.entries(this.seats)) {
            if (b.isBot && b.ownerIdx === +i) delete this.seats[j];
          }
          delete this.seats[i];
          // Notify the player's WS they've been removed
          for (const [ws, info] of this.clients) {
            if (info.seatIndex === +i) {
              this._sendTo(ws, { type:'kicked', reason:'insufficient_funds' });
              this.clients.delete(ws);
              break;
            }
          }
        }
      }
    }
    // Remove bots whose owner left or can't afford min bet
    for (const [i,s] of Object.entries(this.seats)) {
      if (s.isBot && s.ownerIdx!==null && !this.seats[s.ownerIdx]) delete this.seats[i];
    }

    if (!Object.keys(this.seats).length) {
      this.phase='waiting'; this._broadcast({type:'phase',phase:'waiting'}); return;
    }

    const sis = Object.keys(this.seats).map(Number).sort();
    for (const i of sis) this.seats[i].hands[0].push(this._drawCard());
    this.dealerCards.push(this._drawCard());
    for (const i of sis) this.seats[i].hands[0].push(this._drawCard());
    this.dealerCards.push({ ...this._drawCard(), faceDown:true });

    this.phase='deal';
    this._broadcast({ type:'phase', phase:'deal', duration:PHASE_MS.deal });
    this._broadcast({ type:'state', state:this._state() });

    setTimeout(() => {
      if (this.dealerCards[0].rank==='A') this._startInsurance();
      else                                this._startActions();
    }, PHASE_MS.deal);
  }

  // ── Phase: Insurance ─────────────────────────────────────────

  _startInsurance() {
    this.phase = 'insurance';
    this._broadcast({ type:'phase', phase:'insurance', duration:PHASE_MS.insurance });
    this._broadcast({ type:'state', state:this._state() });
    this.phaseTimer = setTimeout(() => this._startActions(), PHASE_MS.insurance);
  }

  // ── Phase: Player Actions — SEQUENTIAL ──────────────────────
  // Each player gets 15 seconds to act, one at a time in seat order.
  // All players see whose turn it is. When done or timed out, next player goes.
  // Bots act automatically within their turn slot.

  _startActions() {
    this._clearTimer();
    this.phase = 'player_action';

    const sis = Object.keys(this.seats).map(Number).sort();

    // Auto-stand blackjacks before starting turns
    for (const i of sis) {
      if (isBlackjack(this.seats[i].hands[0])) this.seats[i].stood[0] = true;
    }

    this._broadcast({ type:'phase', phase:'player_action', duration:PHASE_MS.player_action });
    this._nextTurn(sis, 0);
  }

  _nextTurn(sis, i) {
    this._clearTimer();

    // Skip seats that don't exist or are fully done
    while (i < sis.length) {
      const seat = this.seats[sis[i]];
      if (!seat) { i++; continue; }
      const hi = seat.hands.findIndex((_, h) => !seat.stood[h] && !seat.busted[h]);
      if (hi === -1) { i++; continue; }
      break;
    }

    // All players done — go to dealer
    if (i >= sis.length) { this._startDealer(); return; }

    const idx  = sis[i];
    const seat = this.seats[idx];
    const hi   = seat.hands.findIndex((_, h) => !seat.stood[h] && !seat.busted[h]);

    this.activeSeat        = idx;
    seat.activeHandIdx     = hi;

    // Tell everyone whose turn it is and how long they have
    this._broadcast({ type:'your_turn', seatIndex:idx, handIndex:hi, duration:PHASE_MS.player_action });
    this._broadcast({ type:'state',     state:this._state() });

    // Bots act automatically
    if (seat.isBot) this._botAutoPlay(idx);

    // Auto-stand if player doesn't act in time, then move to next
    this.phaseTimer = setTimeout(() => {
      this._autoStand(idx);
      this._broadcast({ type:'state', state:this._state() });
      this._nextTurn(sis, i + 1);
    }, PHASE_MS.player_action);
  }

  _autoStand(si) {
    const s = this.seats[si];
    if (!s) return;
    s.hands.forEach((_, hi) => {
      if (!s.stood[hi] && !s.busted[hi]) s.stood[hi] = true;
    });
    s.acted = true;
  }

  _allPlayersDone() {
    return Object.values(this.seats).every(seat =>
      seat.hands.every((_, hi) => seat.stood[hi] || seat.busted[hi])
    );
  }

  // Called after each action — advance to next hand or next player
  _advanceTurn(si) {
    const sis  = Object.keys(this.seats).map(Number).sort();
    const seat = this.seats[si];

    // Check for more hands on this player (splits)
    if (seat && !seat.splitAces) {
      const next = seat.hands.findIndex((_, h) => !seat.stood[h] && !seat.busted[h]);
      if (next !== -1) {
        this._clearTimer();
        seat.activeHandIdx = next;
        this._broadcast({ type:'your_turn', seatIndex:si, handIndex:next, duration:PHASE_MS.player_action });
        this._broadcast({ type:'state', state:this._state() });
        if (seat.isBot) this._botAutoPlay(si);
        // Restart timer for the new hand
        this.phaseTimer = setTimeout(() => {
          this._autoStand(si);
          this._broadcast({ type:'state', state:this._state() });
          this._nextTurn(sis, sis.indexOf(si) + 1);
        }, PHASE_MS.player_action);
        return;
      }
    }

    // This player is fully done — move to next seat
    this._nextTurn(sis, sis.indexOf(si) + 1);
  }

  // _checkAllDone kept for compatibility
  _checkAllDone() {
    if (this._allPlayersDone()) {
      this._clearTimer();
      this._startDealer();
    }
  }

  // ── Phase: Dealer ────────────────────────────────────────────

  _startDealer() {
    this._clearTimer();
    this.phase='dealer'; this.activeSeat=null;
    this.dealerCards[1].faceDown=false;
    this._broadcast({ type:'phase', phase:'dealer', duration:PHASE_MS.dealer });
    this._broadcast({ type:'state', state:this._state() });

    const draw = () => {
      if (dealerShouldHit(this.dealerCards)) {
        this.dealerCards.push(this._drawCard());
        this._broadcast({ type:'state', state:this._state() });
        setTimeout(draw, 400); // 400ms between dealer cards
      } else {
        setTimeout(() => this._payout(), 300);
      }
    };
    setTimeout(draw, 300); // Start drawing quickly
  }

  // ── Phase: Payout ────────────────────────────────────────────

  _payout() {
    this.phase='payout';
    const dealerBJ    = isBlackjack(this.dealerCards);
    const { isBust:dBust, total:dTotal } = calcHandFull(this.dealerCards);
    const bust22 = dBust && dTotal===22;
    let hasTieWin = false; // track if any tie bet won this round

    for (const seat of Object.values(this.seats)) {
      let delta=0;

      for (let hi=0; hi<seat.hands.length; hi++) {
        const result = resolveHand(seat.hands[hi], this.dealerCards, seat.busted[hi]);
        const ins    = hi===0 ? seat.insuranceBet : 0;
        // calcPayout returns total chips to credit back (0 for lose/bust)
        const handBet = this._handBet(seat, hi);
        const credit = calcPayout(result, handBet, ins, dealerBJ, this.config.blackjackPayout);
        seat.result[hi]=result; seat.payout[hi]=credit; delta+=credit;
      }

      // ── Tie Bet evaluation ───────────────────────────────────
      // Tie Bet: independent side wager — pays a flat per-tier bonus when
      // player total === dealer total (even on double bust, even on blackjack push).
      //
      // SPLITS: one tie bet per seat (never multiplied across split hands).
      // It covers the whole seat: if ANY of the player's hands ties the dealer,
      // the tie bet wins the bonus once. Players gain more tie chances when
      // splitting but don't pay more. This is by design.
      //
      // BJ+BJ HOUSE RULE: when the player places the tie bet AND both the
      // player and dealer land a natural Blackjack, the hand pays BOTH the
      // full blackjack bonus AND the tie bonus (standard rules would push).
      if (seat.tieBet > 0) {
        const dealerTotal = dTotal;
        let tiedHandIdx = -1;
        for (let hi = 0; hi < seat.hands.length; hi++) {
          const { total: pTotal } = calcHandFull(seat.hands[hi] || []);
          if (pTotal === dealerTotal && pTotal > 0) { tiedHandIdx = hi; break; }
        }
        if (tiedHandIdx !== -1) {
          const bonus = this.config.tieBetPayout || 2000;
          // Player receives: tie bet stake back + fixed bonus
          const tiePayout = seat.tieBet + bonus;
          delta += tiePayout;

          // ── BJ+BJ with tie bet placed: upgrade main bet to full blackjack ──
          // Normally resolveHand returns 'push' for BJ vs BJ and calcPayout
          // credits only the stake back. With the tie bet in play we credit
          // the blackjack bonus as well and relabel the hand 'blackjack'.
          const handBJ = isBlackjack(seat.hands[tiedHandIdx] || []);
          if (handBJ && dealerBJ && seat.result[tiedHandIdx] === 'push') {
            const bjCredit = calcPayout('blackjack', this._handBet(seat, tiedHandIdx), 0, false, this.config.blackjackPayout);
            const oldCredit = seat.payout[tiedHandIdx] || 0;
            delta += (bjCredit - oldCredit);
            seat.payout[tiedHandIdx] = bjCredit;
            seat.result[tiedHandIdx] = 'blackjack';
          } else {
            // Relabel the winning hand's result so the UI shows TIE, not PUSH
            seat.result[tiedHandIdx] = 'tie';
          }

          // Fold the tie payout into the hand's payout line so the client's
          // "net profit" calc (sum of seat.payout) includes the tie bonus.
          seat.payout[tiedHandIdx] = (seat.payout[tiedHandIdx] || 0) + tiePayout;

          const label = (handBJ && dealerBJ)
            ? `TIE BET + BLACKJACK! +$${bonus.toLocaleString()} Tie Bonus`
            : `TIE BET WINS! +$${bonus.toLocaleString()} Bonus`;
          seat.sideBetResult = (seat.sideBetResult ? seat.sideBetResult + ' · ' : '') + label;
          hasTieWin = true;
          // Broadcast tie win BEFORE payout reveal so celebration shows first
          this._broadcast({ type:'tie_win', displayName:seat.displayName, bonus, totalCredit:tiePayout });
        }
      }

      if (seat.sideBet && seat.sideBetAmt>0) {
        let sb=null;
        if (seat.sideBet==='dealer_bust_bonus') {
          if (bust22) sb={win:true,multiplier:1.5,houseBonus:0,label:'Dealer Bust Bonus! 1.5:1'};
        } else {
          const ec = seat.sideBet==='island_blackjack' ? seat.hands[0].slice(0,2) : seat.hands[0];
          sb = evalSpecialBet(ec, seat.sideBet, seat.sideBetAmt);
        }
        if (sb?.win) {
          delta += Math.floor(seat.sideBetAmt*sb.multiplier)+seat.sideBetAmt+sb.houseBonus;
          seat.sideBetResult = sb.label;
        }
      }

      const won = seat.result.some(r=>r==='win'||r==='blackjack');
      if (won) {
        seat.streakWins++;
        if (seat.streakWins>=5) {
          delta += this._baseBet(seat)*2;
          seat.sideBetResult = (seat.sideBetResult?seat.sideBetResult+' · ':'')+' Full Sweep Bonus!';
          seat.streakWins=0;
        }
      } else { seat.streakWins=0; }

      seat.wallet += delta;

      // Bot winnings go directly to owner's wallet, not bot's wallet
      if (seat.isBot && seat.ownerIdx!=null) {
        const owner=this.seats[seat.ownerIdx];
        if (owner) {
          owner.wallet += delta;
          seat.wallet = 0; // bot doesn't hold chips between rounds
        }
      }
    }

    // If a tie bet won, delay the payout reveal by 2 seconds
    // so the tie win celebration is seen by all players first
    const payoutDelay = hasTieWin ? 2000 : 0;
    setTimeout(() => {
      this._broadcast({ type:'phase', phase:'payout', duration:PHASE_MS.payout });
      this._broadcast({ type:'state', state:this._state() });
      this.phaseTimer = setTimeout(() => this._roundEnd(), PHASE_MS.payout);
    }, payoutDelay);
  }

  // ── Phase: Round End ─────────────────────────────────────────

  _roundEnd() {
    this.phase='round_end';
    this._broadcast({ type:'phase', phase:'round_end', duration:PHASE_MS.round_end });

    for (const s of Object.values(this.seats)) if (!s.isBot) this._settle(s);

    this.phaseTimer=setTimeout(()=>{
      // Remove disconnected players — settle their wallet and cut all ties
      for (const [i,s] of Object.entries(this.seats)) {
        if (!s.connected && !s.isBot) {
          // Final wallet settlement if not already done in _onDisconnect
          if (s.wallet > 0 && s.token) {
            this._callPlatform('/api/game/bj/exit', {
              remainingWallet: s.wallet, tableMinBet: this.config.minBet
            }, s.token).catch(e => console.error('[BJ] exit on round_end:', e.message));
          }
          // Remove owned bots
          for (const [j,b] of Object.entries(this.seats)) {
            if (b.isBot && b.ownerIdx === +i) delete this.seats[j];
          }
          delete this.seats[i];
          console.log(`[BJ] Seat ${i} (${s.userId}) fully removed after round end`);
        }
      }
      if (!Object.keys(this.seats).length) {
        this.phase='waiting'; this._broadcast({type:'phase',phase:'waiting'});
      } else {
        this._startBetting();
      }
    }, PHASE_MS.round_end);
  }

  // ── Player Actions ───────────────────────────────────────────

  _placeBet(si, amount) {
    if (this.phase!=='betting') return;
    const s=this.seats[si]; if (!s||s.isBot) return;
    const priorBet = this._baseBet(s);
    const priorStake = priorBet > 0 ? (this._mainStake(s) || priorBet) : 0;
    const available = s.wallet + priorStake;
    const bet=Math.max(this.config.minBet, Math.min(this.config.maxBet, Number(amount)||0));
    if (bet>available) return;
    if (priorStake>0) s.wallet+=priorStake;
    s.bet=bet; s.handBets=[bet]; s.wallet-=bet;
    this._broadcast({ type:'state', state:this._state() });

    // Deal immediately if ALL human players have now placed bets — no need to wait.
    // Applies to all tiers: VIP auto-places the main bet, so the shortcut fires fast.
    // Players opt in to the tie bet via the bottom-bar button BEFORE the main bet lands
    // (or they skip it for that round).
    const humans = Object.values(this.seats).filter(s => !s.isBot);
    const allBet  = humans.length > 0 && humans.every(s => s.bet > 0);
    if (allBet) {
      this._clearTimer();
      setTimeout(() => this._deal(), 500); // tiny pause so client sees the bet before dealing
    }
  }

  _placeSide(si, bet, amount) {
    if (this.phase!=='betting') return;
    const s=this.seats[si]; if (!s||!SIDE_BETS.includes(bet)) return;
    const amt=Math.min(this.config.minBet, amount);
    if (amt>s.wallet) return;
    if (s.sideBetAmt>0) s.wallet+=s.sideBetAmt;
    s.sideBet=bet; s.sideBetAmt=amt; s.wallet-=amt;
    this._broadcast({ type:'state', state:this._state() });
  }

  _insurance(si, take) {
    if (this.phase!=='insurance') return;
    const s=this.seats[si]; if (!s||s.insuranceBet>0||s.insuranceDeclined) return;
    if (take) {
      const a = INSURANCE_AMOUNT; // Fixed $50 insurance
      if (a > s.wallet) return;
      s.insuranceBet = a;
      s.wallet -= a;
    } else {
      s.insuranceDeclined = true;
    }
    this._broadcast({ type:'state', state:this._state() });
  }

  _placeTieBet(si) {
    if (this.phase !== 'betting') return;
    const s = this.seats[si]; if (!s || s.isBot) return;
    const tieAmount = this.config.tieBet || 100;
    // Toggle: if already placed, remove it
    if (s.tieBet > 0) {
      s.wallet += s.tieBet;
      s.tieBet = 0;
      this._broadcast({ type:'state', state:this._state() });
      return;
    }
    if (s.wallet < tieAmount) return; // not enough chips
    s.tieBet = tieAmount;
    s.wallet -= tieAmount;
    this._broadcast({ type:'state', state:this._state() });
  }

  _hit(si) {
    if (this.phase!=='player_action') return;
    const s=this.seats[si]; if (!s) return;
    const hi=s.activeHandIdx;
    if (s.stood[hi]||s.busted[hi]||s.splitAces) return;
    s.hands[hi].push(this._drawCard()); s.acted=true;
    const {total,isBust}=calcHandFull(s.hands[hi]);
    if (isBust) { s.busted[hi]=true; this._advanceTurn(si); }
    else if (total===21) { s.stood[hi]=true; this._advanceTurn(si); }
    else { this._broadcast({ type:'state', state:this._state() }); }
  }

  _stand(si) {
    if (this.phase!=='player_action') return;
    const s=this.seats[si]; if (!s) return;
    s.stood[s.activeHandIdx]=true; s.acted=true;
    this._advanceTurn(si);
  }

  _double(si) {
    if (this.phase!=='player_action') return;
    const s=this.seats[si]; if (!s) return;
    const hi=s.activeHandIdx;
    const hand = s.hands[hi] || [];
    const handBet = this._handBet(s, hi);
    if (hand.length!==2 || s.stood[hi] || s.busted[hi] || s.splitAces || s.wallet<handBet) return;
    s.wallet-=handBet; s.handBets[hi]=handBet*2; s.doubled[hi]=true;
    s.hands[hi].push(this._drawCard());
    if (calcHandFull(s.hands[hi]).isBust) s.busted[hi]=true;
    s.stood[hi]=true; s.acted=true;
    this._advanceTurn(si);
  }

  _split(si) {
    if (this.phase!=='player_action') return;
    const s=this.seats[si]; if (!s) return;
    const hi=s.activeHandIdx;
    const handBet = this._handBet(s, hi);
    // Allow up to 4 hands from splitting
    if (!isTenValuePair(s.hands[hi]) || s.hands.length >= 4 || s.wallet < handBet) return;
    const aces = isAcePair(s.hands[hi]);
    s.wallet -= handBet; // second bet for the split hand

    // Take second card from current hand, start new hand
    const c2 = s.hands[hi].pop();
    const newHandIdx = s.hands.length;
    s.hands.push([c2]);

    // Deal one new card to each hand
    s.hands[hi].push(this._drawCard());
    s.hands[newHandIdx].push(this._drawCard());

    // Track state for new hand
    s.doubled.push(false);
    s.stood.push(false);
    s.busted.push(false);
    s.result.push(null);
    s.payout.push(0);
    s.handBets.push(handBet);

    // Split aces: only one card each, auto-stand
    if (aces) {
      s.stood[hi] = true;
      s.stood[newHandIdx] = true;
      s.splitAces = true;
    }

    s.acted = true;
    this._broadcast({ type:'state', state:this._state() });

    if (aces) {
      this._clearTimer();
      this._advanceTurn(si);
    }
    // If not aces, player continues playing current hand
  }

  // ── Leave ────────────────────────────────────────────────────

  async _leave(ws, userId, si) {
    const s=this.seats[si]; if (!s) return;
    if (s.wallet>0 && s.token) {
      await this._callPlatform('/api/game/bj/exit',
        { remainingWallet:s.wallet, tableMinBet:this.config.minBet }, s.token);
    }
    // Remove owned bots
    for (const [i,b] of Object.entries(this.seats)) {
      if (b.isBot && b.ownerIdx===si) delete this.seats[i];
    }
    delete this.seats[si];
    this.clients.delete(ws);
    this._sendTo(ws, { type:'kicked', reason:'left' });
    this._broadcast({ type:'state', state:this._state() });
  }

  // ── Bank Settlement ──────────────────────────────────────────

  async _settle(seat) {
    const now=Date.now(), last=this._recentExits.get(seat.userId)||0;
    if (now-last<10000) return;
    this._recentExits.set(seat.userId, now);
    if (!seat.token) return;
    try {
      await this._callPlatform('/api/game/game/record-win', {
        isWin: seat.result.some(r=>r==='win'||r==='blackjack'),
        tableMinBet: this.config.minBet,
      }, seat.token);
    } catch(e) { /* stats-only call — swallow errors */ }
  }

  async _callPlatform(route, body, token) {
    const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),8000);
    const headers = {'Content-Type':'application/json'};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    try {
      const r=await fetch(`${PLATFORM_URL}${route}`,{
        method:'POST', headers,
        body:JSON.stringify(body), signal:ctrl.signal,
      });
      const text = await r.text();
      try { return JSON.parse(text); }
      catch { return { ok:false, raw:text.slice(0,100) }; }
    } finally { clearTimeout(t); }
  }

  // ── Shoe ─────────────────────────────────────────────────────

  _drawCard() {
    if (!this.deck.length) this.deck = buildDeck();
    return this.deck.pop();
  }

  // ── State Snapshot ───────────────────────────────────────────

  _state(forUserId) {
    const hideHole = new Set(['deal','insurance','player_action']);
    const dealer = this.dealerCards.map((c, idx) => {
      if (idx === 1 && c.faceDown && hideHole.has(this.phase)) {
        return { rank:'?', suit:'?', faceDown:true };
      }
      return c;
    });

    const seats = {};
    for (const [i, s] of Object.entries(this.seats)) {
      seats[i] = {
        userId:s.userId, sessionId:s.sessionId, index:s.index,
        isBot:s.isBot, ownerIdx:s.ownerIdx,
        joinRole:s.joinRole, isInvitedGuest:s.isInvitedGuest, joinedAt:s.joinedAt,
        wallet:s.wallet, bet:s.bet, handBets:this._ensureHandBets(s),
        insuranceBet:s.insuranceBet, insuranceDeclined:s.insuranceDeclined,
        tieBet:s.tieBet, sideBet:s.sideBet, sideBetAmt:s.sideBetAmt,
        hands:s.hands, activeHandIdx:s.activeHandIdx,
        doubled:s.doubled, stood:s.stood, busted:s.busted, splitAces:s.splitAces,
        result:s.result, payout:s.payout, sideBetResult:s.sideBetResult,
        acted:s.acted, connected:s.connected,
        displayName:s.displayName, avatar:s.avatar, streakWins:s.streakWins,
      };
    }

    return {
      roomId:this.roomId, phase:this.phase, roundNum:this.roundNum, config:this.config,
      hostSeatIndex:this._hostSeatIndex(),
      dealerCards:dealer,
      dealerTotal: (() => {
        if (['dealer','payout','round_end'].includes(this.phase)) {
          return calcHandFull(this.dealerCards).total;
        }
        if (this.dealerCards.length > 0) {
          const { total } = calcHandFull([this.dealerCards[0]]);
          return total;
        }
        return null;
      })(),
      seats, activeSeat:this.activeSeat,
      playerCount:Object.values(this.seats).filter(s=>!s.isBot).length,
      seatCount:Object.keys(this.seats).length,
    };
  }

  // ── Utilities ────────────────────────────────────────────────

  _sendTo(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  _clearTimer() {
    if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
  }

  // ── Broadcast ────────────────────────────────────────────────

  _broadcast(msg) {
    for (const [ws,info] of this.clients) {
      if (ws.readyState!==1) continue;
      ws.send(JSON.stringify(msg.type==='state'
        ? { ...msg, state:this._state(info.userId) }        : msg));
    }
  }
}

module.exports = BlackjackRoom;
