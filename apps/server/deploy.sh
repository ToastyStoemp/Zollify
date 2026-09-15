#!/usr/bin/env bash
#
# Deploys Zollify on the host it is run from.
#
#   ./apps/server/deploy.sh            build here and restart
#   ./apps/server/deploy.sh --pull     git pull first, then build here
#   ./apps/server/deploy.sh --auto     unattended: git pull, pull the GHCR image
#                                      and the latest APKs; restart only when
#                                      something changed. Run by GitHub Actions
#                                      over SSH after each push, and by the
#                                      "Update server" button via systemd
#                                      (apps/server/systemd/)
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

mode="${1:-}"
if [[ "$mode" == "--pull" || "$mode" == "--auto" ]]; then
  echo "→ pulling"
  git pull --ff-only
fi

if [[ "$mode" == "--auto" ]]; then
  # The button's request is consumed first, so a deploy asked for mid-run is not lost.
  rm -f "$repo_root/apps/server/deploy/requested"
  echo "→ fetching APKs"
  # Through a node container: the host needs nothing but Docker and git. The
  # repo and its packages are public, so no token is needed.
  mkdir -p "$repo_root/apps/server/apk" "$repo_root/apps/server/deploy"
  docker run --rm -e ZOLLIFY_APK_DIR=/repo/apps/server/apk     -v "$repo_root:/repo" -w /repo node:22-bookworm-slim node scripts/fetch-apks.mjs     || echo "  (APK fetch failed — keeping what is there)"

  image="$(docker compose -f "$compose_file" --env-file "$env_file" config --images | head -1)"
  running="$(docker inspect -f '{{.Image}}' zollify 2>/dev/null || true)"
  docker compose -f "$compose_file" --env-file "$env_file" pull -q zollify
  latest="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
  if [[ -n "$running" && "$running" == "$latest" ]]; then
    echo "✓ already up to date ($image)"
    exit 0
  fi
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

if [[ "$mode" == "--auto" ]]; then
  echo "→ restarting on the pulled image"
  docker compose -f "$compose_file" --env-file "$env_file" up -d --no-build
else
  echo "→ building and restarting"
  docker compose -f "$compose_file" --env-file "$env_file" up -d --build
fi

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
