import { getContext, setContext, untrack } from 'svelte';
import type { Sandbox, SandboxListResponse, SandboxRunnerInfo } from '$lib/types/sandbox';
import type { GreenhouseEnv } from './env';
import { PanelLayout } from './layout.svelte';
import { MachineWorkspace } from './workspace.svelte';
import type { PersonRef } from './types';

export type NavTarget = { machine?: string | null; session?: string | null; tab?: string | null };

export interface GreenhouseNav {
	machineId(): string | null;
	sessionId(): string | null;
	tab(): string | null;
	go(target: NavTarget, opts?: { replace?: boolean }): void;
}

export type Sheet =
	| 'new-machine'
	| 'share'
	| 'settings'
	| 'quick-open'
	| 'add-repo'
	| 'preview'
	| 'fork'
	| null;

type HistoryEntry = { machine: string | null; session: string | null; tab: string | null };

const LAST_MACHINE = 'greenhouse-last-machine';

export class GreenhouseApp {
	readonly env: GreenhouseEnv;
	readonly nav: GreenhouseNav;
	readonly layout = new PanelLayout();

	list = $state.raw<SandboxListResponse | null>(null);
	listState = $state<'loading' | 'ready' | 'disabled' | 'error'>('loading');
	self = $state.raw<PersonRef | null>(null);
	superAdmin = $state(false);
	organizationId = $state<string | null>(null);
	sheet = $state<Sheet>(null);
	mobilePane = $state<'sessions' | 'chat' | 'changes'>('chat');
	ws = $state.raw<MachineWorkspace | null>(null);
	lastMachine = $state<string | null>(null);

	history = $state.raw<HistoryEntry[]>([]);
	cursor = $state(-1);
	#travelling = false;

	readonly machines = $derived(this.list?.sandboxes ?? []);
	readonly runners = $derived<SandboxRunnerInfo[]>(this.list?.runners ?? []);
	readonly defaultRunner = $derived(this.list?.defaultRunner ?? null);
	readonly machineId = $derived.by(() => {
		const wanted = this.nav.machineId();
		if (wanted) return wanted;
		const list = this.machines;
		if (this.lastMachine && list.some((m) => m.id === this.lastMachine)) return this.lastMachine;
		return list[0]?.id ?? null;
	});
	readonly machine = $derived<Sandbox | null>(
		this.machines.find((m) => m.id === this.machineId) ?? null
	);
	readonly sessionId = $derived.by(() => this.nav.sessionId());
	readonly home = $derived(!this.sessionId);
	readonly canBack = $derived(this.cursor > 0);
	readonly canForward = $derived(this.cursor < this.history.length - 1);

	constructor(env: GreenhouseEnv, nav: GreenhouseNav) {
		this.env = env;
		this.nav = nav;
		if (typeof localStorage !== 'undefined') {
			try {
				this.lastMachine = localStorage.getItem(LAST_MACHINE);
			} catch {
				this.lastMachine = null;
			}
		}
	}

	rememberMachine(id: string) {
		this.lastMachine = id;
		try {
			localStorage.setItem(LAST_MACHINE, id);
		} catch {
			return;
		}
	}

	mount(id: string | null) {
		const current = untrack(() => this.ws);
		if (current?.sandboxId === id) return;
		current?.dispose();
		if (!id) {
			this.ws = null;
			return;
		}
		const ws = new MachineWorkspace(
			id,
			{
				machine: () => this.machines.find((m) => m.id === id) ?? null,
				self: () => this.self,
				superAdmin: () => this.superAdmin,
				sessionId: () => this.nav.sessionId(),
				tab: () => this.nav.tab(),
				openSession: (sid, tab = null) => this.openSession(sid, tab),
				openTab: (tab) => this.nav.go({ tab }, { replace: true })
			},
			this.env
		);
		this.ws = ws;
		ws.start();
	}

	dispose() {
		this.ws?.dispose();
		this.ws = null;
	}

	openMachine(id: string) {
		this.rememberMachine(id);
		this.nav.go({ machine: id, session: null, tab: null });
	}

	openSession(sid: string | null, tab: string | null = null) {
		const machine = this.machineId;
		this.nav.go({ machine, session: sid, tab });
		if (sid) this.mobilePane = 'chat';
	}

	goHome() {
		this.nav.go({ machine: this.machineId, session: null, tab: null });
	}

	record() {
		const entry: HistoryEntry = {
			machine: this.nav.machineId(),
			session: this.nav.sessionId(),
			tab: this.nav.tab()
		};
		untrack(() => {
			if (this.#travelling) {
				this.#travelling = false;
				return;
			}
			const current = this.history[this.cursor];
			if (
				current &&
				current.machine === entry.machine &&
				current.session === entry.session &&
				current.tab === entry.tab
			)
				return;
			const next = [...this.history.slice(0, this.cursor + 1), entry].slice(-50);
			this.history = next;
			this.cursor = next.length - 1;
		});
	}

	back() {
		if (this.cursor <= 0) return;
		this.#travel(this.cursor - 1);
	}

	forward() {
		if (this.cursor >= this.history.length - 1) return;
		this.#travel(this.cursor + 1);
	}

	#travel(index: number) {
		const entry = this.history[index];
		if (!entry) return;
		this.cursor = index;
		this.#travelling = true;
		this.nav.go(entry);
	}
}

const KEY = Symbol('greenhouse-app');

export function setGreenhouseApp(app: GreenhouseApp) {
	setContext(KEY, app);
}

export function getGreenhouseApp(): GreenhouseApp {
	const app = getContext<GreenhouseApp | undefined>(KEY);
	if (!app) throw new Error('Greenhouse shell is not mounted');
	return app;
}
