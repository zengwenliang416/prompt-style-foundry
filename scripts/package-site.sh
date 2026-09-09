#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/package-site.sh /path/to/site.tar.gz" >&2
  exit 2
fi

output="$1"
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

if [[ ! -s public/index.html ]]; then
  echo "public/index.html is missing or empty." >&2
  exit 1
fi

if find public -type l -print -quit | grep -q .; then
  echo "Symlinks are not allowed in the public artifact." >&2
  exit 1
fi


if find public -type f \( -name '.env*' -o -name '*.tmp' -o -name '.DS_Store' -o -name '._*' -o -name '*.pem' -o -name '*.key' -o -name '*.md' \) -print -quit | grep -q .; then
  echo "Forbidden documentation, credential, or temporary file found in public/." >&2
  exit 1
fi

if grep -R -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|OIDC_CLIENT_SECRET=|SESSION_SECRET=|PROVIDER_API_KEY=|sk-[A-Za-z0-9]{20,}' public >/dev/null; then
  echo "Credential-like content found in public/." >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
temporary="${output}.tmp"
rm -f "$temporary"

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
  python3 scripts/create_static_artifact.py "$temporary"

if tar -tzf "$temporary" | grep -Eq '(^|/)(\._|\.DS_Store)'; then
  echo "Packaged artifact contains macOS metadata." >&2
  rm -f "$temporary"
  exit 1
fi

entries=$(tar -tzf "$temporary")
if printf '%s\n' "$entries" | grep -Eq '(^|/)(docs|test-results|playwright-report|coverage)(/|$)|(^|/)(\.env[^/]*|.*\.tmp|.*\.pem|.*\.key)$'; then
  echo "Packaged artifact contains documentation, credential, or temporary paths." >&2
  rm -f "$temporary"
  exit 1
fi

for required_entry in NOTICE.md LICENSE third_party/animejs-LICENSE third_party/awesome-gpt-image-2-LICENSE; do
  if ! printf '%s\n' "$entries" | grep -Fx "$required_entry" >/dev/null; then
    printf 'Packaged artifact is missing required license entry: %s\n' "$required_entry" >&2
    rm -f "$temporary"
    exit 1
  fi
done

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
    "target": "standalone-static-site",
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

printf 'Packaged %s\n' "$output"
cat "${output}.sha256"
