import {
	Bot,
	FilePen,
	FilePlus,
	FileText,
	FolderTree,
	Globe,
	ListTodo,
	Search,
	SquareTerminal,
	Wrench
} from 'lucide-svelte';

export const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

type ToolVerb = { icon: typeof Wrench; done: string; doing: string };

const TOOL_VERBS: Record<string, ToolVerb> = {
	Bash: { icon: SquareTerminal, done: 'Ran', doing: 'Running' },
	Edit: { icon: FilePen, done: 'Edited', doing: 'Editing' },
	MultiEdit: { icon: FilePen, done: 'Edited', doing: 'Editing' },
	NotebookEdit: { icon: FilePen, done: 'Edited', doing: 'Editing' },
	Patch: { icon: FilePen, done: 'Patched', doing: 'Patching' },
	Write: { icon: FilePlus, done: 'Wrote', doing: 'Writing' },
	Read: { icon: FileText, done: 'Read', doing: 'Reading' },
	Grep: { icon: Search, done: 'Searched', doing: 'Searching' },
	Glob: { icon: Search, done: 'Found files', doing: 'Finding files' },
	List: { icon: FolderTree, done: 'Listed', doing: 'Listing' },
	WebFetch: { icon: Globe, done: 'Fetched', doing: 'Fetching' },
	WebSearch: { icon: Globe, done: 'Searched the web', doing: 'Searching the web' },
	TodoWrite: { icon: ListTodo, done: 'Updated todos', doing: 'Updating todos' },
	TodoRead: { icon: ListTodo, done: 'Read todos', doing: 'Reading todos' },
	Task: { icon: Bot, done: 'Delegated', doing: 'Delegating' }
};

export function toolVerb(name: string, running: boolean): { icon: typeof Wrench; verb: string } {
	const known = TOOL_VERBS[name];
	if (known) return { icon: known.icon, verb: running ? known.doing : known.done };
	if (name.includes('Search')) return { icon: Search, verb: name };
	return { icon: Wrench, verb: name };
}

export function truncate(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function midTruncate(text: string, max = 72): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= max) return flat;
	const head = Math.ceil((max - 1) * 0.6);
	return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
}

export function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split('\n').length;
}

export function firstLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim()) ?? '';
	return truncate(line, 90);
}

export function pretty(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

export function fmtCost(cost: number): string {
	return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtClock(time: number): string {
	return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
