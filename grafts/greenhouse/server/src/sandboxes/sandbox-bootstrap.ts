import {
  ORCHARD_ENV_INIT_FILE,
  ORCHARD_ENV_PROFILE,
  ORCHARD_ENV_SYNC_FUNCTION
} from './links/sandbox-env-files';

export const SANDBOX_PHASES = [
  'starting',
  'packages',
  'runtime',
  'agents',
  'storage',
  'account',
  'services',
  'ready'
] as const;

export const SANDBOX_PHASE_FILE = '/tmp/orchard-boot-phase';

export const SANDBOX_DRIVE_MARKER = '.orchard-drive';

export const SANDBOX_BRIDGE_CLI_VERSION = '0.23.0';

const BRIDGE_RELEASES = 'https://github.com/LeafdTK/orchard-releases/releases/download';

export type BridgeArch = 'amd64' | 'arm64';

export function bridgeArchiveName(
  version: string = SANDBOX_BRIDGE_CLI_VERSION,
  arch: BridgeArch = 'amd64'
): string {
  return `orchard_${version}_linux_${arch}.tar.gz`;
}

export function defaultBridgeBinaryUrl(
  version: string = SANDBOX_BRIDGE_CLI_VERSION,
  arch: BridgeArch = 'amd64'
): string {
  return `${BRIDGE_RELEASES}/v${version}/${bridgeArchiveName(version, arch)}`;
}

export function bridgeChecksumsUrl(version: string = SANDBOX_BRIDGE_CLI_VERSION): string {
  return `${BRIDGE_RELEASES}/v${version}/checksums.txt`;
}

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function checksumFor(checksums: string, file: string): string | null {
  for (const raw of checksums.split('\n')) {
    const match = raw.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (match && match[2] === file) return match[1].toLowerCase();
  }
  return null;
}

export const OPENCODE_PASSWORD_SYNC_FUNCTION = `opencode_password_sync() {
  oc_env=/persist/home/.config/opencode/server.env
  oc_pw=$(cat)
  if [ -z "$oc_pw" ]; then
    rm -f "$oc_env"
    return 0
  fi
  oc_line=$(printf 'export OPENCODE_SERVER_PASSWORD=%q' "$oc_pw")
  if [ -f "$oc_env" ] && [ "$(cat "$oc_env")" = "$oc_line" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$oc_env")"
  (umask 077 && printf '%s\\n' "$oc_line" > "$oc_env.tmp") && mv -f "$oc_env.tmp" "$oc_env"
  chown dev:dev "$oc_env" 2>/dev/null || true
  chmod 600 "$oc_env"
  if pgrep -f '[o]pencode serve' >/dev/null 2>&1; then
    pkill -f '[o]pencode serve' >/dev/null 2>&1 || true
    for oc_wait in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -f '[o]pencode serve' >/dev/null 2>&1 || break
      sleep 0.5
    done
    pkill -9 -f '[o]pencode serve' >/dev/null 2>&1 || true
  fi
}

opencode_start() {
  if command -v opencode >/dev/null 2>&1 && ! pgrep -f '[o]pencode serve' >/dev/null 2>&1; then
    su - dev -c '[ -f ~/.config/opencode/server.env ] && . ~/.config/opencode/server.env; OPENCODE_EXPERIMENTAL_PLAN_MODE=1 nohup opencode "serve" --hostname 0.0.0.0 --port 4096 >> /persist/home/.opencode-serve.log 2>&1 &'
  fi
}`;

export const OPENCODE_PASSWORD_ROTATE_SCRIPT = `${OPENCODE_PASSWORD_SYNC_FUNCTION}
opencode_password_sync
opencode_start
`;

