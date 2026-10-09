import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { untrack } from 'svelte';
import { goto } from '$app/navigation';
import { toasts } from '$lib/stores';
import { queryClient } from '$lib/query';
import { optimisticSandboxStatus } from '$lib/queries/sandboxes';
import type {
	AgentSignal,
	ChatAuthor,
	ChatSessionStore,
	RemoteDraft
} from '$lib/components/sandbox/chat';
import {
	DiffComments,
	EditorWorkspace,
	baseName,
	toFsPath,
	type EditorFs,
	type RemoteCursor
} from '$lib/components/sandbox/editor';
import type { Sandbox, SandboxStatus } from '$lib/types/sandbox';
import * as api from './api';
import { alertCopy, showAgentNotification } from './agent-alerts';
import { DEFAULT_BRANCH_PREFIX, branchPrefixFor } from './branch-prefix';
import { CollabFiles } from './collab.svelte';
import { presenceColorVar } from './format';
import type { GreenhouseEnv } from './env';
import { greenhousePrefs } from './prefs.svelte';
import { playGreenhouseSound } from './sounds';
import type { LiveClient } from './live.svelte';
import type {
	CenterTab,
	GhChanges,
	GhChat,
	GhConnect,
	GhGitIdentity,
	GhMembers,
	GhRepo,
	GhSession,
	PersonRef,
	SessionActivityState
} from './types';

export type SessionsMode = 'loading' | 'server' | 'legacy';

export type Role = 'owner' | 'collaborator' | 'viewer' | 'admin';

export type SessionLaunch = {
	repo: string;
	title?: string;
	prompt?: string;
	baseBranch?: string;
	issue?: { provider: 'github' | 'linear'; ref: string };
	at: number;
};

export function isPreparing(session: GhSession | null | undefined): boolean {
	return !!session && (!!session.preparing || !!session.prepareError);
}

export interface WorkspaceHost {
	machine(): Sandbox | null;
	self(): PersonRef | null;
	superAdmin(): boolean;
	sessionId(): string | null;
	tab(): string | null;
	openSession(sid: string | null, tab?: string | null): void;
	openTab(tab: string | null): void;
}

export const VIEWER_ONLY = 'You joined as a read-only guest';
export const LINK_GITHUB = 'Link GitHub to push';

export function hostOnly(action: string): string {
	return `Only the host can ${action}`;
}

function relativeTo(root: string, path: string): string | null {
	const clean = toFsPath(path);
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return clean.startsWith(prefix) ? clean.slice(prefix.length) : null;
}

function legacySession(sandboxId: string, repo: GhRepo): GhSession {
	const now = new Date(0).toISOString();
	return {
		id: `repo:${repo.name}`,
		sandboxId,
		title: repo.name,
		slug: repo.name,
		repo: repo.name,
		branch: repo.branch,
		baseBranch: null,
		baseCommit: null,
		worktreePath: `${api.GH_HOME}/${repo.name}`,
		agent: 'opencode',
		opencodeSessionId: null,
		status: 'active',
		activity: 'idle',
		diffstat: null,
		aheadBehind: null,
		prUrl: null,
		prNumber: null,
		prState: null,
		previewDeploymentId: null,
		previewUrl: null,
		createdBy: null,
		createdAt: now,
		updatedAt: now,
		archivedAt: null
	};
}

export function isLegacy(session: GhSession | null | undefined): boolean {
	return !!session?.id.startsWith('repo:');
}

export function scopeOf(session: GhSession | null | undefined): api.Scope {
	if (!session) return {};
	return isLegacy(session) ? { repo: session.repo } : { session: session.id };
}

