import type {
  ChatAuthor,
  ChatEntry,
  ErrorEntry,
  NoteEntry,
  ResultEntry,
  TextEntry,
  ThinkingEntry,
  ToolEntry,
  ToolStatus,
  TurnFile,
  UserEntry
} from './session-store.svelte';
import type { PermissionReply, PermissionRequest } from './pending';
import { toolFiles, type ToolFile } from './tool-files';

export type AcpEvent = {
  seq: number;
  ts: number;
  chatId: string;
  kind: string;
  author?: { id: string; name?: string; avatarUrl?: string | null } | null;
  data?: unknown;
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
};

export type AcpPendingPermission = {
  request: PermissionRequest;
  options: AcpPermissionOption[];
  seen: number;
};

export type AcpConfigOption = {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: (
    | { value: string; name: string; description?: string }
    | {
        group: string;
        name: string;
        options: { value: string; name: string; description?: string }[];
      }
  )[];
};

export type AcpActivity = 'idle' | 'working' | 'needs_input';

export interface AcpTarget {
  entries: ChatEntry[];
}

const OUTPUT_CAP = 4000;

let keySeq = 0;
function key(): string {
  keySeq += 1;
  return `a${keySeq.toString(36)}`;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function countLines(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => {
      const block = rec(b);
      if (block.type === 'text') return str(block.text) ?? '';
      if (block.type === 'resource_link') return str(block.uri) ?? '';
      if (block.type === 'resource') return str(rec(block.resource).uri) ?? '';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const raw of content) {
    const item = rec(raw);
    if (item.type === 'content') {
      const inner = rec(item.content);
      if (inner.type === 'text' && typeof inner.text === 'string') out.push(inner.text);
    }
  }
  return out.join('\n');
}

function contentFiles(content: unknown): ToolFile[] {
  if (!Array.isArray(content)) return [];
  const items: Array<{ src: unknown; mime: unknown; name?: unknown }> = [];
  for (const raw of content) {
    const item = rec(raw);
    const inner = item.type === 'content' ? rec(item.content) : item;
    if (inner.type === 'image' && typeof inner.data === 'string') {
      const mime = typeof inner.mimeType === 'string' ? inner.mimeType : 'image/png';
      items.push({ src: `data:${mime};base64,${inner.data}`, mime, name: inner.uri });
    } else if (inner.type === 'resource') {
      const res = rec(inner.resource);
      if (typeof res.blob === 'string' && typeof res.mimeType === 'string') {
        items.push({
          src: `data:${res.mimeType};base64,${res.blob}`,
          mime: res.mimeType,
          name: res.uri
        });
      }
    }
  }
  return toolFiles(items);
}

function firstDiff(
  content: unknown
): { path: string; oldText: string | null; newText: string } | null {
  if (!Array.isArray(content)) return null;
  for (const raw of content) {
    const item = rec(raw);
    if (item.type === 'diff' && typeof item.newText === 'string' && typeof item.path === 'string') {
      return {
        path: item.path,
        oldText: typeof item.oldText === 'string' ? item.oldText : null,
        newText: item.newText
      };
    }
  }
  return null;
}

function firstPath(update: Record<string, unknown>): string | null {
  const locations = update.locations;
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      const path = str(rec(loc).path);
      if (path) return path;
    }
  }
  const input = rec(update.rawInput);
  return (
    str(input.file_path) ??
    str(input.filePath) ??
    str(input.path) ??
    str(input.abs_path) ??
    str(input.filename)
  );
}

export function toolStatus(status: unknown): ToolStatus | null {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    default:
      return null;
  }
}

function shortPath(path: string, cwd: string | null): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

function midTruncate(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) * 0.6);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
}

