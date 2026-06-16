#!/usr/bin/env bash
set -euo pipefail

pnpm --filter frontend exec prettier --write . >/dev/null

if git diff --quiet; then
  echo "Frontend already formatted."
  exit 0
fi

echo "Prettier reformatted:"
git --no-pager diff --stat

if ! pnpm --filter frontend exec prettier --check . >/dev/null 2>&1; then
  echo "Prettier output failed re-validation — refusing to commit corrupting changes." >&2
  echo "A source file likely uses a pattern the svelte plugin mangles (e.g. a" >&2
  echo "single-quoted attribute containing both a \" and an {interpolation}). Fix the source." >&2
  git checkout -- .
  exit 1
fi

if [ -z "${LEAFDBOT_PRIVATE_KEY_B64:-}${LEAFDBOT_PRIVATE_KEY:-}" ] || [ -z "${CIRCLE_BRANCH:-}" ]; then
  echo "leafdbot private key / branch unavailable — cannot self-commit." >&2
  echo "Run 'pnpm --filter frontend lint' locally and commit the formatting." >&2
  exit 1
fi

TOKEN="$(bash .circleci/gh-app-token.sh)"
git config user.name "leafdbot[bot]"
git config user.email "192038741+leafdbot[bot]@users.noreply.github.com"
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/LeafdTK/leaf.git"
git add -A
git commit -m "chore(ci): apply linter fixes" \
  -m "Co-authored-by: leafdbot[bot] <192038741+leafdbot[bot]@users.noreply.github.com>"
git push origin "HEAD:${CIRCLE_BRANCH}"
echo "Pushed formatting fixes to ${CIRCLE_BRANCH} as leafdbot[bot]."
