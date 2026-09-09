#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

suffix="${ONEPIC_MANAGED_SMOKE_ID:-$$-$RANDOM}"
network="onepic-managed-smoke-$suffix"
postgres="onepic-managed-pg-$suffix"
api="onepic-managed-api-$suffix"
api_peer="onepic-managed-api-peer-$suffix"
api_bad="onepic-managed-api-bad-$suffix"
image="${ONEPIC_MANAGED_SMOKE_IMAGE:-onepic-api:managed-smoke-$suffix}"
temp_root=$(mktemp -d "${TMPDIR:-/tmp}/onepic-managed-smoke.XXXXXX")
port=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)

cleanup() {
  docker rm -f "$api_bad" "$api_peer" "$api" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$temp_root"
}
trap cleanup EXIT INT TERM

json_field() {
  local file=$1
  local expression=$2
  python3 - "$file" "$expression" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
for part in sys.argv[2].split('.'):
    value = value[part]
print(value)
PY
}

wait_api() {
  for _ in $(seq 1 90); do
    if body=$(curl -fsS "http://127.0.0.1:$port/api/v1/health/ready" 2>/dev/null) \
      && python3 -c 'import json,sys; assert json.loads(sys.argv[1])["data"]["status"] == "ok"' "$body"; then
      return 0
    fi
    if ! docker inspect "$api" >/dev/null 2>&1 || [[ $(docker inspect --format '{{.State.Running}}' "$api") != true ]]; then
      docker logs "$api" >&2 || true
      return 1
    fi
    sleep 1
  done
  docker logs "$api" >&2 || true
  return 1
}

if [[ -z "${ONEPIC_MANAGED_SMOKE_IMAGE:-}" ]]; then
  echo '[managed-image] building production API target'
  docker build --target api -t "$image" .
else
  echo "[managed-image] using prebuilt API image $image"
fi
docker network create "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" \
  -e POSTGRES_DB=onepic \
  -e POSTGRES_USER=onepic \
  -e POSTGRES_PASSWORD=managed-smoke-only \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$postgres" pg_isready -U onepic -d onepic >/dev/null 2>&1 && break
  sleep 1
done

docker run -d --name "$api" --network "$network" -p "127.0.0.1:$port:8080" \
  -e HOST=0.0.0.0 \
  -e RUN_MODE=managed-generation \
  -e DATABASE_URL="postgresql://onepic:managed-smoke-only@$postgres:5432/onepic" \
  -e OIDC_ISSUER=https://identity.example.test \
  -e OIDC_CLIENT_ID=onepic-managed-smoke \
  -e OIDC_CLIENT_SECRET=test \
  -e OIDC_REDIRECT_URI="http://127.0.0.1:$port/api/v1/auth/callback" \
  -e SESSION_SECRET=test-only-managed-image-session-secret-0001 \
  -e MANAGED_PROVIDER_ID=managed-primary \
  "$image" >/dev/null
docker run -d --name "$api_peer" --network "$network" \
  -e HOST=0.0.0.0 \
  -e RUN_MODE=managed-generation \
  -e DATABASE_URL="postgresql://onepic:managed-smoke-only@$postgres:5432/onepic" \
  -e OIDC_ISSUER=https://identity.example.test \
  -e OIDC_CLIENT_ID=onepic-managed-smoke \
  -e OIDC_CLIENT_SECRET=test \
  -e OIDC_REDIRECT_URI="http://127.0.0.1:$port/api/v1/auth/callback" \
  -e SESSION_SECRET=test-only-managed-image-session-secret-0001 \
  -e MANAGED_PROVIDER_ID=managed-primary \
  "$image" >/dev/null
wait_api
for _ in $(seq 1 90); do
  if docker exec "$api_peer" node -e "fetch('http://127.0.0.1:8080/api/v1/health/ready').then(r=>r.json()).then(x=>{if(x.data?.status!=='ok')process.exit(1)})" >/dev/null 2>&1; then
    peer_ready=true
    break
  fi
  sleep 1
done
[[ "${peer_ready:-false}" == true ]] || { docker logs "$api_peer" >&2; exit 1; }
combined_logs=$(docker logs "$api" 2>&1; docker logs "$api_peer" 2>&1)
! grep -q '"event":"migrate_failed"\|"event":"catalog_import_failed"' <<<"$combined_logs"
grep -q '"created":true' <<<"$combined_logs"
grep -q '"created":false' <<<"$combined_logs"

