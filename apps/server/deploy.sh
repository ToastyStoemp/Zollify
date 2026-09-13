#!/usr/bin/env bash
#
# Deploys Zollify on the host it is run from.
#
#   ./apps/server/deploy.sh            build here and restart
#   ./apps/server/deploy.sh --pull     git pull first
#
# Building in Docker is reproducible but slow on a small instance. To build
# elsewhere instead:
#   docker build -f apps/server/Dockerfile -t zollify:TAG .
#   docker save zollify:TAG | ssh HOST 'docker load'
# then run compose with `image: zollify:TAG` and no build section.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

compose_file="apps/server/docker-compose.yml"
env_file="apps/server/.env"

if [[ ! -f "$env_file" ]]; then
  echo "error: $env_file is missing. Copy apps/server/.env.example and fill it in." >&2
  exit 1
fi

if [[ "${1:-}" == "--pull" ]]; then
  echo "→ pulling"
  git pull --ff-only
fi

# Backed up before anything restarts: a deploy is exactly when you most want a
# restore point, and the volume survives the container but not a bad migration.
echo "→ backing up the database"
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
if docker compose -f "$compose_file" ps --status running --quiet zollify >/dev/null 2>&1; then
  docker compose -f "$compose_file" exec -T zollify \
    node -e "const D=require('better-sqlite3');const db=new D('/data/zollify.db',{readonly:true});db.backup('/data/backup.tmp').then(()=>{db.close();process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})" \
    && docker compose -f "$compose_file" cp "zollify:/data/backup.tmp" "backups/zollify-$stamp.db" \
    && docker compose -f "$compose_file" exec -T zollify rm -f /data/backup.tmp \
    && echo "  saved backups/zollify-$stamp.db"
else
  echo "  (not running yet — nothing to back up)"
fi

echo "→ building and restarting"
docker compose -f "$compose_file" --env-file "$env_file" up -d --build

echo "→ waiting for health"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo "✓ healthy"
    docker compose -f "$compose_file" ps
    exit 0
  fi
  sleep 2
done

echo "✗ did not become healthy in 60s — recent logs:" >&2
docker compose -f "$compose_file" logs --tail 40 zollify >&2
exit 1
