export const CONTEXT_KINDS = ['instructions', 'agent', 'command', 'skill', 'mcp'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const CONTEXT_LIMITS = {
  fileBytes: 256 * 1024,
  itemBytes: 1024 * 1024,
  userBytes: 5 * 1024 * 1024,
  items: 200,
  filesPerItem: 50
} as const;

export const RESERVED_MCP = 'orchard';
export const CONTEXT_HOME = '/persist/home';
export const CONTEXT_MANIFEST = `${CONTEXT_HOME}/.orchard/context-manifest.json`;
export const OPENCODE_USER_CONFIG = `${CONTEXT_HOME}/.config/opencode/opencode.jsonc`;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/;

export interface ContextPayload {
  files?: Record<string, string>;
  mcp?: McpServer;
}

export interface McpServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ContextItemInput {
  kind: ContextKind;
  name: string;
  payload: ContextPayload;
}

export class ContextValidationError extends Error {}

function fail(message: string): never {
  throw new ContextValidationError(message);
}

function stringRecord(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') fail(`${what}.${key} must be a string`);
    out[key] = raw;
  }
  return out;
}

export function isContextKind(value: unknown): value is ContextKind {
  return typeof value === 'string' && (CONTEXT_KINDS as readonly string[]).includes(value);
}

export function safeRelativePath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.length > 6) return false;
  return parts.every((part) => SEGMENT_RE.test(part) && part !== '.' && part !== '..');
}

function normalizeMcp(raw: unknown): McpServer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('mcp must be an object');
  const source = raw as Record<string, unknown>;
  const server: McpServer = {};
  if (source.type !== undefined) {
    if (typeof source.type !== 'string') fail('mcp.type must be a string');
    server.type = source.type;
  }
  if (source.command !== undefined) {
    if (typeof source.command !== 'string' || !source.command.trim())
      fail('mcp.command must be a string');
    server.command = source.command;
  }
  if (source.args !== undefined) {
    if (!Array.isArray(source.args) || source.args.some((a) => typeof a !== 'string')) {
      fail('mcp.args must be a list of strings');
    }
    server.args = source.args as string[];
  }
  if (source.url !== undefined) {
    if (typeof source.url !== 'string' || !/^https?:\/\//.test(source.url))
      fail('mcp.url must be an http(s) URL');
    server.url = source.url;
  }
  const env = stringRecord(source.env, 'mcp.env');
  if (Object.keys(env).length) server.env = env;
  const headers = stringRecord(source.headers, 'mcp.headers');
  if (Object.keys(headers).length) server.headers = headers;
  if (!server.command && !server.url) fail('mcp needs a command or a url');
  return server;
}

export function validateContextItem(raw: {
  kind?: unknown;
  name?: unknown;
  files?: unknown;
  mcp?: unknown;
}): ContextItemInput {
  if (!isContextKind(raw.kind)) fail(`kind must be one of ${CONTEXT_KINDS.join(', ')}`);
  const kind = raw.kind;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!NAME_RE.test(name))
    fail('name must be 1 to 64 letters, digits, dots, dashes, underscores or colons');
  if (kind === 'instructions' && name !== 'CLAUDE.md') fail('instructions are named CLAUDE.md');
  if (name.split(':').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('name segments cannot be empty, "." or ".."');
  }
  if (kind === 'mcp') {
    if (name === RESERVED_MCP) fail(`"${RESERVED_MCP}" is reserved for Orchard's own MCP server`);
    return { kind, name, payload: { mcp: normalizeMcp(raw.mcp) } };
  }
  const files = stringRecord(raw.files, 'files');
  const paths = Object.keys(files);
  if (paths.length === 0) fail('files must contain at least one file');
  if (paths.length > CONTEXT_LIMITS.filesPerItem)
    fail(`at most ${CONTEXT_LIMITS.filesPerItem} files per item`);
  for (const path of paths) {
    if (kind === 'skill' ? !safeRelativePath(path) : path !== `${name}.md` && path !== name) {
      fail(kind === 'skill' ? `invalid file path "${path}"` : `the file must be named ${name}.md`);
    }
    if (Buffer.byteLength(files[path], 'utf8') > CONTEXT_LIMITS.fileBytes) {
      fail(`${path} is larger than ${CONTEXT_LIMITS.fileBytes / 1024} KB`);
    }
  }
  if (kind === 'skill' && !('SKILL.md' in files)) fail('a skill needs a SKILL.md');
  return { kind, name, payload: { files } };
}

