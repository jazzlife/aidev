// Trace which imports of the mobile entry reach heavy modules using vite's resolver via a quick rollup build with a plugin.
import { build } from 'vite';
const heavy = /mermaid|@codemirror|xterm|katex|cytoscape|react-scan|modules\/(chat\/ChatInterface|code-editor|shell|git-panel|file-tree|project-workspace|onboarding|task-master|plugins)/;
const parents = new Map();
await build({ configFile: 'vite.mobile.config.js', logLevel: 'silent', build: { write: false, rollupOptions: { plugins: [{ name: 'trace', moduleParsed(info) { for (const id of info.importedIds) { if (!parents.has(id)) parents.set(id, info.id); } } }] } } });
const chain = (id) => { const out = []; let cur = id; while (cur && out.length < 12) { out.push(cur.replace(process.cwd(), '')); cur = parents.get(cur); } return out; };
const seen = new Set();
for (const id of parents.keys()) if (heavy.test(id)) { const c = chain(id); const key = c.slice(0, 3).join('>'); if (seen.has(key)) continue; seen.add(key); console.log(c.join('\n   <- ')); console.log('---'); if (seen.size > 12) break; }
