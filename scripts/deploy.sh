#!/usr/bin/env bash
# Deploy to `ssh ubuntu`: rsync sources, build & (re)start the container with docker compose.
set -euo pipefail
HOST=${DEPLOY_HOST:-ubuntu}
DIR=${DEPLOY_DIR:-surviver}
cd "$(dirname "$0")/.."
rsync -az --delete \
  --exclude node_modules --exclude '**/node_modules' --exclude dist --exclude '**/dist' \
  --exclude desktop/app --exclude desktop/dist --exclude data --exclude .git --exclude .env \
  ./ "$HOST:$DIR/"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd ~/$DIR
# generate an admin token once and keep it in .env (never committed)
if [ ! -f .env ]; then echo "ADMIN_TOKEN=\$(openssl rand -hex 16)" > .env; chmod 600 .env; fi
docker compose up -d --build 2>&1 | grep -v -E 'Executing external compose provider|podman-compose' || true
sleep 3
curl -q -fsS --noproxy "*" http://127.0.0.1:8085/api/health && echo " container healthy"
REMOTE
# upload the Windows build if it exists
if [ -f desktop/dist/Surviver-portable.exe ]; then
  ssh "$HOST" "docker exec surviver mkdir -p /data/downloads" 2>/dev/null || true
  rsync -az --progress desktop/dist/Surviver-portable.exe "$HOST:/tmp/Surviver-portable.exe" >/dev/null
  ssh "$HOST" "docker cp /tmp/Surviver-portable.exe surviver:/data/downloads/Surviver-portable.exe && rm /tmp/Surviver-portable.exe" 2>&1 | grep -v -E 'Executing external|podman-compose' || true
  echo "uploaded Windows build"
fi
echo "deployed → https://surviver.yunix.software"
