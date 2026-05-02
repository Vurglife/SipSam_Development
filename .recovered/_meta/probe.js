#!/usr/bin/env node
/*
 * probe.js — find anything suspicious that might contain Blackjack source.
 * Looks at:
 *   - ALL Write tool_uses (any path)
 *   - Bash commands that look like heredoc / cat > / echo > to files
 *   - User text messages containing big code blocks (>2KB) mentioning Blackjack
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

const writes = [];     // [{ts, source, file_path, contentSize, snippet}]
const bashWrites = []; // [{ts, source, command, snippet}]
const userBjPastes = []; // [{ts, source, contentSize, snippet}]

const TRANSCRIPTS = findAllTranscripts('C:/Users/Mitstar/.claude/projects');

// Track the most recent Read input file_path per tool_use_id so we can
// associate the eventual tool_result with the file it was reading.
const readInputs = {}; // tool_use_id -> file_path

const reads = []; // [{ts, source, file_path, contentSize, content}]

function processToolUse(block, ts, source) {
  if (block.type !== 'tool_use') return;
  const name = (block.name || '').toLowerCase();
  const input = block.input || {};
  if (name === 'write') {
    const fp = input.file_path || input.filePath || '';
    const c = input.content || '';
    writes.push({ ts, source, file_path: fp, contentSize: c.length, snippet: c.slice(0, 160) });
  } else if (name === 'bash') {
    const cmd = input.command || '';
    if (/cat\s*>|cat\s*<<|echo\s*>|tee\s*>|Out-File|Set-Content/i.test(cmd) && /(blackjack|BlackjackRoom)/i.test(cmd)) {
      bashWrites.push({ ts, source, command: cmd.slice(0, 200), snippet: cmd.slice(0, 400) });
    }
  } else if (name === 'read') {
    const fp = input.file_path || input.filePath || '';
    if (block.id) readInputs[block.id] = { fp, ts, source };
  }
}

function processToolResult(block, ts, source) {
  if (block.type !== 'tool_result') return;
  const tuid = block.tool_use_id;
  const meta = readInputs[tuid];
  if (!meta) return; // not a Read result
  let text = '';
  const c = block.content;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const blk of c) if (blk.type === 'text' && blk.text) text += blk.text;
  }
  if (!text) return;
  // Filter to interesting paths
  const fp = meta.fp;
  if (/(blackjack|BlackjackRoom|poker-server|poker-client|vurglife-platform)/i.test(fp)) {
    reads.push({ ts: meta.ts, source: meta.source, file_path: fp, contentSize: text.length, content: text });
  }
}

function processUserMessage(msg, ts, source) {
  const c = msg.content;
  if (typeof c === 'string') {
    if (c.length > 2000 && /(BlackjackRoom|blackjack-server|blackjack-client)/i.test(c)) {
      userBjPastes.push({ ts, source, contentSize: c.length, snippet: c.slice(0, 200) });
    }
  } else if (Array.isArray(c)) {
    for (const blk of c) {
      if (blk.type === 'text' && blk.text && blk.text.length > 2000 && /(BlackjackRoom|blackjack-server|blackjack-client)/i.test(blk.text)) {
        userBjPastes.push({ ts, source, contentSize: blk.text.length, snippet: blk.text.slice(0, 200) });
      }
    }
  }
}

function processLine(line, source) {
  if (!line.trim()) return;
  let obj; try { obj = JSON.parse(line); } catch (e) { return; }
  const ts = obj.timestamp || obj.created_at || obj.ts || '';
  const msg = obj.message || obj;
  if (msg.role === 'user') processUserMessage(msg, ts, source);
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      processToolUse(block, ts, source);
      processToolResult(block, ts, source);
    }
  }
}

(async () => {
  for (const t of TRANSCRIPTS) {
    const stream = fs.createReadStream(t, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const source = path.basename(t);
    for await (const line of rl) processLine(line, source);
  }

  // Filter to Blackjack-relevant Writes
  const bjWrites = writes.filter(w => /blackjack|BlackjackRoom/i.test(w.file_path));
  console.log('=== BLACKJACK WRITE TOOL CALLS ===');
  bjWrites.sort((a,b) => (a.ts > b.ts ? 1 : -1));
  for (const w of bjWrites) {
    console.log(`  ${w.ts}  ${w.contentSize.toString().padStart(7)}  ${w.file_path}`);
    console.log(`    src: ${w.source}`);
  }
  console.log('\n=== BASH COMMANDS THAT LOOK LIKE FILE-WRITES FOR BLACKJACK ===');
  for (const b of bashWrites) {
    console.log(`  ${b.ts}  src: ${b.source}`);
    console.log(`    cmd: ${b.command}`);
  }
  console.log('\n=== USER MESSAGES WITH LARGE BLACKJACK PASTES (>2KB) ===');
  userBjPastes.sort((a,b) => (a.ts > b.ts ? 1 : -1));
  for (const u of userBjPastes) {
    console.log(`  ${u.ts}  size=${u.contentSize}  src: ${u.source}`);
    console.log(`    snip: ${u.snippet.replace(/\n/g,' \\n ').slice(0,150)}`);
  }
  // Read results — sort largest first per file
  console.log('\n=== READ RESULTS for Blackjack-related paths ===');
  const bjReads = reads.filter(r => /blackjack|BlackjackRoom/i.test(r.file_path));
  bjReads.sort((a,b) => b.contentSize - a.contentSize);
  // Group by file_path basename, keep biggest
  const byFile = {};
  for (const r of bjReads) {
    const base = path.basename(r.file_path);
    if (!byFile[base] || byFile[base].contentSize < r.contentSize) byFile[base] = r;
  }
  for (const [base, r] of Object.entries(byFile)) {
    console.log(`  ${base.padEnd(30)} biggestRead=${r.contentSize}  src=${r.source}  ts=${r.ts}`);
  }
  // Save the biggest READ for each Blackjack file as a recovery candidate
  const dumpDir = path.join(__dirname, '..', 'blackjack-reads');
  fs.mkdirSync(dumpDir, { recursive: true });
  for (const [base, r] of Object.entries(byFile)) {
    fs.writeFileSync(path.join(dumpDir, base), r.content || '', 'utf8');
  }
  console.log(`  -> saved biggest reads to: ${dumpDir}`);

  console.log('\n=== TOTAL WRITES ACROSS ALL FILES ===', writes.length);
  console.log('Writes by basename (top 30):');
  const byBase = {};
  for (const w of writes) {
    const b = path.basename(w.file_path || '');
    if (!byBase[b]) byBase[b] = 0;
    byBase[b]++;
  }
  const top = Object.entries(byBase).sort((a,b) => b[1]-a[1]).slice(0,30);
  for (const [b,n] of top) console.log(`  ${n.toString().padStart(4)}  ${b}`);
})();
