# Phase 1 `aidev` deployment

This stack runs CloudCLI behind the existing Nginx Proxy Manager (NPM) at
`https://dev.nado.work`. NPM terminates TLS and forwards one private upstream,
`aidev-auth-gateway:8080`. User containers are created on demand by `runtime-manager`; they never join the
NPM network and do not publish host ports. Adding a user creates its container and
deleting a user removes its container, networks, runtime key, and account.

The current CloudCLI source uses these live paths, which the gateway preserves:

- HTTP and API: `/`, `/api/*`, and `/health`
- realtime chat/session WebSocket: `/ws`
- terminal WebSocket: `/shell`
- plugin WebSockets: `/plugin-ws/*`
- desktop notification WebSocket: `/desktop-notifications`

The gateway owns the multi-user database and signs the external session JWT.
`runtime-manager` creates one CloudCLI container, two networks, two volumes, and
one runtime key per account. A login starts the mapped runtime; deleting the
account removes those resources. Each runtime has a separate internal signing key,
so a token cannot cross user boundaries.
Only `runtime-manager` has access to the Docker socket so it can start and
inspect allowlisted containers; the gateway and CloudCLI runtimes have no Docker
socket access.

Phase 1 reserves `admin.nado.work` and `api.nado.work` for a later management
UI and BFF. They are intentionally not created here; `dev.nado.work` is the
only public application endpoint.

## Prepare the AI-PC

Run these read-only checks on `100.64.0.9` before deploying. Do not recreate or
remove the existing NPM, Portainer, certificates, or networks:

```sh
docker ps
docker network ls
docker volume ls
docker info
```

Find the NPM container and its network:

```sh
docker ps --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}' | rg -i 'nginx|proxy|npm'
docker inspect <npm-container> --format '{{range $name,$network := .NetworkSettings.Networks}}{{$name}}{{"\\n"}}{{end}}'
```

Create `deploy/aidev/.env` from `.env.example` and set
`AIDEV_PROXY_NETWORK` to `npm_bridge`, the existing NPM network, and set
`AIDEV_SECRET_DIR` to a protected host directory such as
`/home/turtlelab/aidev/secrets`. The external network must exist
before the Portainer stack is deployed; the compose file deliberately does not
create it.

## Deploy in Portainer

Create a Portainer Stack named `aidev` from `deploy/aidev/docker-compose.yml`.
Build the dynamic CloudCLI image first with a pinned Claude Code version, then
build the gateway and runtime-manager images and deploy the stack. The stack itself
contains only the gateway and runtime-manager; user containers are created through
the manager. Verify that the only application service on the NPM network is
`aidev-auth-gateway` alongside the existing NPM container:

```sh
docker network inspect "$AIDEV_PROXY_NETWORK"
docker ps --format '{{.Names}}\\t{{.Ports}}'
```

No `ports:` entries are present in the stack. The NPM Proxy Host should be:

| Field | Value |
| --- | --- |
| Domain Names | `dev.nado.work` |
| Scheme | `http` |
| Forward Hostname/IP | `aidev-auth-gateway` |
| Forward Port | `8080` |
| Websockets Support | enabled |
| SSL Certificate | NPM certificate for `dev.nado.work` (ID 6) |
| Force SSL | enabled |

NPM's normal Websocket Support setting adds the HTTP/1.1 upgrade headers. Do not
create an additional Nginx or Caddy instance.

## Simple user command

The AI-PC has a small host command for routine account management. `add` creates
a unique runtime identity, two private networks, two persistent volumes, and the
CloudCLI container. `delete` removes the container, networks, runtime key, and
account; volumes are retained for recovery. Password input is hidden and sent only
through stdin. Passwords must be 4–256 characters.

```sh
aidev-user add alice
aidev-user list
aidev-user delete alice
aidev-user disable alice
```

The new user signs in at `https://dev.nado.work`; no per-user hostname or port
is needed. Install the script once on the AI-PC if it is not already present:

```sh
sudo install -m 0755 deploy/aidev/aidev-user /usr/local/bin/aidev-user
```

## Add or remove users directly

The internal command is also available when a shell wrapper is inconvenient:

```sh
printf '%s\n' 'use-a-long-password' | docker exec -i aidev-auth-gateway node /app/dist/manage-users.js add alice
docker exec aidev-auth-gateway node /app/dist/manage-users.js list
docker exec aidev-auth-gateway node /app/dist/manage-users.js delete alice
```

The username is only the account label. The manager assigns a non-reusable runtime
ID such as `u203b9d6d5029f18d3faf2998`, so a deleted user's container, key, and
network cannot be accidentally reused by a later account. The account is enabled
only after provisioning succeeds. A login starts the already-created container and
waits for its health endpoint.

The runtime image installs Git, OpenSSH, Android `adb`, Claude Code CLI, and
Tizen SDB. Codex is provided by the CloudCLI dependency bundle. The SDB archive
is downloaded and checksum-verified during the image build.

## Verification

From the AI-PC, check the private path before testing DNS:

