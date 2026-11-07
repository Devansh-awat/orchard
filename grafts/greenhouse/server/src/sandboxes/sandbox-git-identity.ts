import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { GitHubService } from '../core/github.service';
import { PrismaService } from '../prisma.service';
import { isUuid, shellQuote } from './sandbox-session-commands';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitActorUser {
  id: string;
  username: string | null;
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  githubId?: string | null;
  githubUsername?: string | null;
}

export interface GitActor {
  userId: string;
  identity: GitIdentity;
  githubLogin: string | null;
  token: string | null;
}

export interface GitIdentityDto extends GitIdentity {
  githubLogin: string | null;
  githubLinked: boolean;
}

export const GITHUB_NOT_LINKED = {
  code: 'github_not_linked',
  message: 'Link your GitHub account to push'
} as const;

export const FALLBACK_GIT_EMAIL = 'sandbox@orchard.dev';

export const GIT_CREDENTIAL_HELPER =
  '!f(){ [ "$1" = get ] || return 0; p=; h=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in protocol=*) p=${l#protocol=};; host=*) h=${l#host=};; esac; done; [ "$p" = https ] && [ "$h" = github.com ] || return 0; echo username=x-access-token; echo "password=$ORCHARD_GIT_TOKEN"; }; f';

export const GIT_TOKEN_EXIT = 70;

export const TERMINAL_ENV_DIR = '/tmp';

const IDENTITY_MAX = 200;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_ID_RE = /^\d{1,20}$/;
const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+$/;
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/;

function clean(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const visible = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || ch === '<' || ch === '>' ? ' ' : ch;
  }).join('');
  return visible.replace(/\s+/g, ' ').trim().slice(0, IDENTITY_MAX);
}

export function githubNoreplyEmail(
  githubId: string | null | undefined,
  login: string | null | undefined
): string | null {
  if (!githubId || !login) return null;
  if (!GITHUB_ID_RE.test(githubId) || !GITHUB_LOGIN_RE.test(login)) return null;
  return `${githubId}+${login}@users.noreply.github.com`;
}

export function gitIdentity(user: GitActorUser): GitIdentity {
  const noreply = githubNoreplyEmail(user.githubId, user.githubUsername);
  const fullName = clean([user.firstName, user.lastName].filter(Boolean).join(' '));
  const login = noreply ? clean(user.githubUsername) : '';
  const name = fullName || login || clean(user.username) || 'Orchard user';
  const orchardEmail = clean(user.email);
  const email = noreply || (EMAIL_RE.test(orchardEmail) ? orchardEmail : FALLBACK_GIT_EMAIL);
  return { name, email };
}

export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email
  };
}

export function gitAuthConfig(withToken: boolean): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ['credential.helper', ''],
    ['http.extraHeader', '']
  ];
  if (withToken) {
    entries.splice(1, 0, ['credential.helper', GIT_CREDENTIAL_HELPER]);
    entries.push(
      ['url.https://github.com/.insteadOf', 'git@github.com:'],
      ['url.https://github.com/.insteadOf', 'ssh://git@github.com/']
    );
  }
  return entries;
}

export function gitAuthFlags(): string {
  return [
    ...gitAuthConfig(true),
    ['core.hooksPath', '/dev/null'] as [string, string],
    ['core.fsmonitor', ''] as [string, string]
  ]
    .map(([key, value]) => `-c ${shellQuote(`${key}=${value}`)}`)
    .join(' ');
}