export function toolShape(
  update: Record<string, unknown>,
  cwd: string | null
): { name: string; input: Record<string, unknown>; summary: string; title: string | null } {
  const kind = str(update.kind) ?? 'other';
  const title = str(update.title);
  const raw = rec(update.rawInput);
  const path = firstPath(update);
  const diff = firstDiff(update.content);
  switch (kind) {
    case 'execute': {
      const command =
        str(raw.command) ??
        (Array.isArray(raw.command) ? raw.command.join(' ') : null) ??
        title ??
        '';
      return {
        name: 'Bash',
        input: { command, ...(str(raw.description) ? { description: raw.description } : {}) },
        summary: midTruncate(command),
        title: command || title
      };
    }
    case 'edit': {
      const file = diff?.path ?? path ?? '';
      const input: Record<string, unknown> = { file_path: file };
      if (diff) {
        input.old_string = diff.oldText ?? '';
        input.new_string = diff.newText;
      }
      const name = diff && diff.oldText === null ? 'Write' : 'Edit';
      if (name === 'Write' && diff) input.content = diff.newText;
      return {
        name,
        input,
        summary: file ? (shortPath(file, cwd).split('/').pop() ?? file) : (title ?? ''),
        title: file || title
      };
    }
    case 'read':
      return {
        name: 'Read',
        input: { file_path: path ?? '' },
        summary: path ? (shortPath(path, cwd).split('/').pop() ?? path) : (title ?? ''),
        title: path ?? title
      };
    case 'search': {
      const pattern = str(raw.pattern) ?? str(raw.query) ?? title ?? '';
      return { name: 'Grep', input: { pattern }, summary: midTruncate(pattern), title: pattern };
    }
    case 'fetch': {
      const url = str(raw.url) ?? title ?? '';
      return { name: 'WebFetch', input: { url }, summary: midTruncate(url), title: url };
    }
    case 'think':
      return { name: 'Task', input: raw, summary: title ?? '', title };
    default:
      return {
        name: title ?? 'Tool',
        input: raw,
        summary: path ? shortPath(path, cwd) : '',
        title
      };
  }
}

function permissionKind(toolKind: string | null): string {
  switch (toolKind) {
    case 'execute':
      return 'bash';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'fetch':
      return 'webfetch';
    case 'read':
      return 'read';
    default:
      return toolKind ?? 'tool';
  }
}

export function pickOption(
  options: AcpPermissionOption[],
  reply: PermissionReply
): AcpPermissionOption | null {
  const order: string[] =
    reply === 'always'
      ? ['allow_always', 'allow_once']
      : reply === 'once'
        ? ['allow_once', 'allow_always']
        : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit;
  }
  return null;
}

export class AcpReducer {
  readonly chatId: string;
  lastSeq = 0;
  activity: AcpActivity = 'idle';
  outstanding = 0;
  title: string | null = null;
  configOptions: AcpConfigOption[] = [];
  commands: { name: string; description?: string }[] = [];
  agentSessionId: string | null = null;
  fatal: string | null = null;
  readonly permissions = new Map<string, AcpPendingPermission>();
  readonly checkpoints = new Map<string, string>();
  readonly tools = new Map<string, ToolEntry>();
  private text: TextEntry | null = null;
  private textKey: string | null = null;
  private thinking: ThinkingEntry | null = null;
  private turnStart: number | null = null;
  private pendingCheckpoint: string[] = [];
  private turnTools: ToolEntry[] = [];

  constructor(
    chatId: string,
    private readonly target: AcpTarget,
    private readonly cwd: string | null = null
  ) {
    this.chatId = chatId;
  }

  private push<T extends ChatEntry>(entry: T): T {
    this.target.entries.push(entry);
    return this.target.entries[this.target.entries.length - 1] as T;
  }

  private breakText() {
    this.text = null;
    this.textKey = null;
    if (this.thinking) {
      this.thinking.done = true;
      this.thinking = null;
    }
  }

  get busy(): boolean {
    return this.outstanding > 0;
  }

  apply(ev: AcpEvent): boolean {
    if (ev.seq <= this.lastSeq) return false;
    this.lastSeq = ev.seq;
    const data = rec(ev.data);
    switch (ev.kind) {
      case 'created':
        this.title = str(data.title) ?? this.title;
        break;
      case 'session':
        this.agentSessionId = str(data.agentSessionId) ?? this.agentSessionId;
        if (Array.isArray(data.configOptions))
          this.configOptions = data.configOptions as AcpConfigOption[];
        this.fatal = null;
        break;
      case 'config':
        if (Array.isArray(data.configOptions))
          this.configOptions = data.configOptions as AcpConfigOption[];
        break;
      case 'prompt':
        this.prompt(ev, data);
        break;
      case 'checkpoint': {
        const commit = str(data.commit);
        const messageId = this.pendingCheckpoint.shift();
        if (commit && messageId) this.checkpoints.set(messageId, commit);
        break;
      }
      case 'turn.start':
        this.breakText();
        this.turnStart = ev.ts;
        this.turnTools = [];
        this.outstanding = Math.max(this.outstanding, 1);
        this.activity = this.permissions.size ? 'needs_input' : 'working';
        break;
      case 'turn.end':
      case 'prompt.done':
        this.endTurn(ev, data);
        break;
      case 'update':
        this.update(ev, data);
        break;
      case 'permission.request':
        this.permissionRequest(ev, data);
        break;
      case 'permission.resolve':
        this.permissionResolve(ev, data);
        break;
      case 'cancel':
        this.permissions.clear();
        break;
      case 'error': {
        this.breakText();
        const message = str(data.message) ?? 'The agent failed';
        if (data.fatal === 'true') this.fatal = message;
        this.push<ErrorEntry>({ kind: 'error', key: key(), detail: message, time: ev.ts });
        break;
      }
      case 'agent.exit':
        this.breakText();
        this.permissions.clear();
        this.push<ErrorEntry>({
          kind: 'error',
          key: key(),
          detail: `The agent stopped${str(data.detail) ? `: ${data.detail}` : ''}`,
          time: ev.ts
        });
        break;
      case 'revert':
        this.breakText();
        this.push<NoteEntry>({
          kind: 'note',
          key: key(),
          time: ev.ts,
          requestId: `revert:${ev.seq}`,
          tone: 'answered',
          lead: 'Files restored to an earlier checkpoint',
          target: null,
          mono: false,
          auto: false
        });
        break;
      default:
        break;
    }
    this.refreshActivity();
    return true;
  }

