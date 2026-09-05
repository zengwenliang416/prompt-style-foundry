#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 7 ]]; then
  echo "Usage: remote-deploy.sh ARTIFACT SHA256 DEPLOY_ROOT DOMAIN RELEASE_ID COMMIT_SHA KEEP_RELEASES" >&2
  exit 2
fi

artifact="$1"
expected_sha="$2"
deploy_root="$3"
domain="$4"
release_id="$5"
commit_sha="$6"
keep_releases="$7"

if [[ "$deploy_root" != /var/www/* ]]; then
  echo "DEPLOY_ROOT must be under /var/www." >&2
  exit 1
fi
if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Invalid deployment domain." >&2
  exit 1
fi
if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid release ID." >&2
  exit 1
fi
if [[ ! "$commit_sha" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
  echo "Invalid commit SHA." >&2
  exit 1
fi
if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid artifact checksum." >&2
  exit 1
fi
if [[ ! "$keep_releases" =~ ^[1-9][0-9]*$ ]]; then
  echo "KEEP_RELEASES must be a positive integer." >&2
  exit 1
fi

for command_name in curl find nginx sha256sum tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "Artifact checksum mismatch." >&2
  exit 1
fi

while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..)
      printf 'Unsafe archive path: %s\n' "$entry" >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "$artifact")

releases_dir="$deploy_root/releases"
state_dir="$deploy_root/state"
release_dir="$releases_dir/$release_id"
temporary_release="${release_dir}.tmp"
previous_release="$(readlink -f "$deploy_root/current" 2>/dev/null || true)"

install -d -m 0755 "$deploy_root" "$releases_dir"
install -d -m 0750 "$state_dir"
rm -rf "$temporary_release"
install -d -m 0755 "$temporary_release"

cleanup() {
  rm -rf "$temporary_release"
}
trap cleanup EXIT

tar -xzf "$artifact" -C "$temporary_release" --no-same-owner

required_files=(
  index.html
  data/catalog.json
  data/stats.json
  data/prompts/case-532.txt
  data/prompts/framework-001.txt
  assets/app.js
  assets/fx.js
  assets/styles.css
  assets/vendor/anime.esm.min.js
)
for required_file in "${required_files[@]}"; do
  if [[ ! -s "$temporary_release/$required_file" ]]; then
    printf 'Release is missing required file: %s\n' "$required_file" >&2
    exit 1
  fi
done

prompt_count="$(find "$temporary_release/data/prompts" -maxdepth 1 -type f -name '*.txt' | wc -l)"
preview_count="$(find "$temporary_release/previews" -maxdepth 1 -type f -name '*.webp' | wc -l)"
expected_preview_count="$(
  grep -oE '"(preview|generatedPreview)":"previews/[^"]+"' \
    "$temporary_release/data/catalog.json" \
    | sed -E 's/^"[^"]+":"([^"]+)"$/\1/' \
    | sort -u \
    | wc -l
)"
if [[ "$prompt_count" -ne 576 ]]; then
  printf 'Expected 576 prompt files, found %s.\n' "$prompt_count" >&2
  exit 1
fi
if [[ "$preview_count" -ne "$expected_preview_count" ]]; then
  printf 'Expected %s preview files from catalog, found %s.\n' \
    "$expected_preview_count" "$preview_count" >&2
  exit 1
fi
if find "$temporary_release" -type f \( -name '._*' -o -name '.DS_Store' \) -print -quit | grep -q .; then
  echo "Release contains macOS metadata." >&2
  exit 1
fi

find "$temporary_release" -type d -exec chmod 0755 {} +
find "$temporary_release" -type f -exec chmod 0644 {} +
chown -R root:www-data "$temporary_release"

nginx -t
rm -rf "$release_dir"
mv "$temporary_release" "$release_dir"
trap - EXIT

ln -sfn "$release_dir" "$deploy_root/current.next"
mv -Tf "$deploy_root/current.next" "$deploy_root/current"
chown -h root:www-data "$deploy_root/current"

status_code="$(
  curl --silent --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --header "Host: $domain" \
    http://127.0.0.1/
)"
case "$status_code" in
  200|301|302|307|308)
    ;;
  *)
    if [[ -n "$previous_release" && -d "$previous_release" ]]; then
      ln -sfn "$previous_release" "$deploy_root/current.next"
      mv -Tf "$deploy_root/current.next" "$deploy_root/current"
    fi
    printf 'Local Nginx health check failed with HTTP %s.\n' "$status_code" >&2
    exit 1
    ;;
esac

deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$state_dir/current-release.json" <<EOF
{
  "releaseId": "$release_id",
  "commit": "$commit_sha",
  "artifactSha256": "$expected_sha",
  "deployedAt": "$deployed_at",
  "domain": "$domain"
}
EOF
chmod 0640 "$state_dir/current-release.json"
chown root:www-data "$state_dir/current-release.json"

current_release="$(readlink -f "$deploy_root/current")"
find "$releases_dir" -mindepth 1 -maxdepth 1 -type d ! -name '*.tmp' -printf '%T@ %p\n' \
  | sort -rn \
  | awk -v keep="$keep_releases" -v current="$current_release" '
      $2 == current { next }
      { count += 1 }
      count >= keep { print $2 }
    ' \
  | xargs -r rm -rf

printf 'Activated release %s for %s\n' "$release_id" "$domain"
