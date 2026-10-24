import { formatNumber, tidy } from './calc';

const SMALL = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 });
const LARGE = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });

function readable(v: number) {
	const abs = Math.abs(v);
	if (abs === 0 || abs >= 1e15 || abs < 1e-9) return formatNumber(v);
	return abs < 1 ? SMALL.format(v) : LARGE.format(v);
}

type Dimension = 'bytes' | 'cpu' | 'time';
type Family = 'si' | 'iec';

type Unit = {
	id: string;
	dim: Dimension;
	factor: number;
	label: string;
	one?: string;
	name: string;
	family?: Family;
	aliases: string[];
};

export type Quantity = { value: number; unit: string; name: string; text: string };

export type Conversion = {
	dimension: string;
	from: Quantity;
	to: Quantity;
	copy: string;
};

const KI = 1024;

const UNITS: Unit[] = [
	{ id: 'b', dim: 'bytes', factor: 1, label: 'B', name: 'Bytes', aliases: ['b', 'byte', 'bytes'] },
	{
		id: 'kb',
		dim: 'bytes',
		factor: 1e3,
		label: 'KB',
		name: 'Kilobytes',
		family: 'si',
		aliases: ['kb', 'k', 'kilobyte', 'kilobytes']
	},
	{
		id: 'mb',
		dim: 'bytes',
		factor: 1e6,
		label: 'MB',
		name: 'Megabytes',
		family: 'si',
		aliases: ['mb', 'megabyte', 'megabytes']
	},
	{
		id: 'gb',
		dim: 'bytes',
		factor: 1e9,
		label: 'GB',
		name: 'Gigabytes',
		family: 'si',
		aliases: ['gb', 'g', 'gigabyte', 'gigabytes']
	},
	{
		id: 'tb',
		dim: 'bytes',
		factor: 1e12,
		label: 'TB',
		name: 'Terabytes',
		family: 'si',
		aliases: ['tb', 't', 'terabyte', 'terabytes']
	},
	{
		id: 'kib',
		dim: 'bytes',
		factor: KI,
		label: 'KiB',
		name: 'Kibibytes',
		family: 'iec',
		aliases: ['kib', 'ki', 'kibibyte', 'kibibytes']
	},
	{
		id: 'mib',
		dim: 'bytes',
		factor: KI ** 2,
		label: 'MiB',
		name: 'Mebibytes',
		family: 'iec',
		aliases: ['mib', 'mi', 'mebibyte', 'mebibytes']
	},
	{
		id: 'gib',
		dim: 'bytes',
		factor: KI ** 3,
		label: 'GiB',
		name: 'Gibibytes',
		family: 'iec',
		aliases: ['gib', 'gi', 'gibibyte', 'gibibytes']
	},
	{
		id: 'tib',
		dim: 'bytes',
		factor: KI ** 4,
		label: 'TiB',
		name: 'Tebibytes',
		family: 'iec',
		aliases: ['tib', 'ti', 'tebibyte', 'tebibytes']
	},
	{
		id: 'm',
		dim: 'cpu',
		factor: 1e-3,
		label: 'millicores',
		one: 'millicore',
		name: 'Millicores',
		aliases: ['m', 'mcpu', 'millicore', 'millicores', 'millicpu']
	},
	{
		id: 'core',
		dim: 'cpu',
		factor: 1,
		label: 'cores',
		one: 'core',
		name: 'Cores',
		aliases: ['core', 'cores', 'cpu', 'cpus', 'vcpu', 'vcpus']
	},
	{
		id: 'ms',
		dim: 'time',
		factor: 1e-3,
		label: 'ms',
		name: 'Milliseconds',
		aliases: ['ms', 'msec', 'msecs', 'millisecond', 'milliseconds']
	},
	{
		id: 's',
		dim: 'time',
		factor: 1,
		label: 's',
		name: 'Seconds',
		aliases: ['s', 'sec', 'secs', 'second', 'seconds']
	},
	{
		id: 'min',
		dim: 'time',
		factor: 60,
		label: 'min',
		name: 'Minutes',
		aliases: ['min', 'mins', 'minute', 'minutes']
	},
	{
		id: 'h',
		dim: 'time',
		factor: 3600,
		label: 'h',
		name: 'Hours',
		aliases: ['h', 'hr', 'hrs', 'hour', 'hours']
	},
	{
		id: 'd',
		dim: 'time',
		factor: 86400,
		label: 'd',
		name: 'Days',
		aliases: ['d', 'day', 'days']
	}
];

const BY_ALIAS = new Map(UNITS.flatMap((u) => u.aliases.map((a) => [a, u] as const)));

const DIMENSION_NAMES: Record<Dimension, string> = {
	bytes: 'Memory',
	cpu: 'CPU',
	time: 'Duration'
};

const PATTERN =
	/^\s*(-?(?:\d[\d,_]*\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]+)\s*(?:(?:in|to|as|into|->|→|=)\s*([a-z]+))?\s*$/i;

export function findUnit(alias: string): Unit | undefined {
	return BY_ALIAS.get(alias.toLowerCase());
}

function ladder(unit: Unit): Unit[] {
	return UNITS.filter(
		(u) =>
			u.dim === unit.dim &&
			(unit.dim !== 'bytes' || !u.family || u.family === (unit.family ?? 'iec'))
	).sort((a, b) => a.factor - b.factor);
}

function best(value: number, unit: Unit): Unit {
	const base = value * unit.factor;
	if (unit.dim === 'cpu') return unit.id === 'm' ? findUnit('core')! : findUnit('m')!;
	const steps = ladder(unit);
	const fits = steps.filter((u) => Math.abs(base) / u.factor >= 1);
	const top = fits[fits.length - 1] ?? steps[0];
	if (top !== unit) return top;
	if (unit.dim === 'bytes' && unit.family) {
		const twin = UNITS.find(
			(u) =>
				u.dim === 'bytes' &&
				u.family &&
				u.family !== unit.family &&
				u.id.replace('i', '') === unit.id.replace('i', '')
		);
		if (twin) return twin;
	}
	const i = steps.indexOf(unit);
	return steps[i - 1] ?? steps[i + 1] ?? unit;
}

function quantity(value: number, unit: Unit): Quantity {
	const v = tidy(value);
	const label = unit.one && Math.abs(v) === 1 ? unit.one : unit.label;
	return { value: v, unit: label, name: unit.name, text: `${readable(v)} ${label}` };
}

export function convert(input: string): Conversion | null {
	const match = PATTERN.exec(input);
	if (!match) return null;
	const value = parseFloat(match[1].replace(/[,_]/g, ''));
	if (!Number.isFinite(value)) return null;
	const from = findUnit(match[2]);
	if (!from) return null;
	const to = match[3] ? findUnit(match[3]) : best(value, from);
	if (!to || to.dim !== from.dim || to === from) return null;
	const out = (value * from.factor) / to.factor;
	const result = quantity(out, to);
	return {
		dimension: DIMENSION_NAMES[from.dim],
		from: quantity(value, from),
		to: result,
		copy: String(result.value)
	};
}
