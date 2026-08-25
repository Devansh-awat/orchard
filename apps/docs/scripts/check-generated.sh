#!/usr/bin/env bash
# Fails if the generated reference is out of date with the code it comes from.
# Same trick the openapi contract already uses: regenerate, then diff.
set -euo pipefail

cd "$(dirname "$0")/.."

pnpm generate

if ! git diff --quiet -- src/content/docs/reference openapi.generated.json; then
  echo
  echo "Generated docs are stale. Run 'pnpm --filter docs generate' and commit the result."
  echo
  git diff --stat -- src/content/docs/reference openapi.generated.json
  exit 1
fi

echo "Generated docs are up to date."
