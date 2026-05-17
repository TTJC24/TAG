#!/usr/bin/env node
// PreToolUse hook: blocks edits to credential files, warns on package.json changes.
// Reads tool call JSON from stdin. Exit 2 blocks the tool call.

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = String(input?.tool_input?.file_path || '').replace(/\\/g, '/');
  if (!filePath) process.exit(0);

  if (/(^|\/)\.env(\.|$)/.test(filePath)) {
    console.error(
      `Blocked: ${filePath} holds credentials (Clerk / Neon / Groq / Gemini / MS Graph). Edit it yourself.`
    );
    process.exit(2);
  }

  if (/(^|\/)package\.json$/.test(filePath)) {
    console.error(
      'Reminder (CLAUDE.md): do not add libraries without explicit approval. Confirm with the user before changing dependencies.'
    );
  }

  process.exit(0);
});
