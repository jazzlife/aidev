#!/usr/bin/env bash
# Installs a long-lived Claude OAuth token into a user's runtime container (runs ON the AI-PC).
#   printf '%s\n' "$TOKEN" | claude-token.sh USERNAME        (token on stdin only: never argv, never logs)
# The token comes from `claude setup-token` on any machine with a browser (valid ~1 year) and is
# written to /home/cloudcli/.claude/settings.json → env.CLAUDE_CODE_OAUTH_TOKEN, which both the Claude
# CLI and the runtime's auth probe honour — so the router sees the engine as available again.
# Replaces the browser-login flow whose refresh token expires ("OAuth session expired and could not be refreshed").
set -uo pipefail
user=${1:?username}
runtime=$(docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js list 2>/dev/null | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const a=j.find(x=>x.username===process.argv[1]);if(!a){console.error('no such user');process.exit(1)}console.log(a.runtime)" "$user") || exit 1
container="aidev-cloudcli-$runtime"
read -r token
case "$token" in sk-ant-oat*) ;; *) echo "not a Claude OAuth token (expected sk-ant-oat…)"; exit 1;; esac
printf '%s' "$token" | docker exec -i "$container" node -e '
const fs=require("fs"),path=require("path");
const token=fs.readFileSync(0,"utf8").trim(); const dir="/home/cloudcli/.claude"; const file=path.join(dir,"settings.json");
fs.mkdirSync(dir,{recursive:true});
let s={}; try{s=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
s.env={...(s.env||{}),CLAUDE_CODE_OAUTH_TOKEN:token};
fs.writeFileSync(file,JSON.stringify(s,null,2)+"\n",{mode:0o600});
console.log("written "+file+" (env.CLAUDE_CODE_OAUTH_TOKEN, "+token.length+" chars)");' || exit 1
echo "gateway re-probes the engine within 60 s; ./relay.sh verify $user shows engines.claude.authenticated"
