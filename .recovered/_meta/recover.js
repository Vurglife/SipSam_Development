#!/usr/bin/env node
/*
 * recover.js — extract lost source files from Claude session transcripts.
 *
 * Strategy: stream each .jsonl line by line, parse, filter tool_use blocks
 * for Edit / Write / MultiEdit tools targeting paths we care about, and
 * keep only the LATEST version of each file per session ordering.
 *
 * Output:
 *   .recovered/sipsam-vip/<basename>            — last full-Write content
 *   .recovered/sipsam-vip/<basename>.edits.txt  — chronological Edit diffs
 *   .recovered/blackjack/...                    — same shape
 *   .recovered/_meta/manifest.json              — what was found, where, when
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = 'G:/SipSam/PokerProject';
const OUT  = path.join(ROOT, '.recovered');
// Scan EVERY .jsonl under the Claude projects dir, including subagent
// transcripts (which often contain Write/Edit calls the parent didn't
// surface).
function findAllTranscripts(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
    }
  }
  walk(root);
  return out;
}
const TRANSCRIPTS = findAllTranscripts('C:/Users/Mitstar/.claude/projects');

// Map every interesting file_path pattern to a bucket name.
function bucketFor(filePath) {
  if (!filePath) return null;
  const fp = filePath.replace(/\\/g, '/').toLowerCase();

  // Blackjack — full game
  if (/\bblackjack-(client|server)\b/.test(fp)) return 'blackjack';

  // SipSam VIP / Specials work — match changes to these specific files
  if (/\/poker-server\/(pokerroom|logic|index)\.js$/i.test(fp)) return 'sipsam-vip';
  if (/\/poker-client\/(index\.html|game\.js|style\.css)$/i.test(fp)) return 'sipsam-vip';
  if (/\/vurglife-platform\/server\/routes\/game\.js$/i.test(fp)) return 'sipsam-vip';
  if (/\/vurglife-platform\/server\/index\.js$/i.test(fp)) return 'sipsam-vip';
  if (/\/vurglife-platform\/client\/public\/index\.html$/i.test(fp)) return 'sipsam-vip';

  return null;
}

// Per-bucket: { '<basename>': { lastWrite: {ts, content}, edits: [{ts, oldString, newString}] } }
const buckets = {};

function record(bucket, filePath, kind, payload, ts, source) {
  buckets[bucket] = buckets[bucket] || {};
  // Use the relative-ish path so we can reconstruct it
  const fp = filePath.replace(/\\/g, '/');
  // Strip everything before the recognisable repo folder so different worktrees
  // map to the same key.
  const rel = fp.replace(/.*?\/(blackjack-(client|server)|poker-(client|server)|vurglife-platform|holdem-(client|server)|rhum32-(client|server))\//, '$1/');
  buckets[bucket][rel] = buckets[bucket][rel] || { writes: [], edits: [] };
  if (kind === 'write') {
    buckets[bucket][rel].writes.push({ ts, source, content: payload.content });
  } else if (kind === 'edit') {
    buckets[bucket][rel].edits.push({
      ts, source,
      old_string: payload.old_string,
      new_string: payload.new_string,
      replace_all: !!payload.replace_all,
    });
  } else if (kind === 'multi_edit') {
    for (const e of (payload.edits || [])) {
      buckets[bucket][rel].edits.push({
        ts, source,
        old_string: e.old_string,
        new_string: e.new_string,
        replace_all: !!e.replace_all,
      });
    }
  }
}

function processToolUse(block, ts, source) {
  if (!block || block.type !== 'tool_use') return;
  const name = (block.name || '').toLowerCase();
  if (!['edit', 'write', 'multiedit'].includes(name)) return;
  const input = block.input || {};
  const filePath = input.file_path || input.filePath;
  if (!filePath) return;
  const bucket = bucketFor(filePath);
  if (!bucket) return;
  if (name === 'write') {
    record(bucket, filePath, 'write', input, ts, source);
  } else if (name === 'edit') {
    record(bucket, filePath, 'edit', input, ts, source);
  } else if (name === 'multiedit') {
    record(bucket, filePath, 'multi_edit', input, ts, source);
  }
}

function processLine(line, source) {
  if (!line.trim()) return;
  let obj;
  try { obj = JSON.parse(line); } catch (e) { return; }
  const ts = obj.timestamp || obj.created_at || obj.ts || '';
  const msg = obj.message || obj;
  const content = msg.content;
  if (!content) return;
  if (Array.isArray(content)) {
    for (const block of content) processToolUse(block, ts, source);
  }
}

async function processFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error('MISSING:', filePath);
    return;
  }
  console.error('Reading', filePath, '(', fs.statSync(filePath).size, 'bytes )');
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const source = path.basename(filePath);
  let n = 0;
  for await (const line of rl) {
    processLine(line, source);
    n++;
  }
  console.error('  lines:', n);
}

(async () => {
  for (const t of TRANSCRIPTS) await processFile(t);

  const manifest = {};
  for (const [bucket, files] of Object.entries(buckets)) {
    manifest[bucket] = {};
    const dir = path.join(OUT, bucket);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, data] of Object.entries(files)) {
      const safeName = rel.replace(/[\\/]/g, '__');
      // Latest Write becomes the canonical recovered file
      let canonical = null;
      if (data.writes.length) {
        // Sort writes by timestamp (string sort works for ISO 8601)
        data.writes.sort((a, b) => (a.ts > b.ts ? 1 : -1));
        canonical = data.writes[data.writes.length - 1];
        const outPath = path.join(dir, safeName);
        fs.writeFileSync(outPath, canonical.content || '', 'utf8');
      }
      // Edits dumped chronologically for replay/audit
      if (data.edits.length) {
        data.edits.sort((a, b) => (a.ts > b.ts ? 1 : -1));
        const editsPath = path.join(dir, safeName + '.edits.json');
        fs.writeFileSync(editsPath, JSON.stringify(data.edits, null, 2), 'utf8');
      }
      manifest[bucket][rel] = {
        writes: data.writes.length,
        edits: data.edits.length,
        latestWriteTs: canonical ? canonical.ts : null,
        latestWriteSource: canonical ? canonical.source : null,
        latestWriteSize: canonical ? (canonical.content || '').length : 0,
      };
    }
  }

  fs.writeFileSync(path.join(OUT, '_meta', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  // Also drop a flat readable summary
  let summary = '';
  for (const [bucket, files] of Object.entries(manifest)) {
    summary += `\n=== ${bucket} ===\n`;
    const rows = Object.entries(files).sort();
    for (const [rel, info] of rows) {
      summary += `  ${rel.padEnd(60)} writes=${info.writes} edits=${info.edits} size=${info.latestWriteSize} latest=${info.latestWriteTs || 'n/a'}\n`;
    }
  }
  fs.writeFileSync(path.join(OUT, '_meta', 'summary.txt'), summary, 'utf8');
  console.error(summary);
})();
