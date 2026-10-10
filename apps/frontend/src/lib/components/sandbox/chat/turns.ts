import type { ChatEntry, FeedEntry, FeedItem } from './session-store.svelte';
import { doingLine, fmtDuration, isRunning, plainLine } from './steps';

export type HumanRow = Extract<FeedItem, { type: 'prompt' | 'comment' }>;

export type AgentBlock = {
	type: 'agent';
	key: string;
	start: number | null;
	steps: FeedEntry[];
	answer: FeedEntry[];
	errors: FeedEntry[];
	notes: FeedEntry[];
	result: FeedEntry | null;
};

export type ChunkRow = HumanRow | AgentBlock;

export type Chunk = { key: string; rows: ChunkRow[] };

export type ActivitySummary = {
	steps: number;
	add: number;
	del: number;
	failed: number;
	duration: number | null;
	thoughtOnly: boolean;
};

export type RailMark = {
	key: string;
	kind: 'prompt' | 'comment' | 'agent';
	who: string;
	preview: string;
	live: boolean;
};

const PROCEDURAL = new Set<ChatEntry['kind']>(['thinking', 'tool', 'agent']);

function entryTime(entry: ChatEntry): number | null {
	return typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null;
}

function toBlock(key: string, start: number | null, entries: FeedEntry[]): AgentBlock {
	let last = -1;
	entries.forEach((item, i) => {
		if (PROCEDURAL.has(item.entry.kind)) last = i;
	});
	const block: AgentBlock = {
		type: 'agent',
		key,
		start,
		steps: [],
		answer: [],
		errors: [],
		notes: [],
		result: null
	};
	entries.forEach((item, i) => {
		const kind = item.entry.kind;
		if (kind === 'result') block.result = item;
		else if (kind === 'error') block.errors.push(item);
		else if (kind === 'note') block.notes.push(item);
		else if (kind === 'text' && i > last) block.answer.push(item);
		else block.steps.push(item);
	});
	return block;
}

export function buildChunks(feed: FeedItem[], busy: boolean): Chunk[] {
	const chunks: Chunk[] = [];
	let chunk: Chunk | null = null;
	let pending: FeedEntry[] = [];
	let held: HumanRow[] = [];
	let open = false;
	let anchor: string | null = null;
	let start: number | null = null;

	const begin = (key: string): Chunk => {
		const next: Chunk = { key: `k:${key}`, rows: [] };
		chunks.push(next);
		chunk = next;
		return next;
	};
	const current = (): Chunk | null => chunk;
	const lastRow = (): ChunkRow | undefined => {
		const rows = current()?.rows;
		return rows?.[rows.length - 1];
	};
	const hasAgent = (): boolean => current()?.rows.some((r) => r.type === 'agent') ?? false;
	const release = () => {
		if (held.length === 0) return;
		const target = current() ?? begin(held[0].key);
		target.rows.push(...held);
		held = [];
	};
	const close = (force: boolean) => {
		if (pending.length > 0 || (force && open)) {
			const key = anchor ?? pending[0]?.entry.key ?? 'live';
			const target = current() ?? begin(key);
			target.rows.push(toBlock(`b:${key}`, start, pending));
		}
		pending = [];
		open = false;
		anchor = null;
		start = null;
		release();
	};

	for (const item of feed) {
		if (item.type === 'prompt') {
			close(false);
			if (!current() || hasAgent()) begin(item.key);
			current()?.rows.push(item);
			open = true;
			anchor = item.key;
			start = entryTime(item.entry);
			continue;
		}
		if (item.type === 'comment') {
			if (open) held.push(item);
			else (current() ?? begin(item.key)).rows.push(item);
			continue;
		}
		const entries: FeedEntry[] =
			item.type === 'tools' ? item.items : [{ entry: item.entry, index: item.index }];
		for (const entry of entries) {
			if (pending.length === 0 && !open) {
				if (!current() || lastRow()?.type === 'agent') begin(entry.entry.key);
				anchor = entry.entry.key;
			}
			if (!open) open = true;
			if (start === null) start = entryTime(entry.entry);
			pending.push(entry);
			if (entry.entry.kind === 'result') close(false);
		}
	}

	if (busy && !open && pending.length === 0) {
		const end = lastRow();
		if (end && end.type !== 'agent') {
			open = true;
			anchor = `after:${end.key}`;
		}
	}
	close(busy);
	return chunks;
}

