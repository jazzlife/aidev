import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import jwt from 'jsonwebtoken';

const token = fs.readFileSync(process.env.RUNTIME_MANAGER_TOKEN_FILE ?? '/run/secrets/runtime-token', 'utf8').trim();
if (token.length < 32) throw new Error('Runtime token too short');
const socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const apiVersion = process.env.DOCKER_API_VERSION ?? 'v1.45';
const image = process.env.CLOUDCLI_IMAGE ?? 'aidev/cloudcli-runtime:latest';
// Shared, read-only release volume: application code lives here, not in the image.
const appVolume = process.env.APP_VOLUME ?? 'aidev_app';
const keyDir = process.env.RUNTIME_KEYS_DIR ?? '/runtime-keys';
const hostKeyDir = process.env.HOST_RUNTIME_KEYS_DIR ?? '/home/turtlelab/aidev/runtime-keys';
const peers = ['aidev-runtime-manager', 'aidev-auth-gateway'];
const tails = new Map<string, Promise<unknown>>();
const label = 'work.nado.aidev.runtime';
const managedLabel = 'work.nado.aidev.managed';
const valid = (name: string) => /^(user\d{2}|u[a-f0-9]{24})$/.test(name);
const containerName = (name: string) => `aidev-cloudcli-${name}`;
const networkName = (name: string, egress = false) => `aidev-${name}-${egress ? 'egress' : 'net'}`;
const labels = (name: string) => ({ [label]: name, [managedLabel]: 'true' });
fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
if (!/^v1\.\d+$/.test(apiVersion)) throw new Error('Invalid Docker API version');

