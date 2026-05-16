# syntax=docker/dockerfile:1
# Build this Dockerfile from the project root directory, not from server/
# Example: docker build -f server/Dockerfile -t server .
# The build context must be the root to access pnpm-workspace.yaml and other root files
#
# Requires BuildKit (default on Docker 23+ / Docker Desktop). If your `docker build`
# fails to parse `--mount=type=cache`, run with `DOCKER_BUILDKIT=1 docker build ...`
# or install buildx.

FROM node:22-bookworm-slim AS base

# Disable apt's auto-cleanup so BuildKit cache mounts keep .deb files between builds.
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

# Install OpenSSL for Prisma (fixes libssl detection warnings)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates

RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app

# Copy only package files first for better layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json ./server/

# Use BuildKit cache mount for pnpm store to speed up rebuilds
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules

# Copy source files
COPY server ./server
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

WORKDIR /app/server
RUN pnpm prisma:generate
RUN pnpm build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NO_PROXY=178.156.144.127,harbor.1mp.dev,harbor-core.harbor.svc.cluster.local,localhost,127.0.0.1
ENV no_proxy=178.156.144.127,harbor.1mp.dev,harbor-core.harbor.svc.cluster.local,localhost,127.0.0.1

# Install Docker CLI for building images via mounted Docker socket
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        gnupg \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma

# Use cache mount for faster production dependency installs
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter server

WORKDIR /app/server
RUN pnpm dlx prisma@6.18.0 generate

COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

