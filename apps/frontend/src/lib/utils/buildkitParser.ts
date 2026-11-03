// Parser for the server's BuildKit step stream. Groups raw log lines by their
// `#id` step id and extracts stage labels, durations, cache hits, and per-step
// output so the UI can render a Depot-style stepped log view.
//
// Two producers write this format. The server transcodes BuildKit's
// `--progress=rawjson` stream into it (stable 8-hex step ids, and lifecycle
// lines emitted the instant they are true), and super builds still emit
// BuildKit's own `--progress=plain` display output (`#12` counter ids, with
// BuildKit's display buffering, so a step can look busy after it finished).

export type StepStatus = 'pending' | 'running' | 'done' | 'cached' | 'error' | 'canceled';

export interface BuildStep {
	id: string; // BuildKit step number, e.g. "5"
	order: number; // first-seen order, used for stable sort
	stage: string | null; // e.g. "base", "builder", "runner", "internal"
	stagePos: string | null; // e.g. "1/3"
	command: string; // first descriptive line, e.g. "FROM …" or "RUN …"
	status: StepStatus;
	durationSec: number | null;
	transferred: string | null; // e.g. "14.3 MB" / "1.7kB"
	firstSeenAt: number | null; // ms epoch (timestamp from `[ts]` prefix if present)
	output: string[]; // raw sub-lines (excluding header)
	error: string | null;
}

export interface BuildMessage {
	order: number;
	timestamp: number | null;
	level: 'INFO' | 'ERROR' | 'WARNING';
	text: string;
}

export interface ParsedBuildLogs {
	steps: BuildStep[];
	messages: BuildMessage[]; // non-step lines like "Waiting for build job …"
}

// Match `[1747...] [INFO] msg` prefix produced by appendLog.
const PREFIX_RE = /^\[(\d{10,})\]\s*\[(INFO|ERROR|WARNING)\]\s?/;

// A step id is a plain-output counter (`#5`) or a transcoded digest (`#a91f0c3e`).
const ID = '[0-9a-f]{8}|\\d+';
// `#5 [base 1/3] FROM docker.io/…`
const STEP_HEADER_RE = new RegExp(`^#(${ID})\\s+\\[([^\\]]+)\\]\\s*(.*)$`);
// `#5 DONE 0.4s` / `#5 CACHED` / `#5 ERROR: …` / `#5 CANCELED`
const STEP_DONE_RE = new RegExp(`^#(${ID})\\s+DONE\\s+([\\d.]+)s\\s*$`);
const STEP_CACHED_RE = new RegExp(`^#(${ID})\\s+CACHED\\s*$`);
const STEP_ERROR_RE = new RegExp(`^#(${ID})\\s+ERROR:?\\s*(.*)$`);
const STEP_CANCELED_RE = new RegExp(`^#(${ID})\\s+CANCELED\\s*$`);
// Any other `#5 …` substep line
const STEP_SUBLINE_RE = new RegExp(`^#(${ID})\\s+(.*)$`);
// `transferring …: 14.30MB done` or `… 1.7kB`
const TRANSFER_RE = /(?:transferring\b[^:]*:\s*|\s)([\d.]+\s?[KMG]?B)(?:\s+done)?\s*$/i;

// Export/push phases emit no `[stage]` header: their first line is the only
// description (e.g. `#36 exporting to oci image format`). Map the known ones
// to friendly labels; anything unrecognized falls back to the raw line.
const HEADERLESS_LABELS: [RegExp, string][] = [
	[/^exporting to .*image format/i, 'Exporting image layers'],
	[/^exporting to image/i, 'Exporting image layers'],
	[/^exporting cache/i, 'Pushing build cache']
];

function headerlessLabel(body: string): string {
	for (const [re, label] of HEADERLESS_LABELS) {
		if (re.test(body)) return label;
	}
	return body;
}

const PUSHER_STEP_ID = '__pusher';
const PUSHER_LINE_RE = /^\[pusher\]/i;
const SKOPEO_LINE_RE =
	/^(Getting image source signatures|Copying blob\b|Copying config\b|Writing manifest|Storing signatures|Skipping fetch of repeat blob)/i;