export function payloadBytes(payload: ContextPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function frontmatter(text: string): { lines: string[]; body: string } | null {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const rest = text.slice(text.indexOf('\n') + 1);
  const end = rest.search(/^---\s*$/m);
  if (end < 0) return null;
  const block = rest.slice(0, end);
  const body = rest.slice(end).replace(/^---\s*\r?\n?/, '');
  return { lines: block.split(/\r?\n/), body };
}

function keepKeys(lines: string[], keys: string[]): string[] {
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key) keeping = keys.includes(key);
    else if (!/^\s/.test(line)) keeping = false;
    if (keeping) kept.push(line);
  }
  return kept;
}

export function toOpencodeAgent(name: string, text: string): string {
  const parsed = frontmatter(text);
  const description = parsed ? keepKeys(parsed.lines, ['description']) : [];
  const head = description.length ? description : [`description: ${JSON.stringify(name)}`];
  return `---\n${[...head, 'mode: subagent'].join('\n')}\n---\n${parsed ? parsed.body : text}`;
}

export function toOpencodeCommand(text: string): string {
  const parsed = frontmatter(text);
  if (!parsed) return text;
  const description = keepKeys(parsed.lines, ['description']);
  return description.length ? `---\n${description.join('\n')}\n---\n${parsed.body}` : parsed.body;
}

export function toOpencodeMcp(server: McpServer): Record<string, unknown> {
  if (server.url && !server.command) {
    return {
      type: 'remote',
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      enabled: true
    };
  }
  return {
    type: 'local',
    command: [server.command as string, ...(server.args ?? [])],
    ...(server.env ? { environment: server.env } : {}),
    enabled: true
  };
}

export interface BoxFiles {
  files: Record<string, string>;
  mcp: Record<string, Record<string, unknown>>;
}

export function boxFilesFor(items: ContextItemInput[]): BoxFiles {
  const files: Record<string, string> = {};
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    const entries = item.payload.files ?? {};
    if (item.kind === 'instructions') {
      files[`${CONTEXT_HOME}/.claude/CLAUDE.md`] = entries['CLAUDE.md'] ?? '';
    } else if (item.kind === 'agent') {
      const text = entries[`${item.name}.md`] ?? entries[item.name] ?? '';
      files[`${CONTEXT_HOME}/.claude/agents/${item.name}.md`] = text;
      files[`${CONTEXT_HOME}/.config/opencode/agent/${item.name}.md`] = toOpencodeAgent(
        item.name,
        text
      );
    } else if (item.kind === 'command') {
      const text = entries[`${item.name}.md`] ?? entries[item.name] ?? '';
      files[`${CONTEXT_HOME}/.claude/commands/${item.name.split(':').join('/')}.md`] = text;
      files[`${CONTEXT_HOME}/.config/opencode/command/${item.name}.md`] = toOpencodeCommand(text);
    } else if (item.kind === 'skill') {
      for (const [path, text] of Object.entries(entries)) {
        files[`${CONTEXT_HOME}/.claude/skills/${item.name}/${path}`] = text;
      }
    } else if (item.kind === 'mcp' && item.payload.mcp) {
      mcp[item.name] = toOpencodeMcp(item.payload.mcp);
    }
  }
  return { files, mcp };
}

export function opencodeUserConfig(mcp: Record<string, Record<string, unknown>>): string {
  return `${JSON.stringify(Object.keys(mcp).length ? { mcp } : {}, null, 2)}\n`;
}

export function mcpSecretKeys(server: McpServer): string[] {
  return [...Object.keys(server.env ?? {}), ...Object.keys(server.headers ?? {})];
}