async function docker(method: string, path: string, body?: unknown, accepted = [200, 201, 204, 304]) {
  return await new Promise<any>((resolve, reject) => {
    const request = http.request({ socketPath, path: `/${apiVersion}${path}`, method, headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (!accepted.includes(response.statusCode ?? 500)) return reject(new Error(`${method} ${path}: ${response.statusCode} ${text.slice(0, 500)}`));
        resolve(text ? JSON.parse(text) : null);
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error('Docker timeout')));
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function lookup(kind: 'containers' | 'networks' | 'volumes', name: string) {
  const data = await docker('GET', `/${kind}/${encodeURIComponent(name)}${kind === 'containers' ? '/json' : ''}`, undefined, [200, 404]);
  return data?.message ? null : data;
}
function owned(resource: any, name: string, container = false) {
  const actual = container ? resource.Config?.Labels : resource.Labels;
  if (actual?.[label] !== name || actual?.[managedLabel] !== 'true') throw new Error(`Refusing foreign resource for ${name}`);
}
function key(name: string) {
  const value = fs.readFileSync(`${keyDir}/${name}.key`, 'utf8').trim();
  if (value.length < 32) throw new Error('Missing runtime key');
  fs.chmodSync(`${keyDir}/${name}.key`, 0o444);
  return value;
}
function registered(name: string) {
  if (!fs.existsSync(`${keyDir}/${name}.json`)) throw new Error('Runtime is not registered');
  const record = JSON.parse(fs.readFileSync(`${keyDir}/${name}.json`, 'utf8'));
  if (record.deleted) throw new Error('Runtime has been deleted');
}
async function connect(network: string, container: string) {
  const info = await lookup('networks', network);
  if (!info) throw new Error('Network missing');
  if (Object.values(info.Containers ?? {}).some((c: any) => c.Name === container)) return;
  await docker('POST', `/networks/${network}/connect`, { Container: container });
}
async function ensure(name: string) {
  registered(name);
  key(name);
  for (const egress of [false, true]) {
    const network = networkName(name, egress);
    const existing = await lookup('networks', network);
    if (existing) { owned(existing, name); if (existing.Internal !== !egress) throw new Error('Unsafe network'); }
    else await docker('POST', '/networks/create', { Name: network, Driver: 'bridge', Internal: !egress, Labels: labels(name) });
  }
  for (const suffix of ['home', 'workspace']) {
    const volume = `aidev_${name}-${suffix}`;
    const existing = await lookup('volumes', volume);
    // user01 is the explicit migration of the original account's volumes.
    if (existing && name !== 'user01') owned(existing, name);
    if (!existing) await docker('POST', '/volumes/create', { Name: volume, Labels: labels(name) });
  }
  let current = await lookup('containers', containerName(name));
  if (current) {
    owned(current, name, true);
    const stale = !current.Mounts.some((m: any) => m.Type === 'volume' && m.Name === appVolume && m.Destination === '/srv/app')
      || current.Config?.Image !== image;
    if (stale && !current.State.Running) { await docker('DELETE', `/containers/${containerName(name)}?force=true&v=false`); current = null; }
  }
  if (!current) {
    await docker('POST', `/containers/create?name=${containerName(name)}`, {
      Image: image,
      Env: ['HOST=0.0.0.0','SERVER_PORT=3001',`AIDEV_RUNTIME=${name}`,'HOME=/home/cloudcli','DATABASE_PATH=/home/cloudcli/.cloudcli/auth.db','VITE_IS_PLATFORM=false'],
      Labels: labels(name),
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        SecurityOpt: ['no-new-privileges:true'],
        Mounts: [
          { Type: 'bind', Source: `${hostKeyDir}/${name}.key`, Target: '/run/secrets/runtime-jwt', ReadOnly: true },
          { Type: 'volume', Source: `aidev_${name}-home`, Target: '/home/cloudcli' },
          { Type: 'volume', Source: `aidev_${name}-workspace`, Target: '/workspace' },
          { Type: 'volume', Source: appVolume, Target: '/srv/app', ReadOnly: true },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { [networkName(name)]: {}, [networkName(name, true)]: {} } },
    });
    current = await lookup('containers', containerName(name));
  }
  if (current.HostConfig.Privileged || Object.keys(current.HostConfig.PortBindings ?? {}).length || current.Mounts.some((m: any) => m.Source.includes('docker.sock'))) throw new Error('Unsafe runtime');
  const nets = Object.keys(current.NetworkSettings.Networks);
  if (nets.length !== 2 || !nets.includes(networkName(name)) || !nets.includes(networkName(name, true))) throw new Error('Unsafe runtime networks');
  for (const peer of peers) await connect(networkName(name), peer);
  return current;
}
async function start(name: string) {
  const current = await ensure(name);
  if (!current.State.Running) await docker('POST', `/containers/${containerName(name)}/start`);
  const target = `http://${containerName(name)}:3001`;
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    try { const health = await fetch(`${target}/health`, { signal: AbortSignal.timeout(3000) }); if (health.ok) return { target, token: jwt.sign({ userId: 1, username: name }, key(name), { expiresIn: '10m', algorithm: 'HS256' }) }; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Runtime startup deadline exceeded');
}
async function provision(name: string) {
  const record = `${keyDir}/${name}.json`;
  if (!fs.existsSync(record)) {
    if (await lookup('containers', containerName(name))) throw new Error('Existing unregistered runtime');
    if (fs.existsSync(`${keyDir}/${name}.key`)) throw new Error('Existing unregistered key');
    fs.writeFileSync(`${keyDir}/${name}.key`, crypto.randomBytes(32).toString('hex'), { mode: 0o444, flag: 'wx' });
    fs.writeFileSync(record, JSON.stringify({ created: Date.now() }), { mode: 0o600, flag: 'wx' });
  }
  return await start(name);
}
async function destroy(name: string) {
  // Tombstone prevents queued starts or stale sessions recreating a deleted user.
  fs.writeFileSync(`${keyDir}/${name}.json`, JSON.stringify({ deleted: true }), { mode: 0o600 });
  const current = await lookup('containers', containerName(name));
  if (current) { owned(current, name, true); await docker('DELETE', `/containers/${containerName(name)}?force=true&v=false`); }
  for (const egress of [false, true]) {
    const net = networkName(name, egress); const network = await lookup('networks', net);
    if (!network) continue;
    owned(network, name);
    for (const [id, info] of Object.entries(network.Containers ?? {})) {
      if (!peers.includes((info as any).Name)) throw new Error('Foreign network endpoint');
      await docker('POST', `/networks/${net}/disconnect`, { Container: id, Force: true });
    }
    await docker('DELETE', `/networks/${net}`);
  }
  fs.rmSync(`${keyDir}/${name}.key`, { force: true });
  // Keep home/workspace volumes for recovery. Runtime IDs are never reused.
  return { deleted: true, dataRetained: true };
}
async function run(name: string, operation: string) {
  const previous = tails.get(name) ?? Promise.resolve();
  const job = previous.catch(() => {}).then<unknown>(() => operation === 'provision' ? provision(name) : operation === 'delete' ? destroy(name) : start(name));
  tails.set(name, job);
  try { return await job; } finally { if (tails.get(name) === job) tails.delete(name); }
}
const server = http.createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
  const supplied = String(req.headers['x-runtime-token'] ?? '');
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return reply(403, { error: 'Forbidden' });
  // Verify a JWT minted by a runtime with its own key (gateway internal API: runtime → gateway calls).
  const verifyMatch = /^\/v1\/runtimes\/([^/]+)\/verify$/.exec(req.url ?? '');
  if (req.method === 'POST' && verifyMatch && valid(verifyMatch[1])) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 8192) return reply(413, { error: 'Body too large' }); chunks.push(Buffer.from(chunk)); }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { token?: unknown };
      if (typeof body.token !== 'string') return reply(400, { error: 'token required' });
      if (!fs.existsSync(`${keyDir}/${verifyMatch[1]}.json`)) return reply(404, { error: 'Unknown runtime' });
      const claims = jwt.verify(body.token, key(verifyMatch[1]), { algorithms: ['HS256'], audience: 'aidev-gateway' });
      if (typeof claims === 'string' || claims.username !== verifyMatch[1]) return reply(401, { error: 'Invalid runtime token' });
      return reply(200, { ok: true, runtime: verifyMatch[1] });
    } catch { return reply(401, { error: 'Invalid runtime token' }); }
  }
  const match = /^\/v1\/runtimes\/([^/]+)\/(provision|start|delete)$/.exec(req.url ?? '');
  if (req.method !== 'POST' || !match || !valid(match[1])) return reply(404, { error: 'Not found' });
  try { reply(200, await run(match[1], match[2])); }
  catch (error) { console.error('[runtime-manager]', error instanceof Error ? error.message : 'Failed'); reply(503, { error: 'Runtime operation failed; see runtime-manager logs' }); }
});
server.listen(Number(process.env.PORT ?? 8090), process.env.HOST ?? '0.0.0.0');
