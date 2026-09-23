import { browser } from '$app/environment';

export interface Shortcut {
	id: string;
	key: string;
	mod?: boolean;
	shift?: boolean;
	alt?: boolean;
	label: string;
	allowInInputs?: boolean;
	when?: () => boolean;
	run: (event: KeyboardEvent) => void;
}

const registry = new Map<string, Shortcut>();
let listening = false;

const IS_MAC = browser && /Mac|iPhone|iPad/.test(navigator.platform);

function inEditable(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function matches(shortcut: Shortcut, event: KeyboardEvent, isMac = IS_MAC): boolean {
	if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
	const modDown = isMac ? event.metaKey : event.ctrlKey;
	const otherMod = isMac ? event.ctrlKey : event.metaKey;
	if (!!shortcut.mod !== modDown || otherMod) return false;
	if (!!shortcut.shift !== event.shiftKey) return false;
	if (!!shortcut.alt !== event.altKey) return false;
	return true;
}

function dispatch(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	for (const shortcut of registry.values()) {
		if (!matches(shortcut, event)) continue;
		if (!shortcut.allowInInputs && !shortcut.mod && inEditable(event.target)) continue;
		if (shortcut.when && !shortcut.when()) continue;
		event.preventDefault();
		shortcut.run(event);
		return;
	}
}

export function registerShortcut(shortcut: Shortcut): () => void {
	registry.set(shortcut.id, shortcut);
	if (browser && !listening) {
		window.addEventListener('keydown', dispatch);
		listening = true;
	}
	return () => {
		registry.delete(shortcut.id);
	};
}

export function listShortcuts(): Shortcut[] {
	return [...registry.values()];
}

export function shortcutLabel(shortcut: Pick<Shortcut, 'key' | 'mod' | 'shift' | 'alt'>): string {
	const parts: string[] = [];
	if (shortcut.mod) parts.push(IS_MAC ? '⌘' : 'Ctrl');
	if (shortcut.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
	if (shortcut.shift) parts.push('⇧');
	const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
	parts.push(key === 'Escape' ? 'esc' : key);
	return parts.join(IS_MAC ? '' : '+');
}
