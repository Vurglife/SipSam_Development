// Stop hook: copy the current session's transcript into the project
// workspace so tools that read the on-disk repo (e.g. Codex) can see the
// conversation, the same way prior recovery .docx/.txt files were visible.
//
// - Idempotent: overwrites the same target paths each turn, so the most
//   recent snapshot survives even if the session ends abruptly.
// - Best-effort: any failure logs to stderr and exits 0; never blocks Stop.
// - Resolves the MAIN project root via `git rev-parse --git-common-dir`,
//   so transcripts land in <project>/.claude/chats/ even when cwd is a
//   per-session worktree.

'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

function bail(msg) {
    if (msg) { try { console.error('[chat-export]', msg); } catch (e) {} }
    process.exit(0);
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const t = setTimeout(() => resolve(data), 1500);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => { data += c; });
        process.stdin.on('end',  () => { clearTimeout(t); resolve(data); });
        process.stdin.on('error',() => { clearTimeout(t); resolve(data); });
    });
}

function projectRoot(cwd) {
    try {
        const out = cp.execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const absGit = path.isAbsolute(out) ? out : path.resolve(cwd, out);
        return path.dirname(absGit);
    } catch (e) {
        return cwd;
    }
}

function safeName(s) {
    return String(s || 'session').replace(/[^A-Za-z0-9_-]/g, '');
}

function renderMarkdown(jsonlPath, sessionId) {
    let lines;
    try { lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/); }
    catch (e) { return null; }
    const out = [
        '# Chat transcript',
        '',
        '- Session: `' + sessionId + '`',
        '- Source: `' + jsonlPath + '`',
        '- Exported: ' + new Date().toISOString(),
        ''
    ];
    for (const raw of lines) {
        if (!raw.trim()) continue;
        let obj;
        try { obj = JSON.parse(raw); } catch (e) { continue; }
        const role = obj.role || (obj.message && obj.message.role) || obj.type;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = (obj.content !== undefined ? obj.content : (obj.message && obj.message.content));
        let text = '';
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            text = content.map(b => {
                if (typeof b === 'string') return b;
                if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
                if (b && b.type === 'tool_use')    return '\n_(tool call: ' + (b.name || '?') + ')_\n';
                if (b && b.type === 'tool_result') return '\n_(tool result)_\n';
                return '';
            }).join('');
        }
        if (!text.trim()) continue;
        out.push('---', '', '## ' + role, '', text.trim(), '');
    }
    return out.join('\n');
}

(async () => {
    const raw = await readStdin().catch(() => '');
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (e) {}
    const jsonl = payload.transcript_path;
    const sid   = payload.session_id || (jsonl ? path.basename(jsonl, '.jsonl') : 'unknown');
    const cwd   = payload.cwd || process.cwd();
    if (!jsonl || !fs.existsSync(jsonl)) return bail('missing transcript_path: ' + jsonl);
    const root = projectRoot(cwd);
    const chatsDir = path.join(root, '.claude', 'chats');
    try { fs.mkdirSync(chatsDir, { recursive: true }); } catch (e) { return bail('mkdir: ' + e.message); }
    const base = new Date().toISOString().slice(0, 10) + '-' + safeName(sid);
    const jsonlOut = path.join(chatsDir, base + '.jsonl');
    const mdOut    = path.join(chatsDir, base + '.md');
    try { fs.copyFileSync(jsonl, jsonlOut); } catch (e) { return bail('copy: ' + e.message); }
    const md = renderMarkdown(jsonl, sid);
    if (md) { try { fs.writeFileSync(mdOut, md, 'utf8'); } catch (e) {} }
    process.exit(0);
})().catch((e) => bail(e && e.message));
