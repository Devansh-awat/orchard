export interface TextEdit {
	index: number;
	remove: number;
	insert: string;
}

const MAX_LINES = 50_000;
const MAX_COST = 4_000;

function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			lines.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) lines.push(text.slice(start));
	return lines;
}

function commonPrefix(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i > 0 && i < max && isLowSurrogate(a.charCodeAt(i))) i--;
	return i;
}

function commonSuffix(a: string, b: string, prefix: number): number {
	const max = Math.min(a.length, b.length) - prefix;
	let i = 0;
	while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
	if (i > 0 && i < max && isLowSurrogate(a.charCodeAt(a.length - i))) i--;
	return i;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function refine(a: string, b: string, offset: number): TextEdit | null {
	if (a === b) return null;
	const prefix = commonPrefix(a, b);
	const suffix = commonSuffix(a, b, prefix);
	return {
		index: offset + prefix,
		remove: a.length - prefix - suffix,
		insert: b.slice(prefix, b.length - suffix)
	};
}

type Run = { kind: 'equal' | 'change'; a: number; aEnd: number; b: number; bEnd: number };

function lineRuns(a: string[], b: string[]): Run[] | null {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	if (max === 0) return [];
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= Math.min(max, MAX_COST); d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
					? v[offset + k + 1]
					: v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		if (found >= 0) break;
	}
	if (found < 0) return null;
	const steps: Array<'equal' | 'delete' | 'insert'> = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d];
		const k = x - y;
		const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
		const prevK = down ? k + 1 : k - 1;
		const prevX = prev[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			steps.push('equal');
			x--;
			y--;
		}
		steps.push(down ? 'insert' : 'delete');
		if (down) y--;
		else x--;
	}
	while (x > 0 && y > 0) {
		steps.push('equal');
		x--;
		y--;
	}
	steps.reverse();
	const runs: Run[] = [];
	let ai = 0;
	let bi = 0;
	for (const step of steps) {
		const kind = step === 'equal' ? 'equal' : 'change';
		const last = runs[runs.length - 1];
		if (!last || last.kind !== kind) runs.push({ kind, a: ai, aEnd: ai, b: bi, bEnd: bi });
		const run = runs[runs.length - 1];
		if (step !== 'insert') {
			ai++;
			run.aEnd = ai;
		}
		if (step !== 'delete') {
			bi++;
			run.bEnd = bi;
		}
	}
	return runs;
}

export function diffText(a: string, b: string): TextEdit[] {
	if (a === b) return [];
	const prefix = commonPrefix(a, b);
	const suffix = commonSuffix(a, b, prefix);
	const midA = a.slice(prefix, a.length - suffix);
	const midB = b.slice(prefix, b.length - suffix);
	const linesA = splitLines(midA);
	const linesB = splitLines(midB);
	const runs =
		linesA.length + linesB.length > MAX_LINES || linesA.length === 0 || linesB.length === 0
			? null
			: lineRuns(linesA, linesB);
	if (!runs) {
		const whole = refine(midA, midB, prefix);
		return whole ? [whole] : [];
	}
	const edits: TextEdit[] = [];
	let posA = prefix;
	const startA: number[] = [];
	for (const line of linesA) {
		startA.push(posA);
		posA += line.length;
	}
	startA.push(posA);
	for (const run of runs) {
		if (run.kind !== 'change') continue;
		const from = linesA.slice(run.a, run.aEnd).join('');
		const to = linesB.slice(run.b, run.bEnd).join('');
		const edit = refine(from, to, startA[run.a]);
		if (edit) edits.push(edit);
	}
	return edits;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
	let out = '';
	let cursor = 0;
	for (const edit of [...edits].sort((x, y) => x.index - y.index)) {
		out += text.slice(cursor, edit.index) + edit.insert;
		cursor = edit.index + edit.remove;
	}
	return out + text.slice(cursor);
}

function touches(x: TextEdit, y: TextEdit): boolean {
	return x.index <= y.index + y.remove && y.index <= x.index + x.remove;
}

export function mergeText(base: string, ours: string, theirs: string): string {
	if (ours === theirs || theirs === base) return ours;
	if (ours === base) return theirs;
	const mine = diffText(base, ours);
	const other = diffText(base, theirs).filter((edit) => !mine.some((m) => touches(m, edit)));
	return applyEdits(base, [...mine, ...other]);
}
