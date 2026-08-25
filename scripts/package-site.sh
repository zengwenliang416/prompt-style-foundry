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

if [[ ! -s public/index.html ]]; then
  echo "public/index.html is missing or empty." >&2
  exit 1
fi

if find public -type l -print -quit | grep -q .; then
  echo "Symlinks are not allowed in the public artifact." >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
temporary="${output}.tmp"
rm -f "$temporary"

tar \
  --exclude='._*' \
  --exclude='.DS_Store' \
  -C public \
  -czf "$temporary" \
  .

if tar -tzf "$temporary" | grep -Eq '(^|/)(\._|\.DS_Store)'; then
  echo "Packaged artifact contains macOS metadata." >&2
  rm -f "$temporary"
  exit 1
fi

mv "$temporary" "$output"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output" >"${output}.sha256"
else
  shasum -a 256 "$output" >"${output}.sha256"
fi

printf 'Packaged %s\n' "$output"
cat "${output}.sha256"
