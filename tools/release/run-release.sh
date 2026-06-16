#!/usr/bin/env bash
set -euo pipefail

REPO="${RELEASE_REPO:-LeafdTK/leaf}"
RP="release-please@16"

git fetch --tags --force --quiet || true

latest() { git tag --list "$1/v*" | sed "s#$1/v##" | sort -V | tail -1; }

pre_server=$(latest server);   pre_frontend=$(latest frontend)
pre_gateway=$(latest gateway); pre_cli=$(latest cli)
pre_r2proxy=$(latest r2-proxy)

if [ -n "${GITHUB_TOKEN:-}" ]; then
  npx --yes "$RP" release-pr --token="$GITHUB_TOKEN" --repo-url="$REPO" --target-branch=main || true
  npx --yes "$RP" github-release --token="$GITHUB_TOKEN" --repo-url="$REPO" --target-branch=main || true
  git fetch --tags --force --quiet || true
else
  echo "::notice::GITHUB_TOKEN not set; reporting current versions only" >&2
fi

server=$(latest server);   frontend=$(latest frontend)
gateway=$(latest gateway); cli=$(latest cli)
r2proxy=$(latest r2-proxy)

moved() { [ "$1" != "$2" ] && echo true || echo false; }
rel_server=$(moved "$pre_server" "$server")
rel_frontend=$(moved "$pre_frontend" "$frontend")
rel_gateway=$(moved "$pre_gateway" "$gateway")
rel_cli=$(moved "$pre_cli" "$cli")
rel_r2proxy=$(moved "$pre_r2proxy" "$r2proxy")

released=false
for f in "$rel_server" "$rel_frontend" "$rel_gateway" "$rel_cli" "$rel_r2proxy"; do
  [ "$f" = "true" ] && released=true
done

umbrella=$(printf '%s\n' \
  "${server:-0.0.0}" "${frontend:-0.0.0}" "${gateway:-0.0.0}" \
  "${cli:-0.0.0}" "${r2proxy:-0.0.0}" | sort -V | tail -1)

versions=$(cat <<JSON
{"server":"${server:-0.0.0}","frontend":"${frontend:-0.0.0}","gateway":"${gateway:-0.0.0}","cli":"${cli:-0.0.0}","r2-proxy":"${r2proxy:-0.0.0}","mcp":"${server:-0.0.0}","umbrella":"${umbrella:-0.0.0}","channel":"stable","released":$released,"released_server":$rel_server,"released_frontend":$rel_frontend,"released_gateway":$rel_gateway,"released_cli":$rel_cli,"released_mcp":$rel_server,"released_r2-proxy":$rel_r2proxy}
JSON
)
versions=$(echo "$versions" | tr -d '\n')

echo "released=$released"
echo "$versions"
echo "$versions" > versions.json
