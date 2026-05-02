1	'use strict';
2	
3	// ─────────────────────────────────────────────────────────────
4	// VurgLife Blackjack — logic.js
5	// Pure card logic. No I/O, no state. Fully testable.
6	// Owner: Amit Ramoutar
7	// ─────────────────────────────────────────────────────────────
8	
9	const SUITS  = ['♠', '♣', '♥', '♦'];
10	const RANKS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
11	// ── Deck ─────────────────────────────────────────────────────
12	// One standard 52-card deck, freshly shuffled every round.
13	// No shoe, no multi-deck — guaranteed unique cards each round.
14	
15	function buildDeck() {
16	  const deck = [];
17	  for (const suit of SUITS) {
18	    for (const rank of RANKS) {
19	      deck.push({ rank, suit, faceDown: false });
20	    }
21	  }
22	  return shuffle(deck);
23	}
24	
25	// Keep buildShoe as alias so nothing breaks
26	function buildShoe() { return buildDeck(); }
27	
28	function shuffle(arr) {
29	  const a = [...arr];
30	  for (let i = a.length - 1; i > 0; i--) {
31	    const j = Math.floor(Math.random() * (i + 1));
32	    [a[i], a[j]] = [a[j], a[i]];
33	  }
34	  return a;
35	}
36	
37	// ── Card Values ───────────────────────────────────────────────
38	
39	function cardValue(rank) {
40	  if (['J','Q','K'].includes(rank)) return 10;
41	  if (rank === 'A') return 11; // aces start high
42	  return parseInt(rank, 10);
43	}
44	
45	function isTenValue(rank) {
46	  return ['10','J','Q','K'].includes(rank);
47	}
48	
49	// ── Hand Calculation ──────────────────────────────────────────
50	
51	/**
52	 * Calculate best hand total from visible cards (skips faceDown).
53	 * Returns { total, isSoft, isBust }
54	 */
55	function calcHand(cards) {
56	  let total = 0, aces = 0;
57	  for (const c of cards) {
58	    if (c.faceDown) continue;
59	    if (c.rank === 'A') { aces++; total += 11; }
60	    else total += cardValue(c.rank);
61	  }
62	  let soft = aces > 0;
63	  while (total > 21 && aces > 0) {
64	    total -= 10; aces--;
65	    if (aces === 0) soft = false;
66	  }
67	  return { total, isSoft: soft, isBust: total > 21 };
68	}
69	
70	/**
71	 * Calculate hand total including face-down cards (full dealer hand).
72	 */
73	function calcHandFull(cards) {
74	  const revealed = cards.map(c => ({ ...c, faceDown: false }));
75	  return calcHand(revealed);
76	}
77	
78	// ── Hand Classification ───────────────────────────────────────
79	
80	function isBlackjack(cards) {
81	  if (cards.length !== 2) return false;
82	  const ranks = cards.map(c => c.rank);
83	  return ranks.includes('A') && ranks.some(r => isTenValue(r));
84	}
85	
86	function isPair(cards) {
87	  return cards.length === 2 && cards[0].rank === cards[1].rank;
88	}
89	
90	/**
91	 * Same 10-value cards can be split (e.g. J+K or 10+Q).
92	 */
93	function isTenValuePair(cards) {
94	  if (cards.length !== 2) return false;
95	  return cardValue(cards[0].rank) === cardValue(cards[1].rank);
96	}
97	
98	function isAcePair(cards) {
99	  return cards.length === 2 && cards[0].rank === 'A' && cards[1].rank === 'A';
100	}
101	
102	// ── Dealer Logic ──────────────────────────────────────────────
103	
104	/**
105	 * Dealer stands on soft 17. Hits on anything less.
106	 */
107	function dealerShouldHit(cards) {
108	  const { total, isSoft } = calcHandFull(cards);
109	  if (total < 17) return true;
110	  if (total === 17 && isSoft) return false; // stands on soft 17
111	  return false;
112	}
113	
114	// ── Result Resolution ─────────────────────────────────────────
115	
116	/**
117	 * Compare player hand vs dealer and return result string.
118	 * @returns {'blackjack'|'win'|'push'|'lose'|'bust'}
119	 */
120	function resolveHand(playerCards, dealerCards, playerBusted) {
121	  if (playerBusted) return 'bust';
122	
123	  const playerBJ = isBlackjack(playerCards);
124	  const dealerBJ = isBlackjack(dealerCards);
125	
126	  if (playerBJ && dealerBJ) return 'push';
127	  if (playerBJ) return 'blackjack';
128	  if (dealerBJ) return 'lose';
129	
130	  const { total: pTotal }             = calcHandFull(playerCards);
131	  const { total: dTotal, isBust: dB } = calcHandFull(dealerCards);
132	
133	  if (dB)           return 'win';
134	  if (pTotal > dTotal) return 'win';
135	  if (pTotal === dTotal) return 'push';
136	  return 'lose';
137	}
138	
139	// ── Payout Calculator ─────────────────────────────────────────
140	
141	/**
142	 * Calculate total chips to CREDIT back to wallet at payout.
143	 * The original bet was already deducted from wallet when placed.
144	 *
145	 * Blackjack (3:2): returns bet × 2.5  (bet back + 1.5× profit)
146	 * Win (1:1):       returns bet × 2    (bet back + 1× profit)
147	 * Push:            returns bet × 1    (bet back, no profit)
148	 * Lose / Bust:     returns 0          (bet already gone)
149	 *
150	 * @returns {number} chips to add to wallet (always >= 0)
151	 */
152	function calcPayout(result, bet, insuranceBet = 0, dealerHasBlackjack = false, blackjackPayoutOverride = null) {
153	  let credit = 0;
154	
155	  switch (result) {
156	    case 'blackjack':
157	      // VIP tiers define a flat blackjack payout; standard uses 3:2 formula
158	      credit = blackjackPayoutOverride !== null && blackjackPayoutOverride !== undefined
159	        ? bet + blackjackPayoutOverride         // bet back + flat bonus
160	        : bet + Math.floor(bet * 1.5);          // 3:2 + bet back
161	      break;
162	    case 'win':       credit = bet * 2; break; // 1:1 + bet back
163	    case 'tie':                                 // tie = push for main bet;
164	    case 'push':      credit = bet;   break;   // tie bonus handled separately
165	    case 'lose':
166	    case 'bust':      credit = 0;     break;   // lose bet
167	  }
168	
169	  // Insurance side bet (deducted separately at bet time)
170	  if (insuranceBet > 0) {
171	    if (dealerHasBlackjack) credit += insuranceBet * 3; // 2:1 + insurance bet back
172	    else                    credit += 0;                // insurance lost
173	  }
174	
175	  return credit;
176	}
177	
178	// ── VurgLife Caribbean Special Bets ──────────────────────────
179	
180	/**
181	 * Evaluate all VurgLife special side bets for a player's hand.
182	 * Called after the third card is dealt (where applicable).
183	 *
184	 * @param {Array}  playerCards  - player's current cards
185	 * @param {string} specialBet   - which special was placed
186	 * @param {number} sideBetAmt   - amount wagered on the side bet
187	 * @returns {{ win: boolean, multiplier: number, houseBonus: number, label: string }}
188	 */
189	function evalSpecialBet(playerCards, specialBet, sideBetAmt) {
190	  const none = { win: false, multiplier: 0, houseBonus: 0, label: '' };
191	
192	  switch (specialBet) {
193	
194	    case 'island_blackjack': {
195	      // Blackjack where the Ace AND King are the same suit
196	      if (playerCards.length !== 2) return none;
197	      const [c1, c2] = playerCards;
198	      const hasAce  = (r) => r === 'A';
199	      const hasKing = (r) => r === 'K';
200	      const suited  = c1.suit === c2.suit;
201	      const isIBJ   = suited &&
202	        ((hasAce(c1.rank) && hasKing(c2.rank)) ||
203	         (hasKing(c1.rank) && hasAce(c2.rank)));
204	      return isIBJ
205	        ? { win: true, multiplier: 3, houseBonus: 500,  label: 'Island Blackjack! 3:1' }
206	        : none;
207	    }
208	
209	    case 'triple_7s': {
210	      // First 3 cards are all 7s
211	      if (playerCards.length < 3) return none;
212	      const first3 = playerCards.slice(0, 3);
213	      const allSevens = first3.every(c => c.rank === '7');
214	      return allSevens
215	        ? { win: true, multiplier: 5, houseBonus: 2500, label: 'Triple 7s! 5:1' }
216	        : none;
217	    }
218	
219	    case 'rum_runner': {
220	      // First 3 cards total exactly 21, but NOT a blackjack
221	      if (playerCards.length < 3) return none;
222	      const first3  = playerCards.slice(0, 3);
223	      const { total } = calcHandFull(first3);
224	      const notBJ  = !isBlackjack(playerCards.slice(0, 2));
225	      return (total === 21 && notBJ)
226	        ? { win: true, multiplier: 4, houseBonus: 1000, label: 'Rum Runner! 4:1' }
227	        : none;
228	    }
229	
230	    case 'dealer_bust_bonus': {
231	      // Evaluated at payout time by BlackjackRoom — not here
232	      return none;
233	    }
234	
235	    default:
236	      return none;
237	  }
238	}
239	
240	/**
241	 * Evaluate Dealer Bust Bonus — dealer busts with exactly 22.
242	 */
243	function evalDealerBustBonus(dealerCards) {
244	  const { total, isBust } = calcHandFull(dealerCards);
245	  return isBust && total === 22;
246	}
247	
248	// ── Exports ───────────────────────────────────────────────────
249	
250	module.exports = {
251	  buildDeck,
252	  buildShoe,
253	  shuffle,
254	  cardValue,
255	  isTenValue,
256	  calcHand,
257	  calcHandFull,
258	  isBlackjack,
259	  isPair,
260	  isTenValuePair,
261	  isAcePair,
262	  dealerShouldHit,
263	  resolveHand,
264	  calcPayout,
265	  evalSpecialBet,
266	  evalDealerBustBonus,
267	};
268	