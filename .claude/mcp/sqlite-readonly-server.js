#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_NAME = 'vurglife-sqlite-readonly';
const SERVER_VERSION = '1.0.0';
const PROJECT_ROOT = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = resolveProjectPath(process.env.VURGLIFE_SQLITE_DB || 'vurglife-platform/data/vurglife.db');
const ROW_LIMIT = clampInt(process.env.SQLITE_MCP_ROW_LIMIT, 1, 500, 100);

let sqlModulePromise;
let dbPromise;

function resolveProjectPath(relativeOrAbsolute) {
  const resolved = path.resolve(PROJECT_ROOT, relativeOrAbsolute);
  const rootWithSep = PROJECT_ROOT.endsWith(path.sep) ? PROJECT_ROOT : PROJECT_ROOT + path.sep;
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Database path must stay inside project root: ${relativeOrAbsolute}`);
  }
  return resolved;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function locateSqlJs() {
  const candidates = [
    path.join(PROJECT_ROOT, 'vurglife-platform', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
    path.join(__dirname, '..', '..', 'vurglife-platform', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js')
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('sql.js is not installed. Run npm install in vurglife-platform first.');
  }
  return found;
}

async function getSqlModule() {
  if (!sqlModulePromise) {
    const sqlJsPath = locateSqlJs();
    const initSqlJs = require(sqlJsPath);
    sqlModulePromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(sqlJsPath), file)
    });
  }
  return sqlModulePromise;
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (!fs.existsSync(DB_PATH)) {
        throw new Error(`SQLite database not found: ${DB_PATH}`);
      }
      const SQL = await getSqlModule();
      return new SQL.Database(fs.readFileSync(DB_PATH));
    })();
  }
  return dbPromise;
}

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function assertReadOnlySql(sql) {
  const clean = stripSqlComments(sql);
  if (!clean) throw new Error('Query is empty.');
  const statements = clean.split(';').map((part) => part.trim()).filter(Boolean);
  if (statements.length !== 1) {
    throw new Error('Only one read-only statement is allowed.');
  }
  const first = statements[0].split(/\s+/, 1)[0].toLowerCase();
  if (!['select', 'with', 'explain'].includes(first)) {
    throw new Error('Only SELECT, WITH, and EXPLAIN queries are allowed.');
  }
  const blocked = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|analyze|pragma)\b/i;
  if (blocked.test(clean)) {
    throw new Error('Write-capable SQL keywords are blocked.');
  }
  return statements[0];
}

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) {
    throw new Error(`Invalid SQLite identifier: ${name}`);
  }
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function runQuery(sql, params = [], limit = ROW_LIMIT) {
  const db = await getDb();
  const cleanSql = assertReadOnlySql(sql);
  const stmt = db.prepare(cleanSql);
  try {
    if (Array.isArray(params) || params && typeof params === 'object') {
      stmt.bind(params);
    }
    const columns = stmt.getColumnNames();
    const rows = [];
    let truncated = false;
    while (stmt.step()) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(stmt.getAsObject());
    }
    return { columns, rows, rowCount: rows.length, truncated, rowLimit: limit };
  } finally {
    stmt.free();
  }
}

async function listTables() {
  const result = await runQuery(
    "SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    [],
    500
  );
  return result.rows;
}

async function describeTable(name) {
  const db = await getDb();
  const quoted = quoteIdentifier(name);
  const columns = db.exec(`PRAGMA table_info(${quoted})`);
  const indexes = db.exec(`PRAGMA index_list(${quoted})`);
  const foreignKeys = db.exec(`PRAGMA foreign_key_list(${quoted})`);
  return {
    table: name,
    columns: execToObjects(columns),
    indexes: execToObjects(indexes),
    foreignKeys: execToObjects(foreignKeys)
  };
}

async function getSchema() {
  const tables = await listTables();
  const schema = [];
  for (const item of tables) {
    const description = await describeTable(item.name);
    schema.push({ ...item, ...description });
  }
  return schema;
}

function execToObjects(resultSets) {
  if (!resultSets || !resultSets[0]) return [];
  const { columns, values } = resultSets[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function toolList() {
  return [
    {
      name: 'list_tables',
      description: 'List user tables and views in vurglife.db.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'describe_table',
      description: 'Describe a single SQLite table or view.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Table or view name.' } },
        required: ['name'],
        additionalProperties: false
      }
    },
    {
      name: 'get_schema',
      description: 'Return table names, columns, indexes, and foreign keys for vurglife.db.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'read_query',
      description: `Run one read-only SELECT/WITH/EXPLAIN query. Results are capped at ${ROW_LIMIT} rows by default.`,
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Read-only SQL query.' },
          params: {
            description: 'Optional sql.js bind parameters as an array or named object.',
            oneOf: [{ type: 'array' }, { type: 'object' }]
          },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Optional row cap.' }
        },
        required: ['sql'],
        additionalProperties: false
      }
    }
  ];
}

async function callTool(name, args = {}) {
  if (name === 'list_tables') return listTables();
  if (name === 'describe_table') return describeTable(args.name);
  if (name === 'get_schema') return getSchema();
  if (name === 'read_query') {
    const limit = clampInt(args.limit, 1, 500, ROW_LIMIT);
    return runQuery(args.sql, args.params || [], limit);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (!method) return;
  if (method.startsWith('notifications/')) return;

  try {
    if (method === 'initialize') {
      result(id, {
        protocolVersion: params && params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      return;
    }
    if (method === 'tools/list') {
      result(id, { tools: toolList() });
      return;
    }
    if (method === 'tools/call') {
      const payload = await callTool(params.name, params.arguments || {});
      result(id, {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      });
      return;
    }
    if (method === 'resources/list') {
      result(id, { resources: [] });
      return;
    }
    if (method === 'prompts/list') {
      result(id, { prompts: [] });
      return;
    }
    error(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    error(id, -32000, err && err.message || String(err));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (err) {
      error(null, -32700, err && err.message || 'Parse error');
    }
  }
});
