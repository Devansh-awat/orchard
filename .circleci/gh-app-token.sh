#!/usr/bin/env bash
set -euo pipefail

# Mints a short-lived GitHub App installation token for leafdbot and prints it.
# Needs: LEAFDBOT_PRIVATE_KEY_B64 (base64 of the app PEM) or LEAFDBOT_PRIVATE_KEY
# (raw PEM). Optional first arg = owner/repo. The leafdbot App ID is a constant
# (192038741 is the bot USER id used in the commit email, NOT the App ID).

app_id="${LEAFDBOT_APP_ID:-1090304}"
repo="${1:-LeafdTK/leaf}"
api="https://api.github.com"

key_file="$(mktemp)"
trap 'rm -f "$key_file"' EXIT
if [ -n "${LEAFDBOT_PRIVATE_KEY_B64:-}" ]; then
  printf '%s' "$LEAFDBOT_PRIVATE_KEY_B64" | base64 -d > "$key_file"
elif [ -n "${LEAFDBOT_PRIVATE_KEY:-}" ]; then
  printf '%s' "$LEAFDBOT_PRIVATE_KEY" > "$key_file"
else
  echo "set LEAFDBOT_PRIVATE_KEY_B64 (base64 PEM) or LEAFDBOT_PRIVATE_KEY" >&2
  exit 1
fi

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$app_id" | b64url)"
sig="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$key_file" -binary | b64url)"
jwt="$header.$payload.$sig"

inst_id="$(curl -sf -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  "$api/repos/$repo/installation" | jq -r '.id')"
curl -sf -X POST -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  "$api/app/installations/$inst_id/access_tokens" | jq -r '.token'
