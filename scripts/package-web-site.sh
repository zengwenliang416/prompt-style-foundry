#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/package-web-site.sh /path/to/web-site.tar.gz" >&2
  exit 2
fi

output="$1"
if [[ "$output" != /* ]]; then
  output="$ROOT/$output"
fi

npm run build -w @onepic/web

if [[ ! -s apps/web/dist/index.html ]]; then
  echo "apps/web/dist/index.html is missing or empty." >&2
  exit 1
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

mkdir -p "$(dirname "$output")"
temporary="${output}.tmp"
rm -f "$temporary"

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
  python3 scripts/create_web_artifact.py "$temporary"

entries=$(tar -tzf "$temporary")
for required_entry in \
  index.html \
  data/catalog.json \
  data/stats.json \
  data/prompts/case-532.txt \
  data/prompts/framework-001.txt \
  NOTICE.md \
  LICENSE \
  third_party/animejs-LICENSE \
  third_party/awesome-gpt-image-2-LICENSE; do
  if ! printf '%s\n' "$entries" | grep -Fx "$required_entry" >/dev/null; then
    printf 'Packaged Vue artifact is missing required entry: %s\n' "$required_entry" >&2
    rm -f "$temporary"
    exit 1
  fi
done

if ! printf '%s\n' "$entries" | grep -Eq '^assets/[A-Za-z0-9._-]+\.js$'; then
  echo "Packaged Vue artifact is missing a JavaScript bundle." >&2
  rm -f "$temporary"
  exit 1
fi
if ! printf '%s\n' "$entries" | grep -Eq '^assets/[A-Za-z0-9._-]+\.css$'; then
  echo "Packaged Vue artifact is missing a CSS bundle." >&2
  rm -f "$temporary"
  exit 1
fi
if printf '%s\n' "$entries" | grep -Eq '(^|/)(docs|src|test-results|playwright-report|coverage)(/|$)|(^|/)(\.env[^/]*|.*\.tmp|.*\.pem|.*\.key|.*\.map)$'; then
  echo "Packaged Vue artifact contains source, documentation, credential, temporary, or source-map paths." >&2
  rm -f "$temporary"
  exit 1
fi

prompt_count=$(printf '%s\n' "$entries" | grep -Ec '^data/prompts/(case-[0-9]+|framework-[0-9]{3})\.txt$')
if [[ "$prompt_count" -ne 576 ]]; then
  printf 'Expected 576 prompt files, found %s.\n' "$prompt_count" >&2
  rm -f "$temporary"
  exit 1
fi

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
member_count=$(printf '%s\n' "$entries" | wc -l | tr -d ' ')
REVISION="$revision" DIRTY="$dirty" WORKTREE_SHA="$worktree_sha" \
  ARTIFACT_NAME="$output_name" ARTIFACT_SHA="$artifact_sha" \
  ARTIFACT_BYTES="$artifact_bytes" MEMBER_COUNT="$member_count" SOURCE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
  MANIFEST_PATH="${output}.manifest.json" python3 - <<'PY'
import json
import os

manifest = {
    "schemaVersion": 1,
    "target": "vue-web-site",
    "revision": os.environ["REVISION"],
    "dirty": os.environ["DIRTY"] == "true",
    "worktreeSha256": os.environ["WORKTREE_SHA"],
    "artifact": {
        "file": os.environ["ARTIFACT_NAME"],
        "sha256": os.environ["ARTIFACT_SHA"],
        "bytes": int(os.environ["ARTIFACT_BYTES"]),
        "members": int(os.environ["MEMBER_COUNT"]),
        "format": "deterministic-tar+gzip",
        "sourceDateEpoch": int(os.environ["SOURCE_EPOCH"]),
    },
    "containsCredentials": False,
    "verified": True,
}
with open(os.environ["MANIFEST_PATH"], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

printf 'Packaged Vue web site %s\n' "$output"
cat "${output}.sha256"
