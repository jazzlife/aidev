# aidev/laya-runtime — tools only (Python + PyTorch ROCm + laya). Contains NO application code:
# the HTTP wrapper runs from the release volume at /srv/app/current/control/laya/app.py.
# Rebuild only when torch/laya versions change (deploy/aidev/release/laya-image.sh build).
#
# Target: AMD Ryzen AI 9 HX 370 / Radeon 890M (gfx1150), ROCm 7.2.x officially supported.
# The host needs only the amdgpu kernel driver; ROCm userspace ships inside the torch wheel.
FROM python:3.12-slim-bookworm
ARG TORCH_INDEX=https://download.pytorch.org/whl/rocm7.1
ARG TORCH_SPEC=torch
ARG LAYA_SPEC=laya==0.3.5
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/models HF_HUB_OFFLINE=0 \
    TOKENIZERS_PARALLELISM=false
RUN apt-get update && apt-get install -y --no-install-recommends libnuma1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --index-url "$TORCH_INDEX" "$TORCH_SPEC" \
 && pip install "$LAYA_SPEC" \
 && useradd --uid 1001 --create-home --shell /usr/sbin/nologin laya \
 && mkdir -p /models /srv/app && chown 1001:1001 /models
# render(993)/video(44) on the AI-PC; compose adds them via group_add as well.
USER 1001:1001
ENV PORT=8095
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD curl -fsS http://127.0.0.1:8095/health || exit 1
CMD ["python", "/srv/app/current/control/laya/app.py"]
