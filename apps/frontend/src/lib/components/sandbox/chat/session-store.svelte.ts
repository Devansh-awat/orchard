import { SvelteMap } from 'svelte/reactivity';
import { apiFetch, toasts } from '$lib/stores';
import {
	OC_ATTACH_MAX_BYTES,
	OC_ATTACH_MAX_COUNT,
	OC_MODEL,
	ocBase,
	ocErrorMessage,
	ocFilePart,
	ocFmtBytes,
	ocFmtTokens,
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

export type ChatAuthor = { id: string; name: string; avatarUrl?: string | null };

export type ChatComment = {
	id: string;
	author: ChatAuthor;
	body: string;
	createdAt: string | number;
	sessionId: string;
};

export type SlashCommand = { name: string; description: string };

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
	expanded: boolean;
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

export type ErrorEntry = { kind: 'error'; key: string; detail: string; time?: number };

export type ChatEntry =
	| UserEntry
	| ThinkingEntry
	| TextEntry
	| ToolEntry
	| AgentEntry
	| ResultEntry
	| ErrorEntry;

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
};

export type QueuedPrompt = {
	id: string;
	text: string;
	attachments: OcAttachment[];
	choice: ModelChoice;
	createdAt: number;
};

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

export type SessionActivity = 'idle' | 'busy' | 'retry';

export type ContextMeter = {
	used: number;
	limit: number | null;
	pct: number;
	tooltip: string;
};

export type SessionStoreOptions = {
	initialSessionId?: string | null;
	directory?: string | null;
	self?: ChatAuthor | null;
	onTurnDone?: () => void;
	onDraftChange?: (text: string) => void;
	beforePrompt?: (sessionId: string, text: string) => Promise<{ messageID?: string }>;
};

const TEMP_PREFIX = 'pending-';
const RETRY_PROBE_MS = 10_000;
const RECONNECT_MS = 2000;
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
		expanded: false
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

export class SessionThread {
	id: string;
	entries = $state<ChatEntry[]>([]);
	loading = $state(false);
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
	sessions = $state<ChatSession[]>([]);
	activeId = $state<string | null>(null);
	readonly threads = new SvelteMap<string, SessionThread>();
	readonly activity = new SvelteMap<string, SessionActivity>();

	providerID = $state(OC_MODEL.providerID);
	modelID = $state(OC_MODEL.modelID);
	variant = $state<string | null>(null);
	plan = $state(false);

	attachments = $state<OcAttachment[]>([]);
	revertBusy = $state<string | null>(null);
	sentTick = $state(0);

	directory = $state<string | null>(null);
	self = $state.raw<ChatAuthor | null>(null);
	comments = $state.raw<ChatComment[]>([]);
	authorOf = $state.raw<(messageId: string) => ChatAuthor | null>(() => null);
	beforePrompt: SessionStoreOptions['beforePrompt'] | null = null;
	onDraftChange: ((text: string) => void) | null = null;
	onTurnDone: (() => void) | null = null;

	#draft = $state('');
	#initialSessionId: string | null;
	#prefs = new Map<string, ModelChoice>();
	#roles = new Map<string, string>();
	#children = new Map<string, { thread: SessionThread; agent: AgentEntry }>();
	#createWork: Promise<void> | null = null;
	#probing: Promise<void> | null = null;
	#live = false;
	#connectedOnce = false;
	#stream: AbortController | null = null;
	#probeTimer: ReturnType<typeof setTimeout> | null = null;
	#destroyed = false;

