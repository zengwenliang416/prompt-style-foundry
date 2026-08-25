#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

artifact="${1:-.tmp/onepic-template-studio.tar.gz}"
if [[ "$artifact" != /* ]]; then
  artifact="$ROOT/$artifact"
fi

required_commands=(curl scp ssh)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

required_variables=(
  DEPLOY_HOST
  DEPLOY_PORT
  DEPLOY_USER
  DEPLOY_ROOT
  DEPLOY_DOMAIN
  DEPLOY_SSH_PRIVATE_KEY
  DEPLOY_SSH_KNOWN_HOSTS
)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    printf 'Required environment variable is empty: %s\n' "$variable_name" >&2
    exit 1
  fi
done

if [[ ! -s "$artifact" ]]; then
  bash scripts/package-site.sh "$artifact"
fi

commit_sha="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
short_sha="${commit_sha:0:12}"
pipeline_number="${CI_PIPELINE_NUMBER:-manual}"
release_id="onepic-${short_sha}-${pipeline_number}"
remote_stage="/tmp/${release_id}"
ssh_target="${DEPLOY_USER}@${DEPLOY_HOST}"

temporary="$(mktemp -d)"
cleanup() {
  ssh -F /dev/null \
    -i "$temporary/id_ed25519" \
    -p "$DEPLOY_PORT" \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$temporary/known_hosts" \
    "$ssh_target" \
    "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT

printf '%s\n' "$DEPLOY_SSH_PRIVATE_KEY" >"$temporary/id_ed25519"
printf '%s\n' "$DEPLOY_SSH_KNOWN_HOSTS" >"$temporary/known_hosts"
chmod 0600 "$temporary/id_ed25519" "$temporary/known_hosts"

ssh_options=(
  -F /dev/null
  -i "$temporary/id_ed25519"
  -p "$DEPLOY_PORT"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$temporary/known_hosts"
)

scp_options=(
  -F /dev/null
  -i "$temporary/id_ed25519"
  -P "$DEPLOY_PORT"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$temporary/known_hosts"
)

if command -v sha256sum >/dev/null 2>&1; then
  artifact_sha="$(sha256sum "$artifact" | awk '{print $1}')"
else
  artifact_sha="$(shasum -a 256 "$artifact" | awk '{print $1}')"
fi

ssh "${ssh_options[@]}" "$ssh_target" "install -d -m 0700 '$remote_stage'"
scp "${scp_options[@]}" \
  "$artifact" \
  ops/woodpecker/remote-deploy.sh \
  "$ssh_target:$remote_stage/"

ssh "${ssh_options[@]}" "$ssh_target" \
  "bash '$remote_stage/remote-deploy.sh' \
    '$remote_stage/$(basename "$artifact")' \
    '$artifact_sha' \
    '$DEPLOY_ROOT' \
    '$DEPLOY_DOMAIN' \
    '$release_id' \
    '$commit_sha' \
    '5'"

curl --fail --silent --show-error --location \
  --retry 6 \
  --retry-all-errors \
  --retry-delay 3 \
  "https://$DEPLOY_DOMAIN/" \
  | grep -F "OnePic Template Studio" >/dev/null

curl --fail --silent --show-error \
  --retry 6 \
  --retry-all-errors \
  --retry-delay 3 \
  "https://$DEPLOY_DOMAIN/data/catalog.json" \
  | grep -F '"total":576' >/dev/null

printf 'Deployed https://%s from %s\n' "$DEPLOY_DOMAIN" "$commit_sha"
