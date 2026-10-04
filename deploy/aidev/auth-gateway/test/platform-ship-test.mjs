// OPS-02: the gateway relays a ship to runtime-manager (token header, generated id) and pushes its result to the
// requester exactly once; ships already finished when it starts are not announced again.
//   npm run build && node test/platform-ship-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';

const ships = new Map([['old0000000000000', { id: 'old0000000000000', requester: 'jazzlife', running: false, created: Date.now() - 60_000, result: { status: 'ok', sha: 'a'.repeat(40), text: 'old' } }]]);
const seen = [];
const manager = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-runtime-token'] });
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/v1/ship') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if ([...ships.values()].some((s) => s.running)) return reply(409, { error: 'a ship is already running' });
      ships.set(body.id, { id: body.id, requester: body.requester, running: true, created: Date.now(), result: null, body });
      return reply(202, { ...ships.get(body.id), step: null, log: '' });
    }
    if (req.url === '/v1/ship') return reply(200, { ships: [...ships.values()].map(({ id, requester, running, created }) => ({ id, requester, running, created })).reverse() });
    const ship = ships.get(req.url.split('/').pop());
    return ship ? reply(200, { ...ship, step: 'checks', log: 'SHIP_STEP checks' }) : reply(404, { error: 'no such ship' });
  });
});
await new Promise((r) => manager.listen(0, '127.0.0.1', r));
const pushed = [];
const { createPlatformShip, ShipError } = await import('../dist/platform-ship.js');
const ship = createPlatformShip({
  managerUrl: `http://127.0.0.1:${manager.address().port}`, managerToken: 't'.repeat(40), pollMs: 60_000,
  push: { sendToUser: async (userId, payload) => { pushed.push({ userId, payload }); return { delivered: 1 }; } },
  userIdByName: (name) => (name === 'jazzlife' ? 3 : null),
});
ship.startWatcher();
await new Promise((r) => setTimeout(r, 50));

const started = await ship.start({ runtime: 'u70edd047aee13516505c5c78', requester: 'jazzlife', from: 'aidev', ref: 'f00d' });
assert.match(started.id, /^[a-f0-9]{16}$/);
assert.equal(seen.at(-1).token, 't'.repeat(40));
assert.deepEqual(ships.get(started.id).body, { id: started.id, runtime: 'u70edd047aee13516505c5c78', requester: 'jazzlife', from: 'aidev', ref: 'f00d' });
await assert.rejects(ship.start({ runtime: 'u70edd047aee13516505c5c78', requester: 'jazzlife' }), (e) => e instanceof ShipError && e.status === 409);
await assert.rejects(ship.status('nope00000000'), (e) => e instanceof ShipError && e.status === 404);

await ship.notifyFinished();
assert.equal(pushed.length, 0, 'nothing finished yet; the old ship is not announced');
Object.assign(ships.get(started.id), { running: false, result: { status: 'rolled_back', sha: 'b'.repeat(40), text: '/m/ does not serve the new mobile bundle' } });
await ship.notifyFinished();
await ship.notifyFinished();
assert.equal(pushed.length, 1);
assert.equal(pushed[0].userId, 3);
assert.match(pushed[0].payload.title, /되돌림 bbbbbbb/);
manager.close();
console.log('platform-ship-test: ok');
process.exit(0);
