export interface StoredTerminalTab {
	id: string;
	podName: string;
	container: string;
	label: string;
	title?: string;
	sessionHandle?: string;
}

export interface StoredTerminalTabs {
	tabs: StoredTerminalTab[];
	active: string;
	counter: number;
}

const PREFIX = 'terminal-tabs:';
const MAX_TABS = 12;

export function terminalTabsKey(kind: string, resourceId: string): string {
	return `${PREFIX}${kind}:${resourceId}`;
}

function isTab(value: unknown): value is StoredTerminalTab {
	if (!value || typeof value !== 'object') return false;
	const t = value as Record<string, unknown>;
	return (
		typeof t.id === 'string' &&
		t.id.length > 0 &&
		typeof t.podName === 'string' &&
		typeof t.container === 'string' &&
		typeof t.label === 'string'
	);
}

export function decodeTerminalTabs(raw: string | null): StoredTerminalTabs | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const rec = parsed as Record<string, unknown>;
	const tabs = Array.isArray(rec.tabs)
		? rec.tabs
				.filter(isTab)
				.slice(0, MAX_TABS)
				.map((t) => ({
					id: t.id,
					podName: t.podName,
					container: t.container,
					label: t.label,
					...(typeof t.title === 'string' && t.title ? { title: t.title } : {}),
					...(typeof t.sessionHandle === 'string' && t.sessionHandle
						? { sessionHandle: t.sessionHandle }
						: {})
				}))
		: [];
	if (tabs.length === 0) return null;
	const active =
		typeof rec.active === 'string' && tabs.some((t) => t.id === rec.active)
			? rec.active
			: tabs[tabs.length - 1].id;
	const counter =
		typeof rec.counter === 'number' && Number.isFinite(rec.counter)
			? Math.max(tabs.length, Math.floor(rec.counter))
			: tabs.length;
	return { tabs, active, counter };
}

export function encodeTerminalTabs(state: StoredTerminalTabs): string | null {
	if (state.tabs.length === 0) return null;
	return JSON.stringify({
		tabs: state.tabs.slice(0, MAX_TABS).map((t) => ({
			id: t.id,
			podName: t.podName,
			container: t.container,
			label: t.label,
			...(t.title ? { title: t.title } : {}),
			...(t.sessionHandle ? { sessionHandle: t.sessionHandle } : {})
		})),
		active: state.active,
		counter: state.counter
	});
}

export function loadTerminalTabs(
	key: string,
	storage: Pick<Storage, 'getItem'> | null = typeof sessionStorage === 'undefined'
		? null
		: sessionStorage
): StoredTerminalTabs | null {
	if (!storage) return null;
	try {
		return decodeTerminalTabs(storage.getItem(key));
	} catch {
		return null;
	}
}

export function saveTerminalTabs(
	key: string,
	state: StoredTerminalTabs,
	storage: Pick<Storage, 'setItem' | 'removeItem'> | null = typeof sessionStorage === 'undefined'
		? null
		: sessionStorage
): void {
	if (!storage) return;
	try {
		const encoded = encodeTerminalTabs(state);
		if (encoded) storage.setItem(key, encoded);
		else storage.removeItem(key);
	} catch {
		return;
	}
}
