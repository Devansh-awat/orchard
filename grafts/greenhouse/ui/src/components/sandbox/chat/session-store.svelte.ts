import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { apiFetch, toasts } from '../../../host/stores';
import {
  OC_ATTACH_MAX_BYTES,
  OC_ATTACH_MAX_COUNT,
  OC_MODEL,
  ocBase,
  ocErrorMessage,
  ocFastSibling,
  ocFilePart,
  ocFmtBytes,
  ocFmtTokens,
  ocIsAborted,
  ocIsAuthError,
  ocModelGroups,
  ocModels,
  ocNormalizeTool,
  ocPartAttachment,
  ocProbe,
  ocReadAttachment,
  ocRepo,
  type OcAttachment,
  type OcEvent,
  type OcMessage,
  type OcMessageInfo,
  type OcModel,
  type OcPart,
  type OcSession,
  type OcToolState,
  type OcTokens
} from '../opencode';
import {
  EDIT_TOOLS,
  FILE_TOOLS,
  countLines,
  fmtCost,
  fmtDuration,
  midTruncate,
  truncate
} from './format';
import {
  noteFor,
  parseOutcome,
  parsePermission,
  parseQuestion,
  parseRequestList,
  planHandoff,
  replyGone,
  requestDetail,
  type AgentRequest,
  type NoteTone,
  type PermissionReply,
  type PermissionRequest,
  type QuestionRequest,
  type RequestOutcome
} from './pending';
import { parseTodos, undoTarget, type TodoItem } from './slash-commands';
import { claimForMessage, claimOwnPrompt, placeUserPart } from './prompt-claims';
import { AcpChat, isAcpChat, newAcpMessageId, type AcpChatInfo } from './acp-chat.svelte';
import type { AcpConfigOption } from './acp-reducer';

export type ChatAuthor = { id: string; name: string; avatarUrl?: string | null };

export type ChatComment = {
  id: string;
  author: ChatAuthor;
  body: string;
  createdAt: string | number;
  sessionId: string;
};

export type { SlashCommand, SlashOption } from './slash-commands';

export type RemoteDraft = { userId: string; name: string; text: string; avatarUrl?: string | null };

export type TurnFile = { name: string; path: string; add: number; del: number };

export type ToolStatus = OcToolState['status'];

export type UserEntry = {
  kind: 'user';
  key: string;
  text: string;
  time: number;
  messageID?: string;
  attachments?: OcAttachment[];
  author?: ChatAuthor | null;
  local?: boolean;
};

export type ThinkingEntry = {
  kind: 'thinking';
  key: string;
  text: string;
  done: boolean;
  expanded: boolean;
  time?: number;
};

export type TextEntry = { kind: 'text'; key: string; text: string; time?: number };

export type ToolEntry = {
  kind: 'tool';
  key: string;
  id: string | null;
  name: string;
  input: unknown;
  output: string | null;
  summary: string;
  title: string | null;
  diff: { add: number; del: number } | null;
  status: ToolStatus | null;
  failed: boolean;
  expanded: boolean | null;
  time?: number;
};

export type AgentEntry = {
  kind: 'agent';
  key: string;
  id: string;
  childID: string | null;
  description: string;
  agentType: string;
  status: ToolStatus;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  entries: ChatEntry[];
  time?: number;
};

export type ResultEntry = {
  kind: 'result';
  key: string;
  cost: number | null;
  duration: number | null;
  files: TurnFile[];
  time?: number;
};

export type ErrorEntry = {
  kind: 'error';
  key: string;
  detail: string;
  time?: number;
  auth?: boolean;
  messageID?: string;
};

export type NoteEntry = {
  kind: 'note';
  key: string;
  time: number;
  requestId: string;
  tone: NoteTone;
  lead: string;
  target: string | null;
  mono: boolean;
  auto: boolean;
};

export type ChatEntry =
  | UserEntry
  | ThinkingEntry
  | TextEntry
  | ToolEntry
  | AgentEntry
  | ResultEntry
  | ErrorEntry
  | NoteEntry;

export type PendingState = 'open' | 'sending' | 'auto';

export type PendingItem = {
  request: AgentRequest;
  dir: string | null;
  state: PendingState;
  seen: number;
};

type ReplyResult = { ok: true } | { gone: true } | { error: string };

export type FeedEntry = { entry: ChatEntry; index: number };

export type FeedItem =
  | { type: 'entry'; key: string; entry: ChatEntry; index: number }
  | {
      type: 'prompt';
      key: string;
      entry: UserEntry;
      index: number;
      author: ChatAuthor | null;
      own: boolean;
      grouped: boolean;
    }
  | {
      type: 'comment';
      key: string;
      comment: ChatComment;
      own: boolean;
      grouped: boolean;
    }
  | { type: 'tools'; key: string; items: FeedEntry[] };

const GROUPABLE = new Set(['tool', 'thinking']);

export type ModelChoice = {
  providerID: string;
  modelID: string;
  variant: string | null;
  plan: boolean;
  agent: string | null;
};

export type QueuedPrompt = {
  id: string;
  text: string;
  attachments: OcAttachment[];
  choice: ModelChoice;
  createdAt: number;
};

export type AcpCatalogEntry = {
  id: string;
  label: string;
  installed: boolean;
  available: boolean;
  error?: string;
  version?: string;
  configOptions?: AcpConfigOption[] | null;
};

export type AcpChoice = { agent: string; model: string | null };

