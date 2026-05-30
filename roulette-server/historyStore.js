'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_MAX = 100;
const HISTORY_FILE = process.env.ROULETTE_HISTORY_FILE
  || path.join(__dirname, 'data', 'roulette-history.json');

const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const BLACK_SET = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

let history = loadHistory();

function normalizePocket(pocket) {
  if (pocket === '00') return '00';
  const n = Number(pocket);
  return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null;
}

function colorOf(pocket) {
  if (pocket === 0 || pocket === '00') return 'green';
  if (RED_SET.has(pocket)) return 'red';
  if (BLACK_SET.has(pocket)) return 'black';
  return 'green';
}

function normalizeEntry(entry) {
  const pocket = normalizePocket(entry && entry.pocket);
  if (pocket === null) return null;
  return {
    pocket,
    color: ['red', 'black', 'green'].includes(entry.color) ? entry.color : colorOf(pocket),
    round: Number.isFinite(Number(entry.round)) ? Number(entry.round) : null,
    at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : Date.now(),
  };
}

function sanitize(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(normalizeEntry)
    .filter(Boolean)
    .slice(0, HISTORY_MAX);
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return sanitize(Array.isArray(parsed) ? parsed : parsed.history);
  } catch (err) {
    console.error('[RouletteHistory] Could not load history:', err.message);
    return [];
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ history }, null, 2));
    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (err) {
    console.error('[RouletteHistory] Could not save history:', err.message);
  }
}

function getHistory() {
  return history.map((entry) => ({ ...entry }));
}

function latest() {
  return history[0] ? { ...history[0] } : null;
}

function recordSpin(entry) {
  const clean = normalizeEntry(entry);
  if (!clean) return getHistory();
  history.unshift(clean);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  saveHistory();
  return getHistory();
}

function setHistory(entries) {
  history = sanitize(entries);
  saveHistory();
  return getHistory();
}

module.exports = {
  HISTORY_MAX,
  HISTORY_FILE,
  getHistory,
  latest,
  recordSpin,
  setHistory,
};
