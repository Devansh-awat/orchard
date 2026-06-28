// Parser for BuildKit `--progress=plain` output. Groups raw log lines by
// their `#N` step id and extracts stage labels, durations, cache hits, and
// per-step output so the UI can render a Depot-style stepped log view.

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

// `#5 [base 1/3] FROM docker.io/…`
const STEP_HEADER_RE = /^#(\d+)\s+\[([^\]]+)\]\s*(.*)$/;
// `#5 DONE 0.4s` / `#5 CACHED` / `#5 ERROR: …` / `#5 CANCELED`
const STEP_DONE_RE = /^#(\d+)\s+DONE\s+([\d.]+)s\s*$/;
const STEP_CACHED_RE = /^#(\d+)\s+CACHED\s*$/;
const STEP_ERROR_RE = /^#(\d+)\s+ERROR:?\s*(.*)$/;
const STEP_CANCELED_RE = /^#(\d+)\s+CANCELED\s*$/;
// Any other `#5 …` substep line
const STEP_SUBLINE_RE = /^#(\d+)\s+(.*)$/;
// `transferring …: 14.30MB done` or `… 1.7kB`
const TRANSFER_RE = /(?:transferring\b[^:]*:\s*|\s)([\d.]+\s?[KMG]?B)(?:\s+done)?\s*$/i;

// Export/push phases emit no `[stage]` header — their first line is the only
// description (e.g. `#36 exporting to oci image format`). Map the known ones
// to friendly labels; anything unrecognized falls back to the raw line.
const HEADERLESS_LABELS: Array<[RegExp, string]> = [
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

function splitStage(stageLabel: string): { stage: string; stagePos: string | null } {
	// "base 1/3" → ("base", "1/3"); "internal" → ("internal", null)
	const m = stageLabel.match(/^(.+?)\s+(\d+\/\d+)\s*$/);
	if (m) return { stage: m[1].trim(), stagePos: m[2] };
	return { stage: stageLabel.trim(), stagePos: null };
}

export function parseBuildkitLogs(raw: string | null | undefined): ParsedBuildLogs {
	const result: ParsedBuildLogs = { steps: [], messages: [] };
	if (!raw) return result;

	const stepMap = new Map<string, BuildStep>();
	let order = 0;

	const lines = raw.split('\n');
	for (const rawLine of lines) {
		if (!rawLine.trim()) continue;
		const { ts, level, rest } = stripPrefix(rawLine);

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
					result.messages.push({ timestamp: ts, level, text: rest });
					continue;
				}
				if (!push) {
					push = {
						id: PUSHER_STEP_ID,
						order: order++,
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
				continue;
			}
			// Non-step line: a status message from appendLog.
			result.messages.push({ timestamp: ts, level, text: rest });
			continue;
		}

		let step = stepMap.get(stepId);
		if (!step) {
			step = {
				id: stepId,
				order: order++,
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
			continue;
		}
		if (doneMatch) {
			step.durationSec = Number(doneMatch[2]);
			if (step.status !== 'error' && step.status !== 'canceled') step.status = 'done';
			continue;
		}
		if (cachedMatch) {
			step.status = 'cached';
			continue;
		}
		if (errorMatch) {
			step.status = 'error';
			step.error = errorMatch[2].trim() || step.error;
			continue;
		}
		if (canceledMatch) {
			step.status = 'canceled';
			continue;
		}
		if (sublineMatch) {
			const body = sublineMatch[2];
			// Headerless steps take their first line as the label instead of
			// rendering as an anonymous "Step #36".
			if (!step.command && !step.stage) {
				step.command = headerlessLabel(body);
				continue;
			}
			// Capture transferred sizes shown next to the stage badge in Depot.
			const tm = body.match(TRANSFER_RE);
			if (tm && !step.transferred) step.transferred = tm[1].replace(/\s+/, ' ');
			step.output.push(body);
		}
	}

	// Promote any step still "running" at end of logs to actual running unless
	// we have a terminal status further down; preserve insertion order.
	result.steps = Array.from(stepMap.values()).sort((a, b) => a.order - b.order);
	return result;
}

export function formatDuration(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return '';
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}m ${s}s`;
}

export function formatTimestamp(ms: number | null): string {
	if (!ms) return '';
	const d = new Date(ms);
	return d.toISOString().replace('T', ' ').slice(0, 23) + 'Z';
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
