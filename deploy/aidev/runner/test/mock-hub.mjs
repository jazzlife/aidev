// Minimal stand-in for the gateway's runner endpoints (F-01 e2e): POST /_runner/pair and
// WS /_runner/ws. Scenario: 1st connection → hello + runner.ping + fs.resolve, then a normal close
// (runner must reconnect); 2nd connection → close 4401 (runner must stop with exit code 3).
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(process.env.WS_MODULE);
const port = Number(process.env.PORT ?? 18181);
const TOKEN = 'a'.repeat(64);
const log = (...a) => console.log('[mock]', ...a);
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/_runner/pair') {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const b = JSON.parse(body);
      log('pair', b.code, b.platform, b.hostname ? 'host ok' : 'no host');
      if (b.code !== 'ABCD1234') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"invalid or expired code"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: TOKEN, target_id: 7, name: 'test-pc' }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true });
let connections = 0;
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/_runner/ws' || req.headers.authorization !== `Bearer ${TOKEN}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); log('rejected upgrade'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    connections += 1; const n = connections; log('connected', n, 'runner', req.headers['x-aidev-runner']);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'runner.hello') {
        const c = msg.params.capabilities;
        log('hello', JSON.stringify({ os: c.os, arch: c.arch, hostname: Boolean(c.hostname), tools: Object.keys(c.tools).length, roots: c.allowed_roots.length, screen: c.screen }));
        if (n === 1) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'runner.ping' }));
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'fs.resolve', params: { path: '../../etc/passwd' } }));
        } else { log('closing with 4401'); ws.close(4401, 'revoked'); }
      } else if (msg.id === 1) { log('ping result', JSON.stringify(msg.result)); }
      else if (msg.id === 2) { log('fs.resolve', JSON.stringify(msg.error)); ws.close(1000, 'bye'); }
    });
  });
});
server.listen(port, () => log('listening', port));