```sh
curl -fsS http://aidev-auth-gateway:8080/_gateway/health
docker exec aidev-auth-gateway node -e "fetch('http://runtime-manager:8090/health').then(r=>console.log(r.status)).catch(console.error)"
```

Then open `https://dev.nado.work`, log in, open a chat, and open the terminal.
Browser developer tools should show `wss://dev.nado.work/ws` and
`wss://dev.nado.work/shell`; no user container hostname or port should appear.

To confirm the isolation boundary:

```sh
docker ps --filter label=work.nado.aidev.managed --format '{{.Names}}\t{{.Status}}'
docker inspect aidev-cloudcli-<runtime-id> --format '{{json .NetworkSettings.Networks}}'
docker inspect aidev-auth-gateway --format '{{json .Mounts}}'
```

Each dynamically created `aidev-cloudcli-<username>` must have only its own
internal `aidev-<username>-net` plus its own egress network, and the gateway
mounts only `auth-data` plus Docker secret files; the Docker socket appears only
in `aidev-runtime-manager`.

## Updates: releases in a volume, never image rebuilds

Application code is not in any image. The `aidev_app` volume holds `releases/<sha>/`
(prebuilt `dist/`, `dist-server/`, `public/`, `shared/`, `control/gateway`,
`control/runtime-manager`, `runtime/entrypoint.mjs`) and `deps/<component>-<lockhash>/node_modules`
(production deps, native modules built once on the AI-PC in a `node:22-bookworm` helper).
`current -> releases/<sha>` is swapped atomically. The gateway and runtime-manager run on plain
`node:22-bookworm-slim`; user runtimes run on `aidev/cloudcli-runtime` (tools only) — that is the
only image, rebuilt only when a tool version changes (`release/runtime-image.sh`).

```
pack.sh (off-box)  ->  release-<sha>.tgz  ->  deploy.sh (AI-PC)
                                               install  : unpack, deps if lockfile new
                                               diff     : frontend | server | gateway | runtime-manager
                                               activate : ln -sfn + mv -T  (atomic)
                                               restart  : only what changed  (docker restart, ~3 s)
```

| Changed | Restarted | User impact |
| --- | --- | --- |
| `src/`, `public/` (frontend) | nothing | next page load |
| `server/`, `shared/`, entrypoint, `package-lock.json` | each running runtime, one at a time | ~5 s reconnect; sessions live in volumes |
| `deploy/aidev/auth-gateway/` | gateway | ~3 s |
| `deploy/aidev/runtime-manager/` | runtime-manager | none (only login/start paths) |

Rollback is `release.sh rollback && release.sh restart <same set>`. `release.sh status|list|prune`.
`release/bootstrap.sh` migrates a Phase 1 box once.

### Behaviour at scale (hundreds of runtimes on one host)

- **Frontend release**: one symlink swap; zero restarts regardless of user count. Open tabs
  loaded on the previous release keep working: the gateway serves `/assets/<hash>` from any
  retained release (hashed names are unique), so lazy-loaded chunks never 404 mid-session.
- **Server release**: `release.sh restart runtimes` restarts N containers in parallel
  (`--batch`, default 6) and probes each runtime's `/health` directly (no 30 s healthcheck
  wait), so a fleet of 200 finishes in minutes, not hours. `--drain` restarts idle runtimes
  first and defers those with live WebSocket sessions (re-run later, or `--force`); `--canary`
  restarts one and stops; `--only a,b` targets specific runtimes. `status` shows the running
  release of every runtime, so a mixed fleet is visible.
- **Concurrency**: all release operations take a host-wide lock (`flock`), so two deploys or a
  deploy and a rollback cannot interleave.
- **deps**: built once per lockfile hash and shared by every runtime via the volume (one
  copy on disk, no per-container node_modules). `prune` removes unreferenced deps.
- **Gateway**: single process; a gateway release costs ~3 s of WebSocket reconnects for
  everyone. For zero-downtime gateway releases run two gateway containers and point the NPM
  proxy host at an nginx `upstream` with both — sessions are in SQLite on the shared
  `auth-data` volume, so either instance can serve any user. Not enabled yet.
- **Multiple hosts**: the volume is per host. Run `deploy.sh` with the same release tarball on
  each host (same `release` id everywhere); runtime-manager is per host already.

## Laya decision service (specialist-agent routing)

`aidev-laya` runs the Laya multilingual System-1 decision model (typed choice/score/noul decisions with
calibrated probabilities) on the AI-PC's Radeon 890M (gfx1150, ROCm) with CPU fallback. The image
(`deploy/aidev/laya/Dockerfile`, `release/laya-image.sh build`) holds only torch+laya; the HTTP wrapper
is `control/laya/app.py` in the release volume, so it updates like everything else. Weights live in the
`aidev_models` volume (`laya-image.sh models`, once). The service is on `aidev-control-net` only; the
gateway exposes it to signed-in users as `POST /api/aidev/route`, `POST /api/aidev/decide`,
`GET /api/aidev/laya/health`. First-time: `release/laya-image.sh setup`.
