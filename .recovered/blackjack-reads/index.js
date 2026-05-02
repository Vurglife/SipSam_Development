1	'use strict';
2	
3	// ─────────────────────────────────────────────────────────────
4	// VurgLife Blackjack — server/index.js
5	// WebSocket server on port 3002.
6	// Spawned by vurglife-platform/server/index.js via child_process.spawn
7	// Owner: Amit Ramoutar
8	// ─────────────────────────────────────────────────────────────
9	
10	require('dotenv').config({ path: '../vurglife-platform/.env' });
11	
12	const WebSocket    = require('ws');
13	const BlackjackRoom = require('./BlackjackRoom');
14	
15	const PORT = process.env.BLACKJACK_WS_PORT || 3002;
16	
17	// ── Table Configuration ──────────────────────────────────────
18	// Standard table: flexible min/max bets. Blackjack pays 3:2, fixed $100 tie bet,
19	//                 fixed $2,000 tie bonus ($3,000 for $500 main bet — legacy rule).
20	// VIP tables:     fixed main bet per tier, flat blackjack + tie payouts.
21	const TABLE_CONFIGS = {
22	  // Standard
23	  100: {
24	    minBet:          100,
25	    maxBet:          500,
26	    walletSize:      2500,
27	    minBank:         2500,
28	    tieBet:          100,
29	    tieBetPayout:    2000,    // payout for non-$500 main bets
30	    tieBetPayoutVIP: 3000,    // legacy: $500 main-bet bonus
31	    blackjackPayout: null,    // null → use standard 3:2 formula
32	    label:           'standard',
33	  },
34	  // VIP tiers — fixed bets, flat payouts
35	  1000: {
36	    minBet:          1000,
37	    maxBet:          1000,
38	    walletSize:      30000,
39	    minBank:         50000,
40	    tieBet:          500,
41	    tieBetPayout:    10000,
42	    blackjackPayout: 5000,
43	    label:           'vip',
44	  },
45	  5000: {
46	    minBet:          5000,
47	    maxBet:          5000,
48	    walletSize:      120000,
49	    minBank:         150000,
50	    tieBet:          1000,
51	    tieBetPayout:    30000,
52	    blackjackPayout: 15000,
53	    label:           'vip',
54	  },
55	  10000: {
56	    minBet:          10000,
57	    maxBet:          10000,
58	    walletSize:      240000,
59	    minBank:         300000,
60	    tieBet:          2000,
61	    tieBetPayout:    75000,
62	    blackjackPayout: 30000,
63	    label:           'vip',
64	  },
65	  20000: {
66	    minBet:          20000,
67	    maxBet:          20000,
68	    walletSize:      500000,
69	    minBank:         750000,
70	    tieBet:          3000,
71	    tieBetPayout:    125000,
72	    blackjackPayout: 70000,
73	    label:           'vip',
74	  },
75	  50000: {
76	    minBet:          50000,
77	    maxBet:          50000,
78	    walletSize:      1000000,
79	    minBank:         1500000,
80	    tieBet:          5000,
81	    tieBetPayout:    250000,
82	    blackjackPayout: 170000,
83	    label:           'vip',
84	  },
85	};
86	
87	// ── Active Rooms ──────────────────────────────────────────────
88	const rooms = new Map(); // roomId → BlackjackRoom
89	
90	function getOrCreateRoom(roomId, minBet) {
91	  if (!rooms.has(roomId)) {
92	    const config = TABLE_CONFIGS[minBet];
93	    if (!config) throw new Error(`Unknown minBet: ${minBet}`);
94	    rooms.set(roomId, new BlackjackRoom(roomId, config));
95	    console.log(`[BJ] Room created: ${roomId} (${config.label})`);
96	  }
97	  return rooms.get(roomId);
98	}
99	
100	// ── WebSocket Server ──────────────────────────────────────────
101	const wss = new WebSocket.Server({ port: PORT }, () => {
102	  console.log(`[BJ] Blackjack WebSocket server listening on port ${PORT}`);
103	});
104	
105	wss.on('connection', (ws, req) => {
106	  // Expected URL: /blackjack?roomId=bj_100_...&userId=123&sessionId=abc&minBet=100
107	  const url       = new URL(req.url, `http://localhost:${PORT}`);
108	  const roomId    = url.searchParams.get('roomId');
109	  const userId    = url.searchParams.get('userId');
110	  const sessionId = url.searchParams.get('sessionId');
111	  const minBet    = parseInt(url.searchParams.get('minBet'), 10);
112	  const token     = url.searchParams.get('token') || null;
113	
114	  if (!roomId || !userId || !sessionId || !minBet) {
115	    ws.close(1008, 'Missing required query params');
116	    return;
117	  }
118	
119	  try {
120	    const room = getOrCreateRoom(roomId, minBet);
121	    room.addClient(ws, userId, sessionId, token);
122	    console.log(`[BJ] User ${userId} joined room ${roomId}`);
123	  } catch (e) {
124	    console.error('[BJ] Connection error:', e.message);
125	    ws.close(1011, e.message);
126	  }
127	});
128	
129	// ── Cleanup empty rooms every 5 minutes ──────────────────────
130	setInterval(() => {
131	  for (const [id, room] of rooms) {
132	    if (room.clients.size === 0 && room.phase === 'waiting') {
133	      rooms.delete(id);
134	      console.log(`[BJ] Room cleaned up: ${id}`);
135	    }
136	  }
137	}, 5 * 60 * 1000);
138	
139	// ── Graceful Shutdown ─────────────────────────────────────────
140	process.on('SIGTERM', () => {
141	  console.log('[BJ] Shutting down...');
142	  wss.close(() => process.exit(0));
143	});
144	