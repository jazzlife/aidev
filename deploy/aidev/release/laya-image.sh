#!/usr/bin/env bash
# Laya decision service — the tools image and one-time setup. No application code in the image.
#   laya-image.sh build [tag]   build aidev/laya-runtime:<tag> (torch ROCm + laya), tag :latest
#   laya-image.sh models        download model weights into the aidev_models volume (needs internet; done once)
#   laya-image.sh gpu           verify torch sees the iGPU inside the image (ROCm/HIP), prints device + a timing
#   laya-image.sh setup         build + models + compose up laya (+ gateway restart so LAYA_URL takes effect)
#   laya-image.sh test          call /route through the container with a Korean and an English command
set -euo pipefail
trap 'echo " ✗ laya-image.sh failed at line $LINENO (exit $?)" >&2' ERR
here=$(cd "$(dirname "$0")" && pwd); DEPLOY=$(cd "$here/.." && pwd)
ENV_FILE="$DEPLOY/.env"; [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
IMG=aidev/laya-runtime; MODEL="${LAYA_MODEL:-convaiinnovations/laya-multilingual}"
GPU_ARGS=(--device /dev/kfd --device /dev/dri --group-add 44 --group-add 993 --security-opt seccomp=unconfined)
compose() { (cd "$DEPLOY" && docker compose -p aidev --env-file "$ENV_FILE" -f docker-compose.yml "$@"); }
case "${1:-}" in
  build)
    tag="${2:-tools-$(date +%Y%m%d)}"
    echo "==> building $IMG:$tag (torch from ${LAYA_TORCH_INDEX:-https://download.pytorch.org/whl/rocm7.1})"
    DOCKER_BUILDKIT=1 docker build -f "$DEPLOY/laya/Dockerfile" "$DEPLOY/laya" \
      --build-arg TORCH_INDEX="${LAYA_TORCH_INDEX:-https://download.pytorch.org/whl/rocm7.1}" -t "$IMG:$tag" 2>&1 | tail -12
    docker tag "$IMG:$tag" "$IMG:latest"; echo " ✓ $IMG:latest -> $tag" ;;
  models)
    docker volume inspect aidev_models >/dev/null 2>&1 || docker volume create --label com.docker.compose.project=aidev --label com.docker.compose.volume=models aidev_models >/dev/null
    docker run --rm -v aidev_models:/models -e HF_HOME=/models -e HF_HUB_OFFLINE=0 "$IMG:latest" \
      python -c "import laya,time; t=time.time(); a=laya.load('$MODEL', device='cpu'); print('downloaded', '$MODEL', 'in', round(time.time()-t,1), 's')"
    echo " ✓ weights in aidev_models" ;;
  gpu)
    docker run --rm "${GPU_ARGS[@]}" -v aidev_models:/models -e HF_HOME=/models -e HF_HUB_OFFLINE=1 \
      -e HSA_OVERRIDE_GFX_VERSION="${HSA_OVERRIDE_GFX_VERSION:-}" "$IMG:latest" python - <<'PY'
import torch, time
print("torch", torch.__version__, "hip", getattr(torch.version, "hip", None), "cuda_available", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device", torch.cuda.get_device_name(0), "capability", torch.cuda.get_device_capability(0))
    x = torch.randn(2048, 2048, device="cuda"); torch.cuda.synchronize(); t = time.time()
    for _ in range(20): y = x @ x
    torch.cuda.synchronize(); print("matmul 2048^2 x20:", round((time.time()-t)*1000,1), "ms")
import laya
for dev in (["cuda"] if torch.cuda.is_available() else []) + ["cpu"]:
    a = laya.load("convaiinnovations/laya-multilingual", device=dev)
    q = {"agent": {"type": "choice", "instructions": "Which specialist?", "criteria": {"frontend": "React, CSS, UI", "backend": "APIs, databases", "devops": "Docker, CI, deploy"}}}
    a.predict("warm", q); t = time.time(); r = a.predict("React 컴포넌트의 버튼 색을 파란색으로 바꿔줘", q)
    print(dev, round((time.time()-t)*1000,1), "ms ->", r["answers"]["agent"]["choice"], r["answers"]["agent"]["probabilities"])
PY
    ;;
  setup)
    "$0" build; "$0" models; "$0" gpu || echo " ! gpu check failed — service will fall back to CPU (LAYA_DEVICE=auto)"
    echo "==> compose up laya"; compose up -d laya 2>&1 | tail -3
    for i in $(seq 1 240); do docker exec aidev-laya curl -fsS -m 2 http://127.0.0.1:8095/health >/dev/null 2>&1 && break; sleep 2; done
    docker exec aidev-laya curl -fsS -m 2 http://127.0.0.1:8095/health; echo
    echo "==> gateway restart (LAYA_URL)"; compose up -d auth-gateway 2>&1 | tail -2
    "$0" test ;;
  test)
    for cmd in "React 로그인 화면의 버튼을 모바일에서 더 크게 보이게 고쳐줘" "Add a Postgres index for the slow orders query and write a migration" "Tizen TV 앱을 sdb로 설치하고 로그를 보여줘"; do
      docker exec aidev-laya curl -sS -m 30 -X POST http://127.0.0.1:8095/route -H 'content-type: application/json' -d "$(python3 -c "import json,sys; print(json.dumps({'text': sys.argv[1], 'agents': {'frontend-react': 'React/TypeScript UI, components, CSS, responsive layout, accessibility', 'backend-node': 'Node.js/Express APIs, auth, websockets, server logic', 'database': 'SQL schema, migrations, indexes, query performance, Postgres/SQLite', 'devops': 'Docker, compose, CI/CD, deployment, nginx, Linux ops', 'tizen-device': 'Tizen TV/watch apps, sdb, .wgt packaging, Samsung device debugging', 'android-device': 'Android apps, adb, Gradle, device automation', 'docs': 'documentation, README, comments, explanations'}}))" "$cmd")"; echo; done ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
