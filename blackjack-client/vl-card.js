// ================================================================
//  VURGLIFE UNIVERSAL CARD MAKER — vl-card.js  v2.0
//  VurgLife Platform — All card games
//
//  Usage:
//    const el = makeVLCard({ rank:'A', suit:'♥' });
//    const el = makeVLCard({ rank:'?', faceDown:true });
//    container.appendChild(el);
//
//  Options object (second arg):
//    size    — 'sm' | '' | 'lg'   (default '')
//    active  — bool               (blue glow border)
//    state   — 'win'|'lose'|'bj'  (result border)
// ================================================================

const VL_SUIT_MAP = {
  h:'♥', d:'♦', c:'♣', s:'♠', H:'♥', D:'♦', C:'♣', S:'♠',
  hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠',
  '♥':'♥','♦':'♦','♣':'♣','♠':'♠',
};
const VL_SUIT_CLASS = {
  '♥':'hearts','♦':'diamonds','♣':'clubs','♠':'spades',
  h:'hearts',d:'diamonds',c:'clubs',s:'spades',
  H:'hearts',D:'diamonds',C:'clubs',S:'spades',
  hearts:'hearts',diamonds:'diamonds',clubs:'clubs',spades:'spades',
};

function normalizeVLOpts(opts = {}) {
  if (typeof opts === 'string') return { size: opts };
  return opts || {};
}

function vlSizeClass(size) {
  if (size === 'sm') return 'vl-sm';
  if (size === 'lg') return 'vl-lg';
  if (size === 'xl') return 'vl-xl';
  return '';
}

function makeVLCard(card, opts = {}) {
  opts = normalizeVLOpts(opts);
  const el = document.createElement('div');

  // ── Face-down ──
  if (!card || card.faceDown || card.rank === '?' || card.rank === null) {
    el.className = [
      'vl-card face-down',
      vlSizeClass(opts.size),
      opts.animate ? 'vl-deal-in' : '',
    ].filter(Boolean).join(' ');
    return el;
  }

  // ── Normalise suit ──
  const suitSym   = VL_SUIT_MAP[card.suit]   || card.suit || '♠';
  const suitClass = VL_SUIT_CLASS[card.suit] || 'spades';
  const rank      = card.rank;

  el.className = [
    'vl-card',
    suitClass,
    vlSizeClass(opts.size),
    opts.active         ? 'vl-active' : '',
    opts.state === 'win'  ? 'vl-win'  : '',
    opts.state === 'lose' ? 'vl-lose' : '',
    opts.state === 'bj'   ? 'vl-bj'  : '',
    opts.animate          ? 'vl-deal-in' : '',
  ].filter(Boolean).join(' ');

  // Top-left pip + centred rank/suit + bottom-right pip
  el.innerHTML = `
    <div class="vl-pip">
      <span class="pip-r">${rank}</span>
      <span class="pip-s">${suitSym}</span>
    </div>
    <span class="vl-rank">${rank}</span>
    <span class="vl-suit">${suitSym}</span>
    <div class="vl-pip-br">
      <span class="pip-r">${rank}</span>
      <span class="pip-s">${suitSym}</span>
    </div>`;

  return el;
}

// Render a full hand of cards into a container element
function renderVLHand(container, cards, opts = {}) {
  if (!container) return;
  container.innerHTML = '';
  (cards || []).forEach(c => container.appendChild(makeVLCard(c, opts)));
}

// Export for CommonJS / module environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeVLCard, renderVLHand };
}
if (typeof window !== 'undefined') {
  window.vlCard = makeVLCard;
  window.renderVLHand = renderVLHand;
}
