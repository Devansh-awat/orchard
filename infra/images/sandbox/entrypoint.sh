#!/bin/bash
set -euo pipefail

if [ "${SANDBOX_HOME_MODE:-block}" = "block" ]; then
  if ! blkid /dev/sandboxhome >/dev/null 2>&1; then
    mkfs.ext4 -q -F -E lazy_itable_init=1,nodiscard /dev/sandboxhome
  fi
  mkdir -p /persist
  mount /dev/sandboxhome /persist
  mkdir -p /persist/home
  mount --bind /persist/home /home/dev
fi

mkdir -p /persist/hostkeys /run/sshd
ln -sfn /persist/hostkeys /etc/ssh/hostkeys
if [ -z "$(ls -A /persist/hostkeys)" ]; then
  ssh-keygen -A
  mv /etc/ssh/ssh_host_* /persist/hostkeys/
fi

if [ -z "$(ls -A /home/dev)" ]; then
  cp -a /etc/skel-dev/. /home/dev/
  chown -R dev:dev /home/dev
fi

if [ -n "${GIT_TOKEN:-}" ]; then
  printf 'https://x-access-token:%s@github.com\n' "$GIT_TOKEN" > /home/dev/.git-credentials
  chown dev:dev /home/dev/.git-credentials
  chmod 600 /home/dev/.git-credentials
  su dev -c 'git config --global credential.helper store'
fi

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
  : > /etc/profile.d/sandbox-agents.sh
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q\n' "$CLAUDE_CODE_OAUTH_TOKEN" >> /etc/profile.d/sandbox-agents.sh
  fi
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    printf 'export OPENAI_API_KEY=%q\n' "$OPENAI_API_KEY" >> /etc/profile.d/sandbox-agents.sh
  fi
  chmod 644 /etc/profile.d/sandbox-agents.sh
fi

if [ -n "${SANDBOX_REPO_URL:-}" ]; then
  repo_dir="/home/dev/$(basename "${SANDBOX_REPO_URL%.git}")"
  if [ ! -d "$repo_dir" ]; then
    su dev -c "git clone '$SANDBOX_REPO_URL' '$repo_dir' >> /home/dev/.clone.log 2>&1" &
  fi
fi

exec /usr/sbin/sshd -D -e
