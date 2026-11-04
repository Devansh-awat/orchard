export type SlashGroup = 'chat' | 'agent' | 'machine' | 'repository';

export type SlashArgs = 'none' | 'optional' | 'required';

export type SlashCommand = {
  name: string;
  description: string;
  group?: SlashGroup;
  hint?: string;
  aliases?: string[];
  args?: SlashArgs;
  readonly?: boolean;
  source?: 'local' | 'server';
};

export type SlashOption = { value: string; label: string; description?: string };

export type SlashMatch = { command: SlashCommand; label: string; score: number };

export type SlashSection = {
  group: SlashGroup;
  label: string;
  items: Array<{ match: SlashMatch; index: number }>;
};

export type SlashInput = { name: string; args: string };

export type TodoItem = { content: string; status: string; priority: string };

export type AgentChoice = { name: string; description: string };

type TranscriptEntry = {
  kind: string;
  text?: string;
  name?: string;
  summary?: string;
  agentType?: string;
  description?: string;
  detail?: string;
  lead?: string;
  target?: string | null;
  attachments?: readonly unknown[];
};

export type SlashNotice = { text: string; todos?: TodoItem[] };

export const SLASH_GROUPS: ReadonlyArray<{ id: SlashGroup; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'agent', label: 'Agent' },
  { id: 'machine', label: 'Machine' },
  { id: 'repository', label: 'Repository' }
];

export const SERVER_PREFERRED = new Set(['init', 'review']);

export const FEEDBACK_URL = 'https://github.com/hackclub/orchard/issues/new';

const local = (command: Omit<SlashCommand, 'source'>): SlashCommand => ({
  args: 'none',
  ...command,
  source: 'local'
});

export const LOCAL_COMMANDS: readonly SlashCommand[] = [
  local({ name: 'help', group: 'chat', description: 'List every command', readonly: true }),
  local({
    name: 'clear',
    group: 'chat',
    aliases: ['new'],
    description: 'Start a fresh chat in a new tab'
  }),
  local({ name: 'compact', group: 'chat', description: 'Summarize the chat to free up context' }),
  local({
    name: 'resume',
    group: 'chat',
    aliases: ['continue'],
    description: 'Switch to another chat',
    hint: '[chat]',
    args: 'optional'
  }),
  local({
    name: 'rename',
    group: 'chat',
    description: 'Rename this session',
    hint: '<title>',
    args: 'required'
  }),
  local({
    name: 'export',
    group: 'chat',
    description: 'Download the chat as Markdown',
    readonly: true
  }),
  local({
    name: 'undo',
    group: 'chat',
    aliases: ['rewind'],
    description: 'Roll back the last prompt and its changes'
  }),
  local({ name: 'redo', group: 'chat', description: 'Bring back what undo rolled back' }),
  local({
    name: 'todos',
    group: 'chat',
    description: "Show the agent's todo list",
    readonly: true
  }),
  local({ name: 'stop', group: 'chat', description: 'Stop the agent' }),
  local({
    name: 'chat',
    group: 'chat',
    description: 'Message the people in this session without asking the agent',
    hint: '<message>',
    args: 'required'
  }),
  local({
    name: 'model',
    group: 'agent',
    description: 'Pick the model',
    hint: '[name]',
    args: 'optional'
  }),
  local({
    name: 'effort',
    group: 'agent',
    description: 'Set the reasoning effort',
    hint: '[low|medium|high|max]',
    args: 'optional'
  }),
  local({ name: 'fast', group: 'agent', description: 'Switch fast mode on or off' }),
  local({
    name: 'plan',
    group: 'agent',
    description: "Plan mode, the agent reads but doesn't edit"
  }),
  local({ name: 'build', group: 'agent', description: 'Leave plan mode so the agent can edit' }),
  local({
    name: 'agents',
    group: 'agent',
    description: 'Pick the agent that answers',
    hint: '[name]',
    args: 'optional'
  }),
  local({ name: 'init', group: 'agent', description: 'Write an AGENTS.md for this repository' }),
  local({
    name: 'review',
    group: 'agent',
    description: 'Review the uncommitted changes, or a commit, branch or PR',
    hint: '[target]',
    args: 'optional'
  }),
  local({
    name: 'security-review',
    group: 'agent',
    description: 'Review the branch for security issues'
  }),
  local({
    name: 'context',
    group: 'agent',
    aliases: ['cost', 'usage'],
    description: 'Context used, cost and Claude usage limits',
    readonly: true
  }),
  local({ name: 'mcp', group: 'agent', description: 'Manage MCP servers' }),
  local({ name: 'memory', group: 'agent', description: 'Edit AGENTS.md or CLAUDE.md' }),
  local({
    name: 'permissions',
    group: 'agent',
    description: 'Permission settings and auto-accept'
  }),
  local({ name: 'terminal', group: 'machine', description: 'Open a terminal' }),
  local({ name: 'diff', group: 'machine', description: 'Open Changes', readonly: true }),
  local({ name: 'pr', group: 'machine', description: 'Create or open the pull request' }),
  local({
    name: 'status',
    group: 'machine',
    description: 'Machine and branch status',
    readonly: true
  }),
  local({ name: 'share', group: 'machine', description: 'Share this session' }),
  local({
    name: 'settings',
    group: 'machine',
    aliases: ['config'],
    description: 'Open settings'
  }),
  local({
    name: 'bug',
    group: 'machine',
    aliases: ['feedback'],
    description: 'Report a problem with Orchard'
  })
];

