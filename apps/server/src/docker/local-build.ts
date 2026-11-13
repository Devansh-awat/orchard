const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const PASSTHROUGH = [
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH'
];

export function localGitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.PATH = source.PATH || DEFAULT_PATH;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export const LOCAL_BUILD_OPT_IN_ENV = 'ALLOW_LOCAL_BUILD_IN_PRODUCTION';

export function localBuildRefusal(source: NodeJS.ProcessEnv = process.env): string | null {
  if (source.NODE_ENV !== 'production') return null;
  if (source[LOCAL_BUILD_OPT_IN_ENV] === 'true') return null;
  return `Local builds run untrusted repositories inside the server process and are off in production. Use BUILD_MODE=kubernetes, or set ${LOCAL_BUILD_OPT_IN_ENV}=true to accept the risk.`;
}