const PUSHER_START_RE = /^\[pusher\] build done/i;
const PUSHER_DONE_RE = /Writing manifest to image destination/i;
const PUSHER_ERROR_RE = /^(FATA|Error)\b|level=fatal/i;

function isPusherLine(body: string): boolean {
	return PUSHER_LINE_RE.test(body) || SKOPEO_LINE_RE.test(body);
}

function isPushActivity(body: string): boolean {
	return SKOPEO_LINE_RE.test(body) || PUSHER_START_RE.test(body);
}

function stripPrefix(line: string): {
	ts: number | null;
	level: BuildMessage['level'];
	rest: string;
} {
	const m = line.match(PREFIX_RE);
	if (!m) return { ts: null, level: 'INFO', rest: line };
	return { ts: Number(m[1]), level: m[2] as BuildMessage['level'], rest: line.slice(m[0].length) };
}

function splitStage(stageLabel: string): { stage: string | null; stagePos: string | null } {
	// "base 1/3" → ("base", "1/3"); "internal" → ("internal", null)
	const words = stageLabel.trim().split(/\s+/);
	if (words.length > 1 && /^[a-z0-9]+\/[a-z0-9]+/i.test(words[0]) && !/^\d+\/\d+$/.test(words[0]))
		words.shift();
	const last = words.at(-1) ?? '';
	if (/^\d+\/\d+$/.test(last)) {
		return { stage: words.slice(0, -1).join(' ') || null, stagePos: last };
	}
	return { stage: words.join(' ') || null, stagePos: null };
}

interface ParserState {
	stepMap: Map<string, BuildStep>;
	messages: BuildMessage[];
	order: number;
}

function parseLineInto(state: ParserState, rawLine: string) {
	const { ts, level, rest } = stripPrefix(rawLine);
	const { stepMap, messages } = state;

	// BuildKit lines all start with `#<digits>`.
	const headerMatch = rest.match(STEP_HEADER_RE);
	const doneMatch = rest.match(STEP_DONE_RE);
	const cachedMatch = rest.match(STEP_CACHED_RE);
	const errorMatch = rest.match(STEP_ERROR_RE);
	const canceledMatch = rest.match(STEP_CANCELED_RE);
	const sublineMatch = rest.match(STEP_SUBLINE_RE);

	const stepId =
		headerMatch?.[1] ??
		doneMatch?.[1] ??
		cachedMatch?.[1] ??
		errorMatch?.[1] ??
		canceledMatch?.[1] ??
		sublineMatch?.[1];

	if (!stepId) {
		if (isPusherLine(rest)) {
			let push = stepMap.get(PUSHER_STEP_ID);
			if (!push && !isPushActivity(rest)) {
				messages.push({ order: state.order++, timestamp: ts, level, text: rest });
				return;
			}
			if (!push) {
				push = {
					id: PUSHER_STEP_ID,
					order: state.order++,
					stage: 'push',
					stagePos: null,
					command: 'Pushing image to registry',
					status: 'running',
					durationSec: null,
					transferred: null,
					firstSeenAt: ts,
					output: [],
					error: null
				};
				stepMap.set(PUSHER_STEP_ID, push);
			}
			if (push.firstSeenAt === null && ts !== null) push.firstSeenAt = ts;
			push.output.push(rest);
			if (PUSHER_DONE_RE.test(rest)) push.status = 'done';
			else if (PUSHER_ERROR_RE.test(rest)) {
				push.status = 'error';
				push.error = rest;
			}
			return;
		}
		// Non-step line: a status message from appendLog.
		messages.push({ order: state.order++, timestamp: ts, level, text: rest });
		return;
	}

	let step = stepMap.get(stepId);
	if (!step) {
		step = {
			id: stepId,
			order: state.order++,
			stage: null,
			stagePos: null,
			command: '',
			status: 'running',
			durationSec: null,
			transferred: null,
			firstSeenAt: ts,
			output: [],
			error: null
		};
		stepMap.set(stepId, step);
	}
	if (step.firstSeenAt === null && ts !== null) step.firstSeenAt = ts;

	if (headerMatch) {
		const { stage, stagePos } = splitStage(headerMatch[2]);
		step.stage = stage;
		step.stagePos = stagePos;
		const cmd = headerMatch[3].trim();
		if (cmd && !step.command) step.command = cmd;
		return;
	}
	if (doneMatch) {
		step.durationSec = Number(doneMatch[2]);
		if (step.status !== 'error' && step.status !== 'canceled') step.status = 'done';
		return;
	}
	if (cachedMatch) {
		step.status = 'cached';
		return;
	}
	if (errorMatch) {
		step.status = 'error';
		step.error = errorMatch[2].trim() || step.error;
		return;
	}
	if (canceledMatch) {
		step.status = 'canceled';
		return;
	}
	if (sublineMatch) {
		const body = sublineMatch[2];
		// Headerless steps take their first line as the label instead of
		// rendering as an anonymous "Step #36".
		if (!step.command && !step.stage) {
			step.command = headerlessLabel(body);
			return;
		}
		// Capture transferred sizes shown next to the stage badge in Depot.
		// Always take the latest reading: the first one is whatever happened to be
		// in flight when the step was sighted, which left rows stuck showing
		// "0.04 kB" for the whole build.
		const tm = body.match(TRANSFER_RE);
		if (tm) step.transferred = tm[1].replace(/\s+/, ' ');
		step.output.push(body);
	}
}