const NAME_RE = /^[^\s]{1,64}$/;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseSlash(text: string): SlashInput | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

export function findCommand(
  commands: readonly SlashCommand[],
  name: string
): { command: SlashCommand; alias: string | null } | null {
  const wanted = name.toLowerCase();
  const direct = commands.find((c) => c.name.toLowerCase() === wanted);
  if (direct) return { command: direct, alias: null };
  const aliased = commands.find((c) => c.aliases?.some((a) => a.toLowerCase() === wanted));
  return aliased ? { command: aliased, alias: wanted } : null;
}

function hintFor(hints: string[]): string | undefined {
  const numbered = hints.filter((h) => /^\$\d+$/.test(h)).map((h) => `<${h.slice(1)}>`);
  if (numbered.length > 0) return numbered.join(' ');
  return hints.includes('$ARGUMENTS') ? '[arguments]' : undefined;
}

function serverDescription(source: string | null, description: string | null): string {
  const text = description?.trim();
  if (text) return text;
  if (source === 'skill') return 'Skill';
  if (source === 'mcp') return 'MCP prompt';
  return 'Repository command';
}

export function serverCommands(data: unknown): SlashCommand[] {
  if (!Array.isArray(data)) return [];
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = str(item.name);
    if (!name || !NAME_RE.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const hints = Array.isArray(item.hints)
      ? item.hints.filter((h): h is string => typeof h === 'string')
      : [];
    const hint = hintFor(hints);
    out.push({
      name,
      description: serverDescription(str(item.source), str(item.description)),
      group: SERVER_PREFERRED.has(name.toLowerCase()) ? 'agent' : 'repository',
      args: hint ? 'optional' : 'none',
      source: 'server',
      ...(hint ? { hint } : {})
    });
  }
  return out;
}

export function mergeCommands(
  builtIn: readonly SlashCommand[],
  server: readonly SlashCommand[]
): SlashCommand[] {
  const preferred = new Map(
    server
      .filter((c) => SERVER_PREFERRED.has(c.name.toLowerCase()))
      .map((c) => [c.name.toLowerCase(), c])
  );
  const taken = new Set<string>();
  const merged: SlashCommand[] = [];
  for (const command of builtIn) {
    const override = preferred.get(command.name.toLowerCase());
    merged.push(override ? { ...override, aliases: command.aliases } : command);
    taken.add(command.name.toLowerCase());
    for (const alias of command.aliases ?? []) taken.add(alias.toLowerCase());
  }
  for (const command of server) {
    const key = command.name.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    merged.push(command);
  }
  return merged;
}

export function visibleCommands(
  commands: readonly SlashCommand[],
  canEdit: boolean
): SlashCommand[] {
  return canEdit ? [...commands] : commands.filter((c) => c.readonly === true);
}

