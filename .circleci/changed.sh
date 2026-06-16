#!/usr/bin/env bash
set -euo pipefail

out="${1:-/tmp/pipeline-params.json}"
branch="${CIRCLE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

frontend=false server=false gateway=false cli=false r2_proxy=false chart=false

mark_all() { frontend=true; server=true; gateway=true; cli=true; r2_proxy=true; chart=true; }

case "$branch" in
  main|beta|alpha|rc|*.x) mark_all ;;
  *)
    git fetch origin main --quiet || true
    base="$(git merge-base origin/main HEAD 2>/dev/null || true)"
    if [ -z "$base" ]; then
      mark_all
    else
      files="$(git diff --name-only "$base"...HEAD)"
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        case "$f" in
          pnpm-lock.yaml|pnpm-workspace.yaml|package.json|commitlint.config.cjs) mark_all ;;
          release-please-config.json|.release-please-manifest.json) mark_all ;;
          .circleci/*|tools/release/*) mark_all ;;
          frontend/*) frontend=true ;;
          server/*)   server=true ;;
          gateway/*)  gateway=true ;;
          cli/*)      cli=true ;;
          r2-proxy/*) r2_proxy=true ;;
          charts/*)   chart=true ;;
        esac
      done <<< "$files"
    fi
    ;;
esac

cat > "$out" <<JSON
{
  "frontend_changed": $frontend,
  "server_changed": $server,
  "gateway_changed": $gateway,
  "cli_changed": $cli,
  "r2_proxy_changed": $r2_proxy,
  "chart_changed": $chart
}
JSON

echo "Changed components for '$branch':"
cat "$out"
