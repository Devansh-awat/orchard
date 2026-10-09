export interface Locatable {
	closest(selector: string): unknown;
}

export interface FocusTarget extends Locatable {
	tagName: string;
	isContentEditable: boolean;
	getAttribute(name: string): string | null;
	matches(selector: string): boolean;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export const CODE_EDITOR_SELECTOR = '.monaco-editor';
export const TERMINAL_SELECTOR = '.pod-terminal';

export function inCodeEditor(el: Locatable | null): boolean {
	return !!el && el.closest(CODE_EDITOR_SELECTOR) !== null;
}

export function inTerminal(el: Locatable | null): boolean {
	return !!el && el.closest(TERMINAL_SELECTOR) !== null;
}

export function holdsTextEntry(el: FocusTarget | null): boolean {
	if (!el) return false;
	if (TEXT_TAGS.has(el.tagName) || el.isContentEditable) return true;
	if (el.getAttribute('role') === 'textbox') return true;
	return inCodeEditor(el);
}

export function mayTakeFocus(
	active: FocusTarget | null,
	owns: (el: FocusTarget) => boolean
): boolean {
	if (!active || active.tagName === 'BODY' || active.tagName === 'HTML') return true;
	if (owns(active)) return true;
	if (holdsTextEntry(active)) return false;
	return !active.matches(':focus-visible');
}

export function activeTarget(): FocusTarget | null {
	if (typeof document === 'undefined') return null;
	const active = document.activeElement;
	return active instanceof HTMLElement ? active : null;
}
