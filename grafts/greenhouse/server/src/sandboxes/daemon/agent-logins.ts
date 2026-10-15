export type AgentCredentialField = 'claudeToken' | 'openaiToken' | 'aiGatewayToken';

export type AgentLoginStep = 'none' | 'code' | 'callback';

export interface AgentSignIn {
  kind: 'signin';
  id: string;
  label: string;
  description: string;
  command: string[];
  step: AgentLoginStep;
  saves?: AgentCredentialField;
}

export interface AgentKey {
  kind: 'key';
  id: string;
  label: string;
  description: string;
  field: AgentCredentialField;
  placeholder: string;
}

export type AgentLoginMethod = AgentSignIn | AgentKey;

export interface AgentLoginInfo {
  agent: string;
  summary: string;
  methods: AgentLoginMethod[];
}

export const AGENT_LOGINS: AgentLoginInfo[] = [
  {
    agent: 'claude',
    summary: 'Saved to your account, so every machine you open is signed in.',
    methods: [
      {
        kind: 'signin',
        id: 'subscription',
        label: 'Claude subscription',
        description:
          'Sign in with your Pro or Max plan. You approve it on claude.ai and paste back a code.',
        command: ['claude', 'setup-token'],
        step: 'code',
        saves: 'claudeToken'
      },
      {
        kind: 'key',
        id: 'token',
        label: 'Token or API key',
        description: 'Paste a token from claude setup-token, or an Anthropic API key.',
        field: 'claudeToken',
        placeholder: 'sk-ant-...'
      }
    ]
  },
  {
    agent: 'codex',
    summary: 'A ChatGPT sign-in stays on this machine. An API key follows you to every machine.',
    methods: [
      {
        kind: 'signin',
        id: 'chatgpt',
        label: 'ChatGPT',
        description:
          'Sign in with your ChatGPT plan using a one-time code. Device code sign-in has to be on in your ChatGPT security settings.',
        command: ['codex', 'login', '--device-auth'],
        step: 'none'
      },
      {
        kind: 'key',
        id: 'openai',
        label: 'OpenAI API key',
        description: 'Billed per token to your OpenAI account.',
        field: 'openaiToken',
        placeholder: 'sk-...'
      }
    ]
  },
  {
    agent: 'fx',
    summary: 'Sign-ins stay on this machine. An AI Gateway key follows you to every machine.',
    methods: [
      {
        kind: 'signin',
        id: 'vercel',
        label: 'Vercel AI Gateway',
        description: 'Sign in with Vercel using a one-time code.',
        command: ['fx', 'login'],
        step: 'none'
      },
      {
        kind: 'signin',
        id: 'chatgpt',
        label: 'ChatGPT',
        description:
          'Use your ChatGPT plan. After you approve, paste the address your browser ends up on.',
        command: ['fx', 'login', 'codex'],
        step: 'callback'
      },
      {
        kind: 'signin',
        id: 'grok',
        label: 'Grok',
        description:
          'Use your Grok plan. After you approve, paste the address your browser ends up on.',
        command: ['fx', 'login', 'grok'],
        step: 'callback'
      },
      {
        kind: 'key',
        id: 'gateway',
        label: 'AI Gateway API key',
        description: 'Billed per token to your Vercel team.',
        field: 'aiGatewayToken',
        placeholder: 'vck_...'
      }
    ]
  },
  {
    agent: 'opencode',
    summary: 'Uses your Claude token and OpenAI key when you have them, plus its own free models.',
    methods: [
      {
        kind: 'key',
        id: 'claude',
        label: 'Claude token',
        description: 'The same token Claude Code uses.',
        field: 'claudeToken',
        placeholder: 'sk-ant-...'
      },
      {
        kind: 'key',
        id: 'openai',
        label: 'OpenAI API key',
        description: 'The same key Codex uses.',
        field: 'openaiToken',
        placeholder: 'sk-...'
      }
    ]
  }
];

export function findSignIn(agent: string, method: string): AgentSignIn | null {
  const info = AGENT_LOGINS.find((a) => a.agent === agent);
  const found = info?.methods.find((m) => m.id === method);
  return found?.kind === 'signin' ? found : null;
}

export function publicLogins(): unknown[] {
  return AGENT_LOGINS.map((info) => ({
    ...info,
    methods: info.methods.map((m) => {
      if (m.kind === 'key') return m;
      const { command: _command, ...rest } = m;
      return rest;
    })
  }));
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL = Array.from({ length: 32 }, (_, i) => i)
  .filter((i) => i !== 9 && i !== 10)
  .map((i) => String.fromCharCode(i))
  .join('')
  .replace(/[\]\\^-]/g, '\\$&');
const ANSI_RE = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}[@-Z\\\\-_]`,
    `[${CONTROL}${String.fromCharCode(127)}]`
  ].join('|'),
  'g'
);
const URL_RE = /https?:\/\/[^\s"'<>\x60]+/g;
const CODE_RE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/;
const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const LOCAL_HOSTS = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/;

export function cleanOutput(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1] ?? '';
    })
    .join('\n')
    .replace(ANSI_RE, '');
}

export interface ParsedLogin {
  url: string | null;
  code: string | null;
  token: string | null;
  lines: string[];
}

export function parseLoginOutput(raw: string): ParsedLogin {
  const text = cleanOutput(raw);
  const urls = [...text.matchAll(URL_RE)]
    .map((m) => m[0].replace(/[.,;)]+$/, ''))
    .filter((u) => !LOCAL_HOSTS.test(u));
  const token = CLAUDE_TOKEN_RE.exec(text)?.[0] ?? null;
  const withoutUrls = text.replace(URL_RE, ' ');
  const code = CODE_RE.exec(withoutUrls)?.[0] ?? null;
  const redacted = token ? text.split(token).join('sk-ant-oat01-••••') : text;
  const lines = redacted
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const deduped: string[] = [];
  for (const line of lines) if (deduped[deduped.length - 1] !== line) deduped.push(line);
  return { url: urls[0] ?? null, code, token, lines: deduped.slice(-12) };
}

export function isLocalCallback(input: string): boolean {
  return LOCAL_HOSTS.test(input.trim());
}
