#!/usr/bin/env bash
# One-time: seed baseline tags at the current commit so knope has a starting
# point to compute deltas from. Edit the versions below first if you want a
# different starting line, then run on `main` and `git push --tags`.
set -euo pipefail

# name:version pairs (portable — no bash-4 associative arrays).
BASE="
server:1.0.0
frontend:0.0.1
gateway:0.1.0
cli:0.1.0
r2-proxy:0.1.0
orchard:0.6.0
"

for pair in $BASE; do
  tag="${pair%%:*}/v${pair##*:}"
  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "exists  $tag"
  else
    git tag "$tag" && echo "created $tag"
  fi
done

echo
echo "Done. Push them with:  git push --tags"
