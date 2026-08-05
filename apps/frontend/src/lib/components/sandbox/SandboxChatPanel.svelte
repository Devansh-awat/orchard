<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { marked } from 'marked';
	import {
		ArrowDown,
		Bot,
		Brain,
		Check,
		ChevronDown,
		Copy,
		Loader2,
		Play,
		Plus,
		Send,
		Square,
		X
	} from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, Menu, MenuItem } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { fade, slide } from '$lib/utils/transitions';
	import { sandboxCredentialsQueryOptions } from '$lib/queries/sandboxes';
	import {
		OC_MODEL,
		ocBase,
		ocDirectory,
		ocErrorMessage,
		ocFmtTokens,
		ocModels,
		ocNormalizeTool,
		ocProbe,
		ocRepo,
		ocShortModelName,
		type OcEvent,
		type OcMessage,
		type OcMessageInfo,
		type OcModel,
		type OcPart,
		type OcSession,
		type OcTokens
	} from './opencode';
	import type { Sandbox, SandboxRepo } from '$lib/types/sandbox';

	type TurnFile = { name: string; path: string; add: number; del: number };

	type ToolEntry = {
		kind: 'tool';
		id: string | null;
		name: string;
		input: unknown;
		summary: string;
		title: string | null;
		diff: { add: number; del: number } | null;
		failed: boolean;
		expanded: boolean;
	};

	type AgentEntry = {
		kind: 'agent';
		id: string;
		childID: string | null;
		description: string;
		agentType: string;
		status: 'pending' | 'running' | 'completed' | 'error';
		expanded: boolean;
		loaded: boolean;
		loading: boolean;
		entries: ChatEntry[];
	};

	type ChatEntry =
		| { kind: 'user'; text: string }
		| { kind: 'thinking'; text: string; done?: boolean; expanded?: boolean }
		| { kind: 'text'; text: string }
		| ToolEntry
		| AgentEntry
		| { kind: 'result'; cost: number | null; duration: number | null; files: TurnFile[] }
		| { kind: 'error'; detail: string };

	type Conversation = {
		id: string;
		title: string;
		repo: string | null;
		hasSession: boolean;
		createdAt: string;
		updatedAt: string;
	};

	let {
		sandbox,
		repos = [],
		selectedRepo = $bindable(null),
		starting = false,
		onstart,
		onturndone
	}: {
		sandbox: Sandbox;
		repos?: SandboxRepo[];
		selectedRepo?: string | null;
		starting?: boolean;
		onstart: () => void;
		onturndone?: () => void;
	} = $props();

	const credentialsQuery = createQuery(() => sandboxCredentialsQueryOptions());
	const missingClaude = $derived(credentialsQuery.data ? !credentialsQuery.data.claude : false);

	let entries = $state<ChatEntry[]>([]);
	let input = $state('');
	let streaming = $state(false);
	let atBottom = $state(true);
	let listEl = $state<HTMLDivElement | undefined>(undefined);
	let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
	let copiedIdx = $state<number | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	let sawTerminal = false;

	let conversations = $state<Conversation[]>([]);
	let convosSupported = $state(false);
	let activeId = $state<string | null>(null);
	let historyLoading = $state(false);
	let historyTruncated = $state(false);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	let deleteOpen = $state(false);
	let deleteTarget = $state<Conversation | null>(null);

	let ocMode = $state(false);
	const ocParts = new Map<string, ChatEntry>();
	const ocRoles = new Map<string, string>();
	const ocTurnCosts = new Map<string, number>();
	const ocAgents = new Map<string, AgentEntry>();
	let ocTurnSession: string | null = null;
	let turnStart = 0;

	let modelList = $state<OcModel[]>([]);
	let selProvider = $state(OC_MODEL.providerID);
	let selModelID = $state(OC_MODEL.modelID);
	let selVariant = $state<string | null>(null);
	let planMode = $state(false);
	let stopping = $state(false);
	let ctxTokens = $state<OcTokens | null>(null);
	const sessionPrefs = new Map<
		string,
		{ providerID: string; modelID: string; variant: string | null; plan: boolean }
	>();

	const selModel = $derived(
		modelList.find((m) => m.providerID === selProvider && m.modelID === selModelID) ?? null
	);
	const modelChipLabel = $derived(ocShortModelName(selModel?.name ?? selModelID));
	const variantOptions = $derived(selModel?.variants ?? []);
	const modelGroups = $derived.by(() => {
		const groups: { name: string; models: OcModel[] }[] = [];
		for (const model of modelList) {
			const group = groups.find((g) => g.name === model.providerName);
			if (group) group.models.push(model);
			else groups.push({ name: model.providerName, models: [model] });
		}
		return groups;
	});
	const ctxUsed = $derived(
		ctxTokens
			? (ctxTokens.total ??
				ctxTokens.input +
					ctxTokens.output +
					ctxTokens.reasoning +
					ctxTokens.cache.read +
					ctxTokens.cache.write)
			: 0
	);
	const ctxLimit = $derived(selModel?.context ?? null);
	const ctxPct = $derived(
		ctxLimit && ctxUsed > 0 ? Math.min(100, (ctxUsed / ctxLimit) * 100) : 0
	);
	const ctxTooltip = $derived(
		ctxTokens
			? [
					`input ${ocFmtTokens(ctxTokens.input)}`,
					`output ${ocFmtTokens(ctxTokens.output)}`,
					`reasoning ${ocFmtTokens(ctxTokens.reasoning)}`,
					`cache read ${ocFmtTokens(ctxTokens.cache.read)}`,
					`cache write ${ocFmtTokens(ctxTokens.cache.write)}`
				].join('\n')
			: ''
	);

	const canStart = $derived(sandbox.status === 'stopped' || sandbox.status === 'error');
	const activeConvo = $derived(conversations.find((c) => c.id === activeId) ?? null);
	const repoLocked = $derived(convosSupported && activeConvo?.hasSession === true);

	let convosInit = false;
	$effect(() => {
		if (sandbox.status === 'running' && !convosInit) {
			convosInit = true;
			init();
		}
	});

	async function init() {
		ocMode = await ocProbe(sandbox.id);
		if (ocMode) {
			ocModels(sandbox.id)
				.then((models) => (modelList = models))
				.catch(() => {});
			await loadSessions();
		} else {
			await loadConversations();
		}
	}

	function savePrefs() {
		if (!ocMode || !activeId) return;
		sessionPrefs.set(activeId, {
			providerID: selProvider,
			modelID: selModelID,
			variant: selVariant,
			plan: planMode
		});
	}

	function restorePrefs(id: string) {
		const prefs = sessionPrefs.get(id);
		if (!prefs) return false;
		selProvider = prefs.providerID;
		selModelID = prefs.modelID;
		selVariant = prefs.variant;
		planMode = prefs.plan;
		return true;
	}

	function pickModel(model: OcModel) {
		selProvider = model.providerID;
		selModelID = model.modelID;
		if (selVariant && !model.variants.includes(selVariant)) selVariant = null;
		savePrefs();
	}

	function pickVariant(variant: string | null) {
		selVariant = variant;
		savePrefs();
	}

	function setPlanMode(plan: boolean) {
		planMode = plan;
		savePrefs();
	}

	$effect(() => {
		if (!ocMode || sandbox.status !== 'running') return;
		const ctrl = new AbortController();
		ocEventLoop(ctrl.signal);
		return () => ctrl.abort();
	});

	function sessionToConvo(session: OcSession): Conversation {
		return {
			id: session.id,
			title: session.title,
			repo: ocRepo(session.directory),
			hasSession: true,
			createdAt: new Date(session.time.created).toISOString(),
			updatedAt: new Date(session.time.updated).toISOString()
		};
	}

	async function loadSessions() {
		try {
			const res = await apiFetch(`${ocBase(sandbox.id)}/session?roots=true&limit=20`);
			if (!res.ok) return;
			const sessions = (await res.json()) as OcSession[];
			conversations = sessions
				.filter((s) => !s.parentID && !s.time.archived)
				.map(sessionToConvo);
			convosSupported = true;
			if (conversations.length === 0) {
				await createConversation();
			} else {
				activeId = conversations[0].id;
				if (conversations[0].repo) selectedRepo = conversations[0].repo;
				await loadHistory(conversations[0].id);
			}
		} catch {
			return;
		}
	}

	async function loadConversations() {
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/conversations`);
			if (!res.ok) return;
			const data = await res.json();
			conversations = data.conversations ?? [];
			convosSupported = true;
			if (conversations.length === 0) {
				await createConversation();
			} else {
				activeId = conversations[0].id;
				if (conversations[0].repo) selectedRepo = conversations[0].repo;
				await loadHistory(conversations[0].id);
			}
		} catch {
			return;
		}
	}

	async function refreshConversations() {
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/conversations`);
			if (!res.ok) return;
			const data = await res.json();
			if (Array.isArray(data.conversations)) conversations = data.conversations;
		} catch {
			return;
		}
	}

	async function createConversation() {
		if (ocMode) {
			try {
				savePrefs();
				const dir = ocDirectory(selectedRepo);
				const query = dir ? `?directory=${encodeURIComponent(dir)}` : '';
				const res = await apiFetch(`${ocBase(sandbox.id)}/session${query}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({})
				});
				if (!res.ok) return;
				const session = (await res.json()) as OcSession;
				if (!conversations.some((c) => c.id === session.id)) {
					conversations.unshift(sessionToConvo(session));
				}
				activeId = session.id;
				entries = [];
				ocParts.clear();
				ocAgents.clear();
				ctxTokens = null;
				historyTruncated = false;
			} catch {
				return;
			}
			return;
		}
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/conversations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(selectedRepo ? { repo: selectedRepo } : {})
			});
			if (!res.ok) return;
			const convo = (await res.json()) as Conversation;
			conversations.push(convo);
			activeId = convo.id;
			entries = [];
			historyTruncated = false;
		} catch {
			return;
		}
	}

	async function switchConversation(id: string) {
		if (id === activeId || streaming) return;
		savePrefs();
		activeId = id;
		const convo = conversations.find((c) => c.id === id);
		if (convo?.repo) selectedRepo = convo.repo;
		await loadHistory(id);
	}

	async function loadHistory(id: string) {
		entries = [];
		ocParts.clear();
		ocAgents.clear();
		ctxTokens = null;
		historyTruncated = false;
		if (sandbox.status !== 'running') return;
		historyLoading = true;
		try {
			if (ocMode) {
				const res = await apiFetch(`${ocBase(sandbox.id)}/session/${id}/message?limit=100`);
				if (!res.ok) return;
				hydrateOc((await res.json()) as OcMessage[]);
				return;
			}
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/conversations/${id}/history`);
			if (!res.ok) return;
			const data = await res.json();
			for (const event of data.events ?? []) {
				handleEvent(event as Record<string, unknown>);
			}
			historyTruncated = data.truncated === true;
		} catch {
			return;
		} finally {
			historyLoading = false;
		}
	}

	function startRename(convo: Conversation) {
		renamingId = convo.id;
		renameText = convo.title;
	}

	async function commitRename() {
		const id = renamingId;
		const title = renameText.trim();
		renamingId = null;
		if (!id || !title) return;
		const convo = conversations.find((c) => c.id === id);
		if (!convo || convo.title === title) return;
		convo.title = title;
		try {
			const path = ocMode
				? `${ocBase(sandbox.id)}/session/${id}`
				: `/apiv1/sandboxes/${sandbox.id}/conversations/${id}`;
			await apiFetch(path, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title })
			});
		} catch {
			return;
		}
	}

	async function deleteConversation() {
		const target = deleteTarget;
		deleteTarget = null;
		if (!target) return;
		try {
			const path = ocMode
				? `${ocBase(sandbox.id)}/session/${target.id}`
				: `/apiv1/sandboxes/${sandbox.id}/conversations/${target.id}`;
			const res = await apiFetch(path, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed to delete conversation');
			conversations = conversations.filter((c) => c.id !== target.id);
			if (activeId === target.id) {
				if (conversations.length > 0) {
					activeId = conversations[0].id;
					await loadHistory(conversations[0].id);
				} else {
					await createConversation();
				}
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete conversation',
				color: 'error'
			});
		}
	}

	$effect(() => {
		const tail = entries.at(-1);
		if (!tail) return;
		void ('text' in tail ? tail.text : 'detail' in tail ? tail.detail : tail.kind);
		void streaming;
		if (atBottom) listEl?.scrollTo({ top: listEl.scrollHeight });
	});

	function onScroll() {
		if (!listEl) return;
		atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48;
	}

	function jumpToLatest() {
		atBottom = true;
		listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
	}

	function renderMd(text: string): string {
		const trimmed = text.trim();
		return trimmed ? (marked.parse(trimmed, { async: false }) as string) : '';
	}

	function appendText(text: string) {
		const tail = entries.at(-1);
		if (tail && tail.kind === 'text') tail.text += text;
		else entries.push({ kind: 'text', text });
	}

	function appendThinking(text: string) {
		const tail = entries.at(-1);
		if (tail && tail.kind === 'thinking') tail.text += text;
		else entries.push({ kind: 'thinking', text });
	}

	const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);
	const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

	function toolGlyph(name: string): string {
		if (name === 'Bash') return '$';
		if (EDIT_TOOLS.has(name)) return '±';
		if (name === 'Read') return '≡';
		if (name === 'Grep' || name === 'Glob' || name.includes('Search')) return '⌕';
		return '⏺';
	}

	function truncate(text: string, max = 80): string {
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length > max ? `${flat.slice(0, max)}…` : flat;
	}

	function midTruncate(text: string, max = 72): string {
		const flat = text.replace(/\s+/g, ' ').trim();
		if (flat.length <= max) return flat;
		const head = Math.ceil((max - 1) * 0.6);
		return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
	}

	function countLines(text: string): number {
		return text.length === 0 ? 0 : text.split('\n').length;
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
			id,
			name,
			input: toolInput,
			summary,
			title,
			diff,
			failed: false,
			expanded: false
		};
	}

	function markToolResults(blocks: unknown[]) {
		for (const block of blocks) {
			const b = block as Record<string, unknown>;
			if (b.type !== 'tool_result' || b.is_error !== true) continue;
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const entry = entries[i];
				if (entry.kind === 'tool' && entry.id === b.tool_use_id) {
					entry.failed = true;
					break;
				}
			}
		}
	}

	function turnFiles(): TurnFile[] {
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

	function handleEvent(event: Record<string, unknown>) {
		if (event.type === 'assistant') {
			const message = event.message as { content?: unknown[] } | undefined;
			for (const block of message?.content ?? []) {
				const b = block as Record<string, unknown>;
				if (b.type === 'text' && typeof b.text === 'string') appendText(b.text);
				else if (b.type === 'thinking' && typeof b.thinking === 'string')
					appendThinking(b.thinking);
				else if (b.type === 'tool_use') {
					entries.push(
						makeToolEntry(
							typeof b.id === 'string' ? b.id : null,
							typeof b.name === 'string' ? b.name : 'tool',
							b.input
						)
					);
				}
			}
		} else if (event.type === 'user') {
			const message = event.message as { content?: unknown } | undefined;
			if (typeof message?.content === 'string' && message.content.trim()) {
				entries.push({ kind: 'user', text: message.content });
			} else if (Array.isArray(message?.content)) {
				for (const block of message.content) {
					const b = block as Record<string, unknown>;
					if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
						entries.push({ kind: 'user', text: b.text });
					}
				}
				markToolResults(message.content);
			}
		} else if (event.type === 'result') {
			sawTerminal = true;
			entries.push({
				kind: 'result',
				cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
				duration: typeof event.duration_ms === 'number' ? event.duration_ms : null,
				files: turnFiles()
			});
		} else if (event.type === 'error') {
			sawTerminal = true;
			entries.push({
				kind: 'error',
				detail: typeof event.detail === 'string' ? event.detail : 'The agent hit an error'
			});
		} else if (event.type === 'raw' && typeof event.text === 'string') {
			appendText(event.text);
		}
	}

	function framePayload(frame: string): string {
		return frame
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim())
			.join('');
	}

	function handleFrame(frame: string) {
		const payload = framePayload(frame);
		if (!payload) return;
		try {
			handleEvent(JSON.parse(payload) as Record<string, unknown>);
		} catch {
			appendText(payload);
		}
	}

	const OC_SKIP_PARTS = new Set([
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

	function ocToolEntry(part: OcPart): ToolEntry {
		const norm = ocNormalizeTool(part.tool ?? 'tool', part.state?.input);
		const entry = makeToolEntry(part.id, norm.name, norm.input);
		if (!entry.summary && typeof part.state?.title === 'string') {
			entry.summary = midTruncate(part.state.title);
		}
		if (part.state?.status === 'error') entry.failed = true;
		return entry;
	}

	function ocAgentFields(part: OcPart) {
		const meta = part.state?.metadata ?? {};
		const input = part.state?.input ?? {};
		const childID =
			typeof meta.sessionId === 'string'
				? meta.sessionId
				: typeof meta.sessionID === 'string'
					? meta.sessionID
					: null;
		const description =
			typeof input.description === 'string'
				? input.description
				: (part.state?.title ?? 'Sub-agent');
		const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
		return { childID, description, agentType, status: part.state?.status ?? 'pending' };
	}

	function appendOcPart(part: OcPart, target: ChatEntry[] = entries) {
		if (OC_SKIP_PARTS.has(part.type)) return;
		const existing = ocParts.get(part.id);
		if (part.type === 'text' || part.type === 'reasoning') {
			if (existing) {
				if (existing.kind === 'text' || existing.kind === 'thinking') {
					existing.text = part.text ?? '';
				}
				if (existing.kind === 'thinking' && part.time?.end) existing.done = true;
				return;
			}
			const entry: ChatEntry =
				part.type === 'text'
					? { kind: 'text', text: part.text ?? '' }
					: { kind: 'thinking', text: part.text ?? '', done: Boolean(part.time?.end) };
			target.push(entry);
			ocParts.set(part.id, target[target.length - 1]);
			return;
		}
		if (part.type === 'tool' && part.tool === 'task') {
			const fields = ocAgentFields(part);
			if (existing && existing.kind === 'agent') {
				Object.assign(existing, fields);
				if (existing.loaded && fields.childID) ocAgents.set(fields.childID, existing);
				return;
			}
			target.push({
				kind: 'agent',
				id: part.id,
				...fields,
				expanded: false,
				loaded: false,
				loading: false,
				entries: []
			});
			ocParts.set(part.id, target[target.length - 1]);
			return;
		}
		const entry = part.type === 'tool' ? ocToolEntry(part) : makeToolEntry(part.id, part.type, part);
		if (existing && existing.kind === 'tool') {
			Object.assign(existing, { ...entry, expanded: existing.expanded });
			return;
		}
		target.push(entry);
		ocParts.set(part.id, target[target.length - 1]);
	}

	async function toggleAgent(agent: AgentEntry) {
		agent.expanded = !agent.expanded;
		if (!agent.expanded || agent.loaded || agent.loading || !agent.childID) return;
		agent.loading = true;
		try {
			const res = await apiFetch(
				`${ocBase(sandbox.id)}/session/${agent.childID}/message?limit=100`
			);
			if (!res.ok) return;
			const messages = (await res.json()) as OcMessage[];
			agent.entries.length = 0;
			for (const { info, parts } of messages) {
				if (info.role === 'user') {
					for (const part of parts) {
						if (part.type === 'text' && part.text?.trim() && !part.synthetic && !part.ignored) {
							agent.entries.push({ kind: 'user', text: part.text });
						}
					}
					continue;
				}
				for (const part of parts) appendOcPart(part, agent.entries);
			}
			agent.loaded = true;
			ocAgents.set(agent.childID, agent);
		} catch {
			return;
		} finally {
			agent.loading = false;
		}
	}

	function hydrateOc(messages: OcMessage[]) {
		let runStart: number | null = null;
		let runCost = 0;
		let lastAssistant: OcMessageInfo | null = null;
		for (let i = 0; i < messages.length; i += 1) {
			const { info, parts } = messages[i];
			if (info.role === 'user') {
				for (const part of parts) {
					if (part.type === 'text' && part.text?.trim() && !part.synthetic && !part.ignored) {
						entries.push({ kind: 'user', text: part.text });
					}
				}
				runStart = null;
				runCost = 0;
				continue;
			}
			lastAssistant = info;
			if (runStart === null) runStart = info.time.created;
			runCost += info.cost ?? 0;
			for (const part of parts) appendOcPart(part);
			const next = messages[i + 1];
			if (info.time.completed && (!next || next.info.role === 'user')) {
				entries.push({
					kind: 'result',
					cost: runCost > 0 ? runCost : null,
					duration: info.time.completed - runStart,
					files: turnFiles()
				});
			}
		}
		if (!lastAssistant) {
			restorePrefs(activeId ?? '');
			return;
		}
		ctxTokens = lastAssistant.tokens ?? null;
		if (activeId && restorePrefs(activeId)) return;
		if (lastAssistant.providerID && lastAssistant.modelID) {
			selProvider = lastAssistant.providerID;
			selModelID = lastAssistant.modelID;
		}
		selVariant = typeof lastAssistant.variant === 'string' ? lastAssistant.variant : null;
		planMode = lastAssistant.agent === 'plan';
	}

	function finishOcTurn() {
		for (const entry of entries) {
			if (entry.kind === 'thinking') entry.done = true;
		}
		const total = [...ocTurnCosts.values()].reduce((sum, cost) => sum + cost, 0);
		if (ocTurnSession === activeId) {
			entries.push({
				kind: 'result',
				cost: total > 0 ? total : null,
				duration: turnStart > 0 ? Date.now() - turnStart : null,
				files: turnFiles()
			});
		}
		streaming = false;
		ocTurnSession = null;
		ocTurnCosts.clear();
		turnStart = 0;
		onturndone?.();
	}

	function handleOcEvent(event: OcEvent) {
		const props = event.properties ?? {};
		const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null;
		if (event.type === 'session.updated' || event.type === 'session.created') {
			const info = props.info as OcSession | undefined;
			if (!info || info.parentID || info.time.archived) return;
			const convo = conversations.find((c) => c.id === info.id);
			if (convo) {
				convo.title = info.title;
				convo.updatedAt = new Date(info.time.updated).toISOString();
			} else if (event.type === 'session.created') {
				conversations.unshift(sessionToConvo(info));
			}
		} else if (event.type === 'session.deleted') {
			if (!sessionID || !conversations.some((c) => c.id === sessionID)) return;
			conversations = conversations.filter((c) => c.id !== sessionID);
			if (activeId === sessionID) {
				activeId = conversations[0]?.id ?? null;
				if (activeId) loadHistory(activeId);
				else createConversation();
			}
		} else if (event.type === 'message.updated') {
			const info = props.info as OcMessageInfo | undefined;
			if (!info) return;
			ocRoles.set(info.id, info.role);
			if (info.role !== 'assistant') return;
			if (info.sessionID === ocTurnSession && typeof info.cost === 'number') {
				ocTurnCosts.set(info.id, info.cost);
			}
			if (info.sessionID === activeId && info.tokens && (info.tokens.total ?? 0) > 0) {
				ctxTokens = info.tokens;
			}
		} else if (event.type === 'message.part.updated') {
			const part = props.part as OcPart | undefined;
			if (!part) return;
			if (ocRoles.get(part.messageID) === 'user') return;
			if (part.sessionID === activeId) {
				appendOcPart(part);
				return;
			}
			const agent = ocAgents.get(part.sessionID);
			if (agent) appendOcPart(part, agent.entries);
		} else if (event.type === 'message.part.delta') {
			if (props.field !== 'text') return;
			const entry = ocParts.get(String(props.partID));
			if (entry && (entry.kind === 'text' || entry.kind === 'thinking')) {
				entry.text += String(props.delta ?? '');
			}
		} else if (event.type === 'session.idle') {
			if (streaming && sessionID === ocTurnSession) finishOcTurn();
		} else if (event.type === 'session.error') {
			const aborted =
				props.error &&
				typeof props.error === 'object' &&
				(props.error as { name?: string }).name === 'MessageAbortedError';
			if (aborted) {
				if (streaming && (!sessionID || sessionID === ocTurnSession)) finishOcTurn();
				return;
			}
			if (sessionID === activeId || !sessionID) {
				entries.push({ kind: 'error', detail: ocErrorMessage(props.error) });
			}
			if (streaming && (!sessionID || sessionID === ocTurnSession)) {
				streaming = false;
				ocTurnSession = null;
				ocTurnCosts.clear();
				turnStart = 0;
				onturndone?.();
			}
		}
	}

	function handleOcFrame(frame: string) {
		const payload = framePayload(frame);
		if (!payload) return;
		try {
			handleOcEvent(JSON.parse(payload) as OcEvent);
		} catch {
			return;
		}
	}

	async function ocSyncAfterConnect() {
		if (!streaming || !ocTurnSession) return;
		try {
			const res = await apiFetch(`${ocBase(sandbox.id)}/session/status`);
			if (!res.ok) return;
			const status = (await res.json()) as Record<string, { type?: string }>;
			const current = status[ocTurnSession]?.type;
			if (current === 'busy' || current === 'retry') return;
			streaming = false;
			ocTurnSession = null;
			ocTurnCosts.clear();
			turnStart = 0;
			if (activeId) await loadHistory(activeId);
			onturndone?.();
		} catch {
			return;
		}
	}

	async function ocEventLoop(signal: AbortSignal) {
		for (;;) {
			try {
				const res = await apiFetch(`${ocBase(sandbox.id)}/event`, { signal });
				if (!res.ok || !res.body) throw new Error('event stream unavailable');
				await ocSyncAfterConnect();
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let boundary = buffer.indexOf('\n\n');
					while (boundary !== -1) {
						handleOcFrame(buffer.slice(0, boundary));
						buffer = buffer.slice(boundary + 2);
						boundary = buffer.indexOf('\n\n');
					}
				}
			} catch {
				if (signal.aborted) return;
			}
			if (signal.aborted) return;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}

	async function submitOc(message: string) {
		turnStart = Date.now();
		ocTurnCosts.clear();
		try {
			if (!activeId) await createConversation();
			if (!activeId) throw new Error('No session available');
			ocTurnSession = activeId;
			const res = await apiFetch(`${ocBase(sandbox.id)}/session/${activeId}/prompt_async`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: { providerID: selProvider, modelID: selModelID },
					...(selVariant ? { variant: selVariant } : {}),
					agent: planMode ? 'plan' : 'build',
					parts: [{ type: 'text', text: message }]
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Chat request failed');
			}
		} catch (err) {
			entries.push({
				kind: 'error',
				detail: err instanceof Error ? err.message : 'Chat request failed'
			});
			streaming = false;
			ocTurnSession = null;
			turnStart = 0;
			onturndone?.();
		}
	}

	async function submitMessage() {
		const message = input.trim();
		if (!message || streaming) return;
		input = '';
		if (inputEl) inputEl.style.height = 'auto';
		entries.push({ kind: 'user', text: message });
		atBottom = true;
		streaming = true;
		sawTerminal = false;
		if (ocMode) {
			await submitOc(message);
			return;
		}
		try {
			const body: Record<string, string> = { message };
			if (activeId) body.conversationId = activeId;
			if (selectedRepo) body.repo = selectedRepo;
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok || !res.body) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Chat request failed');
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					handleFrame(buffer.slice(0, boundary));
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf('\n\n');
				}
				if (sawTerminal) {
					await reader.cancel().catch(() => {});
					break;
				}
			}
			if (buffer.trim()) handleFrame(buffer);
			if (activeConvo && !activeConvo.hasSession) {
				activeConvo.hasSession = true;
				activeConvo.repo = selectedRepo;
			}
		} catch (err) {
			entries.push({
				kind: 'error',
				detail: err instanceof Error ? err.message : 'Chat request failed'
			});
		} finally {
			streaming = false;
			if (convosSupported && !ocMode) refreshConversations();
			onturndone?.();
		}
	}

	async function stopOc() {
		if (!ocTurnSession || stopping) return;
		stopping = true;
		try {
			await apiFetch(`${ocBase(sandbox.id)}/session/${ocTurnSession}/abort`, { method: 'POST' });
		} catch {
			return;
		} finally {
			stopping = false;
		}
	}

	function onComposerKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitMessage();
		}
	}

	function autosize() {
		if (!inputEl) return;
		inputEl.style.height = 'auto';
		inputEl.style.height = `${Math.min(inputEl.scrollHeight, 150)}px`;
	}

	function pretty(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	function firstLine(text: string): string {
		const line = text.split('\n').find((l) => l.trim()) ?? '';
		return truncate(line, 90);
	}

	function fmtCost(cost: number): string {
		return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
	}

	function fmtDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		if (s < 60) return `${s.toFixed(1)}s`;
		return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
	}

	function transcriptText(): string {
		const lines: string[] = [];
		for (const entry of entries) {
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

	function turnText(idx: number): string {
		const chunks: string[] = [];
		for (let i = idx - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.kind === 'user' || entry.kind === 'result') break;
			if (entry.kind === 'text') chunks.unshift(entry.text);
		}
		return chunks.join('\n\n');
	}

	async function copyTurn(idx: number) {
		await navigator.clipboard.writeText(turnText(idx));
		copiedIdx = idx;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copiedIdx = null), 1500);
	}

	let copiedAll = $state(false);
	let copyAllTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyTranscript() {
		await navigator.clipboard.writeText(transcriptText());
		copiedAll = true;
		if (copyAllTimer) clearTimeout(copyAllTimer);
		copyAllTimer = setTimeout(() => (copiedAll = false), 1500);
	}
