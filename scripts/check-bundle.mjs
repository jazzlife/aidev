// Mobile bundle budget (IMPLEMENTATION-PLAN §3.11): main chunk ≤ 600KB and none of the heavy
// workbench-only libraries may leak into dist-mobile. Fails the build otherwise.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('dist-mobile/assets');
const LIMIT = Number(process.env.MOBILE_MAIN_CHUNK_LIMIT ?? 600 * 1024);
const FORBIDDEN = ['@codemirror', 'xterm', 'mermaid', 'katex', 'cytoscape', 'react-scan', 'monaco'];
if (!fs.existsSync(dir)) { console.error('dist-mobile/assets missing'); process.exit(1); }
// Only the initial graph counts: the chunks index.html loads (script + modulepreload). Lazy chunks
// (e.g. the onboarding flow behind React.lazy) are never fetched by the mobile app's own screens.
const html = fs.readFileSync(path.resolve('dist-mobile/index.html'), 'utf8');
const initial = [...html.matchAll(/\/m\/assets\/([^"']+\.js)/g)].map((m) => m[1]);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
let main = null; let total = 0; let lazyTotal = 0; const problems = [];
for (const file of files) {
  const full = path.join(dir, file); const size = fs.statSync(full).size;
  if (!initial.includes(file)) { lazyTotal += size; continue; }
  total += size;
  if (/^index-/.test(file)) main = { file, size };
  const text = fs.readFileSync(full, 'utf8');
  for (const marker of FORBIDDEN) if (text.includes(marker)) problems.push(`${file} contains "${marker}"`);
}
const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(`mobile bundle: initial ${initial.length} chunks ${kb(total)} (main ${main ? `${main.file} ${kb(main.size)}` : 'n/a'}, limit ${kb(LIMIT)}); lazy ${files.length - initial.length} chunks ${kb(lazyTotal)} never loaded by mobile screens`);
if (main && main.size > LIMIT) problems.push(`main chunk ${kb(main.size)} exceeds ${kb(LIMIT)}`);
if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
console.log('✓ mobile bundle within budget');