export type ChatSession = {
  id: string;
  title: string;
  directory: string | null;
  repo: string | null;
  pending: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'unreachable';

export type FollowUpMode = 'queue' | 'steer';

export type AgentSignalKind = 'done' | 'attention' | 'error';

export type AgentSignal = { kind: AgentSignalKind; sessionId: string; detail: string | null };

export type SessionActivity = 'idle' | 'busy' | 'retry';

export type ContextMeter = {
  used: number;
  limit: number | null;
  pct: number;
  tooltip: string;
  tokens: OcTokens | null;
};

export type SessionStoreOptions = {
  initialSessionId?: string | null;
  preferredSessionId?: () => string | null;
  autoSelect?: boolean;
  directory?: string | null;
  self?: ChatAuthor | null;
  onTurnDone?: () => void;
  onSignal?: (signal: AgentSignal) => void;
  onDraftChange?: (text: string) => void;
  beforePrompt?: (sessionId: string, text: string) => Promise<{ messageID?: string }>;
};

const TEMP_PREFIX = 'pending-';
const MODELS_CACHE_PREFIX = 'oc-models:';

function cachedModels(sandboxId: string): OcModel[] {
  try {
    const raw = localStorage.getItem(`${MODELS_CACHE_PREFIX}${sandboxId}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as OcModel[]) : [];
  } catch {
    return [];
  }
}

function cacheModels(sandboxId: string, models: OcModel[]) {
  try {
    localStorage.setItem(`${MODELS_CACHE_PREFIX}${sandboxId}`, JSON.stringify(models));
  } catch {
    return;
  }
}
const AUTO_LINGER_MS = 1500;
const GONE_GRACE_MS = 3000;
const PARENT_HOPS = 4;
const DONE_CAP = 500;
const RETRY_PROBE_MS = 10_000;
const RECONNECT_MS = 2000;
const STATUS_POLL_MS = 5000;
const STATUS_GRACE_MS = 4000;
const OUTPUT_CAP = 4000;

const SKIP_PARTS = new Set([
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'agent',
  'retry',
  'compaction',
  'subtask',
  'file'
]);

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `e${keySeq.toString(36)}`;
}

export function commentTime(comment: ChatComment): number {
  return typeof comment.createdAt === 'number'
    ? comment.createdAt
    : new Date(comment.createdAt).getTime();
}

function partTime(part: OcPart, fallback: number): number {
  const state = part.state as { time?: { start?: number } } | undefined;
  return part.time?.start ?? state?.time?.start ?? fallback;
}

function groupRuns(raw: FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  let run: FeedEntry[] = [];
  const flush = () => {
    let start = 0;
    let end = run.length;
    while (start < end && run[start].entry.kind === 'thinking') start += 1;
    while (end > start && run[end - 1].entry.kind === 'thinking') end -= 1;
    const core = run.slice(start, end);
    const tools = core.filter((item) => item.entry.kind === 'tool').length;
    const loose = (items: FeedEntry[]) => {
      for (const item of items) {
        out.push({ type: 'entry', key: item.entry.key, entry: item.entry, index: item.index });
      }
    };
    if (tools >= 2) {
      loose(run.slice(0, start));
      out.push({ type: 'tools', key: `g:${core[0].entry.key}`, items: core });
      loose(run.slice(end));
    } else {
      loose(run);
    }
    run = [];
  };
  for (const item of raw) {
    if (item.type === 'entry' && GROUPABLE.has(item.entry.kind)) {
      run.push({ entry: item.entry, index: item.index });
      continue;
    }
    if (run.length > 0) flush();
    out.push(item);
  }
  if (run.length > 0) flush();
  return out;
}

function toSession(session: OcSession): ChatSession {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory || null,
    repo: ocRepo(session.directory),
    pending: false,
    createdAt: session.time.created,
    updatedAt: session.time.updated
  };
}

async function failure(res: Response, fallback: string): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  return new Error(data?.data?.message || data?.message || fallback);
}

function makeToolEntry(id: string | null, name: string, toolInput: unknown): ToolEntry {
  const record =
    toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  let summary = '';
  let title: string | null = null;
  if (name === 'Bash' && typeof record.command === 'string') {
    summary = midTruncate(record.command);
    title = record.command;
  } else if (FILE_TOOLS.has(name) && typeof record.file_path === 'string') {
    summary = record.file_path.split('/').pop() ?? record.file_path;
    title = record.file_path;
  } else if (typeof record.pattern === 'string') {
    summary = midTruncate(record.pattern);
    title = record.pattern;
  } else if (typeof record.url === 'string') {
    summary = midTruncate(record.url);
    title = record.url;
  } else if (Object.keys(record).length > 0) {
    try {
      summary = truncate(JSON.stringify(record), 60);
    } catch {
      summary = '';
    }
  }
  let diff: { add: number; del: number } | null = null;
  if (
    name === 'Edit' &&
    typeof record.old_string === 'string' &&
    typeof record.new_string === 'string'
  ) {
    diff = { add: countLines(record.new_string), del: countLines(record.old_string) };
  } else if (name === 'Write' && typeof record.content === 'string') {
    diff = { add: countLines(record.content), del: 0 };
  }
  return {
    kind: 'tool',
    key: nextKey(),
    id,
    name,
    input: toolInput,
    output: null,
    summary,
    title,
    diff,
    status: null,
    failed: false,
    expanded: null
  };
}

function toolEntryFromPart(part: OcPart): ToolEntry {
  const norm = ocNormalizeTool(part.tool ?? 'tool', part.state?.input);
  const entry = makeToolEntry(part.id, norm.name, norm.input);
  if (!entry.summary && typeof part.state?.title === 'string') {
    entry.summary = midTruncate(part.state.title);
  }
  const state = part.state as (OcToolState & { output?: unknown }) | undefined;
  entry.status = state?.status ?? null;
  if (state?.status === 'error') {
    entry.failed = true;
    entry.output = typeof state.error === 'string' ? state.error.slice(0, OUTPUT_CAP) : null;
  } else if (typeof state?.output === 'string') {
    entry.output = state.output.slice(0, OUTPUT_CAP);
  }
  return entry;
}

function agentFields(part: OcPart) {
  const meta = part.state?.metadata ?? {};
  const input = part.state?.input ?? {};
  const childID =
    typeof meta.sessionId === 'string'
      ? meta.sessionId
      : typeof meta.sessionID === 'string'
        ? meta.sessionID
        : null;
  const description =
    typeof input.description === 'string' ? input.description : (part.state?.title ?? 'Sub-agent');
  const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
  return {
    childID,
    description,
    agentType,
    status: (part.state?.status ?? 'pending') as ToolStatus
  };
}

function turnFiles(entries: ChatEntry[]): TurnFile[] {
  const byPath = new Map<string, TurnFile>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === 'user' || entry.kind === 'result') break;
    if (entry.kind !== 'tool' || !EDIT_TOOLS.has(entry.name) || !entry.title) continue;
    const existing = byPath.get(entry.title);
    const add = entry.diff?.add ?? 0;
    const del = entry.diff?.del ?? 0;
    if (existing) {
      existing.add += add;
      existing.del += del;
    } else {
      byPath.set(entry.title, {
        name: entry.title.split('/').pop() ?? entry.title,
        path: entry.title,
        add,
        del
      });
    }
  }
  return [...byPath.values()].reverse();
}

function userEntriesFrom(info: OcMessageInfo, parts: OcPart[]): UserEntry[] {
  const files: OcAttachment[] = [];
  for (const part of parts) {
    const attachment = ocPartAttachment(part);
    if (attachment) files.push(attachment);
  }
  const out: UserEntry[] = [];
  for (const part of parts) {
    if (part.type !== 'text' || !part.text?.trim() || part.synthetic || part.ignored) continue;
    out.push({
      kind: 'user',
      key: nextKey(),
      text: part.text,
      time: info.time.created,
      messageID: info.id,
      ...(out.length > 0 || files.length === 0 ? {} : { attachments: files })
    });
  }
  if (out.length === 0 && files.length > 0) {
    out.push({
      kind: 'user',
      key: nextKey(),
      text: '',
      time: info.time.created,
      messageID: info.id,
      attachments: files
    });
  }
  return out;
}

export function agentOf(choice: ModelChoice): string {
  if (choice.plan) return 'plan';
  return choice.agent ?? 'build';
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function bodyMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const data = body as { message?: unknown; data?: { message?: unknown } };
    if (typeof data.data?.message === 'string') return data.data.message;
    if (typeof data.message === 'string') return data.message;
  }
  return fallback;
}

export class SessionThread {
  id: string;
  entries = $state<ChatEntry[]>([]);
  loading = $state(false);
  failed = $state(false);
  busy = $state(false);
  stopping = $state(false);
  ctxTokens = $state<OcTokens | null>(null);
  revertedMessageID = $state<string | null>(null);
  queue = $state<QueuedPrompt[]>([]);
  loaded = false;
  lastChoice: ModelChoice | null = null;
  turnStart = 0;
  readonly parts = new Map<string, ChatEntry>();
  readonly agents = new Map<string, AgentEntry>();
  readonly turnCosts = new Map<string, number>();

  constructor(id: string) {
    this.id = id;
  }

  reset() {
    this.entries = [];
    this.parts.clear();
    this.agents.clear();
    this.ctxTokens = null;
    this.revertedMessageID = null;
  }

  push<T extends ChatEntry>(entry: T, target: ChatEntry[] = this.entries): T {
    target.push(entry);
    return target[target.length - 1] as T;
  }
}

export class ChatSessionStore {
  readonly sandboxId: string;

  connection = $state<ConnectionState>('idle');
  settled = $state(false);
  models = $state.raw<OcModel[]>([]);
  modelsFailed = $state(false);
  selecting = $state(false);
  sessions = $state<ChatSession[]>([]);
  activeId = $state<string | null>(null);
  readonly threads = new SvelteMap<string, SessionThread>();
  readonly activity = new SvelteMap<string, SessionActivity>();
  readonly waiting = new SvelteSet<string>();
  readonly pending = new SvelteMap<string, PendingItem>();
  readonly deleted = new SvelteSet<string>();
  readonly acpChats = new SvelteMap<string, AcpChat>();
  acpCatalog = $state.raw<AcpCatalogEntry[]>([]);
  acpChoice = $state.raw<AcpChoice | null>(null);
  onAgentPick: ((agent: string, model: string | null) => void) | null = null;
  onNativePick: (() => void) | null = null;
  #acpBusy = new Map<string, boolean>();

  providerID = $state(OC_MODEL.providerID);
  modelID = $state(OC_MODEL.modelID);
  variant = $state<string | null>(null);
  plan = $state(false);
  agent = $state<string | null>(null);

  attachments = $state<OcAttachment[]>([]);
  revertBusy = $state<string | null>(null);
  sentTick = $state(0);

  directory = $state<string | null>(null);
  self = $state.raw<ChatAuthor | null>(null);
  comments = $state.raw<ChatComment[]>([]);
  authorOf = $state.raw<(messageId: string) => ChatAuthor | null>(() => null);
  isHost = $state.raw<() => boolean>(() => true);
  canAnswer = $state.raw<() => boolean>(() => true);
  autoAccept = $state.raw<() => boolean>(() => false);
  answerAuthorOf = $state.raw<(requestId: string) => ChatAuthor | null>(() => null);
  beforePrompt: SessionStoreOptions['beforePrompt'] | null = null;
  onDraftChange: ((text: string) => void) | null = null;
  onTurnDone: (() => void) | null = null;
  onSignal: ((signal: AgentSignal) => void) | null = null;

  #draft = $state('');
  #initialSessionId: string | null;
  readonly #preferredSessionId: (() => string | null) | null;
  readonly #autoSelect: boolean;
  #prefs = new Map<string, ModelChoice>();
  #roles = new Map<string, string>();
  #children = new Map<string, { thread: SessionThread; agent: AgentEntry }>();
  #asked = new Set<string>();
  readonly #parents = new SvelteMap<string, string>();
  readonly #answeredHere = new SvelteSet<string>();
  #notes = new Map<string, NoteEntry[]>();
  #done = new Set<string>();
  #replyApi: 'current' | 'legacy' | null = null;
  #pendingSync: Promise<void> | null = null;
  #createWork: Promise<void> | null = null;
  #probing: Promise<void> | null = null;
  #live = false;
  #connectedOnce = false;
  #stream: AbortController | null = null;
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #syncing: Promise<void> | null = null;
  #destroyed = false;

  constructor(sandboxId: string, options: SessionStoreOptions = {}) {
    this.sandboxId = sandboxId;
    this.#initialSessionId = options.initialSessionId ?? null;
    this.#preferredSessionId = options.preferredSessionId ?? null;
    this.#autoSelect = options.autoSelect ?? true;
    this.models = cachedModels(sandboxId);
    this.directory = options.directory ?? null;
    this.self = options.self ?? null;
    this.onTurnDone = options.onTurnDone ?? null;
    this.onSignal = options.onSignal ?? null;
    this.onDraftChange = options.onDraftChange ?? null;
    this.beforePrompt = options.beforePrompt ?? null;
  }

  get draft(): string {
    return this.#draft;
  }

  set draft(text: string) {
    this.#draft = text;
    this.onDraftChange?.(text);
  }

  readonly active = $derived(this.activeId ? (this.threads.get(this.activeId) ?? null) : null);

  readonly activeSession = $derived(this.sessions.find((s) => s.id === this.activeId) ?? null);

  readonly activeAcp = $derived(this.activeId ? (this.acpChats.get(this.activeId) ?? null) : null);

  registerAcpChats(chats: AcpChatInfo[]) {
    for (const info of chats) {
      if (this.acpChats.has(info.id)) continue;
      const thread = this.#thread(info.id);
      const chat = new AcpChat(this.sandboxId, info, thread, (c) => this.#syncAcp(c));
      this.acpChats.set(info.id, chat);
      if (!this.sessions.some((s) => s.id === info.id)) {
        this.sessions = [
          ...this.sessions,
          {
            id: info.id,
            title: info.title,
            directory: info.cwd,
            repo: info.cwd ? ocRepo(info.cwd) : null,
            pending: false,
            createdAt: info.createdAt,
            updatedAt: info.createdAt
          }
        ];
      }
      if (this.activeId === info.id) chat.connect();
    }
  }

  forgetAcpChat(id: string) {
    this.acpChats.get(id)?.close();
    this.acpChats.delete(id);
    this.threads.delete(id);
    this.activity.delete(id);
    this.waiting.delete(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    for (const [key, item] of this.pending) {
      if (item.request.sessionID === id) this.pending.delete(key);
    }
    if (this.activeId === id) this.activeId = null;
  }

  #syncAcp(chat: AcpChat) {
    const id = chat.info.id;
    const r = chat.reducer;
    const busy = r.busy;
    this.activity.set(id, busy ? 'busy' : 'idle');
    if (r.activity === 'needs_input') this.waiting.add(id);
    else this.waiting.delete(id);
    for (const [requestId, pending] of r.permissions) {
      if (this.pending.has(requestId)) continue;
      this.pending.set(requestId, {
        request: pending.request,
        dir: chat.info.cwd,
        state: 'open',
        seen: pending.seen
      });
      if (this.autoAccept() && this.canAnswer()) void this.replyPermission(requestId, 'once');
    }
    for (const [requestId, item] of this.pending) {
      if (item.request.sessionID === id && !r.permissions.has(requestId))
        this.pending.delete(requestId);
    }
    const title = chat.title;
    const listed = this.sessions.find((s) => s.id === id);
    if (listed && title && listed.title !== title) {
      this.sessions = this.sessions.map((s) =>
        s.id === id ? { ...s, title, updatedAt: Date.now() } : s
      );
    }
    const was = this.#acpBusy.get(id) ?? false;
    this.#acpBusy.set(id, busy);
    if (was && !busy) {
      this.onTurnDone?.();
      this.onSignal?.({ kind: 'done', sessionId: id, detail: null });
    } else if (r.activity === 'needs_input') {
      this.onSignal?.({ kind: 'attention', sessionId: id, detail: null });
    }
  }

  async #deliverAcp(thread: SessionThread, text: string): Promise<boolean> {
    const chat = this.acpChats.get(thread.id);
    if (!chat) return false;
    const messageID = newAcpMessageId();
    const local = thread.push<UserEntry>({
      kind: 'user',
      key: nextKey(),
      text,
      time: Date.now(),
      messageID,
      author: this.self,
      local: true
    });
    this.sentTick += 1;
    try {
      await chat.prompt(text, messageID);
      return true;
    } catch (e) {
      thread.entries = thread.entries.filter((entry) => entry !== local);
      toasts.add({
        title: 'Could not send',
        description: e instanceof Error ? e.message : undefined,
        color: 'error'
      });
      return false;
    }
  }

  async setAcpConfig(configId: string, value: string | boolean): Promise<boolean> {
    const chat = this.activeAcp;
    if (!chat) return false;
    try {
      await chat.setConfig(configId, value);
      return true;
    } catch (e) {
      toasts.add({
        title: 'Could not change that setting',
        description: e instanceof Error ? e.message : undefined,
        color: 'error'
      });
      return false;
    }
  }

  readonly busy = $derived(this.active?.busy ?? false);

  readonly model = $derived(
    this.models.find((m) => m.providerID === this.providerID && m.modelID === this.modelID) ?? null
  );

  readonly variants = $derived(this.model?.variants ?? []);

  readonly fastSibling = $derived(this.model ? ocFastSibling(this.model, this.models) : null);

  readonly modelGroups = $derived(ocModelGroups(this.models));

  readonly requests = $derived.by((): PendingItem[] => {
    const id = this.activeId;
    if (!id) return [];
    return [...this.pending.values()]
      .filter((item) => item.state !== 'sending' && this.rootOf(item.request.sessionID) === id)
      .sort((a, b) => a.seen - b.seen);
  });

  readonly context = $derived.by((): ContextMeter => {
    const tokens = this.active?.ctxTokens ?? null;
    const limit = this.model?.context ?? null;
    if (!tokens) return { used: 0, limit, pct: 0, tooltip: '', tokens: null };
    const used =
      tokens.total ??
      tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
    return {
      used,
      limit,
      pct: limit && used > 0 ? Math.min(100, (used / limit) * 100) : 0,
      tooltip: [
        `input ${ocFmtTokens(tokens.input)}`,
        `output ${ocFmtTokens(tokens.output)}`,
        `reasoning ${ocFmtTokens(tokens.reasoning)}`,
        `cache read ${ocFmtTokens(tokens.cache.read)}`,
        `cache write ${ocFmtTokens(tokens.cache.write)}`
      ].join('\n'),
      tokens
    };
  });

  readonly feed = $derived.by((): FeedItem[] => {
    const thread = this.active;
    if (!thread) return [];
    const entries = thread.entries;
    const comments = this.comments
      .filter((c) => c.sessionId === thread.id)
      .map((comment) => ({ comment, time: commentTime(comment) }))
      .sort((a, b) => a.time - b.time);
    const selfId = this.self?.id ?? null;
    const raw: FeedItem[] = [];
    let c = 0;
    let clock = 0;
    const pushComment = (comment: ChatComment) => {
      raw.push({
        type: 'comment',
        key: `c:${comment.id}`,
        comment,
        own: comment.author.id === selfId,
        grouped: false
      });
    };
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      clock = Math.max(clock, entry.time ?? clock);
      while (c < comments.length && comments[c].time < clock) {
        pushComment(comments[c].comment);
        c += 1;
      }
      if (entry.kind === 'user') {
        const author = this.authorFor(entry);
        raw.push({
          type: 'prompt',
          key: entry.key,
          entry,
          index,
          author,
          own: !author || author.id === selfId,
          grouped: false
        });
      } else {
        raw.push({ type: 'entry', key: entry.key, entry, index });
      }
    }
    for (; c < comments.length; c += 1) pushComment(comments[c].comment);
    const items = groupRuns(raw);
    let prev: string | null = null;
    for (const item of items) {
      if (item.type === 'prompt' || item.type === 'comment') {
        const id = item.type === 'prompt' ? (item.author?.id ?? selfId) : item.comment.author.id;
        item.grouped = id !== null && id === prev;
        prev = id;
      } else {
        prev = null;
      }
    }
    return items;
  });

  authorFor(entry: UserEntry): ChatAuthor | null {
    return (entry.messageID ? this.authorOf(entry.messageID) : null) ?? entry.author ?? this.self;
  }

  turnPromptId(index: number): string | null {
    const entries = this.active?.entries ?? [];
    for (let i = index - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.kind === 'result') return null;
      if (entry.kind === 'user') return entry.messageID ?? null;
    }
    return null;
  }

  choice(): ModelChoice {
    return {
      providerID: this.providerID,
      modelID: this.modelID,
      variant: this.variant,
      plan: this.plan,
      agent: this.agent
    };
  }

  async connect() {
    if (this.#destroyed) return;
    this.#live = true;
    if (this.#probing) return this.#probing;
    if (this.connection === 'idle' || this.connection === 'unreachable') {
      this.#probing = this.#probe().finally(() => (this.#probing = null));
      return this.#probing;
    }
    if (this.connection === 'ready') this.#openStream();
  }

  retry() {
    if (this.#probing) return;
    if (this.#probeTimer) clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
    this.settled = false;
    this.connection = 'idle';
    void this.connect();
  }

  pause() {
    this.#live = false;
    this.#stream?.abort();
    this.#stream = null;
    if (this.#probeTimer) clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    this.#statusTimer = null;
  }

  #sessionDir(id: string): string | null {
    return this.sessions.find((s) => s.id === id)?.directory ?? null;
  }

  #dir(id: string | null, join: '?' | '&' = '?'): string {
    const dir = id ? this.#sessionDir(id) : this.directory;
    return dir ? `${join}directory=${encodeURIComponent(dir)}` : '';
  }

  destroy() {
    this.#destroyed = true;
    this.pause();
  }

  async #probe() {
    if (this.connection !== 'unreachable') this.connection = 'connecting';
    const models = ocModels(this.sandboxId).catch(() => [] as OcModel[]);
    const listing = apiFetch(`${ocBase(this.sandboxId)}/session?roots=true&limit=20`).catch(
      () => null
    );
    const reachable = await ocProbe(this.sandboxId);
    if (this.#destroyed) return;
    if (!reachable) {
      this.connection = 'unreachable';
      this.settled = true;
      if (this.#probeTimer) clearTimeout(this.#probeTimer);
      this.#probeTimer = setTimeout(() => {
        this.#probeTimer = null;
        if (this.connection === 'unreachable' && this.#live) void this.connect();
      }, RETRY_PROBE_MS);
      return;
    }
    this.connection = 'ready';
    void models.then((list) => {
      if (this.#destroyed) return;
      this.modelsFailed = list.length === 0 && this.models.length === 0;
      if (list.length === 0) return;
      this.models = list;
      cacheModels(this.sandboxId, list);
    });
    this.#openStream();
    try {
      await this.#loadSessions(listing);
    } finally {
      this.settled = true;
    }
  }

  #thread(id: string): SessionThread {
    let thread = this.threads.get(id);
    if (!thread) {
      thread = new SessionThread(id);
      this.threads.set(id, thread);
    }
    return thread;
  }

  #savePrefs() {
    if (!this.activeId) return;
    this.#prefs.set(this.activeId, this.choice());
  }

  #applyChoice(choice: ModelChoice) {
    this.providerID = choice.providerID;
    this.modelID = choice.modelID;
    this.variant = choice.variant;
    this.plan = choice.plan;
    this.agent = choice.agent ?? null;
  }

  #restorePrefs(thread: SessionThread) {
    const prefs = this.#prefs.get(thread.id) ?? thread.lastChoice;
    if (prefs) this.#applyChoice(prefs);
  }

  pickModel(model: OcModel) {
    this.providerID = model.providerID;
    this.modelID = model.modelID;
    if (this.variant && !model.variants.includes(this.variant)) this.variant = null;
    this.#savePrefs();
  }

  pickVariant(variant: string | null) {
    this.variant = variant;
    this.#savePrefs();
  }

  cycleVariant() {
    const order: (string | null)[] = [null, ...this.variants];
    if (order.length < 2) return;
    const at = order.indexOf(this.variant);
    this.pickVariant(order[(at + 1) % order.length]);
  }

  toggleFast() {
    const sibling = this.fastSibling;
    if (sibling) this.pickModel(sibling);
  }

  agentDirectory(): string | null {
    return (this.activeId ? this.#sessionDir(this.activeId) : null) ?? this.directory;
  }

  setPlan(plan: boolean) {
    this.plan = plan;
    if (plan) this.agent = null;
    this.#savePrefs();
  }

  setAgent(name: string | null) {
    const next = name?.trim() || null;
    this.plan = next === 'plan';
    this.agent = next === 'plan' || next === 'build' ? null : next;
    this.#savePrefs();
  }

  async #loadSessions(prefetched?: Promise<Response | null>) {
    try {
      const res = await (prefetched ??
        apiFetch(`${ocBase(this.sandboxId)}/session?roots=true&limit=20`));
      if (!res?.ok) return;
      const list = (await res.json()) as OcSession[];
      this.sessions = list.filter((s) => !s.parentID && !s.time.archived).map(toSession);
      const statusSync = this.#syncStatus();
      const wanted = this.#preferredSessionId?.() ?? this.#initialSessionId;
      if (wanted && (await this.#ensureListed(wanted))) {
        await this.selectSession(wanted);
      } else if (this.#autoSelect && this.sessions.length === 0) {
        await this.createSession();
      } else if (this.#autoSelect) {
        await this.selectSession(this.sessions[0].id);
      }
      await statusSync;
      void this.#syncPending();
    } catch {
      return;
    }
  }

  async #ensureListed(id: string): Promise<boolean> {
    if (this.sessions.some((s) => s.id === id)) return true;
    try {
      const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${id}`);
      if (!res.ok) return false;
      const session = (await res.json()) as OcSession;
      if (session.parentID || session.time.archived) return false;
      if (!this.sessions.some((s) => s.id === id)) this.sessions.unshift(toSession(session));
      return true;
    } catch {
      return false;
    }
  }

  async retryHistory() {
    const thread = this.active;
    if (thread && !thread.loading) await this.#loadHistory(thread);
  }

  async selectSession(id: string) {
    if (id === this.activeId) return;
    this.selecting = true;
    try {
      await this.#select(id);
    } finally {
      this.selecting = false;
    }
  }

  async #select(id: string) {
    if (isAcpChat(id)) {
      this.#savePrefs();
      this.activeId = id;
      this.#thread(id);
      this.acpChats.get(id)?.connect();
      return;
    }
    if (!id.startsWith(TEMP_PREFIX) && !(await this.#ensureListed(id))) return;
    this.#savePrefs();
    this.activeId = id;
    const thread = this.#thread(id);
    if (thread.loaded || thread.loading || id.startsWith(TEMP_PREFIX)) {
      this.#restorePrefs(thread);
      return;
    }
    await this.#loadHistory(thread);
    void this.#syncPending();
  }

  async createSession(directory: string | null = this.directory) {
    this.#savePrefs();
    const now = Date.now();
    const temp: ChatSession = {
      id: `${TEMP_PREFIX}${now.toString(36)}`,
      title: 'New chat',
      directory,
      repo: directory ? ocRepo(directory) : null,
      pending: true,
      createdAt: now,
      updatedAt: now
    };
    this.sessions = [temp, ...this.sessions];
    const thread = this.#thread(temp.id);
    thread.loaded = true;
    this.activeId = temp.id;

    const work = (async () => {
      try {
        const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const res = await apiFetch(`${ocBase(this.sandboxId)}/session${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (!res.ok) throw new Error('Could not start a new session');
        const created = toSession((await res.json()) as OcSession);
        const index = this.sessions.findIndex((s) => s.id === temp.id);
        if (index === -1) {
          this.threads.delete(temp.id);
          return;
        }
        const duplicate = this.sessions.findIndex((s) => s.id === created.id);
        if (duplicate !== -1) this.sessions.splice(duplicate, 1);
        this.sessions[this.sessions.findIndex((s) => s.id === temp.id)] = created;
        this.threads.delete(temp.id);
        thread.id = created.id;
        this.threads.set(created.id, thread);
        const prefs = this.#prefs.get(temp.id);
        if (prefs) {
          this.#prefs.set(created.id, prefs);
          this.#prefs.delete(temp.id);
        }
        if (this.activeId === temp.id) this.activeId = created.id;
      } catch (e) {
        this.sessions = this.sessions.filter((s) => s.id !== temp.id);
        this.threads.delete(temp.id);
        if (this.activeId === temp.id) {
          this.activeId = null;
          const next = this.sessions[0]?.id;
          if (next) void this.selectSession(next);
        }
        toasts.add({
          title: 'Could not start a conversation',
          description: e instanceof Error ? e.message : 'Try again shortly.',
          color: 'error'
        });
      }
    })();

    this.#createWork = work;
    await work;
    if (this.#createWork === work) this.#createWork = null;
  }

  async renameSession(id: string, title: string) {
    const next = title.trim();
    const session = this.sessions.find((s) => s.id === id);
    if (!session || !next || session.title === next) return;
    session.title = next;
    if (session.pending) return;
    try {
      await apiFetch(`${ocBase(this.sandboxId)}/session/${id}${this.#dir(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next })
      });
    } catch {
      return;
    }
  }

  async deleteSession(id: string) {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index === -1) return;
    const target = this.sessions[index];
    const restore = [...this.sessions];
    const wasActive = this.activeId === id;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (wasActive) {
      this.activeId = null;
      const next = this.sessions[Math.min(index, this.sessions.length - 1)]?.id ?? null;
      if (next) void this.selectSession(next);
    }

    if (target.pending) {
      if (wasActive && this.sessions.length === 0) await this.createSession();
      return;
    }

    const query = target.directory ? `?directory=${encodeURIComponent(target.directory)}` : '';
    try {
      const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${id}${query}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete conversation');
      this.#dropThread(id);
      if (wasActive && this.sessions.length === 0) await this.createSession();
    } catch (e) {
      this.sessions = restore;
      if (wasActive) {
        this.activeId = null;
        await this.selectSession(id);
      }
      toasts.add({
        title: 'Could not delete the conversation',
        description: e instanceof Error ? e.message : 'Try again shortly.',
        color: 'error'
      });
    }
  }

  #dropThread(id: string) {
    const thread = this.threads.get(id);
    if (!thread) return;
    for (const [child, owner] of this.#children) {
      if (owner.thread === thread) this.#children.delete(child);
    }
    this.threads.delete(id);
    this.#prefs.delete(id);
    this.#notes.delete(id);
  }

  async fork(messageID: string) {
    const thread = this.active;
    if (!thread || this.revertBusy) return;
    this.revertBusy = messageID;
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/fork${this.#dir(thread.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageID })
        }
      );
      if (!res.ok) throw await failure(res, 'Could not fork this session');
      const session = (await res.json()) as OcSession;
      if (!this.sessions.some((s) => s.id === session.id))
        this.sessions.unshift(toSession(session));
      const choice = this.choice();
      this.#savePrefs();
      this.#prefs.set(session.id, choice);
      this.activeId = session.id;
      await this.#loadHistory(this.#thread(session.id));
      toasts.add({ title: 'Forked into a new session', color: 'success' });
    } catch (e) {
      toasts.add({
        title: 'Fork failed',
        description: e instanceof Error ? e.message : 'Could not fork this session',
        color: 'error'
      });
    } finally {
      this.revertBusy = null;
    }
  }

  async revert(messageID: string): Promise<boolean> {
    const thread = this.active;
    if (!thread || this.revertBusy) return false;
    const acp = this.acpChats.get(thread.id);
    if (acp) {
      this.revertBusy = messageID;
      try {
        await acp.revert(messageID);
        this.onTurnDone?.();
        return true;
      } catch (e) {
        toasts.add({
          title: 'Revert failed',
          description: e instanceof Error ? e.message : 'Could not restore the files',
          color: 'error'
        });
        return false;
      } finally {
        this.revertBusy = null;
      }
    }
    this.revertBusy = messageID;
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/revert${this.#dir(thread.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageID })
        }
      );
      if (!res.ok) throw await failure(res, 'Could not revert to this point');
      const session = (await res.json()) as OcSession;
      await this.#loadHistory(thread);
      thread.revertedMessageID = session.revert?.messageID ?? messageID;
      this.onTurnDone?.();
      return true;
    } catch (e) {
      toasts.add({
        title: 'Revert failed',
        description: e instanceof Error ? e.message : 'Could not revert to this point',
        color: 'error'
      });
      return false;
    } finally {
      this.revertBusy = null;
    }
  }

  async unrevert() {
    const thread = this.active;
    if (!thread || this.revertBusy) return;
    this.revertBusy = 'undo';
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/unrevert${this.#dir(thread.id)}`,
        { method: 'POST' }
      );
      if (!res.ok) throw await failure(res, 'Could not undo the revert');
      await this.#loadHistory(thread);
      thread.revertedMessageID = null;
      this.onTurnDone?.();
    } catch (e) {
      toasts.add({
        title: 'Undo failed',
        description: e instanceof Error ? e.message : 'Could not undo the revert',
        color: 'error'
      });
    } finally {
      this.revertBusy = null;
    }
  }

  async abort() {
    const thread = this.active;
    if (!thread || !thread.busy || thread.stopping || thread.id.startsWith(TEMP_PREFIX)) return;
    const acp = this.acpChats.get(thread.id);
    if (acp) {
      thread.stopping = true;
      try {
        await acp.cancel();
      } catch (e) {
        toasts.add({
          title: 'Could not stop the agent',
          description: e instanceof Error ? e.message : undefined,
          color: 'error'
        });
      } finally {
        thread.stopping = false;
      }
      return;
    }
    thread.stopping = true;
    try {
      await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/abort${this.#dir(thread.id)}`,
        {
          method: 'POST'
        }
      );
    } catch {
      return;
    } finally {
      thread.stopping = false;
    }
  }

  canUndo(): boolean {
    const thread = this.active;
    return !!thread && undoTarget(thread.entries, thread.revertedMessageID) !== null;
  }

  async undoLast(): Promise<boolean> {
    const thread = this.active;
    if (!thread || thread.busy) return false;
    const target = undoTarget(thread.entries, thread.revertedMessageID);
    if (!target) return false;
    return this.revert(target);
  }

  async todos(): Promise<TodoItem[] | null> {
    const thread = this.active;
    if (!thread || thread.id.startsWith(TEMP_PREFIX)) return [];
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/todo${this.#dir(thread.id)}`
      );
      if (!res.ok) return null;
      return parseTodos(await res.json());
    } catch {
      return null;
    }
  }

  async readFile(path: string, directory: string | null): Promise<string | null> {
    const query = new URLSearchParams({ path });
    if (directory) query.set('directory', directory);
    try {
      const res = await apiFetch(`${ocBase(this.sandboxId)}/file/content?${query}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { type?: string; content?: unknown };
      return body.type === 'text' && typeof body.content === 'string' ? body.content : null;
    } catch {
      return null;
    }
  }

  #idle(): SessionThread | null {
    const thread = this.active;
    if (!thread || thread.busy || thread.id.startsWith(TEMP_PREFIX)) return null;
    return thread;
  }

  canCompact(): boolean {
    const thread = this.#idle();
    return !!thread && thread.entries.some((e) => e.kind === 'user');
  }

  compact(): Promise<boolean> {
    const thread = this.#idle();
    if (!thread || !this.canCompact()) return Promise.resolve(false);
    this.#beginTurn(thread);
    return this.#fire(
      thread,
      'summarize',
      { providerID: this.providerID, modelID: this.modelID },
      'Could not compact the chat'
    );
  }

  async runCommand(command: string, args: string): Promise<boolean> {
    if (!this.activeId) await this.createSession();
    const thread = this.active;
    if (!thread || thread.busy) return false;
    const choice = this.choice();
    const text = `/${command}${args ? ` ${args}` : ''}`;
    const entry = thread.push(this.#localPrompt(text, []));
    this.#beginTurn(thread);
    if (this.#createWork) await this.#createWork;
    if (thread.id.startsWith(TEMP_PREFIX) || !this.threads.has(thread.id)) {
      this.#failTurn(thread, 'No session available');
      return false;
    }
    const assigned = this.beforePrompt ? await this.beforePrompt(thread.id, text) : null;
    if (assigned?.messageID) entry.messageID = assigned.messageID;
    return this.#fire(
      thread,
      'command',
      {
        ...(assigned?.messageID ? { messageID: assigned.messageID } : {}),
        command,
        arguments: args,
        agent: agentOf(choice),
        model: `${choice.providerID}/${choice.modelID}`,
        ...(choice.variant ? { variant: choice.variant } : {})
      },
      `Could not run /${command}`
    );
  }

  #beginTurn(thread: SessionThread) {
    thread.busy = true;
    thread.turnStart = Date.now();
    thread.turnCosts.clear();
    if (!thread.id.startsWith(TEMP_PREFIX)) this.activity.set(thread.id, 'busy');
    if (thread.id === this.activeId) this.sentTick += 1;
  }

  #failTurn(thread: SessionThread, detail: string) {
    thread.push({ kind: 'error', key: nextKey(), time: Date.now(), detail });
    thread.busy = false;
    thread.turnStart = 0;
    this.activity.set(thread.id, 'idle');
    this.onTurnDone?.();
  }

  async #fire(
    thread: SessionThread,
    action: 'command' | 'summarize',
    body: Record<string, unknown>,
    fallback: string
  ): Promise<boolean> {
    const mark = thread.entries.length;
    const started = () =>
      thread.entries.slice(mark).some((e) => e.kind !== 'error' && e.kind !== 'user');
    let error: string | null = null;
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/${action}${this.#dir(thread.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok && (res.status < 500 || !started())) {
        error = (await failure(res, fallback)).message;
      }
    } catch {
      if (!started()) error = fallback;
    }
    if (error === null) return true;
    if (thread.busy && !started()) this.#failTurn(thread, error);
    return false;
  }

  async #loadHistory(thread: SessionThread) {
    thread.reset();
    thread.loading = true;
    thread.failed = false;
    let ok = false;
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}/message?limit=100${this.#dir(thread.id, '&')}`
      );
      if (!res.ok) return;
      this.#hydrate(thread, (await res.json()) as OcMessage[]);
      ok = true;
      const sres = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${thread.id}${this.#dir(thread.id)}`
      );
      if (sres.ok) {
        const session = (await sres.json()) as OcSession;
        thread.revertedMessageID = session.revert?.messageID ?? null;
      }
    } catch {
      return;
    } finally {
      thread.loading = false;
      thread.loaded = ok;
      thread.failed = !ok;
    }
    const state = this.activity.get(thread.id);
    if ((state === 'busy' || state === 'retry') && !thread.busy) {
      thread.busy = true;
      thread.turnStart = Date.now();
    }
  }

  #hydrate(thread: SessionThread, messages: OcMessage[]) {
    let runStart: number | null = null;
    let runCost = 0;
    let lastAssistant: OcMessageInfo | null = null;
    for (let i = 0; i < messages.length; i += 1) {
      const { info, parts } = messages[i];
      this.#roles.set(info.id, info.role);
      if (info.role === 'user') {
        for (const entry of userEntriesFrom(info, parts)) thread.push(entry);
        runStart = null;
        runCost = 0;
        continue;
      }
      lastAssistant = info;
      if (runStart === null) runStart = info.time.created;
      runCost += info.cost ?? 0;
      for (const part of parts) this.#appendPart(thread, part, thread.entries, info.time.created);
      if (info.error && !ocIsAborted(info.error)) {
        this.#pushError(thread, info.error, info.id, info.time.completed ?? info.time.created);
      }
      const next = messages[i + 1];
      if (info.time.completed && (!next || next.info.role === 'user')) {
        thread.push({
          kind: 'result',
          key: nextKey(),
          time: info.time.completed,
          cost: runCost > 0 ? runCost : null,
          duration: info.time.completed - runStart,
          files: turnFiles(thread.entries)
        });
      }
    }
    if (lastAssistant) {
      thread.ctxTokens = lastAssistant.tokens ?? null;
      if (lastAssistant.providerID && lastAssistant.modelID) {
        thread.lastChoice = {
          providerID: lastAssistant.providerID,
          modelID: lastAssistant.modelID,
          variant: typeof lastAssistant.variant === 'string' ? lastAssistant.variant : null,
          plan: lastAssistant.agent === 'plan',
          agent:
            typeof lastAssistant.agent === 'string' &&
            lastAssistant.agent !== 'plan' &&
            lastAssistant.agent !== 'build'
              ? lastAssistant.agent
              : null
        };
      }
    }
    this.#mergeNotes(thread);
    if (thread.id === this.activeId) this.#restorePrefs(thread);
  }

  #mergeNotes(thread: SessionThread) {
    const notes = this.#notes.get(thread.id);
    if (!notes || notes.length === 0) return;
    const keys = new Set(thread.entries.map((e) => e.key));
    for (const note of notes) {
      if (keys.has(note.key)) continue;
      const at = thread.entries.findIndex((e) => typeof e.time === 'number' && e.time > note.time);
      thread.entries.splice(at === -1 ? thread.entries.length : at, 0, note);
    }
  }

  #appendPart(
    thread: SessionThread,
    part: OcPart,
    target: ChatEntry[] = thread.entries,
    fallbackTime = Date.now()
  ) {
    if (SKIP_PARTS.has(part.type)) return;
    const time = partTime(part, fallbackTime);
    const existing = thread.parts.get(part.id);
    if (part.type === 'text' || part.type === 'reasoning') {
      if (existing) {
        if (existing.kind === 'text' || existing.kind === 'thinking')
          existing.text = part.text ?? '';
        if (existing.kind === 'thinking' && part.time?.end) existing.done = true;
        return;
      }
      const entry: ChatEntry =
        part.type === 'text'
          ? { kind: 'text', key: nextKey(), text: part.text ?? '', time }
          : {
              kind: 'thinking',
              key: nextKey(),
              time,
              text: part.text ?? '',
              done: Boolean(part.time?.end),
              expanded: false
            };
      thread.parts.set(part.id, thread.push(entry, target));
      return;
    }
    if (part.type === 'tool' && part.tool === 'task') {
      const fields = agentFields(part);
      if (fields.childID && this.#parents.get(fields.childID) !== thread.id) {
        this.#parents.set(fields.childID, thread.id);
        if (this.pending.size > 0) this.#syncWaiting();
      }
      if (existing && existing.kind === 'agent') {
        Object.assign(existing, fields);
        if (existing.loaded && fields.childID) {
          this.#children.set(fields.childID, { thread, agent: existing });
        }
        return;
      }
      const agent = thread.push(
        {
          kind: 'agent',
          key: nextKey(),
          time,
          id: part.id,
          ...fields,
          expanded: false,
          loaded: false,
          loading: false,
          entries: []
        } satisfies AgentEntry,
        target
      );
      thread.parts.set(part.id, agent);
      return;
    }
    const entry =
      part.type === 'tool' ? toolEntryFromPart(part) : makeToolEntry(part.id, part.type, part);
    if (existing && existing.kind === 'tool') {
      Object.assign(existing, {
        ...entry,
        key: existing.key,
        time: existing.time,
        expanded: existing.expanded
      });
      return;
    }
    entry.time = time;
    thread.parts.set(part.id, thread.push(entry, target));
  }

  async toggleAgent(agent: AgentEntry) {
    agent.expanded = !agent.expanded;
    if (!agent.expanded || agent.loaded || agent.loading || !agent.childID) return;
    const thread = [...this.threads.values()].find((t) => t.parts.get(agent.id) === agent);
    if (!thread) return;
    agent.loading = true;
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/session/${agent.childID}/message?limit=100`
      );
      if (!res.ok) return;
      const messages = (await res.json()) as OcMessage[];
      agent.entries.length = 0;
      for (const { info, parts } of messages) {
        this.#roles.set(info.id, info.role);
        if (info.role === 'user') {
          for (const part of parts) {
            if (part.type === 'text' && part.text?.trim() && !part.synthetic && !part.ignored) {
              thread.push(
                { kind: 'user', key: nextKey(), text: part.text, time: info.time.created },
                agent.entries
              );
            }
          }
          continue;
        }
        for (const part of parts) {
          this.#appendPart(thread, part, agent.entries, info.time.created);
        }
      }
      agent.loaded = true;
      this.#children.set(agent.childID, { thread, agent });
    } catch {
      return;
    } finally {
      agent.loading = false;
    }
  }

  async addFiles(files: FileList | File[] | null | undefined): Promise<string[]> {
    if (!files) return [];
    const incoming = Array.from(files);
    if (incoming.length === 0) return [];
    const accepted: File[] = [];
    let oversized = 0;
    let overflow = 0;
    for (const file of incoming) {
      if (file.size > OC_ATTACH_MAX_BYTES) {
        oversized += 1;
        continue;
      }
      if (this.attachments.length + accepted.length >= OC_ATTACH_MAX_COUNT) {
        overflow += 1;
        continue;
      }
      accepted.push(file);
    }
    if (oversized > 0) {
      toasts.add({
        title: 'File is too large',
        description: `Attachments are limited to ${ocFmtBytes(OC_ATTACH_MAX_BYTES)} each`,
        color: 'error'
      });
    }
    if (overflow > 0) {
      toasts.add({
        title: 'Too many attachments',
        description: `You can attach up to ${OC_ATTACH_MAX_COUNT} files`,
        color: 'error'
      });
    }
    const added: string[] = [];
    for (const file of accepted) {
      try {
        const attachment = await ocReadAttachment(file);
        this.attachments.push(attachment);
        added.push(attachment.id);
      } catch {
        toasts.add({ title: 'Could not read file', description: file.name, color: 'error' });
      }
    }
    return added;
  }

  removeAttachment(id: string) {
    this.attachments = this.attachments.filter((a) => a.id !== id);
  }

  async send(followUp: FollowUpMode = 'queue'): Promise<boolean> {
    const text = this.draft.trim();
    const files = [...this.attachments];
    if (!text && files.length === 0) return false;
    if (!this.activeId) await this.createSession();
    const thread = this.active;
    if (!thread) return false;
    this.draft = '';
    this.attachments = [];
    const sent = await this.#deliver(thread, text, files, followUp);
    if (!sent && this.attachments.length === 0) this.attachments = files;
    return sent;
  }

  async sendText(text: string, followUp: FollowUpMode = 'queue'): Promise<boolean> {
    const body = text.trim();
    if (!body) return false;
    if (!this.activeId) await this.createSession();
    const thread = this.active;
    if (!thread) return false;
    return this.#deliver(thread, body, [], followUp);
  }

  async #deliver(
    thread: SessionThread,
    text: string,
    files: OcAttachment[],
    followUp: FollowUpMode
  ): Promise<boolean> {
    if (isAcpChat(thread.id)) return this.#deliverAcp(thread, text);
    const choice = this.choice();
    if (followUp === 'steer' && this.#canSteer(thread)) {
      return this.#steer(thread, text, files, choice);
    }
    if (thread.busy || thread.queue.length > 0) {
      thread.queue.push({
        id: crypto.randomUUID(),
        text,
        attachments: files,
        choice,
        createdAt: Date.now()
      });
      this.#drain(thread);
      return true;
    }
    return this.#dispatch(thread, text, files, choice);
  }

  updateQueued(id: string, text: string) {
    const item = this.active?.queue.find((q) => q.id === id);
    if (item) item.text = text;
  }

  removeQueued(id: string) {
    const thread = this.active;
    if (!thread) return;
    thread.queue = thread.queue.filter((q) => q.id !== id);
  }

  sendQueuedNow(id: string) {
    const thread = this.active;
    if (!thread) return;
    if (thread.busy && !this.#canSteer(thread)) return;
    const index = thread.queue.findIndex((q) => q.id === id);
    if (index === -1) return;
    const [item] = thread.queue.splice(index, 1);
    if (thread.busy) void this.#steer(thread, item.text, item.attachments, item.choice);
    else void this.#dispatch(thread, item.text, item.attachments, item.choice);
  }

  #canSteer(thread: SessionThread): boolean {
    return thread.busy && !thread.stopping && !thread.id.startsWith(TEMP_PREFIX);
  }

  #localPrompt(text: string, files: OcAttachment[]): UserEntry {
    return {
      kind: 'user',
      key: nextKey(),
      text,
      time: Date.now(),
      author: this.self,
      local: true,
      ...(files.length > 0 ? { attachments: files } : {})
    };
  }

  async #postPrompt(
    sessionId: string,
    entry: UserEntry,
    files: OcAttachment[],
    choice: ModelChoice
  ): Promise<void> {
    const assigned = this.beforePrompt ? await this.beforePrompt(sessionId, entry.text) : null;
    if (assigned?.messageID) entry.messageID = assigned.messageID;
    const res = await apiFetch(
      `${ocBase(this.sandboxId)}/session/${sessionId}/prompt_async${this.#dir(sessionId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(assigned?.messageID ? { messageID: assigned.messageID } : {}),
          model: { providerID: choice.providerID, modelID: choice.modelID },
          ...(choice.variant ? { variant: choice.variant } : {}),
          agent: agentOf(choice),
          parts: [...files.map(ocFilePart), { type: 'text', text: entry.text }]
        })
      }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.message || 'Chat request failed');
    }
  }

  async #steer(
    thread: SessionThread,
    text: string,
    files: OcAttachment[],
    choice: ModelChoice
  ): Promise<boolean> {
    const entry = thread.push(this.#localPrompt(text, files));
    if (thread.id === this.activeId) this.sentTick += 1;
    try {
      await this.#postPrompt(thread.id, entry, files, choice);
      return true;
    } catch {
      thread.entries = thread.entries.filter((e) => e.key !== entry.key);
      thread.queue.unshift({
        id: crypto.randomUUID(),
        text,
        attachments: files,
        choice,
        createdAt: Date.now()
      });
      this.#drain(thread);
      return true;
    }
  }

  #drain(thread: SessionThread) {
    if (thread.busy) return;
    const next = thread.queue[0];
    if (!next) return;
    thread.queue = thread.queue.slice(1);
    void this.#dispatch(thread, next.text, next.attachments, next.choice);
  }

  async #dispatch(
    thread: SessionThread,
    text: string,
    files: OcAttachment[],
    choice: ModelChoice
  ): Promise<boolean> {
    const entry = thread.push(this.#localPrompt(text, files));
    thread.busy = true;
    thread.turnStart = Date.now();
    thread.turnCosts.clear();
    if (thread.id === this.activeId) this.sentTick += 1;
    try {
      if (this.#createWork) await this.#createWork;
      if (thread.id.startsWith(TEMP_PREFIX) || !this.threads.has(thread.id)) {
        throw new Error('No session available');
      }
      const sessionId = thread.id;
      this.activity.set(sessionId, 'busy');
      await this.#postPrompt(sessionId, entry, files, choice);
      return true;
    } catch (err) {
      thread.push({
        kind: 'error',
        key: nextKey(),
        time: Date.now(),
        detail: err instanceof Error ? err.message : 'Chat request failed'
      });
      thread.busy = false;
      thread.turnStart = 0;
      this.activity.set(thread.id, 'idle');
      this.onTurnDone?.();
      return false;
    }
  }

  #pushError(
    thread: SessionThread,
    error: unknown,
    messageID?: string,
    time = Date.now()
  ): boolean {
    const detail = ocErrorMessage(error);
    for (let i = thread.entries.length - 1; i >= 0; i -= 1) {
      const entry = thread.entries[i];
      if (entry.kind === 'user') break;
      if (entry.kind !== 'error') continue;
      if ((messageID && entry.messageID === messageID) || entry.detail === detail) {
        if (messageID && !entry.messageID) entry.messageID = messageID;
        return false;
      }
    }
    thread.push({
      kind: 'error',
      key: nextKey(),
      time,
      detail,
      auth: ocIsAuthError(error),
      ...(messageID ? { messageID } : {})
    });
    return true;
  }

  #signal(kind: AgentSignalKind, sessionId: string, detail: string | null = null) {
    try {
      this.onSignal?.({ kind, sessionId, detail });
    } catch {
      return;
    }
  }

  lastAnswer(sessionId: string): string | null {
    const entries = this.threads.get(sessionId)?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.kind === 'user') return null;
      if (entry.kind === 'text' && entry.text.trim()) return entry.text;
    }
    return null;
  }

  lastPrompt(sessionId: string): { local: boolean; authorId: string | null } | null {
    const entries = this.threads.get(sessionId)?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.kind !== 'user') continue;
      const author = (entry.messageID ? this.authorOf(entry.messageID) : null) ?? entry.author;
      return { local: !!entry.local, authorId: author?.id ?? null };
    }
    return null;
  }

  #turnFailed(thread: SessionThread): boolean {
    for (let i = thread.entries.length - 1; i >= 0; i -= 1) {
      const entry = thread.entries[i];
      if (entry.kind === 'user') return false;
      if (entry.kind === 'error') return true;
    }
    return false;
  }

  #settle(thread: SessionThread) {
    this.#dropPending(thread.id);
    const failed = this.#turnFailed(thread);
    this.#finishTurn(thread, true);
    if (!failed) this.#signal('done', thread.id, this.lastAnswer(thread.id));
  }

  #finishTurn(thread: SessionThread, drain: boolean) {
    for (const entry of thread.entries) {
      if (entry.kind === 'thinking') entry.done = true;
    }
    const total = [...thread.turnCosts.values()].reduce((sum, cost) => sum + cost, 0);
    const tail = thread.entries.at(-1);
    if (tail && tail.kind !== 'result') {
      thread.push({
        kind: 'result',
        key: nextKey(),
        time: Date.now(),
        cost: total > 0 ? total : null,
        duration: thread.turnStart > 0 ? Date.now() - thread.turnStart : null,
        files: turnFiles(thread.entries)
      });
    }
    thread.busy = false;
    thread.turnCosts.clear();
    thread.turnStart = 0;
    this.onTurnDone?.();
    if (drain) this.#drain(thread);
  }

  #endTurnQuietly(thread: SessionThread) {
    this.#dropPending(thread.id);
    thread.busy = false;
    thread.turnCosts.clear();
    thread.turnStart = 0;
    this.onTurnDone?.();
  }

  #markBusy(sessionID: string, state: SessionActivity) {
    this.activity.set(sessionID, state);
    if (state === 'idle') return;
    const thread = this.threads.get(sessionID);
    if (!thread || !thread.loaded || thread.busy) return;
    thread.busy = true;
    thread.turnStart = Date.now();
    thread.turnCosts.clear();
  }

  #owner(sessionID: string): { thread: SessionThread; target: ChatEntry[] } | null {
    const thread = this.threads.get(sessionID);
    if (thread && (thread.loaded || thread.loading)) return { thread, target: thread.entries };
    const child = this.#children.get(sessionID);
    if (child) return { thread: child.thread, target: child.agent.entries };
    return null;
  }

  #onUserFile(thread: SessionThread, part: OcPart) {
    const attachment = ocPartAttachment(part);
    if (!attachment) return;
    const same = (list: OcAttachment[] | undefined) =>
      !!list?.some((a) => a.id === attachment.id || a.dataUrl === attachment.dataUrl);
    const entry = thread.entries.find(
      (e): e is UserEntry => e.kind === 'user' && e.messageID === part.messageID
    );
    if (entry) {
      if (!same(entry.attachments)) entry.attachments = [...(entry.attachments ?? []), attachment];
      return;
    }
    if (thread.entries.some((e) => e.kind === 'user' && !e.messageID && same(e.attachments))) {
      return;
    }
    const author = this.authorOf(part.messageID);
    thread.push({
      kind: 'user',
      key: nextKey(),
      text: '',
      time: part.time?.start ?? Date.now(),
      messageID: part.messageID,
      attachments: [attachment],
      ...(author ? { author } : {})
    });
  }

  #onUserPart(thread: SessionThread, part: OcPart) {
    if (part.synthetic || part.ignored) return;
    if (part.type === 'file') {
      this.#onUserFile(thread, part);
      return;
    }
    if (part.type !== 'text' || !part.text?.trim()) return;
    const bare = thread.entries.find(
      (e): e is UserEntry => e.kind === 'user' && e.messageID === part.messageID && !e.text
    );
    if (bare) {
      bare.text = part.text;
      return;
    }
    const author = this.authorOf(part.messageID);
    const placement = placeUserPart(
      thread.entries,
      { messageID: part.messageID, text: part.text },
      author,
      this.self?.id ?? null
    );
    if (!placement) return;
    if ('claim' in placement) {
      const entry = thread.entries[placement.claim];
      if (entry.kind === 'user') entry.messageID = part.messageID;
      return;
    }
    thread.push({
      kind: 'user',
      key: nextKey(),
      text: part.text,
      time: part.time?.start ?? Date.now(),
      messageID: part.messageID,
      ...(author ? { author } : {})
    });
  }

  claimPrompt(sessionId: string, messageId: string) {
    const thread = this.threads.get(sessionId);
    if (!thread) return;
    const index = claimOwnPrompt(thread.entries, messageId);
    if (index === null) return;
    const entry = thread.entries[index];
    if (entry.kind === 'user') entry.messageID = messageId;
  }

  #handleEvent(event: OcEvent, directory: string | null = null) {
    const props = event.properties ?? {};
    const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null;
    switch (event.type) {
      case 'server.connected':
      case 'server.heartbeat':
      case 'sync':
        return;
      case 'session.updated':
      case 'session.created': {
        const info = props.info as OcSession | undefined;
        if (!info || info.parentID || info.time.archived) return;
        const thread = this.threads.get(info.id);
        if (thread) thread.revertedMessageID = info.revert?.messageID ?? null;
        const session = this.sessions.find((s) => s.id === info.id);
        if (session) {
          session.title = info.title;
          session.updatedAt = info.time.updated;
        } else if (event.type === 'session.created') {
          this.sessions.unshift(toSession(info));
        }
        return;
      }
      case 'session.deleted': {
        const id = sessionID ?? (props.info as OcSession | undefined)?.id ?? null;
        if (id) this.deleted.add(id);
        if (!id || !this.sessions.some((s) => s.id === id)) return;
        this.sessions = this.sessions.filter((s) => s.id !== id);
        this.#dropThread(id);
        if (this.activeId === id) {
          this.activeId = null;
          const next = this.sessions[0]?.id;
          if (next) void this.selectSession(next);
          else void this.createSession();
        }
        return;
      }
      case 'session.status': {
        const status = props.status as { type?: string } | undefined;
        if (!sessionID || !status?.type) return;
        const state: SessionActivity =
          status.type === 'busy' ? 'busy' : status.type === 'retry' ? 'retry' : 'idle';
        if (state === 'idle') {
          this.activity.set(sessionID, 'idle');
          this.#dropPending(sessionID);
          const thread = this.threads.get(sessionID);
          if (thread?.busy) this.#settle(thread);
        } else {
          this.#markBusy(sessionID, state);
        }
        return;
      }
      case 'session.idle': {
        if (!sessionID) return;
        this.activity.set(sessionID, 'idle');
        this.#dropPending(sessionID);
        const thread = this.threads.get(sessionID);
        if (thread?.busy) this.#settle(thread);
        return;
      }
      case 'session.error': {
        const aborted = ocIsAborted(props.error);
        const scoped =
          !directory || !this.activeId || directory === this.#sessionDir(this.activeId);
        const targets = sessionID
          ? [this.threads.get(sessionID)].filter((t): t is SessionThread => !!t)
          : this.active && scoped
            ? [this.active]
            : [];
        for (const thread of targets) {
          if (aborted) {
            this.#dropPending(thread.id);
            if (thread.busy) this.#finishTurn(thread, false);
            continue;
          }
          const fresh = this.#pushError(thread, props.error);
          const working = thread.busy;
          if (working) this.#endTurnQuietly(thread);
          if (fresh && (working || thread.loaded)) {
            this.#signal('error', thread.id, ocErrorMessage(props.error));
          }
        }
        return;
      }
      case 'permission.asked':
      case 'permission.updated': {
        const request = parsePermission(props);
        if (request) this.#ask(request, directory);
        return;
      }
      case 'question.asked': {
        const request = parseQuestion(props);
        if (request) this.#ask(request, directory);
        return;
      }
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        const outcome = parseOutcome(event.type, props);
        if (outcome) this.#resolve(outcome);
        return;
      }
      case 'message.updated': {
        const info = props.info as OcMessageInfo | undefined;
        if (!info) return;
        this.#roles.set(info.id, info.role);
        const thread = this.threads.get(info.sessionID);
        if (!thread) return;
        if (info.role === 'user') {
          const index = claimForMessage(
            thread.entries,
            info.id,
            this.authorOf(info.id),
            this.self?.id ?? null
          );
          const entry = index === null ? null : thread.entries[index];
          if (entry?.kind === 'user') entry.messageID = info.id;
          return;
        }
        if (info.role !== 'assistant') return;
        if (info.error && !ocIsAborted(info.error) && (thread.loaded || thread.loading)) {
          if (this.#pushError(thread, info.error, info.id) && thread.busy) {
            this.#signal('error', thread.id, ocErrorMessage(info.error));
          }
        }
        if (thread.busy && typeof info.cost === 'number') thread.turnCosts.set(info.id, info.cost);
        if (info.tokens && (info.tokens.total ?? 0) > 0) thread.ctxTokens = info.tokens;
        return;
      }
      case 'message.part.updated': {
        const part = props.part as OcPart | undefined;
        if (!part) return;
        const owner = this.#owner(part.sessionID);
        if (!owner) return;
        if (this.#roles.get(part.messageID) === 'user') {
          if (owner.target === owner.thread.entries) this.#onUserPart(owner.thread, part);
          return;
        }
        this.#appendPart(owner.thread, part, owner.target);
        return;
      }
      case 'message.part.delta': {
        if (props.field !== 'text') return;
        const partID = String(props.partID);
        const scoped = sessionID ? this.#owner(sessionID)?.thread : null;
        const pool = scoped ? [scoped] : [...this.threads.values()];
        for (const thread of pool) {
          const entry = thread.parts.get(partID);
          if (entry && (entry.kind === 'text' || entry.kind === 'thinking')) {
            entry.text += String(props.delta ?? '');
            return;
          }
        }
        return;
      }
    }
  }

  rootOf(sessionID: string): string {
    if (this.threads.has(sessionID)) return sessionID;
    return this.#parents.get(sessionID) ?? this.#children.get(sessionID)?.thread.id ?? sessionID;
  }

  noteAuthor(entry: NoteEntry): ChatAuthor | null {
    if (this.#answeredHere.has(entry.requestId)) return this.self;
    return this.answerAuthorOf(entry.requestId);
  }

  addRequest(request: AgentRequest, dir: string | null = null) {
    this.#ask(request, dir, true);
  }

  #syncWaiting() {
    const owners = new Set<string>();
    for (const item of this.pending.values()) {
      if (item.state === 'open') owners.add(this.rootOf(item.request.sessionID));
    }
    for (const id of [...this.waiting]) if (!owners.has(id)) this.waiting.delete(id);
    for (const id of owners) if (!this.waiting.has(id)) this.waiting.add(id);
  }

  #dropPending(sessionID: string) {
    for (const [id, item] of [...this.pending]) {
      const owner = item.request.sessionID;
      if (owner === sessionID || this.rootOf(owner) === sessionID) this.pending.delete(id);
    }
    this.#syncWaiting();
  }

  #remember(id: string) {
    this.#done.add(id);
    if (this.#done.size <= DONE_CAP) return;
    const oldest = this.#done.values().next().value;
    if (oldest !== undefined) this.#done.delete(oldest);
  }

  #setState(id: string, state: PendingState) {
    const item = this.pending.get(id);
    if (!item || item.state === state) return;
    this.pending.set(id, { ...item, state });
    this.#syncWaiting();
  }

  #sentLastPrompt(owner: string): boolean {
    const last = this.lastPrompt(owner);
    if (!last) return false;
    return last.local || (!!this.self && last.authorId === this.self.id);
  }

  #ask(request: AgentRequest, dir: string | null, quiet = false) {
    if (this.#done.has(request.id)) return;
    const known = this.pending.get(request.id);
    if (known) {
      if (!known.dir && dir) this.pending.set(request.id, { ...known, dir });
      return;
    }
    const owner = this.rootOf(request.sessionID);
    if (owner === request.sessionID && !this.sessions.some((s) => s.id === owner)) {
      void this.#findParent(owner);
    }
    const auto =
      request.kind === 'permission' &&
      this.autoAccept() &&
      this.canAnswer() &&
      this.#sentLastPrompt(owner);
    this.pending.set(request.id, {
      request,
      dir,
      state: auto ? 'auto' : 'open',
      seen: Date.now()
    });
    this.#syncWaiting();
    if (auto && request.kind === 'permission') {
      void this.#autoReply(request);
      return;
    }
    if (quiet || this.#asked.has(request.id)) return;
    this.#asked.add(request.id);
    this.#signal('attention', owner, requestDetail(request, this.#sessionDir(owner)));
  }

  async #findParent(sessionID: string) {
    let id = sessionID;
    for (let hop = 0; hop < PARENT_HOPS; hop += 1) {
      let session: OcSession;
      try {
        const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        session = (await res.json()) as OcSession;
      } catch {
        return;
      }
      if (!session.parentID) break;
      id = session.parentID;
      if (this.threads.has(id) || this.sessions.some((s) => s.id === id)) break;
    }
    if (this.#destroyed || id === sessionID || this.#parents.get(sessionID) === id) return;
    this.#parents.set(sessionID, id);
    this.#syncWaiting();
  }

  async #autoReply(request: PermissionRequest) {
    const result = await this.#postPermission(request, 'once');
    const outcome: RequestOutcome = {
      kind: 'permission',
      id: request.id,
      sessionID: request.sessionID,
      reply: 'once'
    };
    if ('error' in result) {
      this.#answeredHere.delete(request.id);
      this.#setState(request.id, 'open');
      const owner = this.rootOf(request.sessionID);
      this.#signal('attention', owner, requestDetail(request, this.#sessionDir(owner)));
      return;
    }
    this.#finish(request.id, result, outcome);
  }

  #resolve(outcome: RequestOutcome) {
    if (this.#done.has(outcome.id)) return;
    this.#remember(outcome.id);
    const item = this.pending.get(outcome.id);
    if (!item) return;
    const owner = this.rootOf(item.request.sessionID);
    const auto = item.state === 'auto';
    this.#note(owner, item, outcome, auto);
    if (auto) {
      setTimeout(() => {
        if (this.pending.get(outcome.id)?.state !== 'auto') return;
        this.pending.delete(outcome.id);
      }, AUTO_LINGER_MS);
    } else {
      this.pending.delete(outcome.id);
    }
    this.#syncWaiting();
    const plan = planHandoff(item.request);
    if (plan && outcome.kind === 'question' && outcome.answers?.[0]?.[0] === plan.yes) {
      this.#leavePlan(owner);
    }
  }

  #note(owner: string, item: PendingItem, outcome: RequestOutcome, auto: boolean) {
    const dir = this.#sessionDir(owner) ?? this.directory;
    const entry: NoteEntry = {
      kind: 'note',
      key: nextKey(),
      time: Date.now(),
      requestId: item.request.id,
      ...noteFor(item.request, outcome, dir),
      auto
    };
    const list = this.#notes.get(owner) ?? [];
    list.push(entry);
    this.#notes.set(owner, list);
    const thread = this.threads.get(owner);
    if (thread && (thread.loaded || thread.loading)) thread.push(entry);
  }

  #leavePlan(owner: string) {
    if (owner === this.activeId) {
      if (this.plan) this.setPlan(false);
      return;
    }
    const prefs = this.#prefs.get(owner);
    if (prefs) this.#prefs.set(owner, { ...prefs, plan: false });
  }

  #replyDir(item: { request: AgentRequest; dir: string | null }): string {
    const dir = item.dir ?? this.#sessionDir(this.rootOf(item.request.sessionID)) ?? this.directory;
    return dir ? `?directory=${encodeURIComponent(dir)}` : '';
  }

  async #postPermission(
    request: PermissionRequest,
    reply: PermissionReply,
    message?: string
  ): Promise<ReplyResult & { api?: 'current' | 'legacy' }> {
    const item = this.pending.get(request.id) ?? { request, dir: null };
    const base = ocBase(this.sandboxId);
    const query = this.#replyDir(item);
    const post = (path: string, body: unknown) =>
      apiFetch(`${base}${path}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    const calls = {
      current: () =>
        post(`/permission/${encodeURIComponent(request.id)}/reply`, {
          reply,
          ...(message ? { message } : {})
        }),
      legacy: () =>
        post(
          `/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`,
          { response: reply }
        )
    };
    const order: Array<'current' | 'legacy'> =
      request.legacy || this.#replyApi === 'legacy' ? ['legacy', 'current'] : ['current', 'legacy'];
    this.#answeredHere.add(request.id);
    let missing = false;
    for (const api of order) {
      let res: Response;
      try {
        res = await calls[api]();
      } catch {
        return { error: 'Could not reach the agent' };
      }
      if (res.ok) {
        this.#replyApi = api;
        return { ok: true, api };
      }
      const body = await readBody(res);
      const gone = replyGone({ status: res.status, body });
      if (gone === true) return { gone: true };
      if (gone === false) {
        missing = true;
        continue;
      }
      return { error: bodyMessage(body, 'The agent did not take the answer') };
    }
    return missing ? { gone: true } : { error: 'The agent did not take the answer' };
  }

  #finish(id: string, result: ReplyResult, outcome: RequestOutcome) {
    if ('ok' in result) {
      this.#resolve(outcome);
      return;
    }
    if ('gone' in result) {
      this.#answeredHere.delete(id);
      this.#setState(id, 'sending');
      setTimeout(() => {
        if (this.pending.get(id)?.state !== 'sending') return;
        this.pending.delete(id);
        this.#syncWaiting();
      }, GONE_GRACE_MS);
    }
  }

  #replyFailed(id: string, error: string) {
    this.#answeredHere.delete(id);
    this.#setState(id, 'open');
    toasts.add({ title: 'Could not send your answer', description: error, color: 'error' });
  }

  #queueFor(threadId: string, text: string, plan: boolean | null = null) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const base =
      threadId === this.activeId
        ? this.choice()
        : (this.#prefs.get(threadId) ?? thread.lastChoice ?? this.choice());
    thread.queue.push({
      id: crypto.randomUUID(),
      text,
      attachments: [],
      choice: plan === null ? base : { ...base, plan },
      createdAt: Date.now()
    });
    this.#drain(thread);
  }

  async replyPermission(id: string, reply: PermissionReply, message?: string): Promise<boolean> {
    const item = this.pending.get(id);
    if (!item || item.request.kind !== 'permission' || item.state !== 'open') return false;
    if (!this.canAnswer()) return false;
    const acp = this.acpChats.get(item.request.sessionID);
    if (acp) {
      this.#setState(id, 'sending');
      this.#answeredHere.add(id);
      try {
        await acp.answer(id, reply);
        return true;
      } catch (e) {
        this.#replyFailed(id, e instanceof Error ? e.message : 'The agent did not take the answer');
        return false;
      }
    }
    const request = item.request;
    const text = reply === 'reject' ? message?.trim() || undefined : undefined;
    this.#setState(id, 'sending');
    const result = await this.#postPermission(request, reply, text);
    if ('error' in result) {
      this.#replyFailed(id, result.error);
      return false;
    }
    this.#finish(id, result, { kind: 'permission', id, sessionID: request.sessionID, reply });
    if (text && 'ok' in result && result.api === 'legacy') {
      this.#queueFor(this.rootOf(request.sessionID), text);
    }
    return true;
  }

  async #postQuestion(request: QuestionRequest, answers: string[][] | null): Promise<ReplyResult> {
    const item = this.pending.get(request.id) ?? { request, dir: null };
    const action = answers ? 'reply' : 'reject';
    this.#answeredHere.add(request.id);
    try {
      const res = await apiFetch(
        `${ocBase(this.sandboxId)}/question/${encodeURIComponent(request.id)}/${action}${this.#replyDir(item)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answers ? { answers } : {})
        }
      );
      if (res.ok) return { ok: true };
      const body = await readBody(res);
      if (replyGone({ status: res.status, body }) === true) return { gone: true };
      return { error: bodyMessage(body, 'The agent did not take the answer') };
    } catch {
      return { error: 'Could not reach the agent' };
    }
  }

  async #settleQuestion(id: string, answers: string[][] | null): Promise<boolean> {
    const item = this.pending.get(id);
    if (!item || item.request.kind !== 'question' || item.state !== 'open') return false;
    if (!this.canAnswer()) return false;
    const request = item.request;
    this.#setState(id, 'sending');
    const result = await this.#postQuestion(request, answers);
    if ('error' in result) {
      this.#replyFailed(id, result.error);
      return false;
    }
    this.#finish(id, result, { kind: 'question', id, sessionID: request.sessionID, answers });
    return true;
  }

  answerQuestion(id: string, answers: string[][]): Promise<boolean> {
    return this.#settleQuestion(id, answers);
  }

  rejectQuestion(id: string): Promise<boolean> {
    return this.#settleQuestion(id, null);
  }

  async answerPlan(id: string, build: boolean, feedback?: string): Promise<boolean> {
    const item = this.pending.get(id);
    const plan = item ? planHandoff(item.request) : null;
    if (!item || !plan) return false;
    const owner = this.rootOf(item.request.sessionID);
    const ok = await this.#settleQuestion(id, [[build ? plan.yes : plan.no]]);
    const text = feedback?.trim();
    if (ok && !build && text) this.#queueFor(owner, text, true);
    return ok;
  }

  #syncPending(): Promise<void> {
    if (this.#pendingSync) return this.#pendingSync;
    this.#pendingSync = this.#readPending().finally(() => (this.#pendingSync = null));
    return this.#pendingSync;
  }

  async #readPending() {
    const started = Date.now();
    const dirs = new Set<string | null>();
    if (this.directory) dirs.add(this.directory);
    for (const thread of this.threads.values()) {
      const dir = this.#sessionDir(thread.id);
      if (dir) dirs.add(dir);
    }
    dirs.add(null);
    const found: Array<{ request: AgentRequest; dir: string | null }> = [];
    const covered = new Set<string>();
    await Promise.all(
      [...dirs].flatMap((dir) =>
        (['permission', 'question'] as const).map(async (kind) => {
          try {
            const query = dir ? `?directory=${encodeURIComponent(dir)}` : '';
            const res = await apiFetch(`${ocBase(this.sandboxId)}/${kind}${query}`);
            if (!res.ok) return;
            for (const request of parseRequestList(kind, await res.json())) {
              found.push({ request, dir });
            }
            covered.add(`${kind}:${dir ?? ''}`);
          } catch {
            return;
          }
        })
      )
    );
    if (this.#destroyed || covered.size === 0) return;
    const listed = new Set(found.map((f) => f.request.id));
    for (const [id, item] of [...this.pending]) {
      if (item.state !== 'open' || item.seen > started || listed.has(id)) continue;
      if (covered.has(`${item.request.kind}:${item.dir ?? ''}`)) this.pending.delete(id);
    }
    found.sort((a, b) => (a.dir ? 0 : 1) - (b.dir ? 0 : 1));
    for (const { request, dir } of found) this.#ask(request, dir, true);
    this.#syncWaiting();
  }

  #syncStatus(): Promise<void> {
    if (this.#syncing) return this.#syncing;
    this.#syncing = this.#readStatus().finally(() => (this.#syncing = null));
    return this.#syncing;
  }

  async #readStatus() {
    const dirs = new Set<string | null>([null]);
    if (this.directory) dirs.add(this.directory);
    for (const thread of this.threads.values()) {
      const dir = this.#sessionDir(thread.id);
      if (dir) dirs.add(dir);
    }
    const status: Record<string, { type?: string }> = {};
    const covered = new Set<string | null>();
    await Promise.all(
      [...dirs].map(async (dir) => {
        try {
          const query = dir ? `?directory=${encodeURIComponent(dir)}` : '';
          const res = await apiFetch(`${ocBase(this.sandboxId)}/session/status${query}`);
          if (!res.ok) return;
          Object.assign(status, (await res.json()) as Record<string, { type?: string }>);
          covered.add(dir);
        } catch {
          return;
        }
      })
    );
    if (covered.size === 0 || this.#destroyed) return;
    for (const [id, value] of Object.entries(status)) {
      if (value?.type === 'busy' || value?.type === 'retry') this.#markBusy(id, value.type);
    }
    const now = Date.now();
    for (const thread of this.threads.values()) {
      const current = status[thread.id]?.type;
      if (current === 'busy' || current === 'retry') continue;
      if (!covered.has(this.#sessionDir(thread.id))) continue;
      if (thread.busy && thread.turnStart > 0 && now - thread.turnStart < STATUS_GRACE_MS) continue;
      this.activity.set(thread.id, 'idle');
      if (!thread.busy || thread.id.startsWith(TEMP_PREFIX)) continue;
      this.#endTurnQuietly(thread);
      await this.#loadHistory(thread);
      if (!this.#turnFailed(thread)) this.#signal('done', thread.id, this.lastAnswer(thread.id));
      this.#drain(thread);
    }
  }

  #pollStatus() {
    if (this.#statusTimer) return;
    this.#statusTimer = setInterval(() => {
      if (!this.#live || this.connection !== 'ready') return;
      if (typeof document !== 'undefined' && document.hidden) return;
      let busy = false;
      for (const thread of this.threads.values()) {
        if (thread.busy && !thread.id.startsWith(TEMP_PREFIX)) busy = true;
      }
      if (busy) void this.#syncStatus();
    }, STATUS_POLL_MS);
  }

  #invalidateBackground() {
    for (const thread of this.threads.values()) {
      if (thread.id === this.activeId || thread.busy || thread.loading) continue;
      if (thread.id.startsWith(TEMP_PREFIX)) continue;
      thread.loaded = false;
    }
  }

  #openStream() {
    if (this.#stream || this.#destroyed || !this.#live) return;
    const ctrl = new AbortController();
    this.#stream = ctrl;
    this.#pollStatus();
    void this.#eventLoop(ctrl.signal);
  }

  async #eventLoop(signal: AbortSignal) {
    let global = true;
    for (;;) {
      try {
        const path = global ? '/global/event' : `/event${this.#dir(null)}`;
        const res = await apiFetch(`${ocBase(this.sandboxId)}${path}`, {
          signal,
          headers: { Accept: 'text/event-stream' }
        });
        if (global && (res.status === 404 || res.status === 403)) {
          global = false;
          continue;
        }
        if (!res.ok || !res.body) throw new Error('event stream unavailable');
        if (this.#connectedOnce) this.#invalidateBackground();
        this.#connectedOnce = true;
        void this.#syncStatus();
        void this.#syncPending();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            this.#handleFrame(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }

  #handleFrame(frame: string) {
    const payload = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload) as OcEvent & { payload?: OcEvent; directory?: unknown };
      const wrapped = !!parsed.payload && typeof parsed.payload === 'object' && !parsed.type;
      const directory = wrapped && typeof parsed.directory === 'string' ? parsed.directory : null;
      this.#handleEvent(wrapped && parsed.payload ? parsed.payload : parsed, directory);
    } catch {
      return;
    }
  }

  transcriptText(): string {
    const lines: string[] = [];
    for (const entry of this.active?.entries ?? []) {
      if (entry.kind === 'user') lines.push(`> ${entry.text}`);
      else if (entry.kind === 'text') lines.push(entry.text);
      else if (entry.kind === 'tool') lines.push(`[${entry.name}] ${entry.summary}`);
      else if (entry.kind === 'agent') lines.push(`[${entry.agentType}] ${entry.description}`);
      else if (entry.kind === 'result') {
        lines.push(
          `-- ${entry.duration !== null ? fmtDuration(entry.duration) : 'turn complete'}${entry.cost !== null ? ` · ${fmtCost(entry.cost)}` : ''}`
        );
      } else if (entry.kind === 'error') lines.push(`! ${entry.detail}`);
      else if (entry.kind === 'note') {
        lines.push(`· ${entry.lead}${entry.target ? ` ${entry.target}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  turnText(index: number): string {
    const entries = this.active?.entries ?? [];
    const chunks: string[] = [];
    for (let i = index - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.kind === 'user' || entry.kind === 'result') break;
      if (entry.kind === 'text') chunks.unshift(entry.text);
    }
    return chunks.join('\n\n');
  }
}
