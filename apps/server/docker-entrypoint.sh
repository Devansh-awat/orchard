#!/bin/sh
set -e

echo "[entrypoint] ensuring platform db network policies"
node dist/scripts/ensure-platform-db-policies.js || echo "[entrypoint] platform db policy ensure failed (continuing)"

echo "[entrypoint] running prisma migrate deploy"
pnpm dlx prisma@6.18.0 migrate deploy

echo "[entrypoint] starting server"
exec node dist/main
