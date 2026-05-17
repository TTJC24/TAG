#!/usr/bin/env node
// PostToolUse hook: after a .ts/.tsx Edit/Write, run eslint on the changed file
// and pnpm typecheck across the project. Exit 2 surfaces failures back to Claude.

import { spawnSync } from 'node:child_process';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = String(input?.tool_input?.file_path || '');
  if (!/\.(ts|tsx)$/.test(filePath)) process.exit(0);

  const opts = { stdio: 'inherit', shell: true };

  const lint = spawnSync('pnpm', ['exec', 'eslint', filePath], opts);
  if (lint.status !== 0) {
    console.error(`[post-edit] eslint failed on ${filePath}`);
    process.exit(2);
  }

  const tc = spawnSync('pnpm', ['typecheck'], opts);
  if (tc.status !== 0) {
    console.error('[post-edit] pnpm typecheck failed');
    process.exit(2);
  }
});