export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let at = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found === -1) return null;
    if (last !== -1) gaps += found - last - 1;
    last = found;
    at = found + 1;
  }
  return Math.max(1, 100 - gaps * 5 - (t.length - q.length));
}

function nameScore(query: string, name: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - (n.length - q.length);
  const parts = n.split(/[-_:/.]/);
  if (parts.some((p) => p.startsWith(q))) return 700 - (n.length - q.length);
  if (n.includes(q)) return 600 - n.indexOf(q);
  const loose = fuzzy(q, n);
  return loose === null ? null : 300 + loose;
}

function descriptionScore(query: string, description: string): number | null {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return null;
  const words = description.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((w) => w.startsWith(q))) return 200;
  return description.toLowerCase().includes(q) ? 100 : null;
}

export function scoreCommand(command: SlashCommand, query: string): SlashMatch | null {
  if (!query) return { command, label: command.name, score: 0 };
  let best: SlashMatch | null = null;
  const consider = (label: string, score: number | null) => {
    if (score !== null && (!best || score > best.score)) best = { command, label, score };
  };
  consider(command.name, nameScore(query, command.name));
  for (const alias of command.aliases ?? []) {
    const score = nameScore(query, alias);
    consider(alias, score === null ? null : score - 1);
  }
  if (!best) consider(command.name, descriptionScore(query, command.description));
  return best;
}

function groupIndex(group: SlashGroup | undefined): number {
  const at = SLASH_GROUPS.findIndex((g) => g.id === (group ?? 'repository'));
  return at === -1 ? SLASH_GROUPS.length : at;
}

export function rankCommands(commands: readonly SlashCommand[], query: string): SlashMatch[] {
  const scored: Array<{ match: SlashMatch; order: number }> = [];
  commands.forEach((command, order) => {
    const match = scoreCommand(command, query);
    if (match) scored.push({ match, order });
  });
  scored.sort(
    (a, b) =>
      groupIndex(a.match.command.group) - groupIndex(b.match.command.group) ||
      b.match.score - a.match.score ||
      a.order - b.order
  );
  return scored.map((s) => s.match);
}

export function sectionsOf(matches: readonly SlashMatch[]): SlashSection[] {
  const sections: SlashSection[] = [];
  matches.forEach((match, index) => {
    const group = match.command.group ?? 'repository';
    let section = sections.at(-1);
    if (!section || section.group !== group) {
      const label = SLASH_GROUPS.find((g) => g.id === group)?.label ?? 'Repository';
      section = { group, label, items: [] };
      sections.push(section);
    }
    section.items.push({ match, index });
  });
  return sections;
}

