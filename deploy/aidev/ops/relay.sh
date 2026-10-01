#!/bin/bash
# =============================================================================
# Nado AI Dev Platform — Mac 중계: 클라우드 빌드 산출물을 SSH 스트림으로 AI-PC(100.64.0.9)에
# 직접 흘려 넣고, 서버에서 원자 교체(current 심볼릭링크) 후 필요한 프로세스만 재시작한다.
# 서버에는 저장소도, 이미지 빌드도 없다. 단일 명령:
#
#   ./relay.sh bootstrap <payload-dir>        최초 1회: 볼륨 모델로 마이그레이션 (bootstrap-*/ 디렉터리 전체를 스트림)
#   ./relay.sh deploy <release-<sha>.tgz> [restart opts]
#                                             일반 배포: tgz 바이트 | ssh 'deploy.sh -'  → install/diff/activate/restart
#   ./relay.sh rollback [sha]                 이전 릴리스로 원자 전환 + 변경 컴포넌트 재시작
#   ./relay.sh status | list                  서버 릴리스 상태
#   ./relay.sh run <release.sh args...>       예: run restart --drain runtimes
#   ./relay.sh diag                           서버 진단 스냅샷 → inbox/diag-*.txt (읽기 전용)
#   ./relay.sh gpu                            GPU/드라이버/컨테이너 GPU 사용 가능 여부 진단 (읽기 전용)
#   ./relay.sh fetch                          서버 소스/설정 스냅샷 회수 (읽기 전용)
#   ./relay.sh watch                          작업 대기: Claude가 outbox/<id>.job 에 적은 허용 작업만 실행 → inbox/job-<id>.log/.status
#                                             (deploy·rollback·status·list·restart·diag·gpu·logs·verify; 임의 명령·스크립트는 거부)
#   ./relay.sh scripts [dir]                  ops/scripts/*.sh 를 서버 deploy/release/ 에 동기화 (릴리스 스크립트 갱신)
#   ./relay.sh sh <local.sh> [args...]        로컬 스크립트를 서버 bash 로 스트림 실행 → inbox/sh-*.log
#   ./relay.sh verify USER [--bench] [--backup] [--security]   서버 verify-b.sh 실행 — 비밀번호 없음(서버 안에서 10분 세션 발급 후 폐기)
#   ./relay.sh claude-token USER                        `claude setup-token`으로 받은 장기 토큰을 USER 런타임에 설치 (프롬프트 입력, 기록에 남지 않음)
#   ./relay.sh logs <container> [lines]       docker logs 회수 → inbox/logs-*.log
#
# SSH 비밀번호는 최초 1회 (ControlMaster 소켓 8시간). 로그: inbox/<이름>.log
# =============================================================================
set -u
HOST="turtlelab@100.64.0.9"
OPS="$(cd "$(dirname "$0")" && pwd)"
SOCK="/tmp/aidev-relay-$(id -u).sock"
REMOTE_DEPLOY='/home/turtlelab/aidev/deploy'   # 서버 절대경로 ($HOME은 Mac에서 풀리므로 금지)
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)

