const L = require('./logic.js');

const deck = L.shuffleDeck(L.createDeck());
console.log('Deck OK:', deck.length, 'cards');
console.log('Sample 5 cards:', deck.slice(0, 5));

const hand = L.evaluateHand(deck.slice(0, 5));
console.log('Hand evaluation:', hand.name, '| Rank:', hand.rank);

const hand3 = L.evaluate3CardHand(deck.slice(0, 3));
console.log('3-card hand:', hand3.name);

console.log('--- ALL TESTS PASSED ---');
