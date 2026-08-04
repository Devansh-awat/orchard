FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server git curl ca-certificates build-essential python3 \
      sudo tini ripgrep jq unzip locales e2fsprogs \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssh/ssh_host_*

RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN npm install -g @anthropic-ai/claude-code @openai/codex

RUN userdel -r ubuntu \
    && useradd -m -u 1000 -s /bin/bash dev \
    && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

RUN cp -a /etc/skel /etc/skel-dev \
    && mkdir -p /run/sshd /etc/ssh/authorized_keys.d

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