export const SANDBOX_BOOTSTRAP_SCRIPT = `#!/bin/bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

phase() { printf '%s' "$1" > ${SANDBOX_PHASE_FILE}; }
log() { printf '[bootstrap] %s\\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1 || [ -x "/usr/sbin/$1" ] || [ -x "/sbin/$1" ]; }
phase starting

if [ -n "\${ORCHARD_INIT_STAGE:-}" ] && [ -d "$ORCHARD_INIT_STAGE" ]; then
  mkdir -p /orchard-init
  chmod 755 /orchard-init
  for staged in "$ORCHARD_INIT_STAGE"/*; do
    [ -f "$staged" ] || continue
    name=$(basename "$staged")
    case "$name" in
      opencode-password|bridge-token|${ORCHARD_ENV_INIT_FILE}) mode=600 ;;
      *) mode=644 ;;
    esac
    install -m "$mode" "$staged" "/orchard-init/.$name.tmp" && mv -f "/orchard-init/.$name.tmp" "/orchard-init/$name"
  done
  rm -rf "$ORCHARD_INIT_STAGE"
fi

if have apt-get; then PKG=apt
elif have dnf; then PKG=dnf
elif have yum; then PKG=yum
else PKG=none
fi
APT_UPDATED=

pkg_name() {
  case "$PKG:$1" in
    apt:sshd) echo openssh-server ;;
    apt:ss) echo iproute2 ;;
    apt:pgrep) echo procps ;;
    apt:rg) echo ripgrep ;;
    apt:build) echo build-essential ;;
    apt:mountpoint) echo util-linux ;;
    apt:mkfs) echo e2fsprogs ;;
    apt:certs) echo ca-certificates ;;
    apt:infocmp) echo ncurses-bin ;;
    apt:*) echo "$1" ;;
    *:sshd) echo openssh-server ;;
    *:ss) echo iproute ;;
    *:pgrep) echo procps-ng ;;
    *:rg) echo ripgrep ;;
    *:build) echo gcc gcc-c++ make ;;
    *:mountpoint) echo util-linux ;;
    *:mkfs) echo e2fsprogs ;;
    *:certs) echo ca-certificates ;;
    *:locales) echo glibc-langpack-en ;;
    *:infocmp) echo ncurses ;;
    *) echo "$1" ;;
  esac
}

pkg_install() {
  [ "$#" -gt 0 ] || return 0
  names=""
  for wanted in "$@"; do names="$names $(pkg_name "$wanted")"; done
  case "$PKG" in
    apt)
      if [ -z "$APT_UPDATED" ]; then
        apt-get update -qq >/dev/null 2>&1
        APT_UPDATED=1
      fi
      apt-get install -y -qq --no-install-recommends $names >/dev/null 2>&1 && return 0
      for one in $names; do
        apt-get install -y -qq --no-install-recommends "$one" >/dev/null 2>&1 || log "could not install $one"
      done
      ;;
    dnf|yum)
      "$PKG" install -y -q $names >/dev/null 2>&1 && return 0
      for one in $names; do
        "$PKG" install -y -q "$one" >/dev/null 2>&1 || log "could not install $one"
      done
      ;;
    *) log "no package manager to install$names" ;;
  esac
}

missing=""
need() { have "$2" || missing="$missing $1"; }
need sshd sshd
need git git
need curl curl
need tmux tmux
need rg rg
need ss ss
need pgrep pgrep
need sudo sudo
need mountpoint mountpoint
need infocmp infocmp
need tar tar
need gzip gzip
if ! have sshd; then
  missing="$missing certs build python3 jq unzip mkfs locales openssl"
fi
if [ -n "$missing" ]; then
  phase packages
  pkg_install $missing
fi

if ! have node; then
  phase runtime
  if [ "$PKG" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
  elif [ "$PKG" != none ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    "$PKG" install -y -q nodejs >/dev/null 2>&1
  fi
fi
phase agents
if have npm; then
  have claude || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
  have codex || npm install -g @openai/codex >/dev/null 2>&1
  have opencode || npm install -g opencode-ai >/dev/null 2>&1
fi
if have npm && have claude && ! pgrep -f '[o]rchard-claude-update' >/dev/null 2>&1; then
  nohup sh -c 'while :; do npm install -g @anthropic-ai/claude-code@latest; sleep 21600; done' orchard-claude-update >> /var/log/orchard-claude-update.log 2>&1 &
fi

tmux_term=tmux-256color
if have infocmp && ! infocmp tmux-256color >/dev/null 2>&1; then
  tmux_term=screen-256color
fi
cat > /etc/tmux.conf <<TMUXCONF
set -g default-terminal "$tmux_term"
set -ga terminal-overrides ",xterm-256color:Tc"
set -ga terminal-overrides ",xterm*:smcup@:rmcup@"
set -g history-limit 50000
set -g mouse off
set -g status off
set -sg escape-time 0
TMUXCONF
chmod 644 /etc/tmux.conf

phase storage
if [ "\${SANDBOX_HOME_MODE:-filesystem}" = "block" ] && [ -b /dev/sandboxhome ]; then
  if ! blkid /dev/sandboxhome >/dev/null 2>&1; then
    mkfs.ext4 -q -F -E lazy_itable_init=1,nodiscard /dev/sandboxhome
  fi
  mkdir -p /persist
  mountpoint -q /persist || mount /dev/sandboxhome /persist
fi
persist_root="\${SANDBOX_PERSIST_ROOT:-}"
if [ -n "\${SANDBOX_DRIVE_ROOT:-}" ]; then
  drive_root="$SANDBOX_DRIVE_ROOT"
  drive_marker="$drive_root/${SANDBOX_DRIVE_MARKER}"
  if mountpoint -q "$drive_root" 2>/dev/null || grep -qs " $drive_root " /proc/mounts; then
    if [ ! -f "$drive_marker" ]; then
      if [ -n "$persist_root" ] && [ "$persist_root" != "$drive_root" ] && [ -d "$persist_root/home" ]; then
        log "copying $persist_root into the drive at $drive_root"
        if have rsync; then
          rsync -aH "$persist_root/" "$drive_root/"
        else
          cp -a "$persist_root/." "$drive_root/"
        fi
        copied=$?
        sync
        if [ "$copied" -eq 0 ]; then
          printf 'migrated %s\\n' "$persist_root" > "$drive_marker.tmp" && mv -f "$drive_marker.tmp" "$drive_marker"
        else
          log "copying $persist_root into the drive failed ($copied); keeping home in $persist_root"
        fi
      else
        printf 'fresh\\n' > "$drive_marker.tmp" && mv -f "$drive_marker.tmp" "$drive_marker"
      fi
    fi
    if [ -f "$drive_marker" ]; then
      persist_root="$drive_root"
    fi
  else
    log "no drive is mounted at $drive_root; keeping home in \${persist_root:-/persist}"
  fi
fi
if [ -n "$persist_root" ] && [ "$persist_root" != "/persist" ]; then
  mkdir -p "$persist_root"
  if [ -L /persist ] || [ ! -e /persist ]; then
    ln -sfn "$persist_root" /persist
  else
    log "/persist already exists and is not a link; leaving it alone"
  fi
fi
mkdir -p /persist/home /persist/hostkeys

phase account
if ! id dev >/dev/null 2>&1; then
  useradd -u 1000 -d /persist/home -s /bin/bash dev 2>/dev/null || useradd -d /persist/home -s /bin/bash dev
fi
usermod -d /persist/home dev >/dev/null 2>&1 || true
mkdir -p /etc/sudoers.d
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
chmod 440 /etc/sudoers.d/dev

if [ ! -e /persist/home/.profile ] && [ ! -e /persist/home/.bash_profile ] && [ ! -e /persist/home/.bashrc ]; then
  cp -a /etc/skel/. /persist/home/ 2>/dev/null || true
fi
if [ "$(stat -c %U /persist/home/. 2>/dev/null)" != "dev" ]; then
  chown -R dev:dev /persist/home
fi

if [ ! -f /persist/hostkeys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -N '' -t ed25519 -f /persist/hostkeys/ssh_host_ed25519_key
fi
if [ ! -f /persist/hostkeys/ssh_host_rsa_key ]; then
  ssh-keygen -q -N '' -t rsa -b 3072 -f /persist/hostkeys/ssh_host_rsa_key
fi
chmod 644 /persist/hostkeys/*.pub 2>/dev/null || true

mkdir -p /etc/ssh/sshd_config.d
rm -f /etc/ssh/sshd_config.d/zz-orchard.conf
cat > /etc/ssh/sshd_config.d/00-orchard.conf <<'SSHDCONF'
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
if [ ! -f /etc/ssh/sshd_config ]; then
  printf 'Include /etc/ssh/sshd_config.d/*.conf\\n' > /etc/ssh/sshd_config
elif ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config; then
  sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
fi

if ! mountpoint -q /etc/ssh/authorized_keys.d 2>/dev/null && [ -f /orchard-init/authorized_keys ]; then
  mkdir -p /etc/ssh/authorized_keys.d
  chmod 755 /etc/ssh/authorized_keys.d
  install -m 644 /orchard-init/authorized_keys /etc/ssh/authorized_keys.d/authorized_keys
fi

if [ -n "\${GIT_TOKEN:-}" ]; then
  printf 'https://x-access-token:%s@github.com\\n' "$GIT_TOKEN" > /persist/home/.git-credentials
  chown dev:dev /persist/home/.git-credentials
  chmod 600 /persist/home/.git-credentials
  su dev -c 'git config --global credential.helper store'
fi

if [ -s /orchard-init/git-identity ] && have git; then
  git_name=$(sed -n 1p /orchard-init/git-identity)
  git_email=$(sed -n 2p /orchard-init/git-identity)
  git_marker=/persist/home/.config/orchard/git-identity
  git_current=$(git config --file /persist/home/.gitconfig user.email 2>/dev/null || true)
  git_previous=$(sed -n 2p "$git_marker" 2>/dev/null || true)
  if [ -n "$git_name" ] && [ -n "$git_email" ] && { [ -z "$git_current" ] || [ "$git_current" = "$git_previous" ]; }; then
    git config --file /persist/home/.gitconfig user.name "$git_name"
    git config --file /persist/home/.gitconfig user.email "$git_email"
    chown dev:dev /persist/home/.gitconfig
    mkdir -p "$(dirname "$git_marker")"
    printf '%s\\n%s\\n' "$git_name" "$git_email" > "$git_marker"
    chown -R dev:dev /persist/home/.config/orchard
  fi
fi

: > /etc/profile.d/sandbox-agents.sh
if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q\\n' "$CLAUDE_CODE_OAUTH_TOKEN" >> /etc/profile.d/sandbox-agents.sh
fi
if [ -n "\${OPENAI_API_KEY:-}" ]; then
  printf 'export OPENAI_API_KEY=%q\\n' "$OPENAI_API_KEY" >> /etc/profile.d/sandbox-agents.sh
fi
chmod 644 /etc/profile.d/sandbox-agents.sh

if [ -n "\${SANDBOX_REPO_URL:-}" ]; then
  repo_dir="/persist/home/$(basename "\${SANDBOX_REPO_URL%.git}")"
  if [ ! -d "$repo_dir" ]; then
    su dev -c "git clone '$SANDBOX_REPO_URL' '$repo_dir' >> /persist/home/.clone.log 2>&1" &
  fi
fi

if [ -s /orchard-init/setup.sh ] && [ ! -f /persist/.setup-done ]; then
  (
    su dev -c 'bash /orchard-init/setup.sh' > /persist/home/.setup.log 2>&1
    status=$?
    if [ "$status" -eq 0 ]; then
      touch /persist/.setup-done
      echo "[setup] completed" >> /persist/home/.setup.log
    else
      echo "[setup] exited with status $status" >> /persist/home/.setup.log
    fi
  ) &
fi

${ORCHARD_ENV_SYNC_FUNCTION}
if [ -f /orchard-init/${ORCHARD_ENV_INIT_FILE} ]; then
  orchard_env_sync < /orchard-init/${ORCHARD_ENV_INIT_FILE}
fi
cat > /etc/profile.d/orchard-env.sh <<'ORCHARDENV'
${ORCHARD_ENV_PROFILE}ORCHARDENV
chmod 644 /etc/profile.d/orchard-env.sh
if [ -f /persist/home/.bashrc ] && ! grep -q 'orchard-env.sh' /persist/home/.bashrc; then
  printf '[ -r /etc/profile.d/orchard-env.sh ] && . /etc/profile.d/orchard-env.sh\\n' >> /persist/home/.bashrc
fi

mkdir -p /persist/home/.config/opencode /persist/home/.local/share/opencode
ln -sfn /orchard-init/opencode-config.json /persist/home/.config/opencode/opencode.json
ln -sfn /orchard-init/opencode-auth.json /persist/home/.local/share/opencode/auth.json
[ -e /persist/home/.config/opencode/anthropic-auth.json ] || echo '{}' > /persist/home/.config/opencode/anthropic-auth.json
chown dev:dev /persist/home/.config /persist/home/.local /persist/home/.local/share
chown -R dev:dev /persist/home/.config/opencode /persist/home/.local/share/opencode

phase services
${OPENCODE_PASSWORD_SYNC_FUNCTION}
if [ -f /orchard-init/opencode-password ]; then
  opencode_password_sync < /orchard-init/opencode-password
else
  opencode_password_sync < /dev/null
fi
if have opencode && ! pgrep -f '[o]pencode serve' >/dev/null 2>&1; then
  su - dev -c '[ -f ~/.config/opencode/server.env ] && . ~/.config/opencode/server.env; OPENCODE_EXPERIMENTAL_PLAN_MODE=1 nohup opencode serve --hostname 0.0.0.0 --port 4096 >> /persist/home/.opencode-serve.log 2>&1 &'
fi

bridge_bin=/usr/local/bin/orchard
bridge_marker=/usr/local/share/orchard/bridge-source
if [ -s /orchard-init/bridge-token ]; then
  case "$(uname -m)" in
    aarch64|arm64)
      bridge_source="\${ORCHARD_BRIDGE_URL_ARM64:-}"
      bridge_sha="\${ORCHARD_BRIDGE_SHA256_ARM64:-}"
      ;;
    *)
      bridge_source="\${ORCHARD_BRIDGE_URL:-}"
      bridge_sha="\${ORCHARD_BRIDGE_SHA256:-}"
      ;;
  esac
  installed_source=$(cat "$bridge_marker" 2>/dev/null || true)
  if [ -n "$bridge_source" ] && [ -z "$bridge_sha" ]; then
    log "no ORCHARD_BRIDGE_SHA256 for $bridge_source; not installing an unverified bridge"
  elif [ -n "$bridge_source" ] && { [ ! -x "$bridge_bin" ] || [ "$installed_source" != "$bridge_source $bridge_sha" ]; }; then
    bridge_tmp=$(mktemp -d)
    if curl -fsSL --retry 3 --connect-timeout 10 -o "$bridge_tmp/orchard.tar.gz" "$bridge_source"; then
      if ! printf '%s  %s\\n' "$bridge_sha" "$bridge_tmp/orchard.tar.gz" | sha256sum -c - >/dev/null 2>&1; then
        log "the bridge download did not match ORCHARD_BRIDGE_SHA256"
      elif tar -xzf "$bridge_tmp/orchard.tar.gz" -C "$bridge_tmp" orchard 2>/dev/null; then
        install -m 755 "$bridge_tmp/orchard" "$bridge_bin.new" && mv -f "$bridge_bin.new" "$bridge_bin"
        mkdir -p "$(dirname "$bridge_marker")"
        printf '%s' "$bridge_source $bridge_sha" > "$bridge_marker"
        pkill -f 'orchard sandbox bridge' >/dev/null 2>&1 || true
      else
        log "the bridge archive has no orchard binary"
      fi
    else
      log "could not download the bridge from $bridge_source"
    fi
    rm -rf "$bridge_tmp"
  fi
  if [ -x "$bridge_bin" ] && ! pgrep -f 'orchard sandbox bridge' >/dev/null 2>&1; then
    nohup "$bridge_bin" sandbox bridge --listen 0.0.0.0:2222 --target 127.0.0.1:22 --token-file /orchard-init/bridge-token >> /var/log/orchard-bridge.log 2>&1 &
  fi
fi

mkdir -p /run/sshd
chmod 755 /run/sshd
phase ready
if pgrep -x sshd >/dev/null 2>&1; then
  exit 0
fi
exec /usr/sbin/sshd -D -e
`;
