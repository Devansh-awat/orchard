# syntax=docker/dockerfile:1
# Build this Dockerfile from the project root directory, not from apps/server/
# Example: docker build -f apps/server/Dockerfile -t server .
# The build context must be the root to access pnpm-workspace.yaml and other root files
#
# Requires BuildKit (default on Docker 23+ / Docker Desktop). If your `docker build`
# fails to parse `--mount=type=cache`, run with `DOCKER_BUILDKIT=1 docker build ...`
# or install buildx.

# orchardctl, the host commands. Built here rather than shipped as shell so it
# can grow: one binary, one command registry, and no yq gymnastics for the
# values file. Both architectures, because the host picks the one that matches
# it out of the image.
FROM golang:1.26-bookworm AS hostctl
WORKDIR /src
COPY apps/server/hostctl/go.mod apps/server/hostctl/go.sum ./
RUN go mod download
COPY apps/server/hostctl ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/orchardctl-linux-amd64 . \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/orchardctl-linux-arm64 .

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
COPY apps/server/package.json ./apps/server/

# Use BuildKit cache mount for pnpm store to speed up rebuilds
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules

# Copy source files
COPY apps/server ./apps/server
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

WORKDIR /app/apps/server
RUN pnpm prisma:generate
RUN pnpm build

FROM base AS runner
LABEL org.opencontainers.image.source="https://github.com/hackclub/orchard"
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
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/prisma ./apps/server/prisma

# Use cache mount for faster production dependency installs
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter server

WORKDIR /app/apps/server
RUN pnpm dlx prisma@6.18.0 generate

# Host commands for self-hosted installs. They live in the image so that
# `orchardctl update` can refresh them from whatever release it just deployed,
# instead of drifting until someone re-runs the installer. Kept under
# apps/server so a change to them counts as a server change: release-please
# only cuts releases per package, and images only publish on a release, so
# anywhere else they would never reach a published image.
COPY apps/server/hostbin /app/hostbin
COPY --from=hostctl /out/orchardctl-linux-amd64 /out/orchardctl-linux-arm64 /app/hostbin/
COPY LICENSE apps/server/THIRD_PARTY_NOTICES.txt /app/

COPY apps/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

