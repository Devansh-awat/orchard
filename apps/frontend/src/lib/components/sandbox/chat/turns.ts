import type { ChatEntry, FeedEntry, FeedItem } from './session-store.svelte';
import { fmtDuration, toolVerb } from './format';

export type HumanRow = Extract<FeedItem, { type: 'prompt' | 'comment' }>;

export type AgentBlock = {
	type: 'agent';
	key: string;
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

const PROCEDURAL = new Set<ChatEntry['kind']>(['thinking', 'tool', 'agent']);

function toBlock(entries: FeedEntry[]): AgentBlock {
	let last = -1;
	entries.forEach((item, i) => {
		if (PROCEDURAL.has(item.entry.kind)) last = i;
	});
	const block: AgentBlock = {
		type: 'agent',
		key: `b:${entries[0]?.entry.key ?? 'pending'}`,
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

	const open = (key: string) => {
		chunk = { key: `k:${key}`, rows: [] };
		chunks.push(chunk);
		return chunk;
	};
	const close = () => {
		if (pending.length === 0) return;
		const target: Chunk = chunk ?? open(pending[0].entry.key);
		target.rows.push(toBlock(pending));
		pending = [];
	};
	const lastRow = (): ChunkRow | undefined => {
		const current = chunk as Chunk | null;
		return current?.rows[current.rows.length - 1];
	};

	for (const item of feed) {
		if (item.type === 'prompt' || item.type === 'comment') {
			close();
			const current = chunk as Chunk | null;
			const target: Chunk = !current || lastRow()?.type === 'agent' ? open(item.key) : current;
			target.rows.push(item);
			continue;
		}
		const entries: FeedEntry[] =
			item.type === 'tools' ? item.items : [{ entry: item.entry, index: item.index }];
		for (const entry of entries) {
			if (pending.length === 0 && (!chunk || lastRow()?.type === 'agent')) {
				open(entry.entry.key);
			}
			pending.push(entry);
			if (entry.entry.kind === 'result') close();
		}
	}
	close();

	const tail = chunks[chunks.length - 1];
	const end = tail?.rows[tail.rows.length - 1];
	if (busy && tail && end && end.type !== 'agent') {
		tail.rows.push({
			type: 'agent',
			key: `b:after:${end.key}`,
			steps: [],
			answer: [],
			errors: [],
			notes: [],
			result: null
		});
	}
	return chunks;
}

function entryTime(entry: ChatEntry): number | null {
	return typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null;
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

export function liveStep(block: AgentBlock): string {
	for (let i = block.steps.length - 1; i >= 0; i -= 1) {
		const entry = block.steps[i].entry;
		if (entry.kind === 'tool' && (entry.status === 'running' || entry.status === 'pending')) {
			const verb = toolVerb(entry.name, true).verb;
			return entry.summary ? `${verb} ${entry.summary}` : verb;
		}
		if (entry.kind === 'agent' && (entry.status === 'running' || entry.status === 'pending')) {
			return `Running the ${entry.agentType} agent`;
		}
		if (entry.kind === 'thinking' && !entry.done) return 'Thinking';
	}
	if (block.answer.length > 0) return 'Writing';
	return 'Working';
}
