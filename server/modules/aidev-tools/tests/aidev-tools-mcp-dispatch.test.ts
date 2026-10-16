import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every platform tool the MCP process lists must have a branch in its dispatch: `opencode_task` was listed but not
 * dispatched (2026-10-16), so a Claude worker saw the tool and every call came back "Unknown tool". The MCP process is
 * a script that starts serving on import, so its source is read instead.
 */
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'aidev-tools-mcp.ts'), 'utf8');

test('every listed platform tool is dispatched', () => {
  const listStart = source.indexOf('const tools: ToolDefinition[] = [');
  const dispatchStart = source.indexOf('async function callTool(');
  assert.ok(listStart > 0 && dispatchStart > listStart);
  const listed = [...source.slice(listStart, dispatchStart).matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map((match) => match[1]);
  const dispatched = new Set([...source.slice(dispatchStart).matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]));
  assert.ok(listed.length > 20, `found ${listed.length} tools`);
  assert.ok(listed.includes('opencode_task'));
  assert.deepEqual(listed.filter((name) => !dispatched.has(name)), []);
});
