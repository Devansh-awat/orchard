export type VerbText = { done: string; doing: string };

export const VERB_TEXT: Record<string, VerbText> = {
	Bash: { done: 'Ran', doing: 'Running' },
	Edit: { done: 'Edited', doing: 'Editing' },
	MultiEdit: { done: 'Edited', doing: 'Editing' },
	NotebookEdit: { done: 'Edited', doing: 'Editing' },
	Patch: { done: 'Patched', doing: 'Patching' },
	Write: { done: 'Wrote', doing: 'Writing' },
	Read: { done: 'Read', doing: 'Reading' },
	Grep: { done: 'Searched', doing: 'Searching' },
	Glob: { done: 'Found files', doing: 'Finding files' },
	List: { done: 'Listed', doing: 'Listing' },
	WebFetch: { done: 'Fetched', doing: 'Fetching' },
	WebSearch: { done: 'Searched the web', doing: 'Searching the web' },
	TodoWrite: { done: 'Updated todos', doing: 'Updating todos' },
	TodoRead: { done: 'Read todos', doing: 'Reading todos' },
	Task: { done: 'Delegated', doing: 'Delegating' }
};

export function verbText(name: string, running: boolean): string {
	const known = VERB_TEXT[name];
	if (!known) return name;
	return running ? known.doing : known.done;
}

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

export type StepTool = {
	name: string;
	input: unknown;
	summary: string;
	status: string | null;
};

export function isRunning(status: string | null | undefined): boolean {
	return status === 'running' || status === 'pending';
}

function sentence(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (!flat) return '';
	return flat.charAt(0).toUpperCase() + flat.slice(1);
}

export function stepLabel(tool: StepTool): { title: string; arg: string | null } {
	const running = isRunning(tool.status);
	const input =
		tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : {};
	const arg = tool.summary.trim() || null;
	if (tool.name === 'Bash' && typeof input.description === 'string') {
		const described = sentence(input.description);
		if (described) return { title: described, arg };
	}
	return { title: verbText(tool.name, running), arg };
}

export function doingLine(tool: StepTool): string {
	const verb = verbText(tool.name, true);
	return tool.summary ? `${verb} ${tool.summary}` : verb;
}

export function plainLine(text: string, max = 120): string {
	const line =
		text
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l && !/^(```|---|\|)/.test(l)) ?? '';
	const flat = line
		.replace(/^#{1,6}\s+/, '')
		.replace(/^[-*+]\s+/, '')
		.replace(/^\d+\.\s+/, '')
		.replace(/^>\s*/, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function planLabel(name: string): string {
	const base = name.split('/').pop() ?? name;
	const stem = base.replace(/\.md$/i, '');
	const slug = stem.replace(/^[0-9][0-9TZ:._-]*?[-_](?=[a-z])/i, '');
	const words = (slug || stem).replace(/[-_]+/g, ' ').trim();
	return sentence(words) || base;
}

export function isPlanFile(name: string): boolean {
	return /\.md$/i.test(name);
}