export function rankOptions(options: readonly SlashOption[], query: string): SlashOption[] {
  const q = query.trim();
  if (!q) return [...options];
  const scored: Array<{ option: SlashOption; score: number; order: number }> = [];
  options.forEach((option, order) => {
    const score = Math.max(
      nameScore(q, option.value) ?? -1,
      nameScore(q, option.label) ?? -1,
      descriptionScore(q, option.description ?? '') ?? -1
    );
    if (score >= 0) scored.push({ option, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.option);
}

export function bestOption(options: readonly SlashOption[], query: string): SlashOption | null {
  return rankOptions(options, query)[0] ?? null;
}

export function runsImmediately(command: SlashCommand, hasOptions: boolean): boolean {
  const args = command.args ?? 'none';
  if (args === 'none') return true;
  return args === 'optional' && !hasOptions;
}

export function commandLine(command: SlashCommand, label = command.name): string {
  return command.hint ? `/${label} ${command.hint}` : `/${label}`;
}

export function effortOptions(variants: readonly string[]): SlashOption[] {
  return [{ value: 'default', label: 'default' }, ...variants.map((v) => ({ value: v, label: v }))];
}

export function pickEffort(variants: readonly string[], arg: string): string | null | undefined {
  const wanted = arg.trim().toLowerCase();
  if (!wanted) return undefined;
  if (wanted === 'default' || wanted === 'auto' || wanted === 'none') return null;
  const exact = variants.find((v) => v.toLowerCase() === wanted);
  if (exact) return exact;
  return variants.find((v) => v.toLowerCase().startsWith(wanted));
}

export function primaryAgents(data: unknown): AgentChoice[] {
  if (!Array.isArray(data)) return [];
  const out: AgentChoice[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = str(item.name);
    if (!name || item.hidden === true || item.mode === 'subagent') continue;
    out.push({ name, description: str(item.description)?.trim() ?? '' });
  }
  return out;
}

export function parseTodos(data: unknown): TodoItem[] {
  if (!Array.isArray(data)) return [];
  const out: TodoItem[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const content = str(item.content)?.trim();
    if (!content) continue;
    out.push({
      content,
      status: str(item.status) ?? 'pending',
      priority: str(item.priority) ?? 'medium'
    });
  }
  return out;
}

export function undoTarget(
  entries: ReadonlyArray<{ kind: string; messageID?: string }>,
  reverted: string | null
): string | null {
  let target: string | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'user' || !entry.messageID) continue;
    if (reverted && entry.messageID === reverted) break;
    target = entry.messageID;
  }
  return target;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

export function transcriptMarkdown(title: string, entries: readonly TranscriptEntry[]): string {
  const blocks: string[] = [`# ${title.trim() || 'Chat'}`];
  let tools: string[] = [];
  const flush = () => {
    if (tools.length === 0) return;
    blocks.push(tools.join('\n'));
    tools = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      tools.push(`- ${entry.name ?? 'tool'}${entry.summary ? ` \`${entry.summary}\`` : ''}`);
      continue;
    }
    if (entry.kind === 'agent') {
      tools.push(`- ${entry.agentType ?? 'agent'}: ${entry.description ?? ''}`);
      continue;
    }
    flush();
    const text = entry.text?.trim() ?? '';
    if (entry.kind === 'user') {
      const files = entry.attachments?.length ?? 0;
      const body = text || (files > 0 ? `${files} attachment(s)` : '');
      if (body) blocks.push(`## Prompt\n\n${quote(body)}`);
    } else if (entry.kind === 'text' && text) {
      blocks.push(text);
    } else if (entry.kind === 'error' && entry.detail) {
      blocks.push(`**Error:** ${entry.detail}`);
    } else if (entry.kind === 'note' && entry.lead) {
      blocks.push(`_${entry.lead}${entry.target ? ` ${entry.target}` : ''}_`);
    }
  }
  flush();
  return `${blocks.join('\n\n')}\n`;
}

export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'chat'}.md`;
}

export function reviewPrompt(target: string): string {
  const what = target.trim();
  return [
    what
      ? `Review ${what}. It is a commit, a branch to diff against, or a pull request; use git or gh to read the changes.`
      : 'Review the uncommitted changes in this worktree. Run `git status --short`, `git diff` and `git diff --cached` to see them.',
    "Read the surrounding code where you need context. Report bugs, regressions and risky edge cases first, each with the file, the line and a concrete fix. Skip style nits. Don't edit any files."
  ].join('\n\n');
}

export function initPrompt(): string {
  return [
    'Create or update AGENTS.md at the root of this repository so a coding agent can work here without asking.',
    "Cover how to install, build, lint and test (including how to run a single test), the layout of the code, and conventions that aren't obvious from the code itself. Keep it short and specific to this repository. If AGENTS.md, CLAUDE.md or similar files already exist, fold in what is still true."
  ].join('\n\n');
}

export function securityReviewPrompt(baseBranch: string | null): string {
  const base = baseBranch?.trim() || null;
  const range = base ? `\`git diff ${base}...HEAD\`` : 'the diff against the base branch';
  return [
    `Do a security review of the changes on this branch. Read ${range}, plus \`git diff\` and \`git status --short\` for uncommitted and new files.`,
    'Look for injection, broken authentication or authorization, secrets in code, unsafe deserialization, path traversal, SSRF, XSS and missing input validation that the changes introduce.',
    "Only report issues you are confident are exploitable. For each give the file and line, the severity, how it could be exploited and the fix. Don't edit any files."
  ].join('\n\n');
}
