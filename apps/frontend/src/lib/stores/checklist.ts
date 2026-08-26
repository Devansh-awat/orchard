import { browser } from '$app/environment';

// Dismissals only. Whether a step is *done* is always derived from live
// deployment state, so this file never needs to know about it and a step
// finished from the CLI or MCP disappears here without anything syncing.
const STORAGE_KEY = 'orchard:checklist';
const CURRENT_VERSION = 1;
// Enough that nobody hits it in practice, low enough that the entry never grows
// without bound for someone who churns through short-lived apps.
const MAX_TRACKED = 200;

interface ChecklistState {
	v: number;
	perDeployment: Record<string, string[]>;
	global: string[];
}

const EMPTY: ChecklistState = { v: CURRENT_VERSION, perDeployment: {}, global: [] };

function read(): ChecklistState {
	if (!browser) return EMPTY;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return EMPTY;
		const parsed = JSON.parse(raw);
		// A shape from an older version is discarded rather than migrated: the
		// worst case is somebody sees a card they already dismissed once.
		if (parsed?.v !== CURRENT_VERSION) return EMPTY;
		return {
			v: CURRENT_VERSION,
			perDeployment: parsed.perDeployment ?? {},
			global: parsed.global ?? []
		};
	} catch {
		return EMPTY;
	}
}

function write(state: ChecklistState) {
	if (!browser) return;
	try {
		const ids = Object.keys(state.perDeployment);
		let next = state;
		if (ids.length > MAX_TRACKED) {
			const trimmed: Record<string, string[]> = {};
			for (const id of ids.slice(-MAX_TRACKED)) trimmed[id] = state.perDeployment[id];
			next = { ...state, perDeployment: trimmed };
		}
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		/* quota or private mode: dismissals just do not persist */
	}
}

export function dismissedSteps(deploymentId: string): string[] {
	const state = read();
	return [...(state.perDeployment[deploymentId] ?? []), ...state.global];
}

export function dismissStep(deploymentId: string, stepId: string, global = false) {
	const state = read();
	if (global) {
		if (state.global.includes(stepId)) return;
		write({ ...state, global: [...state.global, stepId] });
		return;
	}
	const current = state.perDeployment[deploymentId] ?? [];
	if (current.includes(stepId)) return;
	write({
		...state,
		perDeployment: { ...state.perDeployment, [deploymentId]: [...current, stepId] }
	});
}

export function dismissAllSteps(deploymentId: string, stepIds: string[]) {
	const state = read();
	const current = new Set(state.perDeployment[deploymentId] ?? []);
	for (const id of stepIds) current.add(id);
	write({
		...state,
		perDeployment: { ...state.perDeployment, [deploymentId]: [...current] }
	});
}

export function forgetDeployment(deploymentId: string) {
	const state = read();
	if (!(deploymentId in state.perDeployment)) return;
	const next = { ...state.perDeployment };
	delete next[deploymentId];
	write({ ...state, perDeployment: next });
}
