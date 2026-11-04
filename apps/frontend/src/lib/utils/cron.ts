const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FIELD_RANGES: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7]
];

function validField(field: string, min: number, max: number): boolean {
	for (const part of field.split(',')) {
		const [rangePart, stepPart] = part.split('/');
		if (stepPart !== undefined && !/^\d+$/.test(stepPart)) return false;
		if (rangePart === '*') continue;
		const m = rangePart.match(/^(\d+)(?:-(\d+))?$/);
		if (!m) return false;
		const lo = parseInt(m[1], 10);
		const hi = m[2] ? parseInt(m[2], 10) : lo;
		if (lo < min || hi > max || lo > hi) return false;
	}
	return true;
}

export function validateCron(expr: string): string | null {
	const trimmed = expr.trim();
	if (!trimmed) return 'Enter a cron expression';
	if (trimmed.startsWith('@')) return "Macros like @daily aren't supported. Use 5 fields.";
	const fields = trimmed.split(/\s+/);
	if (fields.length !== 5) {
		return 'Use exactly 5 fields: minute hour day-of-month month day-of-week';
	}
	for (let i = 0; i < 5; i += 1) {
		const [min, max] = FIELD_RANGES[i];
		if (!validField(fields[i], min, max)) {
			return `Field ${i + 1} ("${fields[i]}") is invalid`;
		}
	}
	return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function timeOf(minute: string, hour: string): string | null {
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
	return `${pad(parseInt(hour, 10))}:${pad(parseInt(minute, 10))}`;
}

function dayList(field: string): string | null {
	const days = field.split(',').map((d) => {
		if (!/^\d+$/.test(d)) return null;
		const idx = parseInt(d, 10) % 7;
		return DAY_NAMES[idx];
	});
	if (days.some((d) => d === null)) return null;
	return (days as string[]).join(', ');
}

export function describeCron(expr: string, timeZone?: string | null): string {
	const tz = timeZone || 'UTC';
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return `Custom schedule: ${expr}`;
	const [min, hour, dom, month, dow] = fields;

	if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		const n = parseInt(min.slice(2), 10);
		if (n === 1) return 'Every minute';
		return `Every ${n} minutes`;
	}
	if (/^\d+$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return parseInt(min, 10) === 0 ? 'Every hour' : `Every hour at :${pad(parseInt(min, 10))}`;
	}
	if (hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*' && /^\d+$/.test(min)) {
		return `Every ${parseInt(hour.slice(2), 10)} hours at :${pad(parseInt(min, 10))}`;
	}

	const time = timeOf(min, hour);
	if (time && dom === '*' && month === '*' && dow === '*') {
		return `Every day at ${time} ${tz}`;
	}
	if (time && dom === '*' && month === '*' && dow !== '*') {
		const days = dayList(dow);
		if (days) return `Every ${days} at ${time} ${tz}`;
	}
	if (time && /^\d+$/.test(dom) && month === '*' && dow === '*') {
		const d = parseInt(dom, 10);
		let suffix = 'th';
		if (d === 1 || d === 21 || d === 31) suffix = 'st';
		else if (d === 2 || d === 22) suffix = 'nd';
		else if (d === 3 || d === 23) suffix = 'rd';
		return `Monthly on the ${d}${suffix} at ${time} ${tz}`;
	}
	if (time && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === '*') {
		return `Yearly on ${MONTH_NAMES[parseInt(month, 10) - 1]} ${parseInt(dom, 10)} at ${time} ${tz}`;
	}
	return `Custom schedule: ${expr}`;
}

export const CRON_PRESETS = [
	{ value: '*/15 * * * *', label: 'Every 15 minutes' },
	{ value: '0 * * * *', label: 'Every hour' },
	{ value: '0 2 * * *', label: 'Daily at 02:00' },
	{ value: '0 2 * * 0', label: 'Weekly (Sunday 02:00)' },
	{ value: '0 2 1 * *', label: 'Monthly (1st, 02:00)' }
];
