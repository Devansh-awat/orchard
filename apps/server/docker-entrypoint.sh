#!/bin/sh
set -e

echo "[entrypoint] ensuring platform db network policies"
node dist/scripts/ensure-platform-db-policies.js || echo "[entrypoint] platform db policy ensure failed (continuing)"

echo "[entrypoint] running prisma migrate deploy"
node_modules/.bin/prisma migrate deploy

echo "[entrypoint] starting server"
exec node dist/main