/**
 * Incremental parser: feed it the full (grow-only) log string on every call
 * and it only parses lines appended since the previous call. Falls back to a
 * full reparse when the input is not an extension of what it already saw.
 * Only complete (newline-terminated) lines are consumed, so a partial trailing
 * line is parsed once, when it completes.
 */
export function createBuildkitParser() {
	let state: ParserState = { stepMap: new Map(), messages: [], order: 0 };
	let committedRaw = '';

	return function parse(rawInput: string | null | undefined): ParsedBuildLogs {
		if (!rawInput) {
			state = { stepMap: new Map(), messages: [], order: 0 };
			committedRaw = '';
			return { steps: [], messages: [] };
		}
		// Treat an unterminated final line as complete. If that line later grows,
		// the prefix check fails and we fall back to one full reparse: rare with
		// line-buffered build logs, and always correct.
		const raw = rawInput.endsWith('\n') ? rawInput : `${rawInput}\n`;
		if (!raw.startsWith(committedRaw)) {
			state = { stepMap: new Map(), messages: [], order: 0 };
			committedRaw = '';
		}
		const suffix = raw.slice(committedRaw.length);
		const lastNl = suffix.lastIndexOf('\n');
		if (lastNl >= 0) {
			const complete = suffix.slice(0, lastNl + 1);
			for (const line of complete.split('\n')) {
				if (line.trim()) parseLineInto(state, line);
			}
			committedRaw += complete;
		}
		return {
			steps: Array.from(state.stepMap.values()).sort((a, b) => a.order - b.order),
			messages: state.messages
		};
	};
}

export function parseBuildkitLogs(raw: string | null | undefined): ParsedBuildLogs {
	const state: ParserState = { stepMap: new Map(), messages: [], order: 0 };
	if (!raw) return { steps: [], messages: [] };
	for (const line of raw.split('\n')) {
		if (line.trim()) parseLineInto(state, line);
	}
	return {
		steps: Array.from(state.stepMap.values()).sort((a, b) => a.order - b.order),
		messages: state.messages
	};
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '';
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}m ${s}s`;
}

export function formatTimestamp(ms: number | null): string {
	if (!ms) return '';
	const d = new Date(ms);
	return `${d.toISOString().replace('T', ' ').slice(0, 23)}Z`;
}

export function buildSummary(parsed: ParsedBuildLogs): {
	total: number;
	cached: number;
	done: number;
	running: number;
	error: number;
} {
	const s = { total: parsed.steps.length, cached: 0, done: 0, running: 0, error: 0 };
	for (const step of parsed.steps) {
		if (step.status === 'cached') s.cached++;
		else if (step.status === 'done') s.done++;
		else if (step.status === 'running') s.running++;
		else if (step.status === 'error') s.error++;
	}
	return s;
}
