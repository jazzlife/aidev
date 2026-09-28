#!/usr/bin/env bash
# Web push diagnosis on the AI-PC (read-only except the optional test send).
#   ./relay.sh sh scripts/push-diag.sh            # state + egress
#   ./relay.sh sh scripts/push-diag.sh send USER  # also send a test notification to USER's devices
set -uo pipefail
GW=aidev-auth-gateway
NODE_MODULES=/srv/app/current/control/gateway/node_modules
echo "## release"; docker exec $GW sh -c 'cat /srv/app/current/RELEASE' 2>&1
echo "## subscriptions / Claude login state (DB)"
docker exec -e NM=$NODE_MODULES $GW node -e '
const Database = require(process.env.NM + "/better-sqlite3");
const db = new Database(process.env.DATABASE_PATH || "/data/auth.db", { readonly: true });
const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table", t);
if (!has("push_subscriptions")) { console.log("push_subscriptions table missing (gateway not on the push release?)"); process.exit(0); }
const subs = db.prepare("SELECT a.username, s.endpoint, s.user_agent, s.created_at, s.last_ok, s.failures FROM push_subscriptions s JOIN accounts a ON a.id=s.user_id").all();
console.log("subscriptions:", subs.length);
for (const s of subs) console.log(" -", s.username, new URL(s.endpoint).host, "created", new Date(s.created_at).toISOString(), "last_ok", s.last_ok ? new Date(s.last_ok).toISOString() : "never", "failures", s.failures, "|", (s.user_agent || "").slice(0, 80));
for (const a of db.prepare("SELECT username, claude_token_expires_at e, claude_auth_failure_at f, claude_notice n FROM accounts").all())
  console.log(" account", a.username, "claude token expires", a.e ? new Date(a.e).toISOString().slice(0,10) : "-", "failure", a.f ? new Date(a.f).toISOString() : "-", "last notice", a.n || "-");
' 2>&1
echo "## gateway log: push lines"
docker logs --since 72h $GW 2>&1 | grep -E "\[push\]|push/" | tail -20
echo "## egress from the gateway container to push services"
docker exec $GW node -e '
const hosts = ["https://fcm.googleapis.com/fcm/send", "https://web.push.apple.com", "https://updates.push.services.mozilla.com", "https://wns2-par02p.notify.windows.com"];
Promise.all(hosts.map((u) => fetch(u, { method: "POST", signal: AbortSignal.timeout(8000) }).then((r) => `${new URL(u).host}: reachable (HTTP ${r.status})`).catch((e) => `${new URL(u).host}: FAILED ${e.cause?.code || e.message}`))).then((l) => console.log(l.join("\n")));
' 2>&1
if [ "${1:-}" = "send" ] && [ -n "${2:-}" ]; then
  echo "## test send to ${2}"
  docker exec -e NM=$NODE_MODULES -e U="$2" $GW node --input-type=module -e '
const { openStore } = await import("/srv/app/current/control/gateway/dist/store.js");
const { createPush } = await import("/srv/app/current/control/gateway/dist/push.js");
const store = openStore(process.env.DATABASE_PATH || "/data/auth.db");
const acct = store.account(process.env.U); if (!acct) { console.log("no such user"); process.exit(1); }
const origin = new URL(process.env.PUBLIC_ORIGIN || "https://dev.nado.work").origin;
const push = createPush(store, origin.startsWith("https:") ? origin : "mailto:aidev@localhost");
const webpush = (await import(process.env.NM + "/web-push/src/index.js")).default;
for (const sub of store.pushSubscriptions(acct.id)) {
  try { const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ title: "Nado AI Dev 진단", body: "서버에서 보낸 테스트 알림입니다", url: "/m/settings" }), { TTL: 600 }); console.log(new URL(sub.endpoint).host, "->", r.statusCode); }
  catch (e) { console.log(new URL(sub.endpoint).host, "-> FAILED", e.statusCode || "", (e.body || e.message || "").toString().slice(0, 300)); }
}
store.db.close();' 2>&1
fi