[[ $(docker exec "$postgres" psql -U onepic -d onepic -Atc 'SELECT count(*) FROM template_version') == 576 ]]
[[ $(docker exec "$postgres" psql -U onepic -d onepic -Atc "SELECT count(*) FROM template_version WHERE template_key='case-532' AND version=1") == 1 ]]
grep -q '"event":"catalog_imported"' <<<"$combined_logs"

release_id=$(docker exec "$postgres" psql -U onepic -d onepic -Atc 'SELECT id FROM catalog_release ORDER BY imported_at DESC LIMIT 1')
docker exec "$postgres" psql -U onepic -d onepic -Atc "UPDATE catalog_release SET template_count=575 WHERE id='$release_id'" >/dev/null
readiness_status=$(curl -sS -o "$temp_root/readiness-degraded.json" -w '%{http_code}' "http://127.0.0.1:$port/api/v1/health/ready")
[[ "$readiness_status" == 503 ]]
[[ $(json_field "$temp_root/readiness-degraded.json" data.status) == degraded ]]
docker exec "$api_peer" node -e "fetch('http://127.0.0.1:8080/api/v1/health/ready').then(async r=>{const x=await r.json();if(r.status!==503||x.data?.status!=='degraded')process.exit(1)})"
docker exec "$postgres" psql -U onepic -d onepic -Atc "UPDATE catalog_release SET template_count=576 WHERE id='$release_id'" >/dev/null
wait_api


docker run -d --name "$api_bad" --network "$network" \
  -e HOST=0.0.0.0 \
  -e RUN_MODE=managed-generation \
  -e DATABASE_URL="postgresql://onepic:managed-smoke-only@$postgres:5432/onepic" \
  -e OIDC_ISSUER=https://identity.example.test \
  -e OIDC_CLIENT_ID=onepic-managed-smoke \
  -e OIDC_CLIENT_SECRET=test \
  -e OIDC_REDIRECT_URI="http://127.0.0.1:$port/api/v1/auth/callback" \
  -e SESSION_SECRET=test-only-managed-image-session-secret-0001 \
  -e MANAGED_PROVIDER_ID=managed-primary \
  -e CATALOG_ROOT=/missing-catalog-root \
  "$image" >/dev/null
for _ in $(seq 1 30); do
  [[ $(docker inspect --format '{{.State.Running}}' "$api_bad") == false ]] && break
  sleep 1
done
[[ $(docker inspect --format '{{.State.Running}}' "$api_bad") == false ]]
[[ $(docker inspect --format '{{.State.ExitCode}}' "$api_bad") != 0 ]]
bad_logs=$(docker logs "$api_bad" 2>&1)
grep -q '"event":"catalog_import_failed"' <<<"$bad_logs"
! grep -q '"event":"api_started"' <<<"$bad_logs"

session_token='managed-image-smoke-token'
session_hash=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$session_token")
subject_id=$(docker exec "$postgres" psql -U onepic -d onepic -qAtc \
  "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://identity.example.test','managed-smoke','member') RETURNING id")
docker exec "$postgres" psql -U onepic -d onepic -Atc \
  "INSERT INTO session (subject_id, token_sha256, expires_at) VALUES ('$subject_id','$session_hash',now()+interval '1 hour')" >/dev/null

base="http://127.0.0.1:$port/api/v1"
cookie="onepic_session=$session_token"
origin="http://127.0.0.1:$port"
csrf='x-onepic-requested-with: onepic-fetch'

curl -fsS -H "Cookie: $cookie" "$base/auth/me" -o "$temp_root/me.json"
[[ $(json_field "$temp_root/me.json" data.subject.id) == "$subject_id" ]]

python3 - "$temp_root/input.png" <<'PY'
import binascii
import sys
payload = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082'
open(sys.argv[1], 'wb').write(binascii.unhexlify(payload))
PY
input_bytes=$(wc -c <"$temp_root/input.png" | tr -d ' ')
input_sha=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$temp_root/input.png")

curl -fsS -X POST "$base/uploads" \
  -H "Cookie: $cookie" -H "Origin: $origin" -H "$csrf" -H 'content-type: application/json' \
  --data "{\"declaredBytes\":$input_bytes,\"declaredMime\":\"image/png\"}" \
  -o "$temp_root/upload.json"
upload_id=$(json_field "$temp_root/upload.json" data.uploadId)

curl -fsS -X PUT "$base/uploads/$upload_id/bytes" \
  -H "Cookie: $cookie" -H "Origin: $origin" -H "$csrf" -H 'content-type: application/octet-stream' \
  --data-binary "@$temp_root/input.png" -o "$temp_root/bytes.json"

