#!/usr/bin/env bash
set -euo pipefail

out="$1"
marketplace="${2:-}"
mkdir -p "$out"

for dir in grafts/*/; do
  [ -f "${dir}graft.json" ] || continue
  id=$(node -p "require('./${dir}graft.json').id")
  version=$(node -p "require('./${dir}graft.json').version")
  if [ -n "$marketplace" ] && curl -fsS "$marketplace/grafts/$id/index.json" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).versions.some(v=>v.version===process.argv[1])?0:1))" "$version"; then
    echo "$id $version is already published; bump its version to publish changes"
    continue
  fi
  pnpm --dir "$dir" run --if-present prebuild
  node packages/graft-sdk/bin/graft.mjs doctor "$dir"
  node packages/graft-sdk/bin/graft.mjs pack "$dir" --output "$out/$id-$version.graft"
done
