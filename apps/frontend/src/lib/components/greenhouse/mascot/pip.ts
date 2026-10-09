export type PipPose = 'idle' | 'wave' | 'thinking' | 'happy' | 'sleep';

export const GRID = 18;

type Eyes = 'open' | 'blink' | 'shut' | 'happy' | 'look';
type Arm = 'down' | 'up' | 'out' | 'both';

export interface Frame {
	bob: 0 | 1;
	eyes: Eyes;
	arm: Arm;
	spark: 0 | 1 | 2;
	dots: 0 | 1 | 2 | 3;
	z: 0 | 1 | 2 | 3;
}

export interface Run {
	x: number;
	y: number;
	w: number;
	cell: string;
}

class Canvas {
	cells: string[][] = Array.from({ length: GRID }, () => Array<string>(GRID).fill('.'));

	put(x: number, y: number, cell: string) {
		if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
		this.cells[y][x] = cell;
	}

	art(x: number, y: number, lines: readonly string[]) {
		lines.forEach((line, dy) => {
			for (let dx = 0; dx < line.length; dx++) {
				if (line[dx] !== '.') this.put(x + dx, y + dy, line[dx]);
			}
		});
	}

	runs(): Run[] {
		const out: Run[] = [];
		this.cells.forEach((row, y) => {
			let x = 0;
			while (x < GRID) {
				const cell = row[x];
				let w = 1;
				while (x + w < GRID && row[x + w] === cell) w++;
				if (cell !== '.') out.push({ x, y, w, cell });
				x += w;
			}
		});
		return out;
	}
}

function sparkle(c: Canvas, x: number, y: number, phase: 0 | 1 | 2) {
	if (phase === 0) return;
	if (phase === 1) {
		c.put(x, y, 'Y');
		return;
	}
	c.art(x - 1, y - 1, ['.Y.', 'YYY', '.Y.']);
}

function thinkingDots(c: Canvas, x: number, y: number, count: number) {
	for (let i = 0; i < 3; i++) if (i < count) c.put(x + i * 2, y, 'Y');
}

function arms(c: Canvas, f: Frame, left: number, right: number, y: number) {
	if (f.arm === 'both') {
		c.art(left, y - 3, ['B', 'B', 'B']);
		c.art(right, y - 3, ['B', 'B', 'B']);
		return;
	}
	c.art(left, y, ['B', 'B']);
	if (f.arm === 'up') c.art(right, y - 3, ['.B', 'B.', 'B.']);
	else if (f.arm === 'out') c.art(right, y - 1, ['.B', 'BB']);
	else c.art(right, y, ['B', 'B']);
}

const PIP_BODY = [
	'....BBBB....',
	'..BBBBBBBB..',
	'.BLBBBBBBBB.',
	'.LBBWWWWBBB.',
	'BBBWWWWWWBBB',
	'BBBWWWWWWBBB',
	'BBBWWWWWWBBB',
	'BBBWWWWWWBBB',
	'.BBBWWWWBBB.',
	'.BBBBBBBBBD.',
	'..BBBBBBDD..',
	'....DDDD....'
];

function pip(f: Frame): Run[] {
	const c = new Canvas();
	const ox = 3;
	const oy = 4 - f.bob;
	const glow = f.spark === 2 || f.dots > 0;
	c.art(ox + 6, oy - 3, [glow ? 'YY' : 'LL', 'D.', 'D.']);
	c.art(ox, oy, PIP_BODY);
	c.art(ox + 3, 16 - f.bob, f.bob ? ['DD..DD', 'DD..DD'] : ['DD..DD']);

	const ey = oy + 5;
	if (f.eyes === 'blink') {
		c.art(ox + 4, ey + 1, ['E..E']);
		c.art(ox + 3, ey + 2, ['C....C']);
	} else if (f.eyes === 'shut') {
		c.art(ox + 3, ey + 1, ['EE..EE']);
		c.art(ox + 3, ey + 2, ['C....C']);
	} else if (f.eyes === 'happy') {
		c.art(ox + 3, ey, ['.E..E.', 'E....E', '..EE..']);
	} else if (f.eyes === 'look') {
		c.art(ox + 5, ey - 1, ['E..E', 'E..E']);
		c.art(ox + 3, ey + 2, ['C....C']);
	} else {
		c.art(ox + 4, ey, ['E..E', 'E..E']);
		c.art(ox + 3, ey + 2, ['C....C']);
	}

	arms(c, f, ox - 1, ox + 12, oy + 6);
	if (f.z > 0) c.art(14, 4 - f.z, ['LLLL', '..L.', '.L..', 'LLLL']);
	if (f.dots > 0) thinkingDots(c, 13, 1, f.dots);
	else sparkle(c, 16, 2, f.spark);
	return c.runs();
}

const base: Frame = { bob: 0, eyes: 'open', arm: 'down', spark: 0, dots: 0, z: 0 };

function seq(length: number, at: (i: number) => Partial<Frame>): Frame[] {
	return Array.from({ length }, (_, i) => ({ ...base, ...at(i) }));
}

const breathe = (i: number) => (Math.floor(i / 3) % 2) as 0 | 1;

export const POSES: Record<PipPose, Frame[]> = {
	idle: seq(24, (i) => ({ bob: breathe(i), eyes: i === 17 ? 'blink' : 'open' })),
	wave: seq(16, (i) => ({
		bob: breathe(i),
		arm: Math.floor(i / 2) % 2 ? 'out' : 'up',
		eyes: i === 11 ? 'blink' : 'open'
	})),
	thinking: seq(16, (i) => ({
		eyes: i === 13 ? 'blink' : 'look',
		dots: ((Math.floor(i / 2) % 4) as 0 | 1 | 2 | 3) || 0,
		spark: Math.floor(i / 2) % 4 === 3 ? 2 : 0
	})),
	sleep: seq(24, (i) => ({
		bob: (Math.floor(i / 6) % 2) as 0 | 1,
		eyes: 'shut',
		z: ((Math.floor(i / 4) % 3) + 1) as 1 | 2 | 3
	})),
	happy: seq(8, (i) => ({
		bob: (i % 2) as 0 | 1,
		eyes: 'happy',
		arm: 'both',
		spark: ([2, 1, 0, 1] as const)[i % 4]
	}))
};

export const REST: Record<PipPose, Frame> = {
	idle: { ...base },
	wave: { ...base, arm: 'up' },
	thinking: { ...base, eyes: 'look', dots: 3 },
	happy: { ...base, eyes: 'happy', arm: 'both', spark: 2 },
	sleep: { ...base, eyes: 'shut', z: 2 }
};

export const TICK_MS = 200;

export function draw(frame: Frame): Run[] {
	return pip(frame);
}