export function summarize(block: AgentBlock): ActivitySummary {
	let steps = 0;
	let add = 0;
	let del = 0;
	let failed = 0;
	let thinking = 0;
	let first: number | null = null;
	let last: number | null = null;
	for (const { entry } of [...block.steps, ...block.answer]) {
		const time = entryTime(entry);
		if (time !== null) {
			first = first === null ? time : Math.min(first, time);
			last = last === null ? time : Math.max(last, time);
		}
		if (entry.kind === 'thinking') thinking += 1;
		if (entry.kind === 'tool') {
			steps += 1;
			if (entry.failed) failed += 1;
			add += entry.diff?.add ?? 0;
			del += entry.diff?.del ?? 0;
		} else if (entry.kind === 'agent') {
			steps += 1;
			if (entry.status === 'error') failed += 1;
		}
	}
	const result = block.result?.entry;
	const measured = first !== null && last !== null && last > first ? last - first : null;
	const duration =
		result?.kind === 'result' && result.duration !== null ? result.duration : measured;
	return { steps, add, del, failed, duration, thoughtOnly: steps === 0 && thinking > 0 };
}

export function fmtWorked(ms: number): string {
	if (ms < 1000) return '1s';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return fmtDuration(ms);
}

export function workedLabel(summary: ActivitySummary): string {
	const verb = summary.thoughtOnly ? 'Thought' : 'Worked';
	return summary.duration !== null ? `${verb} for ${fmtWorked(summary.duration)}` : verb;
}

export function liveStep(block: AgentBlock): string {
	for (let i = block.steps.length - 1; i >= 0; i -= 1) {
		const entry = block.steps[i].entry;
		if (entry.kind === 'tool' && isRunning(entry.status)) return doingLine(entry);
		if (entry.kind === 'agent' && isRunning(entry.status)) {
			return `Running the ${entry.agentType} agent`;
		}
		if (entry.kind === 'thinking' && !entry.done) return 'Thinking';
	}
	if (block.answer.length > 0) return 'Writing the reply';
	if (block.steps.length > 0) return 'Planning the next step';
	return 'Thinking';
}

export function liveWindow<T>(steps: T[], size: number): { hidden: number; shown: T[] } {
	if (steps.length <= size) return { hidden: 0, shown: steps };
	return { hidden: steps.length - size, shown: steps.slice(steps.length - size) };
}

function agentPreview(block: AgentBlock, live: boolean): string {
	for (let i = block.answer.length - 1; i >= 0; i -= 1) {
		const entry = block.answer[i].entry;
		if (entry.kind === 'text') {
			const line = plainLine(entry.text);
			if (line) return line;
		}
	}
	if (live) return liveStep(block);
	const error = block.errors[0]?.entry;
	if (error?.kind === 'error') return plainLine(error.detail);
	const summary = summarize(block);
	if (summary.steps === 0 && !summary.thoughtOnly) return 'No output';
	const steps =
		summary.steps > 0 ? ` · ${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'}` : '';
	return `${workedLabel(summary)}${steps}`;
}

export function railMarks(chunks: Chunk[], liveKey: string | null): RailMark[] {
	const marks: RailMark[] = [];
	for (const chunk of chunks) {
		for (const row of chunk.rows) {
			if (row.type === 'agent') {
				const live = row.key === liveKey;
				marks.push({
					key: row.key,
					kind: 'agent',
					who: 'Agent',
					preview: agentPreview(row, live),
					live
				});
			} else if (row.type === 'prompt') {
				const files = row.entry.attachments?.length ?? 0;
				marks.push({
					key: row.key,
					kind: 'prompt',
					who: row.own ? 'You' : (row.author?.name ?? 'Prompt'),
					preview:
						plainLine(row.entry.text) ||
						(files > 0 ? `${files} ${files === 1 ? 'attachment' : 'attachments'}` : 'Prompt'),
					live: false
				});
			} else {
				marks.push({
					key: row.key,
					kind: 'comment',
					who: row.own ? 'You' : row.comment.author.name,
					preview: plainLine(row.comment.body) || 'Comment',
					live: false
				});
			}
		}
	}
	return marks;
}