  private refreshActivity() {
    this.activity =
      this.permissions.size > 0 ? 'needs_input' : this.outstanding > 0 ? 'working' : 'idle';
  }

  private prompt(ev: AcpEvent, data: Record<string, unknown>) {
    this.breakText();
    const messageId = str(data.messageId) ?? `seq_${ev.seq}`;
    const text = blockText(data.prompt);
    const author: ChatAuthor | null = ev.author?.id
      ? { id: ev.author.id, name: ev.author.name ?? '', avatarUrl: ev.author.avatarUrl ?? null }
      : null;
    const existing = this.target.entries.find(
      (e): e is UserEntry => e.kind === 'user' && e.messageID === messageId
    );
    if (existing) {
      existing.local = false;
      if (author) existing.author = author;
      existing.time = ev.ts;
    } else {
      this.push<UserEntry>({
        kind: 'user',
        key: key(),
        text,
        time: ev.ts,
        messageID: messageId,
        author
      });
    }
    this.pendingCheckpoint.push(messageId);
    this.outstanding += 1;
  }

  private endTurn(ev: AcpEvent, data: Record<string, unknown>) {
    this.breakText();
    this.outstanding = Math.max(0, this.outstanding - 1);
    if (ev.kind === 'prompt.done') return;
    const stop = str(data.stopReason) ?? 'end_turn';
    for (const tool of this.turnTools) {
      if (tool.status === 'pending' || tool.status === 'running') {
        tool.status = stop === 'cancelled' ? 'error' : 'completed';
        if (stop === 'cancelled') tool.failed = true;
      }
    }
    if (stop === 'error') return;
    const files = new Map<string, TurnFile>();
    for (const tool of this.turnTools) {
      if ((tool.name !== 'Edit' && tool.name !== 'Write') || !tool.title) continue;
      const prev = files.get(tool.title);
      const add = tool.diff?.add ?? 0;
      const del = tool.diff?.del ?? 0;
      if (prev) {
        prev.add += add;
        prev.del += del;
      } else {
        files.set(tool.title, {
          name: tool.title.split('/').pop() ?? tool.title,
          path: tool.title,
          add,
          del
        });
      }
    }
    this.push<ResultEntry>({
      kind: 'result',
      key: key(),
      cost: null,
      duration: this.turnStart !== null ? Math.max(0, ev.ts - this.turnStart) : null,
      files: [...files.values()],
      time: ev.ts
    });
    if (stop === 'cancelled') {
      this.push<ErrorEntry>({ kind: 'error', key: key(), detail: 'Stopped', time: ev.ts });
    } else if (stop === 'refusal' || stop === 'max_tokens' || stop === 'max_turn_requests') {
      const why =
        stop === 'refusal'
          ? 'The agent declined to continue'
          : stop === 'max_tokens'
            ? 'The agent ran out of output tokens'
            : 'The agent hit its turn limit';
      this.push<ErrorEntry>({ kind: 'error', key: key(), detail: why, time: ev.ts });
    }
    this.turnStart = null;
    this.turnTools = [];
  }

