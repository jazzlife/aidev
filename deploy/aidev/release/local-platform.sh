#!/usr/bin/env bash
# Local platform emulation OFF the AI-PC: real CloudCLI runtime (dist-server) + real gateway (both
# apps) + mock runtime-manager/Laya. For screenshots, UI checks and provider-hook logs without
# engine credentials.  Usage:
#   bash deploy/aidev/release/local-platform.sh up      # starts on 18080 (gateway), 3001 (runtime); prints login
#   bash deploy/aidev/release/local-platform.sh down
# Requires: npm run build (dist, dist-mobile, dist-server) and the gateway built (npm run build in auth-gateway).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
W=${LOCAL_PLATFORM_DIR:-/home/claude/aidev-local}   # not under /tmp: CloudCLI refuses projects in system directories
case "${1:-up}" in
  down) for f in "$W"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done; rm -rf "$W"; echo stopped; exit 0;;
  up) ;;
  *) echo "usage: local-platform.sh up|down" >&2; exit 1;;
esac
rm -rf "$W"; mkdir -p "$W/secrets" "$W/home/workspace/demo-project/src"
SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n=' | head -c 64); echo "$SECRET" > "$W/secrets/rt-key"
head -c 48 /dev/urandom | base64 > "$W/secrets/jwt"; head -c 48 /dev/urandom | base64 > "$W/secrets/rt"
RUNTIME=u0123456789abcdef01234567
cat > "$W/home/workspace/demo-project/src/App.tsx" <<'EOF'
export function App() {
  return <main>Hello from the demo project</main>;
}
EOF
echo '{ "name": "demo-project", "version": "1.0.0" }' > "$W/home/workspace/demo-project/package.json"
# 1. CloudCLI runtime (same seeding as runtime/entrypoint.mjs, minus the release volume)
cat > "$W/runtime.mjs" <<EOF
import crypto from 'node:crypto';
process.env.JWT_SECRET = '$SECRET';
process.env.AIDEV_RUNTIME = '$RUNTIME';
process.env.AIDEV_GATEWAY_URL = 'http://127.0.0.1:18080';
process.env.HOME = '$W/home';
// a Claude session id inherited from the shell that launched this would make every chat resume one transcript
delete process.env.CLAUDE_CODE_SESSION_ID;
// The sandbox authenticates Claude through ANTHROPIC_BASE_URL; a placeholder token makes the runtime's
// auth probe report what is actually true (otherwise the router sees "no engine available").
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_BASE_URL) process.env.ANTHROPIC_AUTH_TOKEN = 'local-platform';
process.env.DATABASE_PATH = '$W/home/.cloudcli/auth.db';
process.env.SERVER_PORT = '3001'; process.env.HOST = '127.0.0.1'; process.env.VITE_IS_PLATFORM = 'false';
const { initializeDatabase, userDb, closeConnection } = await import('$ROOT/dist-server/server/modules/database/index.js');
const { default: bcrypt } = await import('$ROOT/node_modules/bcrypt/bcrypt.js');
await initializeDatabase();
if (!userDb.hasUsers()) userDb.createUser('$RUNTIME', await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12));
userDb.completeOnboarding(1);   // skip the git/agent onboarding wizard in the emulation
closeConnection();
await import('$ROOT/dist-server/server/index.js');
EOF
( cd "$ROOT" && setsid nohup node "$W/runtime.mjs" > "$W/runtime.log" 2>&1 < /dev/null & echo $! > "$W/runtime.pid" )
# 2. mock manager (signs runtime JWTs with the runtime key) + mock laya
cat > "$W/mock.mjs" <<EOF
import http from 'node:http';
import crypto from 'node:crypto';
const secret = '$SECRET';
const b64 = (v) => Buffer.from(v).toString('base64url');
const sign = (payload) => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const p = b64(JSON.stringify(payload)); return h + '.' + p + '.' + crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url'); };
const verify = (t) => { const [h, p, s] = t.split('.'); return s === crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url'); };
const read = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(c.length ? JSON.parse(Buffer.concat(c)) : {})); });
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  const v = req.url.match(/^\\/v1\\/runtimes\\/([^/]+)\\/verify$/);
  if (v) { const b = await read(req); return verify(String(b.token || '')) ? send(res, 200, { ok: true, runtime: v[1] }) : send(res, 401, { error: 'bad' }); }
  const m = req.url.match(/^\\/v1\\/runtimes\\/([^/]+)\\/(provision|start|delete)$/);
  if (m) { const now = Math.floor(Date.now() / 1000); return send(res, 200, { target: 'http://127.0.0.1:3001', token: sign({ userId: 1, username: m[1], iat: now, exp: now + 600 }) }); }
  send(res, 404, {});
}).listen(18090);
EOF
( setsid nohup node "$W/mock.mjs" > "$W/mock.log" 2>&1 < /dev/null & echo $! > "$W/manager.pid" )
( cd "$ROOT/deploy/aidev/auth-gateway" && MOCK_MANAGER_PORT=18091 setsid nohup node test/mock-services.mjs > "$W/laya.log" 2>&1 < /dev/null & echo $! > "$W/laya.pid" )   # laya on 18095; its own manager mock on 18091 is unused
sleep 1
# 3. gateway with both apps
DATABASE_PATH="$W/auth.db" node --input-type=module -e "
const {openStore}=await import('$ROOT/deploy/aidev/auth-gateway/dist/store.js'); const s=openStore(process.env.DATABASE_PATH);
await s.add('demo','demo1234','$RUNTIME',1); s.setRole('demo','admin'); s.db.close();"
( cd "$ROOT/deploy/aidev/auth-gateway" && DATABASE_PATH="$W/auth.db" JWT_SECRET_FILE="$W/secrets/jwt" RUNTIME_MANAGER_TOKEN_FILE="$W/secrets/rt" RUNTIME_MANAGER_URL=http://127.0.0.1:18090 LAYA_URL=http://127.0.0.1:18095 \
  PUBLIC_ORIGIN=http://127.0.0.1:18080 PORT=18080 STATIC_ROOT="$ROOT/dist" MOBILE_STATIC_ROOT="$ROOT/dist-mobile" setsid nohup node dist/auth-gateway.js > "$W/gateway.log" 2>&1 < /dev/null & echo $! > "$W/gateway.pid" )
for i in $(seq 1 40); do curl -sf http://127.0.0.1:18080/_gateway/health >/dev/null && curl -sf http://127.0.0.1:3001/health >/dev/null && break; sleep 0.5; done
echo "local platform up: http://127.0.0.1:18080  (login demo / demo1234; mobile app at /m/)  logs: $W/*.log  workspace: $W/home/workspace"