function chatTime(value: string | number | null | undefined): number {
	if (typeof value === 'number') return value;
	const parsed = value ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

export function chatTabId(chatId: string): string {
	return `chat:${chatId}`;
}

const NEXT_STATUS: Record<'start' | 'stop', SandboxStatus> = {
	start: 'starting',
	stop: 'stopping'
};

export class MachineWorkspace {
	readonly sandboxId: string;
	readonly host: WorkspaceHost;
	readonly env: GreenhouseEnv;
	readonly editor: EditorWorkspace;
	readonly comments = new DiffComments();
	readonly store: ChatSessionStore;
	readonly live: LiveClient;
	readonly collab: CollabFiles;

	sessions = $state.raw<GhSession[]>([]);
	mode = $state<SessionsMode>('loading');
	repos = $state.raw<GhRepo[]>([]);
	reposLoaded = $state(false);
	members = $state.raw<GhMembers | null>(null);
	connect = $state.raw<GhConnect | null>(null);
	connectLoaded = $state(false);
	busy = $state<string | null>(null);

	readonly chats = new SvelteMap<string, GhChat[]>();
	readonly openTabs = new SvelteMap<string, CenterTab[]>();
	readonly drafts = new SvelteMap<string, boolean>();
	readonly changes = new SvelteMap<string, GhChanges>();
	readonly pendingPrompts = new SvelteMap<string, string>();
	readonly launches = new SvelteMap<string, SessionLaunch>();
	readonly #hiddenChats = new SvelteSet<string>();

	readonly machine = $derived.by(() => this.host.machine());
	readonly running = $derived(this.machine?.status === 'running');
	readonly sessionId = $derived.by(() => this.host.sessionId());
	readonly session = $derived(this.sessions.find((s) => s.id === this.sessionId) ?? null);
	readonly active = $derived(this.sessions.filter((s) => s.status !== 'archived'));
	readonly archived = $derived(this.sessions.filter((s) => s.status === 'archived'));

	readonly role = $derived.by((): Role => {
		const machine = this.machine;
		if (this.host.superAdmin()) return 'owner';
		if (machine?.myRole) return machine.myRole;
		if (this.members?.myRole) return this.members.myRole;
		const self = this.host.self();
		if (!machine?.owner || (self && machine.owner.id === self.id)) return 'owner';
		return 'viewer';
	});
	readonly isOwner = $derived(this.role === 'owner');
	readonly canEdit = $derived(this.role === 'owner' || this.role === 'collaborator');
	readonly canLifecycle = $derived(this.role === 'owner' || this.role === 'admin');
	readonly canStart = $derived(this.canEdit || this.role === 'admin');
	readonly lifecycleOnly = $derived(this.role === 'admin');

	githubUnlinked = $state(false);
	identity = $state.raw<GhGitIdentity | null>(null);

	readonly gitIdentity = $derived.by(() => {
		if (this.identity) return this.identity;
		const session = this.session;
		const fromChanges = session ? this.changes.get(session.id)?.identity : null;
		return fromChanges ?? this.members?.me ?? null;
	});
	readonly githubLinked = $derived.by((): boolean | null => {
		if (this.githubUnlinked) return false;
		const identity = this.gitIdentity;
		if (!identity) return null;
		if (typeof identity.githubLinked === 'boolean') return identity.githubLinked;
		return identity.githubLogin ? true : null;
	});
	readonly pushAs = $derived(this.githubLinked ? (this.gitIdentity?.githubLogin ?? null) : null);
	readonly canPush = $derived(
		this.canEdit && this.githubLinked !== false && this.gitIdentity?.canPush !== false
	);
	readonly prIsPrimary = $derived(!!this.session && !this.session.prNumber);

	readonly groups = $derived.by(() => {
		const names = new Set<string>();
		for (const repo of this.repos) names.add(repo.name);
		for (const session of this.active) names.add(session.repo);
		return [...names]
			.sort((a, b) => a.localeCompare(b))
			.map((name) => ({
				name,
				repo: this.repos.find((r) => r.name === name) ?? null,
				sessions: this.active
					.filter((s) => s.repo === name)
					.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			}));
	});

	readonly chatList = $derived.by((): GhChat[] => {
		const session = this.session;
		if (!session) return [];
		const known = (this.chats.get(session.id) ?? []).filter((c) => !this.#hiddenChats.has(c.id));
		const ids = new Set(known.map((c) => c.id));
		const fromStore = this.store.sessions
			.filter(
				(s) =>
					!s.pending &&
					s.directory === session.worktreePath &&
					!ids.has(s.id) &&
					!this.#hiddenChats.has(s.id)
			)
			.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt }))
			.sort((a, b) => chatTime(a.createdAt) - chatTime(b.createdAt));
		if (known.length + fromStore.length > 0) return [...known, ...fromStore];
		if (session.opencodeSessionId) {
			return [
				{ id: session.opencodeSessionId, title: session.title, createdAt: session.createdAt }
			];
		}
		return [];
	});

	readonly tabs = $derived.by((): CenterTab[] => {
		const session = this.session;
		if (!session) return [];
		const chats: CenterTab[] = this.chatList.map((chat) => ({
			kind: 'chat',
			id: chatTabId(chat.id),
			chatId: chat.id,
			title: chat.title || 'Chat'
		}));
		return [...chats, ...(this.openTabs.get(session.id) ?? [])];
	});

	readonly activeTab = $derived.by((): CenterTab | null => {
		const wanted = this.host.tab();
		const tabs = this.tabs;
		return tabs.find((t) => t.id === wanted) ?? tabs[0] ?? null;
	});

	readonly activeChatId = $derived.by(() => {
		const tab = this.activeTab;
		if (tab?.kind === 'chat') return tab.chatId;
		return this.chatList[0]?.id ?? null;
	});

	readonly remoteDrafts = $derived.by((): RemoteDraft[] =>
		this.live.draftsFor(this.activeChatId).map((d) => ({
			userId: d.user.id,
			name: d.user.name,
			text: d.text,
			avatarUrl: d.user.avatarUrl ?? null
		}))
	);

	readonly remoteCursors = $derived.by((): RemoteCursor[] =>
		this.live.others
			.filter((u) => u.view?.file && u.view.line)
			.map((u) => ({
				userId: u.id,
				name: u.name.split(' ')[0] || u.name,
				colorVar: presenceColorVar(u),
				line: u.view?.line ?? 1,
				col: u.view?.col ?? 1,
				selection: u.view?.selection ?? null,
				path: u.view?.file
			}))
	);

	#timers: ReturnType<typeof setInterval>[] = [];
	#disposed = false;

	constructor(sandboxId: string, host: WorkspaceHost, env: GreenhouseEnv) {
		this.sandboxId = sandboxId;
		this.host = host;
		this.env = env;
		this.editor = new EditorWorkspace(this.fs());
		this.live = env.createLive(sandboxId);
		this.store = env.createChatStore(sandboxId, {
			self: host.self(),
			onTurnDone: () => {
				const sid = untrack(() => this.sessionId);
				if (sid) void this.refreshChanges(sid);
				void this.refreshSessions();
				this.collab.reloadAll();
			},
			onSignal: (signal) => this.#alert(signal),
			onDraftChange: (text) => {
				const sid = untrack(() => this.sessionId);
				if (!sid) return;
				this.drafts.set(sid, text.trim().length > 0);
				const chatId = untrack(() => this.activeChatId);
				if (chatId && untrack(() => this.canEdit)) this.live.draft(chatId, text);
			},
			beforePrompt: async () => ({})
		});
		this.store.authorOf = (id: string): ChatAuthor | null => {
			const author = this.live.promptAuthors.get(id);
			return author
				? { id: author.id, name: author.name, avatarUrl: author.avatarUrl ?? null }
				: null;
		};
		this.store.isHost = () => this.isOwner;
		this.store.canAnswer = () => this.canEdit;
		this.store.autoAccept = () => greenhousePrefs.values.autoAcceptPermissions;
		this.store.answerAuthorOf = (id: string): ChatAuthor | null => {
			const author = this.live.answerAuthors.get(id);
			return author
				? { id: author.id, name: author.name, avatarUrl: author.avatarUrl ?? null }
				: null;
		};
		this.live.selfId = host.self()?.id ?? null;
		this.live.onSession = (session) => this.upsert(session);
		this.live.onPrompt = (user, chatId, messageId) => {
			if (user.id === host.self()?.id) this.store.claimPrompt(chatId, messageId);
		};
		this.collab = new CollabFiles({
			live: this.live,
			editor: this.editor,
			canWrite: () => untrack(() => this.canEdit),
			selfId: () => host.self()?.id ?? null,
			target: (path) => {
				const { session, rel } = this.resolve(path);
				if (!session || isLegacy(session) || isPreparing(session)) return null;
				if (!rel || rel.startsWith('/')) return null;
				return { sid: session.id, rel };
			}
		});
	}

	fs(): EditorFs {
		return {
			readFile: (path, opts) => {
				const { scope, rel } = this.resolve(path);
				return api.readFile(this.sandboxId, scope, rel, opts?.ref);
			},
			writeFile: async (path, content) => {
				const { scope, rel } = this.resolve(path);
				await api.writeFile(this.sandboxId, scope, rel, content);
				const sid = untrack(() => this.sessionId);
				if (sid) void this.refreshChanges(sid);
			}
		};
	}

	resolve(path: string): { scope: api.Scope; rel: string; session: GhSession | null } {
		const clean = toFsPath(path);
		const owner = this.sessions
			.filter((s) => clean.startsWith(`${s.worktreePath}/`))
			.sort((a, b) => b.worktreePath.length - a.worktreePath.length)[0];
		if (owner) {
			return {
				scope: scopeOf(owner),
				rel: relativeTo(owner.worktreePath, clean) ?? clean,
				session: owner
			};
		}
		const rel = relativeTo(api.GH_HOME, clean) ?? clean;
		return { scope: {}, rel, session: null };
	}

	absolute(session: GhSession, rel: string): string {
		return `${session.worktreePath}/${rel.replace(/^\.?\//, '')}`;
	}

	start() {
		void this.refreshAll();
		this.#timers.push(
			setInterval(() => {
				if (typeof document !== 'undefined' && document.hidden) return;
				void this.refreshSessions();
			}, 15_000),
			setInterval(() => {
				if (!untrack(() => this.sessions).some((s) => s.preparing)) return;
				void this.refreshSessions();
			}, 2000)
		);
	}

	async refreshAll() {
		if (untrack(() => this.lifecycleOnly)) {
			this.reposLoaded = true;
			this.connectLoaded = true;
			this.mode = 'server';
			return;
		}
		await Promise.all([
			this.refreshRepos(),
			this.refreshMembers(),
			this.refreshConnect(),
			this.refreshIdentity()
		]);
		await this.refreshSessions();
	}

	async refreshRepos() {
		if (!untrack(() => this.running)) {
			this.reposLoaded = true;
			return;
		}
		const res = await api.listRepos(this.sandboxId);
		if (this.#disposed) return;
		if (res.ok) this.repos = res.data.repos ?? [];
		this.reposLoaded = true;
	}

	async refreshSessions() {
		if (untrack(() => this.lifecycleOnly)) return;
		const res = await api.listSessions(this.sandboxId, true);
		if (this.#disposed) return;
		if (res.ok) {
			this.mode = 'server';
			this.sessions = res.data.sessions ?? [];
			return;
		}
		if (res.status === 404 || res.status === 405 || res.status === 0) {
			this.mode = 'legacy';
			this.sessions = this.repos.map((repo) => legacySession(this.sandboxId, repo));
		}
	}

	async refreshMembers() {
		const res = await api.listMembers(this.sandboxId);
		if (this.#disposed) return;
		if (res.ok) this.members = res.data;
	}

	async refreshIdentity() {
		const res = await api.gitIdentity(this.sandboxId);
		if (this.#disposed) return;
		this.identity = res.ok ? res.data : null;
		if (res.ok && res.data.githubLinked) this.githubUnlinked = false;
	}

	async refreshConnect() {
		const res = await api.connectInfo(this.sandboxId);
		if (this.#disposed) return;
		this.connect = res.ok ? res.data : null;
		this.connectLoaded = true;
	}

	async refreshChanges(sid: string) {
		const session = this.sessions.find((s) => s.id === sid);
		if (!session || isPreparing(session) || !untrack(() => this.running)) return;
		const res = await api.changes(this.sandboxId, scopeOf(session));
		if (this.#disposed || !res.ok) return;
		this.changes.set(sid, res.data);
	}

	async loadChats(sid: string) {
		const session = this.sessions.find((s) => s.id === sid);
		if (!session || isLegacy(session) || isPreparing(session)) return;
		const res = await api.listChats(this.sandboxId, sid);
		if (this.#disposed || !res.ok) return;
		const chats = res.data.chats ?? [];
		this.chats.set(sid, chats);
		if (chats.length === 0 && !session.opencodeSessionId) await this.#firstChat(session);
	}

	#creatingChat = new Set<string>();

	async #firstChat(session: GhSession) {
		if (this.#creatingChat.has(session.id)) return;
		if (!untrack(() => this.canEdit) || !untrack(() => this.running)) return;
		this.#creatingChat.add(session.id);
		try {
			const chat = await api.createChat(this.sandboxId, session.id);
			if (this.#disposed) return;
			this.chats.set(session.id, [chat]);
			if (untrack(() => this.sessionId) === session.id) this.host.openTab(chatTabId(chat.id));
		} catch (e) {
			toasts.add({
				title: 'Could not open a chat for this session',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			this.#creatingChat.delete(session.id);
		}
	}

	upsert(session: GhSession) {
		const exists = this.sessions.some((s) => s.id === session.id);
		this.sessions = exists
			? this.sessions.map((s) => (s.id === session.id ? session : s))
			: [session, ...this.sessions];
	}

	#chatIds(session: GhSession): Set<string> {
		const ids = new Set<string>();
		if (session.opencodeSessionId) ids.add(session.opencodeSessionId);
		for (const chat of this.chats.get(session.id) ?? []) ids.add(chat.id);
		for (const s of this.store.sessions) if (s.directory === session.worktreePath) ids.add(s.id);
		return ids;
	}

	activity(session: GhSession): SessionActivityState {
		const ids = this.#chatIds(session);
		for (const id of ids) if (this.store.waiting.has(id)) return 'needs_input';
		for (const id of ids) {
			const state = this.store.activity.get(id);
			if (state === 'busy' || state === 'retry') return 'working';
		}
		return session.activity;
	}

	sessionForChat(chatId: string): GhSession | null {
		const sessions = untrack(() => this.sessions);
		const direct = sessions.find(
			(s) => s.opencodeSessionId === chatId || this.chats.get(s.id)?.some((c) => c.id === chatId)
		);
		if (direct) return direct;
		const dir = this.store.sessions.find((s) => s.id === chatId)?.directory ?? null;
		return dir ? (sessions.find((s) => s.worktreePath === dir) ?? null) : null;
	}

	#watching(chatId: string, session: GhSession | null): { open: boolean; watched: boolean } {
		const openId = untrack(() => this.sessionId);
		const open = session
			? session.id === openId
			: untrack(() => this.mode) === 'legacy' && this.store.activeId === chatId;
		if (open) return { open, watched: true };
		const selfId = this.host.self()?.id ?? null;
		const last = this.store.lastPrompt(chatId);
		if (last?.local) return { open, watched: true };
		if (selfId && last?.authorId === selfId) return { open, watched: true };
		const creator = session?.createdBy?.id ?? null;
		return { open, watched: !!selfId && !last?.authorId && creator === selfId };
	}

	#alert(signal: AgentSignal) {
		if (this.#disposed) return;
		const session = this.sessionForChat(signal.sessionId);
		const { open, watched } = this.#watching(signal.sessionId, session);
		if (!watched) return;
		playGreenhouseSound(signal.kind);
		const prefs = greenhousePrefs.values;
		if (!prefs.notifyAgent) return;
		const hidden = typeof document !== 'undefined' && document.hidden;
		if (open && !hidden) return;
		const title =
			session?.title ?? this.store.sessions.find((s) => s.id === signal.sessionId)?.title ?? '';
		showAgentNotification(
			alertCopy(signal.kind, title, signal.detail, prefs.notAbsolutelyRight),
			`greenhouse:${signal.sessionId}:${signal.kind}`,
			() => {
				if (!session) return;
				this.host.openSession(session.id, isLegacy(session) ? null : chatTabId(signal.sessionId));
			}
		);
	}

	branchPrefix(): string {
		const prefs = greenhousePrefs.values;
		const login = untrack(() => this.gitIdentity?.githubLogin ?? null);
		return branchPrefixFor(prefs.branchPrefixMode, prefs.branchPrefixCustom, login);
	}

	hasDraft(sid: string): boolean {
		return this.drafts.get(sid) === true;
	}

	presenceIn(sid: string) {
		return this.sessionId === sid ? this.live.others : [];
	}

	#addTab(sid: string, tab: CenterTab) {
		const list = this.openTabs.get(sid) ?? [];
		if (!list.some((t) => t.id === tab.id)) this.openTabs.set(sid, [...list, tab]);
		this.host.openTab(tab.id);
	}

	openFile(path: string) {
		const session = this.session;
		if (!session) return;
		const abs = path.startsWith('/') ? path : this.absolute(session, path);
		this.editor.open(abs, { activate: true });
		this.#addTab(session.id, { kind: 'file', id: `file:${abs}`, path: abs, title: baseName(abs) });
	}

	openDiff(path: string) {
		const session = this.session;
		if (!session) return;
		const abs = path.startsWith('/') ? path : this.absolute(session, path);
		this.#addTab(session.id, { kind: 'diff', id: `diff:${abs}`, path: abs, title: baseName(abs) });
	}

	async openPreview(port: number) {
		const session = this.session;
		if (!session) return;
		const id = `preview:${port}`;
		this.#addTab(session.id, { kind: 'preview', id, port, title: `localhost:${port}`, url: null });
		await this.refreshPreview(port);
	}

	async refreshPreview(port: number) {
		const session = this.session;
		if (!session) return;
		const res = await api.previewToken(this.sandboxId, port);
		const url = res.ok ? res.data.url : null;
		const list = this.openTabs.get(session.id) ?? [];
		this.openTabs.set(
			session.id,
			list.map((t) => (t.kind === 'preview' && t.port === port ? { ...t, url } : t))
		);
		if (!res.ok) {
			toasts.add({
				title: res.status === 404 ? 'Previews are not available yet' : 'Could not open the preview',
				description: res.status === 404 ? 'This server has no preview proxy yet.' : res.message,
				color: 'error'
			});
		}
	}

	closeTab(id: string): boolean {
		const session = this.session;
		if (!session) return false;
		const list = this.openTabs.get(session.id) ?? [];
		const tab = list.find((t) => t.id === id);
		if (!tab) return false;
		if (tab.kind === 'file') {
			const shared = this.collab.get(tab.path)?.active ?? false;
			if (!shared && this.editor.isDirty(tab.path)) return false;
			this.collab.release(tab.path);
			this.editor.close(tab.path, { force: true });
		}
		const all = this.tabs;
		const index = all.findIndex((t) => t.id === id);
		this.openTabs.set(
			session.id,
			list.filter((t) => t.id !== id)
		);
		if (this.activeTab?.id === id) {
			const next = all[index + 1] ?? all[index - 1] ?? null;
			this.host.openTab(next && next.id !== id ? next.id : null);
		}
		return true;
	}

	reorder(from: number, to: number) {
		const session = this.session;
		if (!session) return;
		const chatCount = this.chatList.length;
		const list = [...(this.openTabs.get(session.id) ?? [])];
		const a = from - chatCount;
		const b = to - chatCount;
		if (a < 0 || b < 0 || a >= list.length || b >= list.length) return;
		const [moved] = list.splice(a, 1);
		list.splice(b, 0, moved);
		this.openTabs.set(session.id, list);
	}

	async deleteChat(chatId: string) {
		const session = this.session;
		if (!session || !this.canEdit || isLegacy(session)) return;
		const before = this.chats.get(session.id) ?? this.chatList;
		const tabs = this.tabs;
		const index = tabs.findIndex((t) => t.id === chatTabId(chatId));
		const wasActive = this.activeTab?.id === chatTabId(chatId);
		this.chats.set(
			session.id,
			before.filter((c) => c.id !== chatId)
		);
		this.#hiddenChats.add(chatId);
		if (wasActive) {
			const next = tabs[index + 1] ?? tabs[index - 1] ?? null;
			this.host.openTab(next && next.id !== chatTabId(chatId) ? next.id : null);
		}
		try {
			const res = await api.deleteChat(this.sandboxId, session.id, chatId);
			if (res.remaining === 0) await this.newChat();
		} catch (e) {
			this.chats.set(session.id, before);
			this.#hiddenChats.delete(chatId);
			toasts.add({
				title: 'Could not delete the chat',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async newChat() {
		const session = this.session;
		if (!session || !this.canEdit || isPreparing(session)) return;
		if (!isLegacy(session)) {
			try {
				const chat = await api.createChat(this.sandboxId, session.id);
				const list = this.chats.get(session.id) ?? this.chatList;
				this.chats.set(session.id, [...list, chat]);
				this.host.openTab(chatTabId(chat.id));
				return;
			} catch (e) {
				if (!(e instanceof api.GhApiError) || e.status !== 404) {
					toasts.add({
						title: 'Could not start a chat',
						description: e instanceof Error ? e.message : undefined,
						color: 'error'
					});
					return;
				}
			}
		}
		await this.store.createSession(session.worktreePath);
		const id = this.store.activeId;
		if (id) this.host.openTab(chatTabId(id));
	}

	async createSession(input: {
		repo: string;
		title?: string;
		prompt?: string;
		baseBranch?: string;
		issue?: { provider: 'github' | 'linear'; ref: string };
	}) {
		if (!this.canEdit) return null;
		try {
			const prefix = this.branchPrefix();
			const session = await api.createSession(this.sandboxId, {
				...input,
				...(prefix === DEFAULT_BRANCH_PREFIX ? {} : { branchPrefix: prefix })
			});
			this.upsert(session);
			this.launches.set(session.id, { ...input, at: Date.now() });
			this.host.openSession(session.id, null);
			return session;
		} catch (e) {
			if (e instanceof api.GhApiError && e.status === 404) {
				const repo = this.repos.find((r) => r.name === input.repo);
				if (repo) {
					const legacy = legacySession(this.sandboxId, repo);
					this.mode = 'legacy';
					if (!this.sessions.some((s) => s.id === legacy.id))
						this.sessions = [...this.sessions, legacy];
					if (input.prompt?.trim()) this.pendingPrompts.set(legacy.id, input.prompt.trim());
					this.host.openSession(legacy.id, null);
					return legacy;
				}
			}
			if (input.issue && e instanceof api.GhApiError && e.status === 403) {
				toasts.add({
					title: 'Only the host can start from this issue',
					description: e.message,
					color: 'error'
				});
				return null;
			}
			toasts.add({
				title: 'Could not start the session',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			return null;
		}
	}

	async setRepoIcon(name: string, icon: string | null) {
		const previous = this.repos.find((r) => r.name === name);
		if (!previous || (previous.icon ?? null) === icon) return;
		const patch = (value: string | null) =>
			(this.repos = this.repos.map((r) => (r.name === name ? { ...r, icon: value } : r)));
		patch(icon);
		try {
			const saved = await api.setRepoIcon(this.sandboxId, name, icon);
			if (this.#disposed) return;
			patch(saved.icon);
		} catch (e) {
			if (this.#disposed) return;
			patch(previous.icon ?? null);
			toasts.add({
				title: 'Could not change the icon',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
		void this.refreshRepos();
	}

	async renameSession(session: GhSession, title: string) {
		const next = title.trim();
		if (!next || next === session.title) return;
		const previous = session;
		this.upsert({ ...session, title: next });
		try {
			this.upsert(await api.patchSession(this.sandboxId, session.id, { title: next }));
		} catch (e) {
			this.upsert(previous);
			toasts.add({
				title: 'Rename failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async archiveSession(
		session: GhSession,
		archived = true,
		deleteBranch = archived && greenhousePrefs.values.deleteBranchOnArchive
	) {
		const previous = session;
		this.upsert({
			...session,
			status: archived ? 'archived' : 'active',
			archivedAt: archived ? new Date().toISOString() : null
		});
		if (archived && this.sessionId === session.id) this.host.openSession(null);
		try {
			this.upsert(
				await api.patchSession(this.sandboxId, session.id, {
					archived,
					...(archived && deleteBranch ? { deleteBranch: true } : {})
				})
			);
		} catch (e) {
			this.upsert(previous);
			toasts.add({
				title: archived ? 'Archive failed' : 'Restore failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async deleteSession(session: GhSession, deleteBranch: boolean): Promise<boolean> {
		const previous = this.sessions;
		this.sessions = this.sessions.filter((s) => s.id !== session.id);
		if (this.sessionId === session.id) this.host.openSession(null);
		try {
			await api.deleteSession(this.sandboxId, session.id, deleteBranch);
			this.launches.delete(session.id);
			return true;
		} catch (e) {
			this.sessions = previous;
			toasts.add({
				title: 'Delete failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			return false;
		}
	}

	async retrySession(session: GhSession) {
		if (!this.canEdit) return null;
		const launch = this.launches.get(session.id);
		const input = launch
			? {
					repo: launch.repo,
					title: launch.title,
					prompt: launch.prompt,
					baseBranch: launch.baseBranch,
					issue: launch.issue
				}
			: { repo: session.repo, title: session.title };
		if (!(await this.deleteSession(session, true))) return null;
		return this.createSession(input);
	}

	async forkSession(session: GhSession) {
		return this.createSession({
			repo: session.repo,
			baseBranch: session.branch,
			title: `${session.title} fork`
		});
	}

	async lifecycle(action: 'start' | 'stop') {
		const machine = this.machine;
		if (!machine || this.busy || !(action === 'start' ? this.canStart : this.canLifecycle)) return;
		this.busy = action;
		const previous = machine.status;
		optimisticSandboxStatus(queryClient, this.sandboxId, NEXT_STATUS[action]);
		try {
			await api.sandboxAction(this.sandboxId, action);
			void queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
		} catch (e) {
			optimisticSandboxStatus(queryClient, this.sandboxId, previous);
			toasts.add({
				title: `Could not ${action} ${machine.name}`,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			this.busy = null;
		}
	}

	async retryApply() {
		const machine = this.machine;
		if (!machine || this.busy || !this.canLifecycle) return;
		this.busy = 'retry';
		try {
			await api.retryApply(this.sandboxId);
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			toasts.add({ title: `Retrying the last change on ${machine.name}`, color: 'success' });
		} catch (e) {
			const missing = e instanceof api.GhApiError && (e.status === 404 || e.status === 405);
			toasts.add({
				title: missing ? 'Retry is not available on this server yet' : 'Retry failed',
				description: missing
					? 'Stop and start the machine to apply it again.'
					: e instanceof Error
						? e.message
						: undefined,
				color: missing ? 'info' : 'error'
			});
		} finally {
			this.busy = null;
		}
	}

	async createPr(draft = false) {
		const current = this.session;
		if (!current) return;
		const res = await api.createPr(this.sandboxId, scopeOf(current), {
			title: current.title,
			draft
		});
		const number = res.number ?? Number(res.url.split('/').pop());
		this.upsert({ ...current, prUrl: res.url, prNumber: number || null, prState: 'open' });
		toasts.add({
			title: draft ? 'Draft pull request opened' : 'Pull request opened',
			color: 'success',
			action: { label: 'View', onClick: () => window.open(res.url, '_blank', 'noopener') }
		});
	}

	prFailed(label: string, e: unknown) {
		if (api.isGithubUnlinked(e)) {
			this.githubUnlinked = true;
			toasts.add({
				title: LINK_GITHUB,
				description: 'Pushes and pull requests run with your own GitHub account.',
				color: 'info',
				action: { label: 'Link GitHub', onClick: () => goto(api.LINK_GITHUB_HREF) }
			});
			return;
		}
		toasts.add({
			title: `${label} failed`,
			description: e instanceof Error ? e.message : undefined,
			color: 'error'
		});
	}

	async removePreview(session: GhSession) {
		if (!this.isOwner) return false;
		try {
			const res = await api.removePreview(this.sandboxId, session.id);
			this.upsert(res.session);
			toasts.add({ title: 'Preview removed', color: 'success' });
			return true;
		} catch (e) {
			toasts.add({
				title: 'Could not remove the preview',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
			return false;
		}
	}

	async sendComment(chatId: string, body: string) {
		const session = this.session;
		const self = this.host.self();
		if (!session || !body.trim()) return;
		const local = {
			id: `local-${Date.now().toString(36)}`,
			chatId,
			author: self ?? { id: 'me', name: 'You' },
			body: body.trim(),
			createdAt: Date.now()
		};
		try {
			const saved = await api.postComment(this.sandboxId, session.id, chatId, body.trim());
			this.live.addLocalComment(saved);
		} catch {
			if (!this.live.comment(chatId, body.trim())) this.live.addLocalComment(local);
		}
	}

	async queuePrompt(text: string) {
		const store = this.store;
		store.draft = text;
		await store.send();
	}

	dispose() {
		this.#disposed = true;
		for (const timer of this.#timers) clearInterval(timer);
		this.#timers = [];
		this.collab.dispose();
		this.live.close();
		this.store.destroy();
		this.editor.dispose();
	}
}
