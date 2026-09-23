// Mobile bundle budget (IMPLEMENTATION-PLAN §3.11): main chunk ≤ 600KB and none of the heavy
// workbench-only libraries may leak into dist-mobile. Fails the build otherwise.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('dist-mobile/assets');
const LIMIT = Number(process.env.MOBILE_MAIN_CHUNK_LIMIT ?? 600 * 1024);
const FORBIDDEN = ['@codemirror', 'xterm', 'mermaid', 'katex', 'cytoscape', 'react-scan', 'monaco'];
if (!fs.existsSync(dir)) { console.error('dist-mobile/assets missing'); process.exit(1); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
let main = null; let total = 0; const problems = [];
for (const file of files) {
  const full = path.join(dir, file); const size = fs.statSync(full).size; total += size;
  if (/^index-/.test(file)) main = { file, size };
  const text = fs.readFileSync(full, 'utf8');
  for (const marker of FORBIDDEN) if (text.includes(marker)) problems.push(`${file} contains "${marker}"`);
}
const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(`mobile bundle: ${files.length} chunks, total ${kb(total)}, main ${main ? `${main.file} ${kb(main.size)}` : 'n/a'} (limit ${kb(LIMIT)})`);
if (main && main.size > LIMIT) problems.push(`main chunk ${kb(main.size)} exceeds ${kb(LIMIT)}`);
if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
console.log('✓ mobile bundle within budget');
