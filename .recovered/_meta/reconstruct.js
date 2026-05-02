#!/usr/bin/env node
/*
 * reconstruct.js — best-effort reconstruction of lost files from transcripts.
 *
 * For each interesting file, gather:
 *   1. EVERY Read tool result (which is a `cat -n`-formatted snapshot at some
 *      offset). Stitch together the union of line ranges, taking the LATEST
 *      version for each line number where they overlap.
 *   2. The chronological Edit chain. Apply each Edit on top of the stitched
 *      base. (Order: stitched base may already include later edits because the
 *      Read happened after some edits — applying again should be idempotent in
 *      most cases since old_string won't match anymore.)
 *
 * Output goes to .recovered/<bucket>/<basename> with a sibling `.notes.txt`
 * explaining what's complete vs. partial.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function findAllTranscripts(root) {
  const out = [];
  function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
    }
  }
  walk(root); return out;
}

function bucketFor(fp) {
  if (!fp) return null;
  const f = fp.replace(/\\/g,'/').toLowerCase();
  if (/\bblackjack-(client|server)\b/.test(f)) return 'blackjack';
  if (/\/poker-(server|client)\//.test(f)) return 'sipsam-vip';
  if (/\/vurglife-platform\//.test(f)) return 'sipsam-vip';
  return null;
}

function relPath(fp) {
  return fp.replace(/\\/g,'/').replace(/.*?\/(blackjack-(client|server)|poker-(client|server)|vurglife-platform)\//, '$1/');
}

const files = {}; // bucket/relPath -> { reads: [{ts, lines:{n: text}}], edits: [{ts, old, new, all}], writes: [{ts, content}] }

function ensure(b, rel) {
  const k = b + '|' + rel;
  if (!files[k]) files[k] = { bucket: b, rel, reads: [], edits: [], writes: [] };
  return files[k];
}

const readInputs = {}; // tool_use_id -> { fp, ts, source, offset, limit }

function processToolUse(block, ts) {
  if (block.type !== 'tool_use') return;
  const name = (block.name||'').toLowerCase();
  const input = block.input || {};
  const fp = input.file_path || input.filePath;
  if (!fp) return;
  const b = bucketFor(fp);
  if (!b) return;
  const rel = relPath(fp);
  if (name === 'write') {
    ensure(b, rel).writes.push({ ts, content: input.content || '' });
  } else if (name === 'edit') {
    ensure(b, rel).edits.push({ ts, old: input.old_string || '', new: input.new_string || '', all: !!input.replace_all });
  } else if (name === 'multiedit') {
    for (const e of (input.edits || [])) {
      ensure(b, rel).edits.push({ ts, old: e.old_string || '', new: e.new_string || '', all: !!e.replace_all });
    }
  } else if (name === 'read') {
    if (block.id) readInputs[block.id] = { fp, ts, offset: input.offset || 1, limit: input.limit || 0 };
  }
}

function processToolResult(block) {
  if (block.type !== 'tool_result') return;
  const meta = readInputs[block.tool_use_id];
  if (!meta) return;
  const b = bucketFor(meta.fp);
  if (!b) return;
  let text = '';
  const c = block.content;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) for (const blk of c) if (blk.type==='text' && blk.text) text += blk.text;
  if (!text) return;
  // Parse cat -n format: each non-empty line starts with optional whitespace + number + tab + content
  const lines = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\t(.*)$/);
    if (m) lines[+m[1]] = m[2];
  }
  ensure(b, relPath(meta.fp)).reads.push({ ts: meta.ts, lines });
}

function processLine(line) {
  if (!line.trim()) return;
  let obj; try { obj = JSON.parse(line); } catch(e){ return; }
  const ts = obj.timestamp || obj.created_at || obj.ts || '';
  const msg = obj.message || obj;
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      processToolUse(block, ts);
      processToolResult(block);
    }
  }
}

function stitch(reads) {
  // For each line number, take the latest snapshot's value
  reads.sort((a,b) => (a.ts > b.ts ? 1 : -1));
  const merged = {};
  for (const r of reads) {
    for (const [n, t] of Object.entries(r.lines)) {
      // Latest wins (overwrite)
      merged[+n] = t;
    }
  }
  // Reconstruct as line array
  const max = Math.max(...Object.keys(merged).map(Number).concat([0]));
  const arr = new Array(max);
  let coveredCount = 0;
  for (let i = 1; i <= max; i++) {
    if (merged.hasOwnProperty(i)) { arr[i-1] = merged[i]; coveredCount++; }
    else arr[i-1] = `// [LINE ${i} MISSING — no Read snapshot covers it]`;
  }
  return { content: arr.join('\n'), maxLine: max, covered: coveredCount, lines: merged };
}

function applyEdits(base, edits) {
  edits.sort((a,b) => (a.ts > b.ts ? 1 : -1));
  let s = base;
  let applied = 0, failed = 0;
  for (const e of edits) {
    if (!e.old) {
      // Cannot apply Edit with empty old_string except as initial Write — skip
      failed++; continue;
    }
    if (e.all) {
      // Replace all
      const idx = s.indexOf(e.old);
      if (idx >= 0) { s = s.split(e.old).join(e.new); applied++; }
      else failed++;
    } else {
      const idx = s.indexOf(e.old);
      if (idx >= 0) { s = s.slice(0, idx) + e.new + s.slice(idx + e.old.length); applied++; }
      else failed++;
    }
  }
  return { content: s, applied, failed };
}

(async () => {
  const TRANSCRIPTS = findAllTranscripts('C:/Users/Mitstar/.claude/projects');
  console.error(`Scanning ${TRANSCRIPTS.length} transcripts...`);
  for (const t of TRANSCRIPTS) {
    const stream = fs.createReadStream(t, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) processLine(line);
  }

  const ROOT = 'G:/SipSam/PokerProject/.recovered';
  const notes = [];
  notes.push(`Reconstruction run at ${new Date().toISOString()}`);
  notes.push(`Scanned ${TRANSCRIPTS.length} transcripts`);
  notes.push('');

  const sortedKeys = Object.keys(files).sort();
  for (const k of sortedKeys) {
    const f = files[k];
    const dir = path.join(ROOT, f.bucket);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = f.rel.replace(/[\\/]/g, '__');

    // Pick base: latest Write if any, else stitched reads
    let base = '';
    let baseSource = 'none';
    if (f.writes.length) {
      f.writes.sort((a,b)=>(a.ts>b.ts?1:-1));
      base = f.writes[f.writes.length-1].content;
      baseSource = `Write @${f.writes[f.writes.length-1].ts}`;
    } else if (f.reads.length) {
      const stitched = stitch(f.reads);
      base = stitched.content;
      baseSource = `${f.reads.length} Reads (max line ${stitched.maxLine}, covered ${stitched.covered})`;
    }

    // Apply edits chronologically
    const editResult = applyEdits(base, f.edits);

    fs.writeFileSync(path.join(dir, safeName), editResult.content, 'utf8');

    notes.push(`=== ${f.bucket}/${f.rel} ===`);
    notes.push(`  base: ${baseSource}`);
    notes.push(`  edits: ${f.edits.length} (applied=${editResult.applied}, failed=${editResult.failed})`);
    notes.push(`  output size: ${editResult.content.length} bytes`);
    notes.push('');
  }

  fs.writeFileSync(path.join(ROOT, '_meta', 'reconstruction-notes.txt'), notes.join('\n'), 'utf8');
  console.error('Done. See .recovered/_meta/reconstruction-notes.txt');
})();
