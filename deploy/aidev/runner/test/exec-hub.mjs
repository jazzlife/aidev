// exec e2e against a real shell setup: on hello, run one command (cwd given as "~/…") and report
// output + exit, or TIMEOUT if nothing comes back. Then close 4401 so the runner exits.
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(process.env.WS_MODULE);
const TOKEN = 'a'.repeat(64);
const CMD = process.env.EXEC_CMD ?? 'echo hi-$((1+1)); pwd';
const CWD = process.env.EXEC_CWD ?? '~/aidev-work';
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let out = '';
    const finish = (line) => { console.log(line); ws.close(4401, 'done'); setTimeout(() => process.exit(0), 300); };
    const timer = setTimeout(() => finish(`TIMEOUT output=${JSON.stringify(out)}`), Number(process.env.EXEC_TIMEOUT_MS ?? 15000));
    ws.on('message', (data, binary) => {
      if (binary) { out += data.subarray(4).toString(); return; }
      const msg = JSON.parse(String(data));
      if (msg.method === 'runner.hello') ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'exec.start', params: { cmd: CMD, cwd: CWD, streamId: 1 } }));
      else if (msg.id === 1 && msg.error) { clearTimeout(timer); finish(`ERROR ${msg.error.message}`); }
      else if (msg.method === 'exec.exit') { clearTimeout(timer); finish(`EXIT code=${msg.params.code} output=${JSON.stringify(out)}`); }
    });
  });
});
server.listen(Number(process.env.PORT ?? 18182), () => console.log('listening'));