curl -fsS -X POST "$base/uploads/$upload_id/confirm" \
  -H "Cookie: $cookie" -H "Origin: $origin" -H "$csrf" -H 'content-type: application/json' \
  --data "{\"sha256\":\"$input_sha\"}" -o "$temp_root/confirm.json"
source_id=$(json_field "$temp_root/confirm.json" data.mediaObjectId)

prompt_sha=$(python3 - <<'PY'
import json
catalog=json.load(open('public/data/catalog.json', encoding='utf-8'))
print(next(item['promptSha256'] for item in catalog['templates'] if item['id']=='case-532'))
PY
)

curl -fsS -X POST "$base/prechecks" \
  -H "Cookie: $cookie" -H "Origin: $origin" -H "$csrf" -H 'content-type: application/json' \
  --data "{\"templateId\":\"case-532\",\"templateVersion\":1,\"sourceObjectId\":\"$source_id\",\"settings\":{\"model\":\"gpt-image-2\",\"quality\":\"high\"}}" \
  -o "$temp_root/precheck.json"
precheck_id=$(json_field "$temp_root/precheck.json" data.precheckId)

status=$(curl -sS -o "$temp_root/generation.json" -w '%{http_code}' -X POST "$base/generations" \
  -H "Cookie: $cookie" -H "Origin: $origin" -H "$csrf" -H 'Idempotency-Key: managed-image-smoke-0001' -H 'content-type: application/json' \
  --data "{\"templateId\":\"case-532\",\"templateVersion\":1,\"promptSha256\":\"$prompt_sha\",\"sourceObjectId\":\"$source_id\",\"precheckId\":\"$precheck_id\",\"settings\":{\"model\":\"gpt-image-2\",\"quality\":\"high\"}}")
[[ "$status" == 202 ]]
[[ $(json_field "$temp_root/generation.json" data.state) == queued ]]
generation_id=$(json_field "$temp_root/generation.json" data.id)

curl -fsS -H "Cookie: $cookie" "$base/generations/$generation_id/sidecar" -o "$temp_root/sidecar.json"
[[ $(json_field "$temp_root/sidecar.json" data.kind) == onepic-generation-sidecar ]]
[[ $(json_field "$temp_root/sidecar.json" data.template.key) == case-532 ]]
[[ $(json_field "$temp_root/sidecar.json" data.prompt.compiledSha256) == "$prompt_sha" ]]
[[ $(json_field "$temp_root/sidecar.json" data.input.sha256) == "$input_sha" ]]

report_path=${ONEPIC_MANAGED_SMOKE_REPORT:-docs/design/evidence/o05/managed-image-smoke.json}
mkdir -p "$(dirname "$report_path")"
REPORT_PATH="$report_path" IMAGE="$image" GENERATION_ID="$generation_id" PROMPT_SHA="$prompt_sha" INPUT_SHA="$input_sha" python3 - <<'PY'
import datetime
import json
import os
import subprocess
report = {
    'schemaVersion': '1.0.0',
    'measuredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'workspace': {
        'commit': subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip(),
        'dirty': bool(subprocess.check_output(['git','status','--porcelain'], text=True).strip()),
        'worktreeSha256': subprocess.check_output(['python3','scripts/worktree_fingerprint.py'], text=True).strip(),
    },
    'containerTarget': 'api',
    'assertions': {
        'cleanPostgresMigrationsAndCatalogImport': True,
        'concurrentReplicaStartupSerialized': True,
        'migrationOrImportFailureStopsReplica': True,
        'managedReadinessRequiresSchemaAndCatalog': True,
        'managedReadinessDegradedHttp503': True,
        'templateVersions': 576,
        'case532Version': 1,
        'managedAuthRoute': True,
        'singleImageUploadConfirm': True,
        'case532Precheck': True,
        'generationCreateHttp202': True,
        'generationState': 'queued',
        'sidecarHttp': True,
        'promptSha256': os.environ['PROMPT_SHA'],
        'inputSha256': os.environ['INPUT_SHA'],
        'externalProviderCalls': 0,
    },
    'generationId': os.environ['GENERATION_ID'],
    'passed': True,
    'limitations': [
        'No Worker was started, so the queued task could not call a Provider.',
        'No real or paid Provider was called; W06 remains unauthorized.',
    ],
}
with open(os.environ['REPORT_PATH'], 'w', encoding='utf-8') as handle:
    json.dump(report, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
PY

echo "[managed-image] clean production image precheck/create/sidecar passed: $generation_id"