</script>

<div class="chat-root">
	{#if sandbox.status !== 'running'}
		<div class="chat-gate">
			<p class="chat-gate-text">Start the sandbox to chat.</p>
			{#if canStart}
				<Button variant="primary" loading={starting} onclick={onstart}>
					<Play class="h-4 w-4" /> Start sandbox
				</Button>
			{:else}
				<p class="chat-gate-sub">Waiting for the sandbox to be ready.</p>
			{/if}
		</div>
	{:else}
		{#if convosSupported}
			<div class="conv-bar">
				<div class="conv-tabs" role="tablist" aria-label="Conversations">
					{#each conversations as convo (convo.id)}
						<div
							class="conv-tab"
							class:conv-tab--active={convo.id === activeId}
							role="tab"
							aria-selected={convo.id === activeId}
						>
							{#if renamingId === convo.id}
								<input
									class="conv-rename"
									bind:value={renameText}
									aria-label="Conversation title"
									onkeydown={(e) => {
										if (e.key === 'Enter') commitRename();
										else if (e.key === 'Escape') renamingId = null;
									}}
									onblur={commitRename}
									{@attach (el) => (el as HTMLInputElement).focus()}
								/>
							{:else}
								<button
									type="button"
									class="conv-tab-btn"
									title={convo.title}
									onclick={() => switchConversation(convo.id)}
									ondblclick={() => startRename(convo)}
								>
									{truncate(convo.title, 24) || 'Untitled'}
								</button>
								<button
									type="button"
									class="conv-close"
									aria-label={`Delete ${convo.title}`}
									disabled={ocMode && streaming}
									onclick={() => {
										deleteTarget = convo;
										deleteOpen = true;
									}}
								>
									<X class="h-3 w-3" />
								</button>
							{/if}
						</div>
					{/each}
				</div>
				<button
					type="button"
					class="conv-add"
					aria-label="New conversation"
					disabled={ocMode && streaming}
					onclick={createConversation}
				>
					<Plus class="h-3.5 w-3.5" />
				</button>
				<div class="conv-right">
					{#if ocMode && ctxUsed > 0}
						<span class="conv-ctx" title={ctxTooltip}>
							{#if ctxLimit}
								<span class="conv-ctx-bar" aria-hidden="true">
									<span class="conv-ctx-fill" style:width="{ctxPct}%"></span>
								</span>
							{/if}
							<span class="conv-ctx-text">
								{ocFmtTokens(ctxUsed)}{ctxLimit ? ` / ${ocFmtTokens(ctxLimit)}` : ''}
							</span>
						</span>
					{/if}
					{#if entries.length > 0}
						<button
							type="button"
							class="conv-copy"
							aria-label="Copy transcript"
							title="Copy transcript"
							onclick={copyTranscript}
						>
							{#if copiedAll}<Check class="h-3 w-3" />{:else}<Copy class="h-3 w-3" />{/if}
						</button>
					{/if}
					{#if ocMode}
						<span class="conv-engine">opencode</span>
					{/if}
				</div>
			</div>
		{/if}
		{#if missingClaude}
			<div class="chat-cred">
				<span>No Claude credentials on your account.</span>
				<a href="/user/settings?tab=sandbox">Open user settings</a>
			</div>
		{/if}
		<div class="chat-scroll-wrap">
			<div class="chat-log" bind:this={listEl} onscroll={onScroll}>
				{#if entries.length === 0 && !historyLoading}
					<div class="chat-col">
						<p class="chat-empty-title">Ask the agent to build something.</p>
						<p class="chat-empty-sub">
							The agent works directly in the sandbox filesystem; sessions persist on its disk.
						</p>
					</div>
				{/if}
				<div class="chat-col chat-col--feed">
					{#if historyLoading}
						<div class="tr-working">
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading history
						</div>
					{/if}
					{#if historyTruncated}
						<p class="chat-truncated">Older messages were truncated.</p>
					{/if}
					{#each entries as entry, i (i)}
						{@render row(entry, i, 0)}
					{/each}
					{#if streaming}
						<div class="tr-working">
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Working
						</div>
					{/if}
				</div>
			</div>
			{#if !atBottom}
				<button type="button" class="tr-jump" transition:fade onclick={jumpToLatest}>
					<ArrowDown class="h-3 w-3" /> Jump to latest
				</button>
			{/if}
		</div>
		<form
			class="chat-composer"
			class:chat-composer--plan={ocMode && planMode}
			onsubmit={(e) => {
				e.preventDefault();
				submitMessage();
			}}
		>
			<div class="chat-composer-col">
				<textarea
					bind:this={inputEl}
					bind:value={input}
					class="chat-composer-input"
					rows="1"
					placeholder="Ask the agent to build something"
					aria-label="Message the agent"
					oninput={autosize}
					onkeydown={onComposerKey}
				></textarea>
				<div class="chat-composer-foot">
					{#if ocMode}
						<div class="chat-chips">
							<Menu placement="top-start">
								{#snippet trigger(props, open)}
									<button
										type="button"
										class="chat-chip"
										class:chat-chip--open={open}
										aria-label="Model"
										{...props}
									>
										{modelChipLabel}
										<ChevronDown class="h-3 w-3" />
									</button>
								{/snippet}
								<div class="chat-menu-scroll">
									{#each modelGroups as group (group.name)}
										<div class="chat-menu-group">{group.name}</div>
										{#each group.models as m (m.providerID + m.modelID)}
											<MenuItem onclick={() => pickModel(m)}>
												<span class="chat-menu-label">{ocShortModelName(m.name)}</span>
												{#if m.providerID === selProvider && m.modelID === selModelID}
													<Check class="h-3 w-3" />
												{/if}
											</MenuItem>
										{/each}
									{/each}
								</div>
							</Menu>
							{#if variantOptions.length > 0}
								<Menu placement="top-start">
									{#snippet trigger(props, open)}
										<button
											type="button"
											class="chat-chip"
											class:chat-chip--open={open}
											aria-label="Reasoning effort"
											{...props}
										>
											{selVariant ?? 'effort'}
											<ChevronDown class="h-3 w-3" />
										</button>
									{/snippet}
									<MenuItem onclick={() => pickVariant(null)}>
										<span class="chat-menu-label">default</span>
										{#if !selVariant}<Check class="h-3 w-3" />{/if}
									</MenuItem>
									{#each variantOptions as v (v)}
										<MenuItem onclick={() => pickVariant(v)}>
											<span class="chat-menu-label">{v}</span>
											{#if selVariant === v}<Check class="h-3 w-3" />{/if}
										</MenuItem>
									{/each}
								</Menu>
							{/if}
							<div class="chat-mode" role="radiogroup" aria-label="Agent mode">
								<button
									type="button"
									role="radio"
									aria-checked={!planMode}
									class="chat-mode-btn"
									class:chat-mode-btn--active={!planMode}
									onclick={() => setPlanMode(false)}
								>
									Build
								</button>
								<button
									type="button"
									role="radio"
									aria-checked={planMode}
									class="chat-mode-btn chat-mode-btn--plan"
									class:chat-mode-btn--active={planMode}
									onclick={() => setPlanMode(true)}
								>
									Plan
								</button>
							</div>
							{#if planMode}
								<span class="chat-plan-badge">read only</span>
							{/if}
						</div>
					{:else if streaming}
						<span class="chat-composer-working">
							<Loader2 class="h-3 w-3 animate-spin" /> Working
						</span>
					{:else}
						<span class="chat-composer-hint">Enter sends · Shift+Enter for a newline</span>
					{/if}
					<div class="chat-composer-tools">
						{#if repoLocked}
							<span class="chat-repo-select chat-repo-select--static">
								{activeConvo?.repo ?? 'home'}
							</span>
						{:else if repos.length > 0}
							<select
								class="chat-repo-select"
								bind:value={selectedRepo}
								aria-label="Working repository"
							>
								{#each repos as repo (repo.name)}
									<option value={repo.name}>{repo.name}</option>
								{/each}
							</select>
						{:else}
							<span class="chat-repo-select chat-repo-select--static">home</span>
						{/if}
						{#if ocMode && streaming}
							<button
								type="button"
								class="chat-send chat-send--stop"
								disabled={stopping}
								aria-label="Stop the agent"
								onclick={stopOc}
							>
								<Square class="h-3 w-3" fill="currentColor" />
							</button>
						{:else}
							<button
								type="submit"
								class="chat-send"
								disabled={streaming || !input.trim()}
								aria-label="Send message"
							>
								<Send class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</div>
			</div>
		</form>
	{/if}
</div>

{#snippet row(entry: ChatEntry, i: number, depth: number)}
	{#if entry.kind === 'user'}
		{#if depth === 0}
			<div class="tr-user">
				<span class="tr-user-dot" aria-hidden="true"></span>
				<div class="tr-user-text">{entry.text}</div>
			</div>
		{:else}
			<div class="tr-sub-prompt">{entry.text}</div>
		{/if}
	{:else if entry.kind === 'thinking'}
		{@const live = depth === 0 && streaming && entry === entries[entries.length - 1] && !entry.done}
		{#if live || entry.expanded}
			<div class="tr-think" class:tr-think--live={live}>
				<button
					type="button"
					class="tr-row tr-row-btn"
					aria-expanded="true"
					onclick={() => (entry.expanded = false)}
				>
					<span class="tr-row-icon"><Brain class="h-3 w-3" /></span>
					<span class="tr-row-label">Thinking</span>
				</button>
				<pre
					class="tr-think-body"
					{@attach (el) => {
						void entry.text;
						if (live) el.scrollTop = el.scrollHeight;
					}}>{entry.text}</pre>
			</div>
		{:else}
			{@const thought = firstLine(entry.text)}
			<button
				type="button"
				class="tr-row tr-row-btn"
				title={entry.text}
				aria-expanded="false"
				onclick={() => (entry.expanded = true)}
			>
				<span class="tr-row-icon"><Brain class="h-3 w-3" /></span>
				<span class="tr-row-label">Thinking</span>
				{#if thought}<span class="tr-chip">{thought}</span>{/if}
			</button>
		{/if}
	{:else if entry.kind === 'text'}
		<div class="tr-md">{@html renderMd(entry.text)}</div>
	{:else if entry.kind === 'tool'}
		<div class="tr-tool" class:tr-tool--failed={entry.failed}>
			<button
				type="button"
				class="tr-row tr-row-btn"
				aria-expanded={entry.expanded}
				onclick={() => (entry.expanded = !entry.expanded)}
			>
				<span class="tr-row-icon tr-row-glyph" aria-hidden="true">
					{toolGlyph(entry.name)}
				</span>
				<span class="tr-row-label">{entry.name}</span>
				{#if entry.summary}
					<span class="tr-chip" title={entry.title ?? undefined}>{entry.summary}</span>
				{/if}
				{#if entry.diff}
					<span class="tr-diffstat">
						{#if entry.diff.add > 0}<span class="tr-diff-add">+{entry.diff.add}</span>{/if}
						{#if entry.diff.del > 0}<span class="tr-diff-del">-{entry.diff.del}</span>{/if}
					</span>
				{/if}
				{#if entry.failed}<span class="tr-tool-failed">failed</span>{/if}
			</button>
			{#if entry.expanded}
				<pre class="tr-tool-detail" transition:slide>{pretty(entry.input)}</pre>
			{/if}
		</div>
	{:else if entry.kind === 'agent'}
		{#if depth === 0}
			<div class="tr-agent">
				<button
					type="button"
					class="tr-row tr-row-btn"
					aria-expanded={entry.expanded}
					onclick={() => toggleAgent(entry)}
				>
					<span class="tr-row-icon"><Bot class="h-3 w-3" /></span>
					<span class="tr-row-label">{entry.agentType}</span>
					<span class="tr-chip">{entry.description}</span>
					{#if entry.status === 'running' || entry.status === 'pending'}
						<span class="tr-agent-state">
							<Loader2 class="h-3 w-3 animate-spin" data-motion="progress" /> running
						</span>
					{:else if entry.status === 'error'}
						<span class="tr-tool-failed">failed</span>
					{:else}
						<span class="tr-agent-state">done</span>
					{/if}
				</button>
				{#if entry.expanded}
					<div class="tr-agent-body" transition:slide>
						{#if entry.loading}
							<div class="tr-working">
								<Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading sub-agent
							</div>
						{:else if !entry.childID}
							<p class="tr-agent-empty">No transcript yet.</p>
						{:else if entry.entries.length === 0}
							<p class="tr-agent-empty">The sub-agent has not produced output yet.</p>
						{:else}
							{#each entry.entries as child, ci (ci)}
								{@render row(child, ci, 1)}
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<div class="tr-row">
				<span class="tr-row-icon"><Bot class="h-3 w-3" /></span>
				<span class="tr-row-label">{entry.agentType}</span>
				<span class="tr-chip">{entry.description}</span>
			</div>
		{/if}
	{:else if entry.kind === 'result'}
		<div class="tr-turn">
			{#if entry.duration !== null}
				<span class="tr-turn-meta">{fmtDuration(entry.duration)}</span>
			{/if}
			<button
				type="button"
				class="tr-turn-copy"
				aria-label="Copy this reply"
				title="Copy this reply"
				onclick={() => copyTurn(i)}
			>
				{#if copiedIdx === i}<Check class="h-3 w-3" />{:else}<Copy class="h-3 w-3" />{/if}
			</button>
			<div class="tr-turn-files">
				{#each entry.files as file (file.path)}
					<span class="tr-file-chip" title={file.path}>
						{file.name}
						{#if file.add > 0}<span class="tr-diff-add">+{file.add}</span>{/if}
						{#if file.del > 0}<span class="tr-diff-del">-{file.del}</span>{/if}
					</span>
				{/each}
			</div>
			{#if entry.cost !== null}
				<span class="tr-turn-cost">{fmtCost(entry.cost)}</span>
			{/if}
		</div>
	{:else}
		<div class="tr-error">{entry.detail}</div>
	{/if}
{/snippet}

<ConfirmModal
	bind:open={deleteOpen}
	title="Delete conversation?"
	description={`This deletes ${deleteTarget?.title ?? 'this conversation'} and its transcript from the sandbox.`}
	confirmLabel="Delete"
	onconfirm={deleteConversation}
	oncancel={() => (deleteTarget = null)}
/>

<style>
	.chat-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.chat-gate {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2.5rem 1rem;
	}

	.chat-gate-text {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}

	.chat-gate-sub {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.conv-bar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
		padding: 0 0.5rem;
		border-bottom: 1px solid var(--border-default);
	}

	.conv-tabs {
		display: flex;
		align-items: stretch;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.conv-tabs::-webkit-scrollbar {
		display: none;
	}

	.conv-tab {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		padding-right: 0.25rem;
	}

	.conv-tab--active {
		border-bottom-color: var(--accent);
	}

	.conv-tab-btn {
		border: none;
		background: none;
		padding: 0.4375rem 0.125rem 0.4375rem 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		transition: color var(--dur-fast);
	}

	.conv-tab--active .conv-tab-btn {
		color: var(--text-default);
	}

	.conv-tab-btn:hover {
		color: var(--text-default);
	}

	.conv-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.conv-tab:hover .conv-close,
	.conv-close:focus-visible {
		opacity: 1;
	}

	.conv-close:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.conv-rename {
		width: 9rem;
		margin: 0.25rem 0;
		padding: 0.125rem 0.375rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-xs);
		background: var(--bg-sunken);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
	}

	.conv-rename:focus-visible {
		outline: none;
	}

	.conv-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.conv-add:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.conv-add:disabled,
	.conv-close:disabled {
		color: var(--text-faint);
		cursor: default;
		background: none;
	}

	.conv-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		margin-left: auto;
		padding-right: 0.25rem;
	}

	.conv-engine {
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.conv-ctx {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	.conv-ctx-bar {
		width: 3.5rem;
		height: 0.25rem;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
		overflow: hidden;
	}

	.conv-ctx-fill {
		display: block;
		height: 100%;
		border-radius: var(--radius-pill);
		background: var(--accent);
		transition: width var(--dur-fast);
	}

	.conv-ctx-text {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
	}

	.conv-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.conv-copy:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.chat-cred {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		padding: 0.375rem 1rem;
		border-bottom: 1px solid var(--border-default);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.chat-cred a {
		color: var(--text-link);
		text-decoration: none;
	}

	.chat-cred a:hover {
		text-decoration: underline;
	}

	.chat-scroll-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.chat-log {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		padding: 0.75rem 1rem 1rem;
	}

	.chat-col {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.375rem;
		width: 100%;
		max-width: 52rem;
		margin: 0 auto;
	}

	.chat-col--feed {
		margin-top: auto;
		margin-left: auto;
		margin-right: auto;
	}

	.chat-empty-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
	}

	.chat-empty-sub {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.chat-truncated {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		text-align: center;
	}

	.tr-user {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.tr-user-dot {
		width: 0.5rem;
		height: 0.5rem;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent);
		transform: translateY(-1px);
	}

	.tr-user-text {
		font-size: var(--text-footnote);
		line-height: 1.55;
		font-weight: 600;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-md {
		max-width: 70ch;
		font-size: var(--text-footnote);
		line-height: 1.65;
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.tr-md :global(p) {
		margin: 0.5rem 0;
	}

	.tr-md :global(p:first-child) {
		margin-top: 0.25rem;
	}

	.tr-md :global(ul),
	.tr-md :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.375rem;
	}

	.tr-md :global(ul) {
		list-style: disc;
	}

	.tr-md :global(ol) {
		list-style: decimal;
	}

	.tr-md :global(li) {
		margin: 0.1875rem 0;
	}

	.tr-md :global(li::marker) {
		color: var(--text-faint);
	}

	.tr-md :global(code) {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		padding: 1px 6px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-raised);
	}

	.tr-md :global(pre) {
		margin: 0.5rem 0;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		overflow-x: auto;
	}

	.tr-md :global(pre code) {
		padding: 0;
		border: none;
		border-radius: 0;
		background: none;
		font-size: var(--text-caption);
		line-height: 1.55;
	}

	.tr-md :global(h1),
	.tr-md :global(h2),
	.tr-md :global(h3),
	.tr-md :global(h4) {
		margin: 0.75rem 0 0.25rem;
		font-size: var(--text-footnote);
		font-weight: 700;
		color: var(--text-default);
	}

	.tr-md :global(a) {
		color: var(--text-link);
		text-decoration: none;
	}

	.tr-md :global(a:hover) {
		text-decoration: underline;
	}

	.tr-md :global(blockquote) {
		margin: 0.5rem 0;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-muted);
	}

	.tr-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		width: 100%;
		padding: 0.1875rem 0.375rem;
		border-radius: var(--radius-xs);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.tr-row-btn {
		border: none;
		background: none;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.tr-row-btn:hover {
		background: var(--bg-hover);
	}

	.tr-row-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.tr-row-glyph {
		font-family: var(--font-mono, monospace);
	}

	.tr-row-label {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--text-default);
	}

	.tr-chip {
		min-width: 0;
		font-family: var(--font-mono, monospace);
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: var(--radius-xs);
		padding: 0 0.375rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tr-tool {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.tr-tool--failed .tr-row-icon,
	.tr-tool--failed .tr-row-label {
		color: var(--status-error);
	}

	.tr-diffstat {
		display: inline-flex;
		gap: 0.375rem;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}

	.tr-diff-add {
		color: var(--status-success);
	}

	.tr-diff-del {
		color: var(--status-error);
	}

	.tr-tool-failed {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--status-error);
		background: var(--status-error-bg);
		border: 1px solid var(--status-error-border);
		border-radius: var(--radius-pill);
		padding: 0 0.375rem;
	}

	.tr-tool-detail {
		margin: 0.25rem 0 0.25rem 1.375rem;
		padding: 0.5rem 0.625rem;
		max-height: 16rem;
		overflow: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		white-space: pre;
	}

	.tr-think {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.tr-think-body {
		margin: 0.125rem 0 0.25rem 1.375rem;
		padding: 0.375rem 0.625rem;
		max-height: 12.5em;
		overflow-y: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
		color: var(--text-faint);
		background: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-think--live .tr-think-body {
		color: var(--text-muted);
	}

	.tr-sub-prompt {
		font-size: var(--text-caption);
		line-height: 1.5;
		font-weight: 600;
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-agent {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.tr-agent-state {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.tr-agent-body {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin: 0.25rem 0 0.25rem 1.375rem;
		padding: 0.5rem 0.625rem;
		max-height: 24rem;
		overflow-y: auto;
		background: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}

	.tr-agent-empty {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.tr-turn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		margin: 0.375rem 0 0.5rem;
		padding: 0.25rem 0.375rem;
	}

	.tr-turn-meta {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.tr-turn-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.tr-turn-copy:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.tr-turn-files {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	.tr-file-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.0625rem 0.375rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-raised);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.tr-turn-cost {
		margin-left: auto;
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.tr-error {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--status-error-border);
		border-radius: var(--radius-sm);
		background: var(--status-error-bg);
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tr-working {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.tr-jump {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-overlay);
		box-shadow: var(--elev-1);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		cursor: pointer;
	}

	.chat-composer {
		flex-shrink: 0;
		border-top: 1px solid var(--border-default);
		padding: 0.5rem 1rem 0.625rem;
	}

	.chat-composer-col {
		max-width: 52rem;
		margin: 0 auto;
	}

	.chat-composer-input {
		width: 100%;
		border: none;
		background: none;
		resize: none;
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: 1.55;
		padding: 0;
	}

	.chat-composer-input:focus-visible {
		outline: none;
	}

	.chat-composer-input::placeholder {
		color: var(--text-faint);
	}

	.chat-composer-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.375rem;
	}

	.chat-composer-hint {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.chat-composer-working {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
	}

	.chat-composer-tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.chat-repo-select {
		border: none;
		background: none;
		padding: 0.125rem 0.25rem;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		cursor: pointer;
		border-radius: var(--radius-xs);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.chat-repo-select:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.chat-repo-select--static {
		cursor: default;
	}

	.chat-repo-select--static:hover {
		color: var(--text-muted);
		background: none;
	}

	.chat-send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--text-on-accent);
		cursor: pointer;
		transition: opacity var(--dur-fast);
	}

	.chat-send:disabled {
		background: var(--bg-sunken);
		color: var(--text-faint);
		cursor: default;
	}

	.chat-send--stop {
		background: var(--status-error-bg);
		color: var(--status-error);
		border: 1px solid var(--status-error-border);
	}

	.chat-send--stop:disabled {
		border: 1px solid var(--status-error-border);
		background: var(--status-error-bg);
		color: var(--status-error);
		opacity: 0.6;
	}

	.chat-composer--plan {
		border-top-color: var(--accent);
		background: var(--accent-subtle);
	}

	.chat-chips {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.chat-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		max-width: 12rem;
		padding: 0.125rem 0.375rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.chat-chip:hover,
	.chat-chip--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.chat-menu-scroll {
		max-height: 20rem;
		overflow-y: auto;
	}

	.chat-menu-group {
		padding: 0.375rem 0.75rem 0.125rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}

	.chat-menu-label {
		flex: 1;
		min-width: 0;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chat-mode {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
	}

	.chat-mode-btn {
		border: none;
		background: none;
		padding: 0.0625rem 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.chat-mode-btn--active {
		background: var(--bg-raised);
		color: var(--text-default);
	}

	.chat-mode-btn--plan.chat-mode-btn--active {
		background: var(--accent);
		color: var(--text-on-accent);
	}

	.chat-plan-badge {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--accent);
		white-space: nowrap;
	}
</style>