# Credentials come from the macOS keychain: an SSH key registered once (ssh-add --apple-use-keychain) opens the
# connection without a password, so the relay also reconnects on its own. A password prompt is only offered
# on a terminal; anywhere else (Claude, the watcher) it fails at once with the steps to register the key.
key_help() {
  local h=${HOST#*@} u=${HOST%@*}
  echo "SSH 키가 키체인에 등록돼 있지 않습니다 — 한 번만 등록하면 비밀번호 없이 연결됩니다:" >&2
  echo "  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519            # 이미 있으면 건너뛰기" >&2
  echo "  ssh-add --apple-use-keychain ~/.ssh/id_ed25519" >&2
  echo "  ssh-copy-id -i ~/.ssh/id_ed25519.pub $HOST           # 서버 비밀번호 1회" >&2
  echo "  printf 'Host $h\\n  User $u\\n  IdentityFile ~/.ssh/id_ed25519\\n  UseKeychain yes\\n  AddKeysToAgent yes\\n' >> ~/.ssh/config" >&2
}
ensure_master() {
  ssh -S "$SOCK" -O check "$HOST" >/dev/null 2>&1 && return 0
  if ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=15 -M -S "$SOCK" -o ControlPersist=8h -fN "$HOST" 2>/dev/null; then
    echo "==> $HOST 접속 (키체인의 SSH 키)"; return 0
  fi
  key_help
  [ -t 0 ] || exit 1
  echo "==> $HOST 접속 (이번만 비밀번호 입력)"
  ssh "${SSH_OPTS[@]}" -M -S "$SOCK" -o ControlPersist=8h -fN "$HOST" || { echo "SSH 실패"; exit 1; }
}
rsh() { ssh -S "$SOCK" "$HOST" "$@"; }
logto() { local name="$1"; shift; "$@" 2>&1 | tee "$OPS/inbox/$name.log"; return "${PIPESTATUS[0]}"; }
stamp() { date +%Y%m%d-%H%M%S; }

do_bootstrap() {
  local dir="${1:?payload dir}"; [ -f "$dir/apply.sh" ] || { echo "$dir/apply.sh 없음"; exit 1; }
  ensure_master
  echo "==> $(basename "$dir") 를 스트림으로 전송하고 서버에서 apply.sh 실행"
  logto "bootstrap-$(stamp)" bash -c "tar cz -C '$dir' . | ssh -S '$SOCK' '$HOST' 'set -e; d=\$(mktemp -d /tmp/aidev-bootstrap-XXXXXX); tar xz -C \"\$d\"; cd \"\$d\"; bash ./apply.sh; rc=\$?; rm -rf \"\$d\"; exit \$rc'"
}
do_deploy() {
  local tgz="${1:?release tgz}"; shift || true; [ -s "$tgz" ] || { echo "$tgz 없음"; exit 1; }
  ensure_master
  local sha; sha=$(tar xzOf "$tgz" '*/RELEASE' 2>/dev/null | tr -d '[:space:]')   # bsdtar glob; no tar|head SIGPIPE
  echo "==> release $sha 스트림 → 서버 deploy.sh - $*"
  logto "deploy-$sha-$(stamp)" bash -c "cat '$tgz' | ssh -S '$SOCK' '$HOST' \"bash $REMOTE_DEPLOY/release/deploy.sh - $*\""
}
do_run() { ensure_master; logto "run-$(stamp)" rsh "bash $REMOTE_DEPLOY/release/release.sh $*"; }
do_diag() {  # 읽기 전용 진단: 서버 상태를 inbox/diag-*.txt 로 회수
  ensure_master
  logto "diag-$(stamp)" rsh 'echo "## date"; date; echo "## bootstrap/deploy processes"; ps -eo pid,etime,cmd | grep -E "bootstrap.sh|deploy.sh|release.sh|npm |node-gyp|docker run" | grep -v grep
    echo "## helper containers"; docker ps --filter ancestor=node:22-bookworm --format "{{.ID}} {{.Status}} {{.Command}}"
    echo "## aidev containers"; docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" | grep -E "^aidev|cloudcli"
    echo "## images"; docker images "aidev/*" --format "{{.Repository}}:{{.Tag}} {{.Size}}"
    echo "## volume aidev_app"; docker run --rm -v aidev_app:/srv/app node:22-bookworm-slim sh -c "ls -la /srv/app; echo releases:; ls -la /srv/app/releases 2>/dev/null; echo deps:; ls -la /srv/app/deps 2>/dev/null; du -sh /srv/app/deps/* 2>/dev/null; readlink /srv/app/current" 2>&1
    echo "## deploy dir"; ls -la $HOME/aidev/deploy $HOME/aidev/deploy/release 2>&1
    echo "## gateway"; docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 5 http://aidev-auth-gateway:8080/_gateway/release 2>&1; echo
    echo "## last helper container logs"; for c in $(docker ps -aq --filter ancestor=node:22-bookworm | head -3); do docker logs --tail 20 $c 2>&1; done'
}

do_fetch() {
  ensure_master
  local out="$OPS/inbox/snapshot-$(stamp)"; mkdir -p "$out"
  rsh 'cd $HOME/aidev && tar czf - --exclude=secrets --exclude=runtime-keys --exclude="*/node_modules" --exclude="*/.git" --exclude="*/dist" --exclude="*/dist-server" source deploy 2>/dev/null' > "$out/aidev-src.tgz"
  rsh 'docker exec nginx-proxy-manager cat /data/nginx/proxy_host/4.conf' > "$out/npm-4.conf" 2>&1
  rsh 'docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}"; echo; docker volume ls; echo; docker images aidev/*' > "$out/docker-state.txt" 2>&1
  rsh "bash $REMOTE_DEPLOY/release/release.sh status" > "$out/release-status.txt" 2>&1
  echo "==> $out"
}

# ---- 작업 대기(watch): Claude가 쓰는 outbox/<id>.job 한 줄 = 허용 목록의 relay 작업 하나 --------------------
# 형식은 "명령 인자…" 한 줄. 인자는 정해진 모양만 통과(공백·; $ ` | & 등은 모두 거부)하고, 원격 셸 문자열로
# 합쳐지기 전에 검증된다. bootstrap·scripts·sh·run·claude-token·fetch는 작업으로 받지 않는다(직접 실행).
# 결과: inbox/job-<id>.log(실시간), inbox/job-<id>.status(종료 코드 또는 rejected), 작업 파일은 outbox/done/.
# 상태: inbox/watch.state 에 매 주기 "alive <epoch> ssh=<ok|down> pid=<pid> job=<id|->".
JOB_OK_ID='^[A-Za-z0-9._-]{1,80}$'
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }
job_reject() { echo "rejected: $*"; return 2; }
run_job() {
  set +u   # macOS bash 3.2: empty arrays trip `set -u`
  local line argv cmd a
  line=$(head -1 "$1" | tr -d '\r')
  [ -n "${line// /}" ] || { job_reject "빈 작업"; return; }
  read -r -a argv <<< "$line"
  cmd="${argv[0]:-}"
  for a in "${argv[@]}"; do [[ "$a" =~ ^[A-Za-z0-9._,/=-]{1,120}$ ]] || { job_reject "허용되지 않는 인자: $a"; return; }; done
  case "$cmd" in
    deploy)
      [[ "${argv[1]:-}" =~ ^releases/release-[0-9a-f]{12}(-dirty)?\.tgz$ ]] || { job_reject "deploy releases/release-<sha>.tgz 만 허용"; return; }
      [ -s "$OPS/${argv[1]}" ] || { job_reject "$OPS/${argv[1]} 없음"; return; }
      for a in "${argv[@]:2}"; do [[ "$a" =~ ^(--batch|--drain|--force|--canary|--only|[0-9]{1,3}|[a-z,-]{1,60})$ ]] || { job_reject "deploy 옵션 거부: $a"; return; }; done
      do_deploy "$OPS/${argv[1]}" "${argv[@]:2}" ;;
    rollback)
      [ -z "${argv[1]:-}" ] || [[ "${argv[1]}" =~ ^[0-9a-f]{12}(-dirty)?$ ]] || { job_reject "rollback [sha]"; return; }
      do_run rollback ${argv[1]:-} ;;
    status|list) do_run "$cmd" ;;
    restart)
      for a in "${argv[@]:1}"; do [[ "$a" =~ ^(gateway|runtime-manager|runtimes|laya|--drain|--force|--batch|[0-9]{1,3})$ ]] || { job_reject "restart 대상/옵션 거부: $a"; return; }; done
      do_run restart "${argv[@]:1}" ;;
    diag) do_diag ;;
    gpu) do_gpu ;;
    logs)
      [[ "${argv[1]:-}" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] && { [ -z "${argv[2]:-}" ] || [[ "${argv[2]}" =~ ^[0-9]{1,5}$ ]]; } || { job_reject "logs <container> [lines]"; return; }
      do_logs "${argv[1]}" "${argv[2]:-200}" ;;
    verify)
      [[ "${argv[1]:-}" =~ ^[a-z0-9][a-z0-9_.-]{2,63}$ ]] || { job_reject "verify <user> [--bench|--backup|--experiments|--security]"; return; }
      for a in "${argv[@]:2}"; do [[ "$a" =~ ^--(bench|backup|experiments|security)$ ]] || { job_reject "verify 옵션 거부: $a"; return; }; done
      do_verify "${argv[1]}" "${argv[@]:2}" ;;
    *) job_reject "허용되지 않는 작업: ${cmd:-(빈 줄)}" ;;
  esac
}
do_watch() {
  ensure_master; mkdir -p "$OPS/outbox/done" "$OPS/inbox"
  echo "==> 작업 대기 시작 (5초 간격, Ctrl+C 종료). 허용 작업: deploy rollback status list restart diag gpu logs verify"
  local warned="" f id rc ssh_state current
  while true; do
    ssh -S "$SOCK" -O check "$HOST" >/dev/null 2>&1 && ssh_state=ok || ssh_state=down
    current="-"
    for f in "$OPS"/outbox/*.job; do
      [ -f "$f" ] || continue
      [ $(( $(date +%s) - $(mtime "$f") )) -ge 2 ] || continue   # still being written
      id=$(basename "$f" .job)
      if ! [[ "$id" =~ $JOB_OK_ID ]]; then mv "$f" "$OPS/outbox/done/" 2>/dev/null; continue; fi
      current="$id"; echo "alive $(date +%s) ssh=$ssh_state pid=$$ job=$id" > "$OPS/inbox/watch.state"
      echo "==> [$id] $(head -1 "$f" | tr -d '\r')"
      ( run_job "$f" ) < /dev/null > "$OPS/inbox/job-$id.log" 2>&1; rc=$?   # jobs never read the terminal
      [ $rc -eq 2 ] && grep -q '^rejected:' "$OPS/inbox/job-$id.log" && rc=rejected
      echo "$rc" > "$OPS/inbox/job-$id.status"; echo "    → $rc"
      mv "$f" "$OPS/outbox/done/" 2>/dev/null
      ssh -S "$SOCK" -O check "$HOST" >/dev/null 2>&1 && ssh_state=ok || ssh_state=down
    done
    for d in "$OPS"/outbox/*/; do   # 예전 방식(디렉터리 + apply.sh)은 더 이상 자동 실행하지 않음
      [ -f "$d/READY" ] && [ -z "$warned" ] && { echo "!! $(basename "$d"): apply.sh 작업은 자동 실행하지 않습니다 (./relay.sh bootstrap $d 로 직접)"; warned=1; }
    done
    echo "alive $(date +%s) ssh=$ssh_state pid=$$ job=-" > "$OPS/inbox/watch.state"
    sleep 5
  done
}

