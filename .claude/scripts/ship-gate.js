#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC_ROOTS = [
  'poker-server',
  'poker-client',
  'blackjack-server',
  'blackjack-client',
  'rhum32-server',
  'rhum32-client',
  'roulette-server',
  'roulette-client',
  'holdem-server',
  'holdem-client',
  'shared',
  'vurglife-platform/server',
  'vurglife-platform/client/public'
];

function run(command, args, timeout = 6000) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout
    });
  } catch (err) {
    return null;
  }
}

function projectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const fromGit = run('git', ['rev-parse', '--show-toplevel']);
  return fromGit ? path.resolve(fromGit.trim()) : null;
}

function changedFiles(root) {
  const commands = [
    ['diff', '--name-only', 'HEAD', '--', ...SRC_ROOTS, ':(exclude)**/node_modules/**'],
    ['diff', '--name-only', '--cached', '--', ...SRC_ROOTS, ':(exclude)**/node_modules/**'],
    ['ls-files', '--others', '--exclude-standard', '--', ...SRC_ROOTS, ':(exclude)**/node_modules/**']
  ];
  const files = new Set();
  for (const args of commands) {
    const output = run('git', args);
    if (!output) continue;
    for (const line of output.split(/\r?\n/)) {
      const file = line.trim();
      if (file) files.add(file.replace(/\\/g, '/'));
    }
  }
  return [...files].sort().filter((file) => shouldCheck(root, file));
}

function shouldCheck(root, file) {
  if (!file.endsWith('.js') && !file.endsWith('.json')) return false;
  if (
    file.includes('/node_modules/') ||
    file.startsWith('.git/') ||
    file.includes('/.claude/') ||
    file.includes('/data/') && file.endsWith('.db') ||
    /\.bak\./.test(file)
  ) {
    return false;
  }
  return fs.existsSync(path.join(root, file));
}

function checkJson(filePath) {
  JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const root = projectRoot();
  if (!root) return 0;
  process.chdir(root);
  if (!run('node', ['--version'], 3000)) return 0;

  const failures = [];
  for (const file of changedFiles(root)) {
    const filePath = path.join(root, file);
    if (file.endsWith('.js')) {
      try {
        execFileSync('node', ['--check', filePath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10000
        });
      } catch (err) {
        failures.push(`[JS PARSE]  ${file}\n${err.stderr || err.message}`);
      }
    } else if (file.endsWith('.json')) {
      try {
        checkJson(filePath);
      } catch (err) {
        failures.push(`[JSON BAD]  ${file}\n${err.message}`);
      }
    }
  }

  if (failures.length) {
    process.stderr.write('SHIP-GATE BLOCKED - broken syntax in changed files. Fix before finishing:\n');
    process.stderr.write(`${failures.join('\n\n')}\n`);
    return 2;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.exitCode = 0;
}
