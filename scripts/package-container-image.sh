#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

if [[ $# -ne 2 ]]; then
  echo "Usage: scripts/package-container-image.sh <api|worker|web|static> <output.tar.gz>" >&2
  exit 2
fi

target=$1
output=$2
case "$target" in
  api|worker|web|static) ;;
  *)
    echo "Unsupported container target: $target" >&2
    exit 2
    ;;
esac

if [[ "$output" != /* ]]; then
  output="$ROOT/$output"
fi

revision=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
  dirty=true
else
  dirty=false
fi
worktree_sha=$(python3 scripts/worktree_fingerprint.py)
if [[ ! "$worktree_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Failed to calculate a valid worktree fingerprint." >&2
  exit 1
fi

if [[ -n "${ONEPIC_ARTIFACT_VERSION:-}" ]]; then
  version=$ONEPIC_ARTIFACT_VERSION
else
  version=$(git rev-parse --short=12 HEAD)
  if [[ "$dirty" == true ]]; then
    version="${version}-dirty-${worktree_sha:0:12}"
  fi
fi
image="onepic-${target}:${version}"
mkdir -p "$(dirname "$output")"

docker build \
  --target "$target" \
  --label "org.opencontainers.image.revision=$revision" \
  --label "io.onepic.source.dirty=$dirty" \
  --label "io.onepic.source.worktree-sha256=$worktree_sha" \
  -t "$image" \
  .

if docker image inspect --format '{{json .Config.Env}} {{json .Config.Labels}}' "$image" |
  grep -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|OIDC_CLIENT_SECRET=|SESSION_SECRET=|PROVIDER_API_KEY=|WORKER_PROVIDER_API_KEY=|sk-[A-Za-z0-9]{20,}' >/dev/null; then
  echo "Credential-like material found in image configuration for $target." >&2
  exit 1
fi
if docker history --no-trunc --format '{{.CreatedBy}}' "$image" |
  grep -E 'OIDC_CLIENT_SECRET=|SESSION_SECRET=|PROVIDER_API_KEY=|WORKER_PROVIDER_API_KEY=|sk-[A-Za-z0-9]{20,}' >/dev/null; then
  echo "Credential-like material found in image history for $target." >&2
  exit 1
fi
if [[ "$target" == "api" || "$target" == "worker" ]]; then
  [[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == "node" ]] || {
    echo "$target image must run as the non-root node user." >&2
    exit 1
  }
fi
case "$target" in
  api)
    docker run --rm --entrypoint sh "$image" -ec '
      test -s /licenses/NOTICE.md
      test -s /licenses/LICENSE
      test -s /licenses/third_party/animejs-LICENSE
      test -s /licenses/third_party/awesome-gpt-image-2-LICENSE
      test ! -e /app/node_modules/vitest
      test ! -e /app/node_modules/@playwright/test
      test ! -e /app/node_modules/eslint
      test -s /app/apps/api/dist/server.js
      test ! -e /app/node_modules/typescript
      test ! -e /app/node_modules/vite
      test ! -e /app/node_modules/rollup
      test ! -e /app/node_modules/esbuild
      test ! -e /app/node_modules/vue
      test ! -e /app/node_modules/@onepic/test-support
      if find /app/node_modules -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*.map" -o -name "*.md" -o -name "*.markdown" \) -print -quit | grep -q .; then
        echo "forbidden API dependency payload detected" >&2
        exit 1
      fi
      if find /app/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name spec -o -name specs -o -name testing \) -print -quit | grep -q .; then
        echo "forbidden API dependency test directory detected" >&2
        exit 1
      fi
      npm ls --omit=dev --all --json >/tmp/npm-ls.json
      node -e "const d=require(\"/tmp/npm-ls.json\"); if ((d.problems ?? []).length) { console.error(\"API production dependency problems detected\"); process.exit(1) }"
      if find -L /app/node_modules -type l -print -quit | grep -q .; then
        echo "dangling API dependency symlink detected" >&2
        exit 1
      fi
      test -s /app/apps/api/dist/db/migrate-cli.js
      test -s /app/apps/api/dist/modules/catalog/import-cli.js
      test -d /app/apps/api/migrations
      test -s /app/public/data/catalog.json
      test -s /app/public/data/prompts/case-532.txt
      test -s /app/data/library/templates.json
      test "$(find /app/public/data/prompts -type f -name "*.txt" | wc -l)" -eq 576
      test "$(find /app/public -type f | wc -l)" -eq 577
      test ! -e /app/public/index.html
      test -s /app/packages/contracts/openapi/api-v1.json
      test -s /app/packages/managed-runtime/dist/index.js
      test -r /app/package.json
      test -r /app/apps/api/package.json
      test -r /app/packages/contracts/package.json
      test -r /app/packages/contracts/openapi/api-v1.json
      test -r /app/packages/managed-runtime/package.json
      test ! -e /app/docs
      test ! -e /app/apps/worker
      if find /app/apps /app/packages /app/public /app/data -type f \( -name ".env*" -o -name "*.tmp" -o -name "*.test.*" -o -name "*.pem" -o -name "*.key" -o -name "*.map" \) -print -quit | grep -q .; then
        echo "forbidden API image file detected" >&2
        exit 1
      fi
      if grep -R -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}" /app/apps /app/packages /app/public /app/data >/dev/null; then
        echo "credential-like API project payload detected" >&2
        exit 1
      fi
    '
    ;;
  worker)
    docker run --rm --entrypoint sh "$image" -ec '
      test -s /licenses/NOTICE.md
      test -s /licenses/LICENSE
      test -s /licenses/third_party/animejs-LICENSE
      test -s /licenses/third_party/awesome-gpt-image-2-LICENSE
      test ! -e /app/node_modules/vitest
      test ! -e /app/node_modules/@playwright/test
      test ! -e /app/node_modules/eslint
      test ! -e /app/node_modules/typescript
      test ! -e /app/node_modules/vite
      test ! -e /app/node_modules/rollup
      test ! -e /app/node_modules/esbuild
      test ! -e /app/node_modules/vue
      test ! -e /app/node_modules/@onepic/test-support
      if find /app/node_modules -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*.map" -o -name "*.md" -o -name "*.markdown" \) -print -quit | grep -q .; then
        echo "forbidden Worker dependency payload detected" >&2
        exit 1
      fi
      if find /app/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name spec -o -name specs -o -name testing \) -print -quit | grep -q .; then
        echo "forbidden Worker dependency test directory detected" >&2
        exit 1
      fi
      npm ls --omit=dev --all --json >/tmp/npm-ls.json
      node -e "const d=require(\"/tmp/npm-ls.json\"); if ((d.problems ?? []).length) { console.error(\"Worker production dependency problems detected\"); process.exit(1) }"
      if find -L /app/node_modules -type l -print -quit | grep -q .; then
        echo "dangling Worker dependency symlink detected" >&2
        exit 1
      fi
      test -s /app/apps/worker/dist/index.js
      test -s /app/apps/worker/dist/replay-deletions-cli.js
      test -s /app/packages/managed-runtime/dist/index.js
      test ! -e /app/docs
      test ! -e /app/apps/api
      test ! -e /app/public
      test -s /app/packages/contracts/dist/index.js
      test -r /app/package.json
      test -r /app/apps/worker/package.json
      test -r /app/packages/contracts/package.json
      test -r /app/packages/managed-runtime/package.json
      if find /app/apps /app/packages -type f \( -name ".env*" -o -name "*.tmp" -o -name "*.test.*" \) -print -quit | grep -q .; then
        echo "forbidden Worker image file detected" >&2
        exit 1
      fi
      if grep -R -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}" /app/apps /app/packages >/dev/null; then
        echo "credential-like Worker project payload detected" >&2
        exit 1
      fi
    '
    ;;
  web)
    docker run --rm --entrypoint sh "$image" -ec '
      test -s /licenses/NOTICE.md
      test -s /licenses/LICENSE
      test -s /licenses/third_party/animejs-LICENSE
      test -s /licenses/third_party/awesome-gpt-image-2-LICENSE
      test -s /usr/share/nginx/html/index.html
      test -s /usr/share/nginx/html/data/catalog.json
      test -s /usr/share/nginx/html/data/prompts/case-532.txt
      test -s /usr/share/nginx/html/assets/app.js
      test "$(find /usr/share/nginx/html/assets -maxdepth 1 -type f -name "index-*.js" | wc -l)" -eq 1
      test "$(find /usr/share/nginx/html/assets -maxdepth 1 -type f -name "index-*.css" | wc -l)" -eq 1
      test ! -e /usr/share/nginx/html/docs
      if find /usr/share/nginx/html -type f \( -name ".env*" -o -name "*.tmp" -o -name ".DS_Store" -o -name "._*" -o -name "*.pem" -o -name "*.key" -o -name "*.md" -o -name "*.map" -o -name "*.log" -o -name "*.bak" -o -name "*.zip" -o -name "*.tar" -o -name "*.gz" -o -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \) -print -quit | grep -q .; then
        echo "forbidden Web image file detected" >&2
        exit 1
      fi
      if find /usr/share/nginx/html/previews -type f -name "*.webp" -print | grep -Ev "/(case-[0-9]+|framework-[0-9]{3})\\.webp$" | grep -q .; then
        echo "unexpected Web preview filename detected" >&2
        exit 1
      fi
      if grep -R -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|OIDC_CLIENT_SECRET=|SESSION_SECRET=|PROVIDER_API_KEY=|sk-[A-Za-z0-9]{20,}" /usr/share/nginx/html >/dev/null; then
        echo "credential-like Web content detected" >&2
        exit 1
      fi
    '
    ;;
  static)
    docker run --rm --entrypoint sh "$image" -ec '
      test -s /licenses/NOTICE.md
      test -s /licenses/LICENSE
      test -s /licenses/third_party/animejs-LICENSE
      test -s /licenses/third_party/awesome-gpt-image-2-LICENSE
      test -s /usr/share/nginx/html/index.html
      test -s /usr/share/nginx/html/data/catalog.json
      test -s /usr/share/nginx/html/data/prompts/case-532.txt
      test -s /usr/share/nginx/html/assets/app.js
      test "$(find /usr/share/nginx/html/assets -maxdepth 1 -type f -name "index-*.js" | wc -l)" -eq 0
      test "$(find /usr/share/nginx/html/assets -maxdepth 1 -type f -name "index-*.css" | wc -l)" -eq 0
      test ! -e /usr/share/nginx/html/docs
      if find /usr/share/nginx/html -type f \( -name ".env*" -o -name "*.tmp" -o -name ".DS_Store" -o -name "._*" -o -name "*.pem" -o -name "*.key" -o -name "*.md" -o -name "*.map" -o -name "*.log" -o -name "*.bak" -o -name "*.zip" -o -name "*.tar" -o -name "*.gz" -o -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \) -print -quit | grep -q .; then
        echo "forbidden static image file detected" >&2
        exit 1
      fi
      if find /usr/share/nginx/html/previews -type f -name "*.webp" -print | grep -Ev "/(case-[0-9]+|framework-[0-9]{3})\\.webp$" | grep -q .; then
        echo "unexpected static preview filename detected" >&2
        exit 1
      fi
      if grep -R -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|OIDC_CLIENT_SECRET=|SESSION_SECRET=|PROVIDER_API_KEY=|sk-[A-Za-z0-9]{20,}" /usr/share/nginx/html >/dev/null; then
        echo "credential-like static content detected" >&2
        exit 1
      fi
    '
    ;;
esac

temporary="${output}.tmp"
rm -f "$temporary"
docker save "$image" | gzip -n -9 >"$temporary"
mv "$temporary" "$output"

output_dir=$(dirname "$output")
output_name=$(basename "$output")
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$output_name" >"${output_name}.sha256")
else
  (cd "$output_dir" && shasum -a 256 "$output_name" >"${output_name}.sha256")
fi

artifact_sha=$(awk '{print $1}' "${output}.sha256")
artifact_bytes=$(wc -c <"$output" | tr -d ' ')
image_id=$(docker image inspect --format '{{.Id}}' "$image")
TARGET="$target" IMAGE="$image" IMAGE_ID="$image_id" REVISION="$revision" DIRTY="$dirty" \
  WORKTREE_SHA="$worktree_sha" ARTIFACT_NAME="$output_name" ARTIFACT_SHA="$artifact_sha" \
  ARTIFACT_BYTES="$artifact_bytes" \
  MANIFEST_PATH="${output}.manifest.json" python3 - <<'PY'
import json
import os

manifest = {
    "schemaVersion": 1,
    "target": os.environ["TARGET"],
    "image": os.environ["IMAGE"],
    "imageId": os.environ["IMAGE_ID"],
    "revision": os.environ["REVISION"],
    "dirty": os.environ["DIRTY"] == "true",
    "worktreeSha256": os.environ["WORKTREE_SHA"],
    "artifact": {
        "file": os.environ["ARTIFACT_NAME"],
        "sha256": os.environ["ARTIFACT_SHA"],
        "bytes": int(os.environ["ARTIFACT_BYTES"]),
        "format": "docker-save+gzip",
    },
    "embeddedProjectCredentialsDetected": False,
    "verified": True,
}
with open(os.environ["MANIFEST_PATH"], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

printf 'Packaged %s image as %s\n' "$target" "$output"
cat "${output}.sha256"
