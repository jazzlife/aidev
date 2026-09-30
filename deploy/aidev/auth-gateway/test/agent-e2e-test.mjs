// F-09d end to end (opt-in: costs a model call): the real runner runs the PC's Claude Code headless with the
// task on stdin (exec.start{stdin}), exactly as remote_agent does, and the stream-json report comes back.
//   RUNNER_BIN=… AGENT_E2E=1 node test/agent-e2e-test.mjs      (needs `claude` logged in on this machine)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const RUNNER_BIN = process.env.RUNNER_BIN;
if (!RUNNER_BIN || !process.env.AGENT_E2E) { console.log('SKIP: set RUNNER_BIN and AGENT_E2E=1'); process.exit(0); }
try { execFileSync('sh', ['-c', 'command -v claude'], { stdio: 'ignore' }); } catch { console.log('SKIP: claude not installed'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-agent-e2e-'));
const work = path.join(dir, 'proj');
fs.mkdirSync(work);
fs.writeFileSync(path.join(work, 'calc.c'), '#include <stdio.h>\nint add(int a, int b) { return a - b; }\nint main(void) { printf("%d\\n", add(2, 3)); return 0; }\n');
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken } = await import('../dist/runner-hub.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const tid = store.addTarget({ userId: uid, name: 'agent-box', platform: 'linux', pairingCode: 'AG', pairingExpires: Date.now() + 60000 });
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(uid, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
const runners = createRunnerHub(store, new WebSocketServer({ noServer: true }), { logDir: path.join(dir, 'logs') });
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => { if (!runners.upgrade(req, socket, head, new URL(req.url, 'http://x').pathname)) socket.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const home = path.join(dir, 'runner-home');
fs.mkdirSync(home);
// inherit_env: this machine's Claude login may live in the environment (a PC keeps it in ~/.claude or the keychain)
fs.writeFileSync(path.join(home, 'runner.toml'), `gateway = "http://127.0.0.1:${server.address().port}"\ntoken = "${token}"\ntarget_id = ${tid}\nname = "agent-box"\nallowed_roots = ["${work}"]\ninherit_env = true\n`);
const runner = spawn(RUNNER_BIN, ['start'], { env: { ...process.env, AIDEV_RUNNER_HOME: home }, stdio: 'ignore' });
for (let i = 0; i < 100 && !(runners.online(tid) && JSON.parse(store.target(uid, tid).capabilities ?? '{}').features); i++) await new Promise((r) => setTimeout(r, 100));
const caps = JSON.parse(store.target(uid, tid).capabilities);
assert.ok(caps.features.includes('stdin'), JSON.stringify(caps.features));
assert.ok(caps.tools.claude, `claude not detected: ${JSON.stringify(caps.tools)}`);
console.log(`runner ${caps.runner}: stdin feature, claude ${caps.tools.claude}`);

const t0 = Date.now();
const task = 'calc.c 의 add()가 틀린 값을 낸다. 컴파일해서 실행해 확인하고, 고친 다음 다시 실행해 5가 나오는지 검증하라. 보고는 한 문단.';
const st = await runners.exec(tid, uid, { cmd: 'claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash', cwd: work, stdin: task, timeoutSec: 600 }, { approvedBy: 'user' });
const done = await runners.waitRun(st.remoteRunId, 540_000);
const text = fs.readFileSync(runners.logPath(st.remoteRunId), 'utf8');
const lines = text.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const result = lines.find((e) => e.type === 'result');
const bash = lines.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((c) => c.type === 'tool_use').map((c) => `${c.name}: ${JSON.stringify(c.input).slice(0, 80)}`);
runner.kill(); server.close();
assert.equal(done.code, 0, text.slice(-2000));
assert.ok(result && !result.is_error, `no successful result: ${text.slice(-1500)}`);
assert.match(fs.readFileSync(path.join(work, 'calc.c'), 'utf8'), /a \+ b/, 'the local agent fixed the file');
console.log(`PASS claude on the PC: ${bash.length} tool calls (${bash.slice(0, 4).join(' | ')}), fixed calc.c, ${result.num_turns} turns, $${result.total_cost_usd?.toFixed(3)} — ${Date.now() - t0}ms\n  report: ${String(result.result).slice(0, 300)}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
