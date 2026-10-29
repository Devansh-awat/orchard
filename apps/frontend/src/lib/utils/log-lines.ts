export type ToHtml = (line: string) => string | undefined;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
	key: string;
	html: string;
	text?: string;
	ts?: number | null;
	source?: string | null;
	level?: LogLevel;
	detail?: string[];
	lineNo?: number;
}

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&#x27;': "'",
	'&nbsp;': ' '
};

// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const BUILD_PREFIX_RE = /^\[(\d{10,13})\]\s*(?:\[(INFO|ERROR|WARNING)\]\s?)?/;
const ERROR_RE =
	/(^|[\s[(|:])(fatal|panic|error|err|crit|critical|emerg)([\s\]):|=]|$)|\b(exception|traceback|uncaught|unhandled)\b/i;
const WARN_RE = /(^|[\s[(|:])(warn|warning)([\s\]):|=]|$)/i;
const DEBUG_RE = /(^|[\s[(|:])(debug|trace|dbg)([\s\]):|=]|$)/i;
const STEP_HEADER_RE = /^#([0-9a-f]{8}|\d+)\s+\[([^\]]+)\]\s*(.*)$/;
const STEP_ERROR_RE = /^#([0-9a-f]{8}|\d+)\s+ERROR\b/;
const STEP_ANY_RE = /^#([0-9a-f]{8}|\d+)\s/;
const PUSH_RE =
	/^\[pusher\]|^(Getting image source signatures|Copying blob\b|Copying config\b|Writing manifest|Storing signatures|Skipping fetch of repeat blob)/i;

export function escapeLine(line: string): string | undefined {
	const plain = line.replace(ANSI_RE, '');
	if (!plain.trim()) return undefined;
	return plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlToText(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m]);
}

export function leadingTime(text: string): number | null {
	const m = ISO_RE.exec(text.slice(0, 64));
	if (!m) return null;
	const t = Date.parse(m[0].replace(' ', 'T'));
	return Number.isFinite(t) ? t : null;
}

export function guessLevel(text: string): LogLevel | undefined {
	const head = text.slice(0, 160);
	if (ERROR_RE.test(head)) return 'error';
	if (WARN_RE.test(head)) return 'warn';
	if (DEBUG_RE.test(head)) return 'debug';
	return undefined;
}

function keyed(lines: Omit<LogLine, 'key'>[]): LogLine[] {
	const seen = new Map<string, number>();
	return lines.map((line) => {
		const base = `${line.ts ?? ''}|${line.html}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return { ...line, key: n ? `${base}#${n}` : base };
	});
}

export function textLogLines(text: string, toHtml: ToHtml = escapeLine): LogLine[] {
	if (!text) return [];
	const out: Omit<LogLine, 'key'>[] = [];
	for (const raw of text.replace(/\r/g, '').split('\n')) {
		const html = toHtml(raw);
		if (!html) continue;
		const plain = raw.replace(ANSI_RE, '');
		out.push({ html, text: htmlToText(html), ts: leadingTime(plain) });
	}
	return keyed(out);
}

function stepLabel(stage: string, command: string) {
	const cmd = command.replace(/\s+/g, ' ').trim();
	const short = cmd.length > 42 ? `${cmd.slice(0, 41)}…` : cmd;
	return `[${stage}] ${short}`.trim();
}

export function buildLogLines(
	raw: string | null | undefined,
	toHtml: ToHtml = escapeLine
): LogLine[] {
	if (!raw) return [];
	const steps = new Map<string, string>();
	const out: Omit<LogLine, 'key'>[] = [];
	for (const line of raw.replace(/\r/g, '').split('\n')) {
		if (!line.trim()) continue;
		const prefix = BUILD_PREFIX_RE.exec(line);
		const rest = prefix ? line.slice(prefix[0].length) : line;
		const plain = rest.replace(ANSI_RE, '');
		if (!plain.trim()) continue;
		const stamp = prefix ? Number(prefix[1]) : null;
		const ts = stamp == null ? leadingTime(plain) : stamp < 1e12 ? stamp * 1000 : stamp;
		let source = 'Orchard';
		const header = STEP_HEADER_RE.exec(plain);
		const step = STEP_ANY_RE.exec(plain);
		if (header) {
			source = stepLabel(header[2], header[3]);
			steps.set(header[1], source);
		} else if (step) {
			source = steps.get(step[1]) ?? `#${step[1]}`;
		} else if (PUSH_RE.test(plain)) {
			source = 'Push';
		}
		const level: LogLevel | undefined =
			prefix?.[2] === 'ERROR' || STEP_ERROR_RE.test(plain)
				? 'error'
				: prefix?.[2] === 'WARNING'
					? 'warn'
					: guessLevel(plain);
		const shown =
			ts != null && !ISO_RE.test(plain.slice(0, 40))
				? `${new Date(ts).toISOString()} ${rest}`
				: rest;
		const html = toHtml(shown) ?? '';
		if (!html) continue;
		out.push({ html, text: htmlToText(html), ts, source, level });
	}
	return keyed(out);
}

export function lineText(line: LogLine): string {
	return line.text ?? htmlToText(line.html);
}

export function lineLevel(line: LogLine): LogLevel | undefined {
	return line.level ?? guessLevel(lineText(line));
}

export function withTimes(lines: LogLine[]): (number | null)[] {
	let last: number | null = null;
	return lines.map((l) => {
		if (l.ts != null) last = l.ts;
		return last;
	});
}
