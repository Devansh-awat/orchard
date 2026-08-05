export const SANDBOX_BOOTSTRAP_SCRIPT = `#!/bin/bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \\
    openssh-server git curl ca-certificates sudo procps e2fsprogs util-linux \\
    build-essential python3 ripgrep jq unzip locales openssl >/dev/null
fi

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
command -v codex >/dev/null 2>&1 || npm install -g @openai/codex >/dev/null 2>&1
command -v opencode >/dev/null 2>&1 || npm install -g opencode-ai >/dev/null 2>&1

if [ "\${SANDBOX_HOME_MODE:-filesystem}" = "block" ] && [ -b /dev/sandboxhome ]; then
  if ! blkid /dev/sandboxhome >/dev/null 2>&1; then
    mkfs.ext4 -q -F -E lazy_itable_init=1,nodiscard /dev/sandboxhome
  fi
  mkdir -p /persist
  mountpoint -q /persist || mount /dev/sandboxhome /persist
fi
mkdir -p /persist/home /persist/hostkeys

if ! id dev >/dev/null 2>&1; then
  useradd -u 1000 -d /persist/home -s /bin/bash dev 2>/dev/null || useradd -d /persist/home -s /bin/bash dev
fi
usermod -d /persist/home dev >/dev/null 2>&1 || true
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
chmod 440 /etc/sudoers.d/dev

if [ ! -e /persist/home/.profile ]; then
  cp -a /etc/skel/. /persist/home/ 2>/dev/null || true
fi
chown -R dev:dev /persist/home

if [ ! -f /persist/hostkeys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -N '' -t ed25519 -f /persist/hostkeys/ssh_host_ed25519_key
fi
if [ ! -f /persist/hostkeys/ssh_host_rsa_key ]; then
  ssh-keygen -q -N '' -t rsa -b 3072 -f /persist/hostkeys/ssh_host_rsa_key
fi

cat > /etc/ssh/sshd_config.d/zz-orchard.conf <<'SSHDCONF'
Port 22
HostKey /persist/hostkeys/ssh_host_ed25519_key
HostKey /persist/hostkeys/ssh_host_rsa_key
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers dev
AuthorizedKeysFile /etc/ssh/authorized_keys.d/authorized_keys
ClientAliveInterval 30
ClientAliveCountMax 3
PrintMotd no
AcceptEnv LANG LC_*
SSHDCONF

if [ -n "\${GIT_TOKEN:-}" ]; then
  printf 'https://x-access-token:%s@github.com\\n' "\$GIT_TOKEN" > /persist/home/.git-credentials
  chown dev:dev /persist/home/.git-credentials
  chmod 600 /persist/home/.git-credentials
  su dev -c 'git config --global credential.helper store'
fi

if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "\${OPENAI_API_KEY:-}" ]; then
  : > /etc/profile.d/sandbox-agents.sh
  if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q\\n' "\$CLAUDE_CODE_OAUTH_TOKEN" >> /etc/profile.d/sandbox-agents.sh
  fi
  if [ -n "\${OPENAI_API_KEY:-}" ]; then
    printf 'export OPENAI_API_KEY=%q\\n' "\$OPENAI_API_KEY" >> /etc/profile.d/sandbox-agents.sh
  fi
  chmod 644 /etc/profile.d/sandbox-agents.sh
fi

if [ -n "\${SANDBOX_REPO_URL:-}" ]; then
  repo_dir="/persist/home/\$(basename "\${SANDBOX_REPO_URL%.git}")"
  if [ ! -d "\$repo_dir" ]; then
    su dev -c "git clone '\$SANDBOX_REPO_URL' '\$repo_dir' >> /persist/home/.clone.log 2>&1" &
  fi
fi

if [ -s /orchard-init/setup.sh ] && [ ! -f /persist/.setup-done ]; then
  (
    su dev -c 'bash /orchard-init/setup.sh' > /persist/home/.setup.log 2>&1
    status=\$?
    if [ "\$status" -eq 0 ]; then
      touch /persist/.setup-done
      echo "[setup] completed" >> /persist/home/.setup.log
    else
      echo "[setup] exited with status \$status" >> /persist/home/.setup.log
    fi
  ) &
fi

mkdir -p /persist/home/.config/opencode /persist/home/.local/share/opencode
ln -sfn /orchard-init/opencode-config.json /persist/home/.config/opencode/opencode.json
ln -sfn /orchard-init/opencode-auth.json /persist/home/.local/share/opencode/auth.json
chown -R dev:dev /persist/home/.config /persist/home/.local
if command -v opencode >/dev/null 2>&1; then
  su - dev -c 'nohup opencode serve --hostname 0.0.0.0 --port 4096 >> /persist/home/.opencode-serve.log 2>&1 &'
fi

mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
`;
