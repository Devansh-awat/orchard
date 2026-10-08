import { SANDBOX_BOOTSTRAP_SCRIPT } from '../sandbox-bootstrap';
import { ORCHARD_ENV_INIT_FILE, orchardEnvBundle } from '../links/sandbox-env-files';
import type { SandboxSecrets } from './sandbox-runner';

export const SECRET_INIT_FILES: readonly string[] = [
  'opencode-password',
  'bridge-token',
  ORCHARD_ENV_INIT_FILE
];

export function opencodeAuthJson(claudeToken: string | null): string {
  if (!claudeToken) return '{}';
  return JSON.stringify({
    anthropic: { type: 'oauth', refresh: '', access: claudeToken, expires: 99999999999999 }
  });
}

export function opencodeConfigJson(
  mcpToken: string | null,
  opts: { mcpUrl?: string | null; requireHttpsMcp?: boolean } = {}
): string {
  const config: Record<string, unknown> = { plugin: ['@cortexkit/opencode-anthropic-auth'] };
  const url = opts.mcpUrl ?? process.env.SANDBOX_MCP_URL ?? '';
  const reachable = !opts.requireHttpsMcp || url.startsWith('https://');
  if (mcpToken && url && reachable) {
    config.mcp = {
      orchard: {
        type: 'remote',
        url,
        headers: { Authorization: `Bearer ${mcpToken}` },
        enabled: true
      }
    };
  }
  return JSON.stringify(config);
}

export const GIT_IDENTITY_INIT_FILE = 'git-identity';

export function gitIdentityFile(
  identity: { name: string; email: string } | null | undefined
): string {
  if (!identity) return '';
  const line = (value: string) => value.replace(/[\r\n]/g, ' ').trim();
  return `${line(identity.name)}\n${line(identity.email)}\n`;
}

export function authorizedKeysFile(keys: string[]): string {
  return `${keys.join('\n')}\n`;
}

export function stagedInitFiles(
  secrets: SandboxSecrets,
  opts: { mcpUrl?: string | null; requireHttpsMcp?: boolean } = {}
): Record<string, string> {
  return {
    'bootstrap.sh': SANDBOX_BOOTSTRAP_SCRIPT,
    'setup.sh': secrets.setupScript || '',
    authorized_keys: authorizedKeysFile(secrets.authorizedKeys),
    'opencode-auth.json': opencodeAuthJson(secrets.claudeToken),
    'opencode-config.json': opencodeConfigJson(secrets.mcpToken, opts),
    'opencode-password': secrets.opencodePassword || '',
    'bridge-token': secrets.bridgeToken || '',
    [ORCHARD_ENV_INIT_FILE]: orchardEnvBundle(secrets.attachedEnv),
    [GIT_IDENTITY_INIT_FILE]: gitIdentityFile(secrets.gitIdentity)
  };
}
