// The gateway's checks for the ship gate (release/ship.sh runs `npm test` here): every test/*-test.mjs against a fresh
// build, one at a time; any failure fails the ship. Routing and the other gateway rules were tested but never gated
// (no test script until 2026-10-13), so a change that broke what they check could still deploy.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const files = fs.readdirSync(here).filter((name) => name.endsWith('-test.mjs')).sort();
const failed = [];
for (const name of files) {
  const t0 = Date.now();
  const result = spawnSync(process.execPath, [path.join(here, name)], { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = result.status === 0;
  const last = `${result.stdout ?? ''}`.trim().split('\n').at(-1) ?? '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${Date.now() - t0} ms) ${ok ? last.slice(0, 120) : ''}`);
  if (!ok) { failed.push(name); console.log(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n')); }
}
if (failed.length) { console.log(`\n${failed.length} of ${files.length} gateway tests failed: ${failed.join(', ')}`); process.exit(1); }
console.log(`\nall ${files.length} gateway tests passed`);