do_scripts() {
  local dir="${1:-$OPS/scripts}"; [ -d "$dir" ] || { echo "$dir 없음"; exit 1; }
  ensure_master
  echo "==> $dir/*.sh → 서버 $REMOTE_DEPLOY/release/"
  logto "scripts-$(stamp)" bash -c "tar cz -C '$dir' . | ssh -S '$SOCK' '$HOST' 'set -e; tar xz -C $REMOTE_DEPLOY/release/; chmod +x $REMOTE_DEPLOY/release/*.sh; ls -la $REMOTE_DEPLOY/release/'"
}
do_sh() {
  local script="${1:?local script}"; shift || true; [ -f "$script" ] || { echo "$script 없음"; exit 1; }
  ensure_master
  logto "sh-$(basename "$script" .sh)-$(stamp)" bash -c "cat '$script' | ssh -S '$SOCK' '$HOST' 'bash -s -- $*'"
}
do_verify() {
  local user="${1:?username}"; shift || true
  ensure_master
  # no password: verify-b.sh mints a 10-minute session inside the gateway container and revokes it
  logto "verify-$(stamp)" rsh "bash $REMOTE_DEPLOY/release/verify-b.sh $user $*"
}
do_claude_token() {
  local user="${1:?username}"
  echo "먼저 이 Mac에서  claude setup-token  을 실행해 브라우저 로그인 후 출력된 sk-ant-oat… 토큰을 복사하세요 (약 1년 유효)." >&2
  local tok; read -rs -p "$user 런타임에 설치할 토큰: " tok </dev/tty; echo >&2
  case "$tok" in sk-ant-oat*) ;; *) echo "sk-ant-oat 로 시작하는 토큰이 아닙니다"; exit 1;; esac
  ensure_master
  # token on stdin only: never argv, never the inbox log
  logto "claude-token-$user-$(stamp)" bash -c "printf '%s\n' \"\$0\" | ssh -S '$SOCK' '$HOST' 'bash $REMOTE_DEPLOY/release/claude-token.sh $user'" "$tok"
}
do_gpu() {
  ensure_master; logto "gpu-$(stamp)" rsh '
    echo "## cpu"; lscpu | grep -E "Model name|Vendor|^CPU\(s\)|Flags" | cut -c1-200
    echo "## pci (gpu/accelerator)"; lspci -nn 2>/dev/null | grep -iE "vga|3d|display|accelerat|processing|npu|neural" 
    echo "## kernel modules"; lsmod | grep -iE "amdgpu|radeon|i915|xe|nvidia|habana|intel_vpu|ivpu|kfd" 
    echo "## devices"; ls -la /dev/dri /dev/kfd /dev/accel* /dev/nvidia* 2>&1 | head -20
    echo "## rocm"; (rocminfo 2>/dev/null | grep -E "Name:|Marketing|Compute Unit|gfx" | head -20; rocm-smi --showproductname 2>&1 | head -10; ls /opt/rocm* 2>&1 | head -3)
    echo "## intel"; (which sycl-ls clinfo xpu-smi 2>&1; clinfo -l 2>&1 | head -10; xpu-smi discovery 2>&1 | head -10; ls /dev/accel 2>&1)
    echo "## vulkan/opencl"; (which vulkaninfo 2>&1; vulkaninfo --summary 2>&1 | grep -iE "deviceName|driverName" | head -5)
    echo "## groups"; id; getent group video render
    echo "## docker runtimes"; docker info --format "{{json .Runtimes}}"
    echo "## container /dev/dri test"; docker run --rm --device=/dev/dri --device=/dev/kfd ubuntu:24.04 ls -la /dev/dri /dev/kfd 2>&1 | head -10
    echo "## ollama/llama on host?"; (which ollama 2>&1; systemctl is-active ollama 2>&1; ss -tlnp 2>/dev/null | grep -E ":11434|:8000|:8080 " | head)
    echo "## dmesg gpu"; sudo -n dmesg 2>/dev/null | grep -iE "amdgpu|i915|xe |ivpu|npu" | head -10 || echo "(dmesg needs sudo)"
    echo "## mem"; free -h | head -2'
}
do_logs() { local c="${1:?container}"; ensure_master; logto "logs-$c-$(stamp)" rsh "docker logs --tail ${2:-200} $c 2>&1"; }

case "${1:-}" in
  bootstrap) do_bootstrap "${2:-}" ;;
  scripts)   do_scripts "${2:-}" ;;
  sh)        shift; do_sh "$@" ;;
  verify)    shift; do_verify "$@" ;;
  claude-token) shift; do_claude_token "$@" ;;
  logs)      shift; do_logs "$@" ;;
  deploy)    shift; do_deploy "$@" ;;
  rollback)  shift; do_run rollback "$@" ;;
  status)    do_run status ;;
  list)      do_run list ;;
  run)       shift; do_run "$@" ;;
  diag)      do_diag ;;
  gpu)       do_gpu ;;
  fetch)     do_fetch ;;
  watch)     do_watch ;;
  *) sed -n '3,24p' "$0"; exit 1 ;;
esac
