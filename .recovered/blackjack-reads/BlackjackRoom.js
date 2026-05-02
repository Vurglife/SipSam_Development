300	
301	    this.phase='deal';
302	    this._broadcast({ type:'phase', phase:'deal', duration:PHASE_MS.deal });
303	    this._broadcast({ type:'state', state:this._state() });
304	
305	    setTimeout(() => {
306	      if (this.dealerCards[0].rank==='A') this._startInsurance();
307	      else                                this._startActions();
308	    }, PHASE_MS.deal);
309	  }
310	
311	  // ── Phase: Insurance ─────────────────────────────────────────
312	
313	  _startInsurance() {
314	    this.phase = 'insurance';
315	    this._broadcast({ type:'phase', phase:'insurance', duration:PHASE_MS.insurance });
316	    this._broadcast({ type:'state', state:this._state() });
317	    this.phaseTimer = setTimeout(() => this._startActions(), PHASE_MS.insurance);
318	  }
319	
320	  // ── Phase: Player Actions — SEQUENTIAL ──────────────────────
321	  // Each player gets 15 seconds to act, one at a time in seat order.
322	  // All players see whose turn it is. When done or timed out, next player goes.
323	  // Bots act automatically within their turn slot.
324	
325	  _startActions() {
326	    this._clearTimer();
327	    this.phase = 'player_action';
328	
329	    const sis = Object.keys(this.seats).map(Number).sort();
330	
331	    // Auto-stand blackjacks before starting turns
332	    for (const i of sis) {
333	      if (isBlackjack(this.seats[i].hands[0])) this.seats[i].stood[0] = true;
334	    }
335	
336	    this._broadcast({ type:'phase', phase:'player_action', duration:PHASE_MS.player_action });
337	    this._nextTurn(sis, 0);
338	  }
339	
340	  _nextTurn(sis, i) {
341	    this._clearTimer();
342	
343	    // Skip seats that don't exist or are fully done
344	    while (i < sis.length) {
345	      const seat = this.seats[sis[i]];
346	      if (!seat) { i++; continue; }
347	      const hi = seat.hands.findIndex((_, h) => !seat.stood[h] && !seat.busted[h]);
348	      if (hi === -1) { i++; continue; }
349	      break;
350	    }
351	
352	    // All players done — go to dealer
353	    if (i >= sis.length) { this._startDealer(); return; }
354	
355	    const idx  = sis[i];
356	    const seat = this.seats[idx];
357	    const hi   = seat.hands.findIndex((_, h) => !seat.stood[h] && !seat.busted[h]);
358	
359	    this.activeSeat        = idx;
360	    seat.activeHandIdx     = hi;
361	
362	    // Tell everyone whose turn it is and how long they have
363	    this._broadcast({ type:'your_turn', seatIndex:idx, handIndex:hi, duration:PHASE_MS.player_action });
364	    this._broadcast({ type:'state',     state:this._state() });
365	
366	    // Bots act automatically
367	    if (seat.isBot) this._botAutoPlay(idx);
368	
369	    // Auto-stand if player doesn't act in time, then move to next
370	    this.phaseTimer = setTimeout(() => {
371	      this._autoStand(idx);
372	      this._broadcast({ type:'state', state:this._state() });
373	      this._nextTurn(sis, i + 1);
374	    }, PHASE_MS.player_action);
375	  }
376	
377	  _autoStand(si) {
378	    const s = this.seats[si];
379	    if (!s) return;
380	    s.hands.forEach((_, hi) => {
381	      if (!s.stood[hi] && !s.busted[hi]) s.stood[hi] = true;
382	    });
383	    s.acted = true;
384	  }
385	
386	  _allPlayersDone() {
387	    return Object.values(this.seats).every(seat =>
388	      seat.hands.every((_, hi) => seat.stood[hi] || seat.busted[hi])
389	    );
390	  }
391	
392	  // Called after each action — advance to next hand or next player
393	  _advanceTurn(si) {
394	    const sis  = Object.keys(this.seats).map(Number).sort();
395	    const seat = this.seats[si];
396	
397	    // Check for more hands on this player (splits)
398	    if (seat && !seat.splitAces) {
399	      const next = seat.hands.findIndex((_, h) => !seat.stood[h] && !seat.busted[h]);
400	      if (next !== -1) {
401	        this._clearTimer();
402	        seat.activeHandIdx = next;
403	        this._broadcast({ type:'your_turn', seatIndex:si, handIndex:next, duration:PHASE_MS.player_action });
404	        this._broadcast({ type:'state', state:this._state() });
405	        if (seat.isBot) this._botAutoPlay(si);
406	        // Restart timer for the new hand
407	        this.phaseTimer = setTimeout(() => {
408	          this._autoStand(si);
409	          this._broadcast({ type:'state', state:this._state() });
410	          this._nextTurn(sis, sis.indexOf(si) + 1);
411	        }, PHASE_MS.player_action);
412	        return;
413	      }
414	    }
415	
416	    // This player is fully done — move to next seat
417	    this._nextTurn(sis, sis.indexOf(si) + 1);
418	  }
419	
420	  // _checkAllDone kept for compatibility
421	  _checkAllDone() {
422	    if (this._allPlayersDone()) {
423	      this._clearTimer();
424	      this._startDealer();
425	    }
426	  }
427	
428	  // ── Phase: Dealer ────────────────────────────────────────────
429	
430	  _startDealer() {
431	    this._clearTimer();
432	    this.phase='dealer'; this.activeSeat=null;
433	    this.dealerCards[1].faceDown=false;
434	    this._broadcast({ type:'phase', phase:'dealer', duration:PHASE_MS.dealer });
435	    this._broadcast({ type:'state', state:this._state() });
436	
437	    const draw = () => {
438	      if (dealerShouldHit(this.dealerCards)) {
439	        this.dealerCards.push(this._drawCard());
440	        this._broadcast({ type:'state', state:this._state() });
441	        setTimeout(draw, 400); // 400ms between dealer cards
442	      } else {
443	        setTimeout(() => this._payout(), 300);
444	      }
445	    };
446	    setTimeout(draw, 300); // Start drawing quickly
447	  }
448	
449	  // ── Phase: Payout ────────────────────────────────────────────
450	
451	  _payout() {
452	    this.phase='payout';
453	    const dealerBJ    = isBlackjack(this.dealerCards);
454	    const { isBust:dBust, total:dTotal } = calcHandFull(this.dealerCards);
455	    const bust22 = dBust && dTotal===22;
456	    let hasTieWin = false; // track if any tie bet won this round
457	
458	    for (const seat of Object.values(this.seats)) {
459	      let delta=0;
460	
461	      for (let hi=0; hi<seat.hands.length; hi++) {
462	        const result = resolveHand(seat.hands[hi], this.dealerCards, seat.busted[hi]);
463	        const ins    = hi===0 ? seat.insuranceBet : 0;
464	        // calcPayout returns total chips to credit back (0 for lose/bust)
465	        const credit = calcPayout(result, seat.bet, ins, dealerBJ);
466	        seat.result[hi]=result; seat.payout[hi]=credit; delta+=credit;
467	      }
468	
469	      // ── Tie Bet evaluation ───────────────────────────────────
470	      // Tie Bet: pays fixed $2,000 bonus ($3,000 for $500 main bet)
471	      // Works even if both bust with same total
472	      // Player still loses their round bet if they bust — tie bet is independent
473	      if (seat.tieBet > 0) {
474	        const { total: pTotal } = calcHandFull(seat.hands[0] || []);
475	        const playerTotal = pTotal;
476	        const dealerTotal = dTotal;
477	        if (playerTotal === dealerTotal && playerTotal > 0) {
478	          // Fixed bonus: $3,000 for $500 main bet, $2,000 for all others
479	          const bonus      = seat.bet >= 500 ? TIE_BONUS_VIP : TIE_BONUS_STD;
480	          // Player receives: tie bet back + fixed bonus
481	          const tiePayout  = seat.tieBet + bonus;
482	          delta += tiePayout;
483	          const label = `🎯 TIE BET WINS! +$${bonus.toLocaleString()} Bonus`;
484	          seat.sideBetResult = (seat.sideBetResult ? seat.sideBetResult + ' · ' : '') + label;
485	          hasTieWin = true;
486	          // Broadcast tie win BEFORE payout reveal
487	          this._broadcast({ type:'tie_win', displayName:seat.displayName, bonus, totalCredit:tiePayout });
488	        }
489	      }
490	
491	      if (seat.sideBet && seat.sideBetAmt>0) {
492	        let sb=null;
493	        if (seat.sideBet==='dealer_bust_bonus') {
494	          if (bust22) sb={win:true,multiplier:1.5,houseBonus:0,label:'Dealer Bust Bonus! 1.5:1'};
495	        } else {
496	          const ec = seat.sideBet==='island_blackjack' ? seat.hands[0].slice(0,2) : seat.hands[0];
497	          sb = evalSpecialBet(ec, seat.sideBet, seat.sideBetAmt);
498	        }
499	        if (sb?.win) {
500	          delta += Math.floor(seat.sideBetAmt*sb.multiplier)+seat.sideBetAmt+sb.houseBonus;
501	          seat.sideBetResult = sb.label;
502	        }
503	      }
504	
505	      const won = seat.result.some(r=>r==='win'||r==='blackjack');
506	      if (won) {
507	        seat.streakWins++;
508	        if (seat.streakWins>=5) {
509	          delta += seat.bet*2;
510	          seat.sideBetResult = (seat.sideBetResult?seat.sideBetResult+' · ':'')+' Full Sweep Bonus!';
511	          seat.streakWins=0;
512	        }
513	      } else { seat.streakWins=0; }
514	
515	      seat.wallet += delta;
516	
517	      // Bot winnings go directly to owner's wallet, not bot's wallet
518	      if (seat.isBot && seat.ownerIdx!=null) {
519	        const owner=this.seats[seat.ownerIdx];
520	        if (owner) {
521	          owner.wallet += delta;
522	          seat.wallet = 0; // bot doesn't hold chips between rounds
523	        }
524	      }
525	    }
526	
527	    // If a tie bet won, delay the payout reveal by 2 seconds
528	    // so the tie win celebration is seen by all players first
529	    const payoutDelay = hasTieWin ? 2000 : 0;
530	    setTimeout(() => {
531	      this._broadcast({ type:'phase', phase:'payout', duration:PHASE_MS.payout });
532	      this._broadcast({ type:'state', state:this._state() });
533	      this.phaseTimer = setTimeout(() => this._roundEnd(), PHASE_MS.payout);
534	    }, payoutDelay);
535	  }
536	
537	  // ── Phase: Round End ─────────────────────────────────────────
538	
539	  _roundEnd() {
540	    this.phase='round_end';
541	    this._broadcast({ type:'phase', phase:'round_end', duration:PHASE_MS.round_end });
542	
543	    for (const s of Object.values(this.seats)) if (!s.isBot) this._settle(s);
544	
545	    this.phaseTimer=setTimeout(()=>{
546	      // Remove disconnected players — settle their wallet and cut all ties
547	      for (const [i,s] of Object.entries(this.seats)) {
548	        if (!s.connected && !s.isBot) {
549	          // Final wallet settlement if not already done in _onDisconnect
550	          if (s.wallet > 0) {
551	            this._callPlatform('/api/game/exit', {
552	              userId: s.userId, remainingWallet: s.wallet, tableMinBet: this.config.minBet
553	            }).catch(e => console.error('[BJ] exit on round_end:', e.message));
554	          }
555	          // Remove owned bots
556	          for (const [j,b] of Object.entries(this.seats)) {
557	            if (b.isBot && b.ownerIdx === +i) delete this.seats[j];
558	          }
559	          delete this.seats[i];