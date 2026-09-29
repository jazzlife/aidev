// Stand-in for a dev server on the runner's PC (F-06 smoke): HTML with absolute paths, a module, a redirect,
// a cookie, header echo and an HMR-style WebSocket echo. BASE="" → serves at "/"; BASE="/p/…/" → only under it
// (and 404s the root with a hint, like Vite with --base).
import http from 'node:http';
import { WebSocketServer } from 'ws';
const port = Number(process.argv[2]); const BASE = process.argv[3] || '';
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null });
  let p = req.url.split('?')[0];
  if (BASE) { if (!p.startsWith(BASE)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(`The server is configured with a public base URL of ${BASE} - did you mean to visit ${BASE}${p.slice(1)} instead?`); } p = '/' + p.slice(BASE.length); }
  const at = (x) => (BASE ? BASE + x.slice(1) : x);
  if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><html><head><title>dev</title><script type="module" src="${at('/src/main.js')}"></script></head><body><a href="${at('/about')}">about</a><img src="//cdn.example/x.png"></body></html>`); }
  if (p === '/src/main.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('console.log("main")'); }
  if (p === '/redirect') { res.writeHead(302, { location: `http://localhost:${port}${at('/login')}`, 'set-cookie': 'sid=1; Path=/; HttpOnly' }); return res.end(); }
  if (p === '/seen') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(seen)); }
  if (p === '/post' && req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`got:${b}`); }); return; }
  res.writeHead(404); res.end('nope');
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => { ws.send(JSON.stringify({ hello: true, path: req.url, origin: req.headers.origin ?? null, host: req.headers.host })); ws.on('message', (d) => ws.send(`echo:${d}`)); });
server.listen(port, '127.0.0.1', () => console.log(`fake dev server on ${port} base=${BASE || '/'}`));
