#!/bin/sh
set -e

echo "[entrypoint] running prisma migrate deploy"
pnpm dlx prisma@6.18.0 migrate deploy

echo "[entrypoint] starting server"
exec node dist/main
