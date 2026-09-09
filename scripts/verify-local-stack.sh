#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

project=${ONEPIC_SMOKE_PROJECT:-onepic-o05-smoke-$$}
web_port=${ONEPIC_SMOKE_WEB_PORT:-4183}
static_port=${ONEPIC_SMOKE_STATIC_PORT:-4184}

compose() {
  ONEPIC_RUN_MODE=catalog-only \
  ONEPIC_WORKER_GENERATION_ENABLED=false \
  ONEPIC_WEB_PORT="$web_port" \
  ONEPIC_STATIC_PORT="$static_port" \
    docker compose -p "$project" --profile static-only "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_healthy() {
  local service=$1
  local container status
  container=$(compose ps -q "$service")
  for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
    case "$status" in
      healthy) return 0 ;;
      unhealthy|exited|dead)
        compose logs --no-color --tail=120 "$service" >&2
        return 1
        ;;
    esac
    sleep 2
  done
  compose logs --no-color --tail=120 "$service" >&2
  echo "$service did not become healthy" >&2
  return 1
}

echo '[o05] validating Compose and Dockerfile'
docker compose config --quiet
docker build --check .

echo '[o05] building API, Worker, Web, and standalone static images'
compose build api worker web static

echo '[o05] starting a fresh isolated stack'
compose up -d postgres api worker web
wait_healthy postgres
wait_healthy api
wait_healthy worker
wait_healthy web

base="http://127.0.0.1:$web_port"
for route in / /discover /studio /workspace /guide; do
  body=$(mktemp)
  curl -fsS "$base$route" -o "$body"
  grep -q '<div id="app"' "$body"
  rm -f "$body"
done
curl -fsS "$base/api/v1/health/live" | grep -q '"status":"ok"'
curl -fsS "$base/api/v1/health/ready" | grep -q '"status":"ok"'
[[ $(compose exec -T postgres psql -U onepic -d onepic -Atc "SELECT to_regclass('public.schema_migrations') IS NULL") == t ]]
curl -fsS "$base/data/catalog.json" | grep -q '"templates"'
curl -fsS "$base/data/prompts/case-532.txt" | grep -q 'BEGIN VISUAL BLUEPRINT'
compose exec -T worker node -e "fetch('http://127.0.0.1:9090/internal/health/ready').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>{if(!t.includes('\\\"status\\\":\\\"ok\\\"'))process.exit(1)})"


echo '[o05] verifying clean production API image in managed mode through precheck/create/sidecar'
api_image=$(compose images -q api)
ONEPIC_MANAGED_SMOKE_IMAGE="$api_image" bash scripts/verify-managed-image.sh
echo '[o05] verifying standalone public/ image without API dependencies'
compose up -d --no-deps static
wait_healthy static
curl -fsS "http://127.0.0.1:$static_port/data/catalog.json" | grep -q '"templates"'
curl -fsS "http://127.0.0.1:$static_port/data/prompts/case-532.txt" | grep -q 'BEGIN VISUAL BLUEPRINT'

echo '[o05] verifying graceful container SIGTERM path'
compose stop -t 35 worker
compose logs --no-color worker | grep -q '"event":"worker_stopped"'

if find public -type f \( -name '.DS_Store' -o -name '._*' -o -name '*.tmp' \) -print -quit | grep -q .; then
  echo 'forbidden temporary metadata found in public/' >&2
  exit 1
fi

echo '[o05] cleaning isolated containers and volumes'
compose down --volumes --remove-orphans >/dev/null
trap - EXIT INT TERM
if compose ps -q | grep -q .; then
  echo 'isolated smoke containers remained after cleanup' >&2
  exit 1
fi

report_path=${ONEPIC_SMOKE_REPORT:-docs/design/evidence/o05/local-stack-smoke.json}
mkdir -p "$(dirname "$report_path")"
REPORT_PATH="$report_path" PROJECT="$project" WEB_PORT="$web_port" STATIC_PORT="$static_port" \
  python3 - <<'PY'
import datetime
import json
import os
import platform
import subprocess

def output(*args):
    return subprocess.check_output(args, text=True).strip()

report = {
    "measuredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "workspace": {
        "commit": output("git", "rev-parse", "HEAD"),
        "dirty": bool(output("git", "status", "--porcelain")),
    },
    "environment": {
        "platform": platform.platform(),
        "docker": output("docker", "version", "--format", "{{.Server.Version}}"),
        "compose": output("docker", "compose", "version", "--short"),
    },
    "isolation": {
        "project": os.environ["PROJECT"],
        "webPort": int(os.environ["WEB_PORT"]),
        "staticPort": int(os.environ["STATIC_PORT"]),
        "containersAndVolumesRemoved": True,
    },
    "assertions": {
        "dockerfileCheck": True,
        "cleanComposeStart": True,
        "apiLiveness": True,
        "apiReadinessWithPostgres": True,
        "workerInternalReadinessWithPostgres": True,
        "catalogOnlyProductionStartupSkippedDatabaseWrites": True,
        "managedProductionImagePrecheckCreateAndSidecar": True,
        "fiveSpaDeepLinksRefresh": True,
        "catalogAndCase532Assets": True,
        "standaloneStaticImageWithoutApi": True,
        "workerSigtermLoggedCleanStop": True,
        "publicTemporaryMetadataAbsent": True,
        "externalProviderCalls": 0,
    },
    "passed": True,
    "limitations": [
        "The primary Compose stack stayed catalog-only; a separate clean production-image smoke enabled managed API routes through queued generation and sidecar, without starting a Worker.",
        "In-flight provider shutdown is verified separately by runtime-shutdown.integration.test.ts with real PostgreSQL and a loopback provider double.",
        "No real or paid provider was called; W06 remains unauthorized.",
    ],
}
with open(os.environ["REPORT_PATH"], "w", encoding="utf-8") as handle:
    json.dump(report, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(os.environ["REPORT_PATH"])
PY

echo '[o05] clean isolated stack, health, deep links, static deployment, and graceful stop passed'