	constructor(sandboxId: string, options: SessionStoreOptions = {}) {
		this.sandboxId = sandboxId;
		this.#initialSessionId = options.initialSessionId ?? null;
		this.directory = options.directory ?? null;
		this.self = options.self ?? null;
		this.onTurnDone = options.onTurnDone ?? null;
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

	readonly busy = $derived(this.active?.busy ?? false);

	readonly model = $derived(
		this.models.find((m) => m.providerID === this.providerID && m.modelID === this.modelID) ?? null
	);

	readonly variants = $derived(this.model?.variants ?? []);

	readonly modelGroups = $derived(ocModelGroups(this.models));

	readonly context = $derived.by((): ContextMeter => {
		const tokens = this.active?.ctxTokens ?? null;
		const limit = this.model?.context ?? null;
		if (!tokens) return { used: 0, limit, pct: 0, tooltip: '' };
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
			].join('\n')
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
			plan: this.plan
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
	}

	destroy() {
		this.#destroyed = true;
		this.pause();
	}

	async #probe() {
		if (this.connection !== 'unreachable') this.connection = 'connecting';
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
		ocModels(this.sandboxId)
			.then((models) => (this.models = models))
			.catch(() => {});
		this.#openStream();
		try {
			await this.#loadSessions();
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

	setPlan(plan: boolean) {
		this.plan = plan;
		this.#savePrefs();
	}

	async #loadSessions() {
		try {
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session?roots=true&limit=20`);
			if (!res.ok) return;
			const list = (await res.json()) as OcSession[];
			this.sessions = list.filter((s) => !s.parentID && !s.time.archived).map(toSession);
			await this.#syncStatus();
			const wanted = this.#initialSessionId;
			if (wanted && (await this.#ensureListed(wanted))) {
				await this.selectSession(wanted);
			} else if (this.sessions.length === 0) {
				await this.createSession();
			} else {
				await this.selectSession(this.sessions[0].id);
			}
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

	async selectSession(id: string) {
		if (id === this.activeId) return;
		if (!id.startsWith(TEMP_PREFIX) && !(await this.#ensureListed(id))) return;
		this.#savePrefs();
		this.activeId = id;
		const thread = this.#thread(id);
		if (thread.loaded || thread.loading || id.startsWith(TEMP_PREFIX)) {
			this.#restorePrefs(thread);
			return;
		}
		await this.#loadHistory(thread);
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
			await apiFetch(`${ocBase(this.sandboxId)}/session/${id}`, {
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

		try {
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${id}`, {
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
	}

	async fork(messageID: string) {
		const thread = this.active;
		if (!thread || this.revertBusy) return;
		this.revertBusy = messageID;
		try {
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${thread.id}/fork`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messageID })
			});
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

	async revert(messageID: string) {
		const thread = this.active;
		if (!thread || this.revertBusy) return;
		this.revertBusy = messageID;
		try {
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${thread.id}/revert`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messageID })
			});
			if (!res.ok) throw await failure(res, 'Could not revert to this point');
			const session = (await res.json()) as OcSession;
			await this.#loadHistory(thread);
			thread.revertedMessageID = session.revert?.messageID ?? messageID;
			this.onTurnDone?.();
		} catch (e) {
			toasts.add({
				title: 'Revert failed',
				description: e instanceof Error ? e.message : 'Could not revert to this point',
				color: 'error'
			});
		} finally {
			this.revertBusy = null;
		}
	}

	async unrevert() {
		const thread = this.active;
		if (!thread || this.revertBusy) return;
		this.revertBusy = 'undo';
		try {
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${thread.id}/unrevert`, {
				method: 'POST'
			});
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
		thread.stopping = true;
		try {
			await apiFetch(`${ocBase(this.sandboxId)}/session/${thread.id}/abort`, { method: 'POST' });
		} catch {
			return;
		} finally {
			thread.stopping = false;
		}
	}

	async #loadHistory(thread: SessionThread) {
		thread.reset();
		thread.loading = true;
		let ok = false;
		try {
			const res = await apiFetch(
				`${ocBase(this.sandboxId)}/session/${thread.id}/message?limit=100`
			);
			if (!res.ok) return;
			this.#hydrate(thread, (await res.json()) as OcMessage[]);
			ok = true;
			const sres = await apiFetch(`${ocBase(this.sandboxId)}/session/${thread.id}`);
			if (sres.ok) {
				const session = (await sres.json()) as OcSession;
				thread.revertedMessageID = session.revert?.messageID ?? null;
			}
		} catch {
			return;
		} finally {
			thread.loading = false;
			thread.loaded = ok;
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
					plan: lastAssistant.agent === 'plan'
				};
			}
		}
		if (thread.id === this.activeId) this.#restorePrefs(thread);
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

	async addFiles(files: FileList | File[] | null | undefined) {
		if (!files) return;
		const incoming = Array.from(files);
		if (incoming.length === 0) return;
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
		for (const file of accepted) {
			try {
				this.attachments.push(await ocReadAttachment(file));
			} catch {
				toasts.add({ title: 'Could not read file', description: file.name, color: 'error' });
			}
		}
	}

	removeAttachment(id: string) {
		this.attachments = this.attachments.filter((a) => a.id !== id);
	}

	async send(): Promise<boolean> {
		const text = this.draft.trim();
		const files = [...this.attachments];
		if (!text && files.length === 0) return false;
		if (!this.activeId) await this.createSession();
		const thread = this.active;
		if (!thread) return false;
		this.draft = '';
		this.attachments = [];
		const choice = this.choice();
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
		const sent = await this.#dispatch(thread, text, files, choice);
		if (!sent && this.attachments.length === 0) this.attachments = files;
		return sent;
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
		if (!thread || thread.busy) return;
		const index = thread.queue.findIndex((q) => q.id === id);
		if (index === -1) return;
		const [item] = thread.queue.splice(index, 1);
		void this.#dispatch(thread, item.text, item.attachments, item.choice);
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
		const draft: UserEntry = {
			kind: 'user',
			key: nextKey(),
			text,
			time: Date.now(),
			author: this.self,
			local: true,
			...(files.length > 0 ? { attachments: files } : {})
		};
		const entry = thread.push(draft);
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
			const assigned = this.beforePrompt ? await this.beforePrompt(sessionId, text) : null;
			if (assigned?.messageID) entry.messageID = assigned.messageID;
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session/${sessionId}/prompt_async`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...(assigned?.messageID ? { messageID: assigned.messageID } : {}),
					model: { providerID: choice.providerID, modelID: choice.modelID },
					...(choice.variant ? { variant: choice.variant } : {}),
					agent: choice.plan ? 'plan' : 'build',
					parts: [...files.map(ocFilePart), { type: 'text', text }]
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Chat request failed');
			}
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

	#onUserPart(thread: SessionThread, part: OcPart) {
		if (part.type !== 'text' || !part.text?.trim() || part.synthetic || part.ignored) return;
		const known = thread.entries.find(
			(e): e is UserEntry => e.kind === 'user' && e.messageID === part.messageID
		);
		if (known) return;
		const unclaimed = thread.entries.some((e) => e.kind === 'user' && !e.messageID && e.local);
		if (unclaimed) return;
		thread.push({
			kind: 'user',
			key: nextKey(),
			text: part.text,
			time: part.time?.start ?? Date.now(),
			messageID: part.messageID
		});
	}

	#handleEvent(event: OcEvent) {
		const props = event.properties ?? {};
		const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null;
		switch (event.type) {
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
					const thread = this.threads.get(sessionID);
					if (thread?.busy) this.#finishTurn(thread, true);
				} else {
					this.#markBusy(sessionID, state);
				}
				return;
			}
			case 'session.idle': {
				if (!sessionID) return;
				this.activity.set(sessionID, 'idle');
				const thread = this.threads.get(sessionID);
				if (thread?.busy) this.#finishTurn(thread, true);
				return;
			}
			case 'session.error': {
				const aborted =
					props.error &&
					typeof props.error === 'object' &&
					(props.error as { name?: string }).name === 'MessageAbortedError';
				const targets = sessionID
					? [this.threads.get(sessionID)].filter((t): t is SessionThread => !!t)
					: this.active
						? [this.active]
						: [];
				for (const thread of targets) {
					if (aborted) {
						if (thread.busy) this.#finishTurn(thread, false);
						continue;
					}
					thread.push({
						kind: 'error',
						key: nextKey(),
						time: Date.now(),
						detail: ocErrorMessage(props.error)
					});
					if (thread.busy) this.#endTurnQuietly(thread);
				}
				return;
			}
			case 'message.updated': {
				const info = props.info as OcMessageInfo | undefined;
				if (!info) return;
				this.#roles.set(info.id, info.role);
				const thread = this.threads.get(info.sessionID);
				if (!thread) return;
				if (info.role === 'user') {
					if (thread.entries.some((e) => e.kind === 'user' && e.messageID === info.id)) return;
					for (let i = thread.entries.length - 1; i >= 0; i -= 1) {
						const entry = thread.entries[i];
						if (entry.kind !== 'user') continue;
						if (!entry.messageID) entry.messageID = info.id;
						break;
					}
					return;
				}
				if (info.role !== 'assistant') return;
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

	async #syncStatus() {
		try {
			const res = await apiFetch(`${ocBase(this.sandboxId)}/session/status`);
			if (!res.ok) return;
			const status = (await res.json()) as Record<string, { type?: string }>;
			for (const [id, value] of Object.entries(status)) {
				if (value?.type === 'busy' || value?.type === 'retry') this.#markBusy(id, value.type);
			}
			for (const thread of this.threads.values()) {
				const current = status[thread.id]?.type;
				if (current === 'busy' || current === 'retry') continue;
				this.activity.set(thread.id, 'idle');
				if (!thread.busy || thread.id.startsWith(TEMP_PREFIX)) continue;
				this.#endTurnQuietly(thread);
				await this.#loadHistory(thread);
				this.#drain(thread);
			}
		} catch {
			return;
		}
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
		void this.#eventLoop(ctrl.signal);
	}

	async #eventLoop(signal: AbortSignal) {
		for (;;) {
			try {
				const res = await apiFetch(`${ocBase(this.sandboxId)}/event`, { signal });
				if (!res.ok || !res.body) throw new Error('event stream unavailable');
				if (this.#connectedOnce) this.#invalidateBackground();
				this.#connectedOnce = true;
				void this.#syncStatus();
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
			this.#handleEvent(JSON.parse(payload) as OcEvent);
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
