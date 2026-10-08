import { resolveSharedValues, type EnvVar } from '../../env/env-resolver';

export const ORCHARD_ENV_DIR = '/persist/home/.config/orchard/env';

export const ORCHARD_ENV_INIT_FILE = 'orchard-env';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FILE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export const SHELL_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'TERM',
  'HOSTNAME',
  'IFS',
  'PS1',
  'PS2',
  'PS4',
  'ENV',
  'BASH_ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'OPENCODE_SERVER_PASSWORD'
]);

export interface EnvFileDatabase {
  name: string;
  url: string | null;
}

export interface EnvFileInput {
  projectName: string;
  environmentName: string;
  vars: EnvVar[];
  database?: EnvFileDatabase | null;
}

export function isEnvFileSlug(value: unknown): value is string {
  return typeof value === 'string' && FILE_SLUG_RE.test(value) && !value.endsWith('-');
}

export function shellEnvValue(value: string): string {
  return `'${value.replace(/\0/g, '').replace(/'/g, `'\\''`)}'`;
}

function label(value: string): string {
  return Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : ch;
  })
    .join('')
    .trim()
    .slice(0, 120);
}

export function renderEnvFile(input: EnvFileInput): string {
  const { values, secretKeys } = resolveSharedValues(input.vars);
  const lines = [
    `# Orchard environment for ${label(input.projectName)} / ${label(input.environmentName)}`,
    '# Rewritten by Orchard on every sync, so edits here are lost.'
  ];
  const keys = [...values.keys()].sort();
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) continue;
    if (SHELL_RESERVED_KEYS.has(key)) {
      lines.push(`# ${key} is skipped because it would override the shell`);
      continue;
    }
    if (secretKeys.has(key)) {
      lines.push(`# ${key} is secret; Orchard keeps secret values write-only`);
      continue;
    }
    lines.push(`${key}=${shellEnvValue(values.get(key) ?? '')}`);
  }
  if (input.database && !values.has('DATABASE_URL')) {
    if (input.database.url) {
      lines.push(`DATABASE_URL=${shellEnvValue(input.database.url)}`);
    } else {
      lines.push(
        `# DATABASE_URL is unset: turn on public access for ${label(input.database.name)} to reach it from a sandbox`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function orchardEnvBundle(files: Record<string, string> | null | undefined): string {
  if (!files) return '';
  return Object.keys(files)
    .filter(isEnvFileSlug)
    .sort()
    .map((slug) => `${slug} ${Buffer.from(files[slug], 'utf8').toString('base64')}\n`)
    .join('');
}

export function parseOrchardEnvBundle(bundle: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of bundle.split('\n')) {
    const [slug, data] = line.split(' ');
    if (!isEnvFileSlug(slug) || data === undefined) continue;
    out[slug] = Buffer.from(data, 'base64').toString('utf8');
  }
  return out;
}

export const ORCHARD_ENV_SYNC_FUNCTION = `orchard_env_sync() {
  [ -d /persist/home ] || return 0
  id dev >/dev/null 2>&1 || return 0
  oe_dir=${ORCHARD_ENV_DIR}
  mkdir -p "$oe_dir" || return 0
  chown dev:dev /persist/home/.config /persist/home/.config/orchard "$oe_dir" 2>/dev/null
  chmod 700 /persist/home/.config/orchard "$oe_dir"
  oe_stage=$(mktemp -d) || return 0
  while read -r oe_name oe_data; do
    case "$oe_name" in ''|-*|*[!a-z0-9-]*) continue ;; esac
    printf '%s' "$oe_data" | base64 -d > "$oe_stage/$oe_name.env" 2>/dev/null || rm -f "$oe_stage/$oe_name.env"
  done
  for oe_file in "$oe_dir"/*.env; do
    [ -e "$oe_file" ] || [ -L "$oe_file" ] || continue
    [ -e "$oe_stage/$(basename "$oe_file")" ] || rm -f "$oe_file"
  done
  for oe_file in "$oe_stage"/*.env; do
    [ -e "$oe_file" ] || continue
    oe_target="$oe_dir/$(basename "$oe_file")"
    rm -f "$oe_target"
    install -o dev -g dev -m 600 "$oe_file" "$oe_target"
  done
  rm -rf "$oe_stage"
}`;

export const ORCHARD_ENV_SYNC_SCRIPT = `${ORCHARD_ENV_SYNC_FUNCTION}
orchard_env_sync
`;

export const ORCHARD_ENV_PROFILE = `for orchard_env_file in "$HOME"/.config/orchard/env/*.env; do
  [ -r "$orchard_env_file" ] || continue
  set -a
  . "$orchard_env_file"
  set +a
done
unset orchard_env_file
`;
