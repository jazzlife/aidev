// WebSocket through the preview path (HMR): node test/preview-ws.mjs <gateway> <path> → JSON {hello, echo}
import { WebSocket } from 'ws';
const [gw, path] = process.argv.slice(2);
const ws = new WebSocket(gw.replace(/^http/, 'ws') + path, { headers: { origin: 'null' } });
const out = {}; const t = setTimeout(() => { console.log(JSON.stringify({ ...out, timeout: true })); process.exit(1); }, 8000);
ws.on('message', (d) => { const s = String(d); if (!out.hello) { out.hello = JSON.parse(s); ws.send('ping-hmr'); } else { out.echo = s; clearTimeout(t); console.log(JSON.stringify(out)); ws.close(); process.exit(0); } });
ws.on('error', (e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