export function gitConfigEnv(entries: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export function exportLine(env: Record<string, string>): string {
  const pairs = Object.entries(env);
  if (!pairs.length) return '';
  return `export ${pairs.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}`;
}

export function gitExecPrelude(identity: GitIdentity, withToken: boolean): string {
  const lines = [exportLine({ ...gitIdentityEnv(identity), GIT_TERMINAL_PROMPT: '0' })];
  if (withToken) {
    lines.push(
      `IFS= read -r ORCHARD_GIT_TOKEN || [ -n "$ORCHARD_GIT_TOKEN" ] || exit ${GIT_TOKEN_EXIT}`,
      'export ORCHARD_GIT_TOKEN'
    );
  }
  return lines.join('\n');
}

export function gitTokenStdin(token: string): Buffer {
  if (!TOKEN_RE.test(token)) throw new Error('the GitHub token has an unexpected format');
  return Buffer.from(`${token}\n`, 'utf8');
}

export function terminalSharedEnv(
  identity: GitIdentity,
  withToken: boolean
): Record<string, string> {
  return { ...gitIdentityEnv(identity), ...gitConfigEnv(gitAuthConfig(withToken)) };
}

export function terminalEnvFile(actor: GitActor): string {
  const env: Record<string, string> = terminalSharedEnv(actor.identity, !!actor.token);
  if (actor.token) {
    gitTokenStdin(actor.token);
    env.ORCHARD_GIT_TOKEN = actor.token;
  }
  return `${exportLine(env)}\n`;
}

export function sharedTerminalShell(actor: GitActor): { file: string; tmuxEnv: string } {
  const bare: GitActor = { ...actor, token: null };
  return {
    file: terminalEnvFile(bare),
    tmuxEnv: terminalTmuxEnvScript(bare.identity, false)
  };
}

export function terminalEnvPath(engineSessionId: string): string {
  if (!isUuid(engineSessionId)) throw new Error('invalid terminal session id');
  return `${TERMINAL_ENV_DIR}/.orchard-term-${engineSessionId.toLowerCase()}`;
}

export function writeTerminalEnvScript(path: string): string {
  const tmp = `${path}.tmp`;
  return `umask 077; cat > ${shellQuote(tmp)} && mv -f ${shellQuote(tmp)} ${shellQuote(path)}`;
}

export function terminalTmuxEnvScript(identity: GitIdentity, withToken: boolean): string {
  return Object.keys(terminalSharedEnv(identity, withToken))
    .map((key) => `tmux set-environment ${key} "$${key}" 2>/dev/null`)
    .join('; ');
}

export class GitHubNotLinkedException extends ConflictException {
  constructor() {
    super({ ...GITHUB_NOT_LINKED });
  }
}

const ACTOR_SELECT = {
  id: true,
  username: true,
  email: true,
  firstName: true,
  lastName: true,
  githubId: true,
  githubUsername: true
} as const;

type ActorRow = GitActorUser & { id: string };

@Injectable()
export class SandboxGitActorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GitHubService) private readonly github: Pick<GitHubService, 'getValidUserToken'>
  ) {}

  private async row(userId: string): Promise<ActorRow> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: ACTOR_SELECT
    });
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  private async tokenOf(row: ActorRow): Promise<string | null> {
    return (await this.github.getValidUserToken(row.id).catch(() => null)) || null;
  }

  async resolve(userId: string): Promise<GitActor> {
    const row = await this.row(userId);
    return {
      userId: row.id,
      identity: gitIdentity(row),
      githubLogin: row.githubUsername ?? null,
      token: await this.tokenOf(row)
    };
  }

  async resolveIdentity(userId: string): Promise<GitActor> {
    const row = await this.row(userId);
    return {
      userId: row.id,
      identity: gitIdentity(row),
      githubLogin: row.githubUsername ?? null,
      token: null
    };
  }

  async describe(userId: string): Promise<GitIdentityDto> {
    const row = await this.row(userId);
    return {
      ...gitIdentity(row),
      githubLogin: row.githubUsername ?? null,
      githubLinked: !!(await this.tokenOf(row))
    };
  }

  requireToken(actor: GitActor): string {
    if (!actor.token) throw new GitHubNotLinkedException();
    return actor.token;
  }

  async requireActorToken(userId: string): Promise<string> {
    return this.requireToken(await this.resolve(userId));
  }
}
