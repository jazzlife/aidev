// Generates synthetic routing examples per seed agent with the Claude CLI (run where `claude -p` works):
//   node data/gen-examples.mjs [perLang=35] [model=sonnet]  -> data/agent-examples.jsonl  ({text, agent, lang, depth, task_kind})
// The bench set (deploy/aidev/laya/app/bench/commands.jsonl) stays held out — this file is training data
// for the lexical classifier (and later for Laya fine-tuning).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { seedAgents } from '../dist/seed-agents.js';

const perLang = Number(process.argv[2] ?? 35);
const model = process.argv[3] ?? 'sonnet';
const agents = seedAgents.filter((a) => a.domain !== 'meta');
const out = new URL('./agent-examples.jsonl', import.meta.url).pathname;
const existing = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const done = new Set(existing.map((e) => e.agent));
const run = (prompt) => new Promise((resolve, reject) => execFile('claude', ['-p', prompt, '--model', model, '--output-format', 'text'], { maxBuffer: 8 * 1024 * 1024, timeout: 600_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
const KINDS = 'bulk_read (reading/analyzing many files or long logs) | implement | debug | refactor | design | ops | explain';
for (const agent of agents) {
  if (done.has(agent.name)) { console.log('skip', agent.name); continue; }
  const others = agents.filter((a) => a.name !== agent.name).map((a) => `${a.name}: ${a.hint}`).join('\n');
  const prompt = `You generate training data for a router that assigns developer chat commands to specialist agents.
Target agent: ${agent.name}
Description: ${agent.description}
Other agents (the commands must clearly NOT belong to these):
${others}

Write ${perLang} Korean and ${perLang} English commands a developer would type to an AI coding assistant that should be routed to "${agent.name}". Requirements:
- Realistic and varied: imperative requests, questions, pasted error messages, short (3-6 words) and long (2-3 sentences), casual and formal, with concrete file/tool/framework names typical for this domain.
- Cover many sub-topics of the domain; avoid repeating the same verbs/nouns; do not mention the agent name.
- Each item: depth 0-4 (0 instant answer/one-liner, 1 one-file change, 2 feature across files, 3 unknown-cause debugging/refactor/design, 4 architecture/migration) and task_kind from: ${KINDS}.
Output ONLY JSON lines, one per line, no prose, no code fences:
{"text":"...","lang":"ko|en","depth":N,"task_kind":"..."}`;
  process.stdout.write(`${agent.name}: generating… `);
  try {
    const text = await run(prompt);
    const rows = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r.text === 'string' && r.text.length > 3);
    const lines = rows.map((r) => JSON.stringify({ text: r.text.trim(), agent: agent.name, lang: r.lang === 'ko' || /[가-힣]/.test(r.text) ? 'ko' : 'en', depth: Number.isFinite(r.depth) ? Math.max(0, Math.min(4, Math.round(r.depth))) : null, task_kind: typeof r.task_kind === 'string' ? r.task_kind : null }));
    fs.appendFileSync(out, `${lines.join('\n')}\n`);
    console.log(`${rows.length} rows`);
  } catch (error) { console.log('FAILED', error.message.slice(0, 200)); }
}
console.log('total', fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length);
