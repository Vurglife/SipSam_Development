1250	  const alt           = document.getElementById('bet-alert-text');
1251	  const isVIP = BJ_TABLE.label === 'vip';
1252	
1253	  if (chipSection)   chipSection.style.display   = 'flex';
1254	  if (tieBetSection) tieBetSection.style.display = 'flex';
1255	
1256	  if (isVIP) {
1257	    if (betConfirm)   betConfirm.style.display   = 'none';
1258	    if (fixedSection) {
1259	      fixedSection.style.display = 'flex';
1260	      const amtEl = document.getElementById('bet-fixed-amount');
1261	      if (amtEl) amtEl.textContent = '$' + (BJ_TABLE.minBet || 0).toLocaleString();
1262	    }
1263	    if (alt) alt.textContent = 'Placing your bet…';
1264	  } else {
1265	    if (betConfirm)   betConfirm.style.display   = 'block';
1266	    if (fixedSection) fixedSection.style.display = 'none';
1267	    if (alt) alt.textContent = 'Tap a chip to bet';
1268	  }
1269	}
1270	
1271	// VIP auto-placement: bet is fixed, no chip choice — send it immediately.
1272	// Tie bet is NOT auto-placed; the player must opt in each round via the
1273	// bottom-bar "Tie Bet $X" button while the betting timer is running.
1274	function _autoPlaceFixedBet() {
1275	  if (_betPlaced) return;
1276	  if (BJ_TABLE.label !== 'vip') return;
1277	  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
1278	  const amt = BJ_TABLE.minBet || 0;
1279	  if (!amt || amt > avail) {
1280	    const alt = document.getElementById('bet-alert-text');
1281	    if (alt) alt.textContent = 'Insufficient wallet for fixed bet';
1282	    return;
1283	  }
1284	  pendingBet = amt;
1285	  updateBetDisplay();
1286	  _sendBet();
1287	}
1288	
1289	function addChip(val) {
1290	  if (typeof SFX !== 'undefined') SFX.chip();
1291	  const avail = window._lastBJState?.seats?.[mySeatIndex]?.wallet ?? myChips;
1292	  if (val > avail) { showIngameToast('Insufficient Chips', `Need $${val.toLocaleString()} to place this bet.`); return; }
1293	  pendingBet = val;
1294	  updateBetDisplay();
1295	  _sendBet();
1296	}
1297	
1298	function _sendBet() {
1299	  if (!ws || pendingBet < BJ_TABLE.minBet) return;
1300	  _betPlaced = true;
1301	  sendMsg('place_bet', { amount: pendingBet });
1302	  stopCountdown();
1303	
1304	  const ov = document.getElementById('bet-overlay');
1305	  if (!ov) return;
1306	
1307	  // Hide chips, keep tie bet visible after bet placed
1308	  const chipSection   = document.getElementById('bet-chips-section');
1309	  const betConfirm    = document.getElementById('bet-confirm-section');
1310	  const fixedSection  = document.getElementById('bet-fixed-section');
1311	  const tieBetSection = document.getElementById('bet-tiebet-section');
1312	  const alt           = document.getElementById('bet-alert-text');
1313	
1314	  if (chipSection)   chipSection.style.display   = 'none';
1315	  if (betConfirm)    betConfirm.style.display    = 'none';
1316	  if (fixedSection)  fixedSection.style.display  = 'none';
1317	  if (tieBetSection) tieBetSection.style.display = 'flex';
1318	  if (alt) alt.textContent = `✓ Bet $${pendingBet.toLocaleString()} placed`;
1319	
1320	  // Auto-close overlay after 3 seconds — but NOT in VIP: player needs the full
1321	  // betting window to toggle tie bet since the main bet was auto-placed.
1322	  clearTimeout(ov._closeTimer);
1323	  if (BJ_TABLE.label !== 'vip') {
1324	    ov._closeTimer = setTimeout(() => {
1325	      ov.style.display = 'none';
1326	    }, 3000);
1327	  }
1328	}
1329	
1330	function placeBet() { _sendBet(); }
1331	
1332	function placeTieBet() {
1333	  if (!ws) return;
1334	  sendMsg('place_tie');
1335	  if (typeof SFX !== 'undefined') SFX.chip();
1336	}
1337	
1338	function updateBetDisplay() {
1339	  const d = document.getElementById('bet-display');
1340	  const a = document.getElementById('bet-alert-text');
1341	  if (d) d.textContent = pendingBet > 0 ? '$' + pendingBet.toLocaleString() : '';
1342	  if (a) a.textContent = pendingBet >= BJ_TABLE.minBet ? `Bet: $${pendingBet.toLocaleString()}` : 'Tap a chip to bet';
1343	}
1344	
1345	function takeInsurance(take) {
1346	  sendMsg('insurance', { take });
1347	  const ip = document.getElementById('insurance-panel');
1348	  if (ip) ip.style.display = 'none';
1349	}
1350	
1351	// ─────────────────────────────────────────────────────
1352	// COUNTDOWN
1353	// ─────────────────────────────────────────────────────
1354	let _cdInterval = null;
1355	function startCountdown(secs, showOverlay) {
1356	  stopCountdown();
1357	  let t = Math.floor(secs); const TOTAL = secs;
1358	  const cd      = document.getElementById('cd-number');
1359	  const overlay = document.getElementById('your-turn-overlay');
1360	  const ring    = document.getElementById('bet-ring');
1361	  const bc      = document.getElementById('bet-countdown');
1362	
1363	  // Only show the big centred overlay during player action turns, not betting/insurance
1364	  if (overlay) { overlay.style.display = showOverlay ? 'flex' : 'none'; }
1365	
1366	  const update = rem => {
1367	    if (cd) { cd.textContent = rem; cd.classList.toggle('urgent', rem > 0 && rem <= 3); }
1368	    if (ring) { ring.style.strokeDashoffset = 213.6*(1-rem/TOTAL); ring.style.stroke = rem<=3?'#ef4444':rem<=5?'#f87171':'#c9a84c'; }
1369	    if (bc) bc.textContent = rem;
1370	    if (rem <= 3 && rem > 0 && typeof SFX !== 'undefined') SFX.timer?.();
1371	  };
1372	  update(t);
1373	  _cdInterval = setInterval(() => { t--; if (t <= 0) { stopCountdown(); return; } update(t); }, 1000);
1374	}
1375	function stopCountdown() {
1376	  clearInterval(_cdInterval);
1377	  const cd      = document.getElementById('cd-number');
1378	  const overlay = document.getElementById('your-turn-overlay');
1379	  if (overlay) overlay.style.display = 'none';
1380	  if (cd) cd.classList.remove('urgent');
1381	}
1382	
1383	// ─────────────────────────────────────────────────────
1384	// DEAL ANIMATION
1385	// ─────────────────────────────────────────────────────
1386	let _dealActive = false;
1387	function runDealAnim(state) {
1388	  if (_dealActive) return;
1389	  const oval = document.getElementById('oval-table'); if (!oval) return;
1390	  oval.querySelectorAll('.deal-anim-card').forEach(e => e.remove());
1391	  _dealActive = true;
1392	  const deck = document.getElementById('deck-pile');
1393	  if (deck) deck.classList.add('visible');
1394	
1395	  const ow=oval.offsetWidth, oh=oval.offsetHeight, cx=ow/2, cy=oh/2;
1396	
1397	  // Visual zone positions for 6 seats in semicircle
1398	  const vzPos = [
1399	    {x:ow*0.18, y:oh*0.22},  // vz0 top-left
1400	    {x:ow*0.50, y:oh*0.16},  // vz1 top-centre
1401	    {x:ow*0.82, y:oh*0.22},  // vz2 top-right
1402	    {x:ow*0.22, y:oh*0.72},  // vz3 bottom-left
1403	    {x:ow*0.50, y:oh*0.80},  // vz4 bottom-centre (primary)
1404	    {x:ow*0.78, y:oh*0.72},  // vz5 bottom-right
1405	  ];
1406	  const dealerPos = {x:cx, y:oh*0.12};
1407	
1408	  if (!document.getElementById('bj-deal-kf')) {
1409	    const s=document.createElement('style');s.id='bj-deal-kf';
1410	    s.textContent='@keyframes bjDealCard{0%{opacity:1;transform:translate(0,0) rotate(0deg)}100%{opacity:.85;transform:translate(var(--dx),var(--dy)) rotate(var(--dr))}}';
1411	    document.head.appendChild(s);
1412	  }
1413	
1414	  const seats    = Object.keys(state.seats||{}).map(Number).sort();
1415	  const allSeats = seats;
1416	  const order    = [];
1417	  for (let r=0; r<2; r++) {
1418	    seats.forEach(si => order.push({si, dealer:false}));
1419	    order.push({si:-1, dealer:true});
1420	  }
1421	
1422	  let idx = 0;
1423	  const dealOne = () => {
1424	    if (idx >= order.length) { if(deck)deck.classList.remove('visible'); _dealActive=false; return; }
1425	    const {si, dealer} = order[idx];
1426	    const target = dealer ? dealerPos : (vzPos[getVisualZone(si, allSeats)] || {x:cx,y:cy});
1427	
1428	    const card = document.createElement('div');
1429	    card.className = 'deal-anim-card';
1430	    const tx = (target.x - cx + (Math.random()-.5)*12).toFixed(1);
1431	    const ty = (target.y - cy + (Math.random()-.5)*10).toFixed(1);
1432	    const dr = ((Math.random()-.5)*16).toFixed(1)+'deg';
1433	    card.style.cssText = `position:absolute;left:${cx-14}px;top:${cy-20}px;width:28px;height:40px;border-radius:5px;background:#083a7a url('backVurgLife.png') center/80% no-repeat;border:1.5px solid #8b6914;box-shadow:0 2px 8px rgba(0,0,0,.8);--dx:${tx}px;--dy:${ty}px;--dr:${dr};animation:bjDealCard .25s ease-out forwards;z-index:50`;
1434	    oval.appendChild(card);
1435	    if (typeof SFX !== 'undefined') SFX.card();
1436	    card.addEventListener('animationend', () => { card.style.transition='opacity .18s'; card.style.opacity='0'; setTimeout(()=>card.remove(),200); }, {once:true});
1437	    idx++;
1438	    setTimeout(dealOne, 50);
1439	  };
1440	  dealOne();
1441	}
1442	
1443	// ─────────────────────────────────────────────────────
1444	// AUTO-LOGIN
1445	// ─────────────────────────────────────────────────────
1446	window.addEventListener('beforeunload', () => {
1447	  if (window._intentionalExit||window._serverSettled||!igmToken||!myChips) return;
1448	  const mb = BJ_TABLE.minBet || 100;
1449	  navigator.sendBeacon('/api/game/bj/exit-beacon?token='+encodeURIComponent(igmToken),
1450	    new Blob([JSON.stringify({remainingWallet:myChips,tableMinBet:mb})],{type:'application/json'}));
1451	});
1452	
1453	window.addEventListener('DOMContentLoaded', () => {
1454	  _loadFreeze();
1455	  _updateFreezeUI();
1456	
1457	  // ── Path 1: URL has roomId params (from direct link or invite redirect) ──
1458	  const urlParams = new URLSearchParams(window.location.search);
1459	  const urlRoomId = urlParams.get('roomId');
1460	  const urlMinBet = urlParams.get('minBet');
1461	
1462	  if (urlRoomId) {
1463	    // Skip lobby entirely — connect directly to the specified room
1464	    const user = JSON.parse(sessionStorage.getItem('bj_user') || '{}');
1465	    myUsername = user.username || '';
1466	    _isSinglePlayer = urlRoomId.includes('_private');
1467	    _lobbyMode = _isSinglePlayer ? 'single' : 'multi';
1468	    window._bjRoomId = urlRoomId;
1469	    _pendingRoomId   = urlRoomId;
1470	
1471	    document.getElementById('screen-lobby').classList.remove('active');
1472	    document.getElementById('screen-game').classList.add('active');
1473	    document.getElementById('ingame-menu-btn').style.display = 'flex';
1474	
1475	    if (!user.username) {
1476	      // Not logged in via sessionStorage — try IGM token fallback
1477	      setTimeout(() => {
1478	        const tok = typeof igmToken !== 'undefined' ? igmToken : '';
1479	        const uname = typeof myUsername !== 'undefined' ? myUsername : 'Player';
1480	        connectWS(uname, tok, urlRoomId);
1481	      }, 300);
1482	    } else {
1483	      // Handle table entry if not already done
1484	      if (!JSON.parse(sessionStorage.getItem('bj_table') || '{}').enterHandled) {
1485	        fetch('/api/game/bj/enter', {
1486	          method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+user.token},
1487	          credentials:'include', body:JSON.stringify({tableMinBet: Number(urlMinBet) || 100})
1488	        }).catch(() => {});
1489	      }
1490	      sessionStorage.removeItem('bj_user');
1491	      sessionStorage.removeItem('bj_table');
1492	      connectWS(user.username, user.token, urlRoomId);
1493	    }
1494	    return;
1495	  }
1496	
1497	  // ── Path 2: sessionStorage set ──────────────────────────────
1498	  try {
1499	    const uj = sessionStorage.getItem('bj_user');