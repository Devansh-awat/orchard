# syntax=docker/dockerfile:1
# Build from the project root: docker build -f apps/frontend/Dockerfile -t orchard-frontend .
# Requires BuildKit (default on Docker 23+ / Docker Desktop). Otherwise:
#   DOCKER_BUILDKIT=1 docker build -f apps/frontend/Dockerfile -t orchard-frontend .

FROM node:22-alpine AS base

RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/frontend/package.json ./apps/frontend/
# Cache the pnpm store across builds (massive speedup on dep changes).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY . .

WORKDIR /app/apps/frontend
# Cache Vite's transform output between builds. Persists across CI runs via
# the registry-backed cache (Vite/Rollup re-uses .vite/deps and friends).
RUN --mount=type=cache,id=vite,target=/app/apps/frontend/node_modules/.vite \
    --mount=type=cache,id=svelte-kit,target=/app/apps/frontend/.svelte-kit \
    pnpm build

FROM base AS runner
LABEL org.opencontainers.image.source="https://github.com/hackclub/orchard"
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/frontend/package.json ./apps/frontend/package.json
COPY --from=builder /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=builder /app/apps/frontend/build ./apps/frontend/build
COPY LICENSE ./LICENSE

EXPOSE 3000

WORKDIR /app/apps/frontend/build
CMD ["node", "index.js"]

