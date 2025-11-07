# Build this Dockerfile from the project root directory, not from server/
# Example: docker build -f server/Dockerfile -t server .
# The build context must be the root to access pnpm-workspace.yaml and other root files
# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS base

# Install OpenSSL for Prisma (fixes libssl detection warnings)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Install Railpack CLI
RUN curl -fsSL https://railway.app/install.sh | sh

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma

# Use cache mount for faster production dependency installs
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter server

WORKDIR /app/server
RUN pnpm dlx prisma@6.18.0 generate

EXPOSE 3001

CMD ["node", "dist/main"]