  private update(ev: AcpEvent, update: Record<string, unknown>) {
    const kind = str(update.sessionUpdate);
    switch (kind) {
      case 'agent_message_chunk': {
        const content = rec(update.content);
        const chunk = content.type === 'text' ? (str(content.text) ?? '') : '';
        if (!chunk) return;
        if (this.thinking) {
          this.thinking.done = true;
          this.thinking = null;
        }
        const messageKey = str(update.messageId);
        if (!this.text || (messageKey && messageKey !== this.textKey)) {
          this.text = this.push<TextEntry>({ kind: 'text', key: key(), text: '', time: ev.ts });
          this.textKey = messageKey;
        }
        this.text.text += chunk;
        return;
      }
      case 'agent_thought_chunk': {
        const content = rec(update.content);
        const chunk = content.type === 'text' ? (str(content.text) ?? '') : '';
        if (!chunk) return;
        this.text = null;
        this.textKey = null;
        if (!this.thinking) {
          this.thinking = this.push<ThinkingEntry>({
            kind: 'thinking',
            key: key(),
            text: '',
            done: false,
            expanded: false,
            time: ev.ts
          });
        }
        this.thinking.text += chunk;
        return;
      }
      case 'user_message_chunk':
        return;
      case 'tool_call':
        this.toolCall(ev, update);
        return;
      case 'tool_call_update':
        this.toolUpdate(update);
        return;
      case 'plan':
        this.plan(ev, update);
        return;
      case 'session_info_update':
        this.title = str(update.title) ?? this.title;
        return;
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions as AcpConfigOption[];
        }
        return;
      case 'current_mode_update': {
        const mode = str(update.currentModeId);
        if (mode) {
          this.configOptions = this.configOptions.map((o) =>
            o.category === 'mode' || o.id === 'mode' ? { ...o, currentValue: mode } : o
          );
        }
        return;
      }
      case 'available_commands_update':
        if (Array.isArray(update.availableCommands)) {
          this.commands = (update.availableCommands as unknown[])
            .map((c) => rec(c))
            .filter((c) => typeof c.name === 'string')
            .map((c) => ({ name: c.name as string, description: str(c.description) ?? undefined }));
        }
        return;
      default:
        return;
    }
  }

  private toolCall(ev: AcpEvent, update: Record<string, unknown>) {
    this.breakText();
    const id = str(update.toolCallId) ?? `seq_${ev.seq}`;
    const existing = this.tools.get(id);
    if (existing) {
      this.toolUpdate(update);
      return;
    }
    const shape = toolShape(update, this.cwd);
    const entry = this.push<ToolEntry>({
      kind: 'tool',
      key: key(),
      id,
      name: shape.name,
      input: shape.input,
      output: null,
      summary: shape.summary,
      title: shape.title,
      diff: null,
      status: toolStatus(update.status) ?? 'pending',
      failed: update.status === 'failed',
      expanded: null,
      time: ev.ts
    });
    this.tools.set(id, entry);
    this.turnTools.push(entry);
    this.fillTool(entry, update);
  }

  private toolUpdate(update: Record<string, unknown>) {
    const id = str(update.toolCallId);
    const entry = id ? this.tools.get(id) : null;
    if (!entry) return;
    if (update.kind || update.rawInput || update.locations || update.title) {
      const merged = { kind: inferKind(entry.name), ...update };
      const shape = toolShape(merged, this.cwd);
      if (shape.title) entry.title = shape.title;
      if (shape.summary) entry.summary = shape.summary;
      if (update.kind || update.rawInput) {
        entry.name = shape.name;
        entry.input = shape.input;
      }
    }
    const status = toolStatus(update.status);
    if (status) {
      entry.status = status;
      entry.failed = status === 'error';
    }
    this.fillTool(entry, update);
  }

  private fillTool(entry: ToolEntry, update: Record<string, unknown>) {
    const diff = firstDiff(update.content);
    if (diff) {
      entry.diff = { add: countLines(diff.newText), del: countLines(diff.oldText) };
      const input = rec(entry.input);
      if (entry.name === 'Edit' || entry.name === 'Write') {
        entry.input = {
          ...input,
          file_path: diff.path,
          old_string: diff.oldText ?? '',
          new_string: diff.newText,
          ...(entry.name === 'Write' ? { content: diff.newText } : {})
        };
        entry.title = diff.path;
        entry.summary = shortPath(diff.path, this.cwd).split('/').pop() ?? diff.path;
      }
    }
    const text = contentText(update.content);
    const raw = typeof update.rawOutput === 'string' ? update.rawOutput : null;
    const output = text || raw;
    if (output) entry.output = output.slice(0, OUTPUT_CAP);
    const files = contentFiles(update.content);
    if (files.length) entry.files = files;
  }

  private plan(ev: AcpEvent, update: Record<string, unknown>) {
    if (!Array.isArray(update.entries)) return;
    const lines = (update.entries as unknown[]).map((raw) => {
      const item = rec(raw);
      const mark = item.status === 'completed' ? 'x' : ' ';
      const suffix = item.status === 'in_progress' ? ' (in progress)' : '';
      return `- [${mark}] ${str(item.content) ?? ''}${suffix}`;
    });
    this.breakText();
    const prev = this.target.entries[this.target.entries.length - 1];
    if (prev && prev.kind === 'text' && prev.text.startsWith('**Plan**\n')) {
      prev.text = `**Plan**\n${lines.join('\n')}`;
      return;
    }
    this.push<TextEntry>({
      kind: 'text',
      key: key(),
      text: `**Plan**\n${lines.join('\n')}`,
      time: ev.ts
    });
  }

  private permissionRequest(ev: AcpEvent, data: Record<string, unknown>) {
    const requestId = str(data.requestId);
    if (!requestId) return;
    const toolCall = rec(data.toolCall);
    const callId = str(toolCall.toolCallId);
    const tool = callId ? this.tools.get(callId) : null;
    const toolKind = str(toolCall.kind) ?? (tool ? inferKind(tool.name) : null);
    const shape = toolShape({ ...toolCall, kind: toolKind ?? 'other' }, this.cwd);
    const metadata: Record<string, unknown> = {};
    const input = tool ? rec(tool.input) : shape.input;
    if (typeof input.command === 'string' && input.command) metadata.command = input.command;
    if (typeof input.file_path === 'string' && input.file_path) metadata.filepath = input.file_path;
    if (typeof input.url === 'string' && input.url) metadata.url = input.url;
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      metadata.diff = unifiedDiff(
        String(input.file_path ?? ''),
        input.old_string,
        input.new_string
      );
    }
    const options = Array.isArray(data.options)
      ? (data.options as unknown[])
          .map((o) => rec(o))
          .filter((o) => typeof o.optionId === 'string')
          .map((o) => ({
            optionId: o.optionId as string,
            name: str(o.name) ?? (o.optionId as string),
            kind: str(o.kind) ?? 'allow_once'
          }))
      : [];
    this.permissions.set(requestId, {
      seen: ev.ts,
      options,
      request: {
        kind: 'permission',
        id: requestId,
        sessionID: this.chatId,
        permission: permissionKind(toolKind),
        patterns: [],
        always: options.some((o) => o.kind === 'allow_always') ? ['*'] : [],
        metadata,
        title: str(toolCall.title) ?? tool?.title ?? shape.title,
        messageID: null,
        callID: callId,
        legacy: false
      }
    });
  }

  private permissionResolve(ev: AcpEvent, data: Record<string, unknown>) {
    const requestId = str(data.requestId);
    if (!requestId) return;
    const pending = this.permissions.get(requestId);
    this.permissions.delete(requestId);
    if (!pending) return;
    const option = pending.options.find((o) => o.optionId === data.optionId);
    const allowed = !data.cancelled && !!option && option.kind.startsWith('allow');
    const title = pending.request.title;
    this.push<NoteEntry>({
      kind: 'note',
      key: key(),
      time: ev.ts,
      requestId,
      tone: allowed ? 'allowed' : 'denied',
      lead: allowed ? (option?.kind === 'allow_always' ? 'Always allowed' : 'Allowed') : 'Denied',
      target: title,
      mono: pending.request.permission === 'bash',
      auto: false
    });
  }
}

function inferKind(name: string): string {
  switch (name) {
    case 'Bash':
      return 'execute';
    case 'Edit':
    case 'Write':
      return 'edit';
    case 'Read':
      return 'read';
    case 'Grep':
      return 'search';
    case 'WebFetch':
      return 'fetch';
    case 'Task':
      return 'think';
    default:
      return 'other';
  }
}

function unifiedDiff(path: string, before: string, after: string): string {
  const minus = before ? before.split('\n').map((l) => `-${l}`) : [];
  const plus = after.split('\n').map((l) => `+${l}`);
  return [`--- a/${path}`, `+++ b/${path}`, '@@', ...minus, ...plus].join('\n');
}

export function acpOptionValues(
  option: AcpConfigOption
): { value: string; name: string; description?: string; group?: string }[] {
  const out: { value: string; name: string; description?: string; group?: string }[] = [];
  for (const item of option.options ?? []) {
    if ('group' in item && Array.isArray(item.options)) {
      for (const inner of item.options) out.push({ ...inner, group: item.name });
    } else if ('value' in item) {
      out.push(item);
    }
  }
  return out;
}
