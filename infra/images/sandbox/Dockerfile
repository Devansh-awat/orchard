FROM golang:1.26-bookworm AS cli
WORKDIR /src
COPY apps/cli/go.mod apps/cli/go.sum ./
RUN go mod download
COPY apps/cli/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/orchard .

FROM node:22.23.4-bookworm-slim AS node

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server git curl ca-certificates build-essential python3 sudo \
      ripgrep jq unzip locales e2fsprogs tmux iproute2 procps util-linux \
      ncurses-bin tar gzip openssl rsync \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssh/ssh_host_*

RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN npm install -g \
    npm@latest \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
      @zed-industries/claude-agent-acp@0.23.1 \
      @zed-industries/codex-acp@0.16.0 \
    && npm cache clean --force

RUN curl -fsSL https://fx.sh/setup.sh | FX_INSTALL_DIR=/usr/local/bin bash

COPY --from=cli /out/orchard /usr/local/bin/orchard

RUN userdel -r ubuntu 2>/dev/null || true

EXPOSE 22 4096 4097

CMD ["/bin/bash", "/orchard-init/bootstrap.sh"]
