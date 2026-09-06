#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required_commands=(curl git node npm python3)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

if git ls-files | grep -Eq '(^|/)(\._|\.DS_Store)'; then
  echo "Tracked macOS metadata files are not allowed." >&2
  exit 1
fi

python3 scripts/build_library.py
python3 scripts/validate_library.py
python3 scripts/validate_design_schemas.py
python3 -m unittest discover -s tests -p 'test_*.py'
while IFS= read -r python_file; do
  python3 -m py_compile "$python_file"
done < <(git ls-files '*.py')
node --check public/assets/app.js
node --check public/assets/fx.js

# Workspace gates (F01/F02): clean environment must run `npm ci` first.
if [[ ! -d node_modules ]]; then
  echo "node_modules is missing; run npm ci before verification." >&2
  exit 1
fi
npm run lint
npm run lint:contract
npm run gen:api:check
npm run typecheck
npm run build:workspaces

required_files=(
  NOTICE.md
  third_party/animejs-LICENSE
  third_party/awesome-gpt-image-2-LICENSE
  public/index.html
  public/data/catalog.json
  public/data/stats.json
  public/data/prompts/case-532.txt
  public/data/prompts/framework-001.txt
  public/assets/app.js
  public/assets/fx.js
  public/assets/styles.css
  public/assets/vendor/anime.esm.min.js
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    printf 'Required file is missing or empty: %s\n' "$required_file" >&2
    exit 1
  fi
done

server_pid=""
server_log="$(mktemp)"
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$server_log"
}
trap cleanup EXIT

port="$(
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"

python3 scripts/serve.py --host 127.0.0.1 --port "$port" >"$server_log" 2>&1 &
server_pid=$!

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    cat "$server_log" >&2
    exit 1
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:$port/" | grep -F "OnePic Template Studio" >/dev/null
curl -fsS "http://127.0.0.1:$port/data/catalog.json" | grep -F '"total":576' >/dev/null
curl -fsS "http://127.0.0.1:$port/data/prompts/case-532.txt" | grep -F "[System / Prompt]" >/dev/null
curl -fsS "http://127.0.0.1:$port/assets/app.js" | grep -F 'fetch("data/catalog.json")' >/dev/null
curl -fsS "http://127.0.0.1:$port/previews/case-1.webp" >/dev/null

echo "Repository verification passed."
