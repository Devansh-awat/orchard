import type { Backup } from './types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isNum = (s: string) => /^\d+$/.test(s);
const pad = (s: string | number) => String(s).padStart(2, '0');
const stepOf = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1] ?? null;

function ordinal(n: number): string {
	const tail = n % 100;
	if (tail >= 11 && tail <= 13) return `${n}th`;
	return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

export function describeCron(cron: string | null | undefined): string | null {
	const parts = (cron ?? '').trim().split(/\s+/).filter(Boolean);
	const fields = parts.length === 6 ? parts.slice(1) : parts;
	if (fields.length !== 5) return null;
	const [min, hour, dom, mon, dow] = fields;
	if (mon !== '*') return null;
	const time = isNum(min) && isNum(hour) ? `${pad(hour)}:${pad(min)} UTC` : null;

	if (dom === '*' && dow === '*') {
		if (time) return `Every day at ${time}`;
		if (isNum(min) && hour === '*')
			return min === '0' ? 'Every hour' : `Every hour at :${pad(min)}`;
		const hours = stepOf(hour);
		if (isNum(min) && hours) {
			const every = hours === '1' ? 'Every hour' : `Every ${hours} hours`;
			return min === '0' ? `${every}, from 00:00 UTC` : `${every}, from 00:${pad(min)} UTC`;
		}
		const minutes = stepOf(min);
		if (minutes && hour === '*') return `Every ${minutes} minutes`;
		return null;
	}
	if (!time) return null;
	if (dom === '*') {
		if (isNum(dow) && Number(dow) <= 7) return `Every ${DAYS[Number(dow) % 7]} at ${time}`;
		if (dow === '1-5') return `Weekdays at ${time}`;
		return null;
	}
	if (dow === '*' && isNum(dom)) return `The ${ordinal(Number(dom))} of every month at ${time}`;
	return null;
}

export function formatWhen(iso: string | null | undefined): string {
	if (!iso) return '';
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return '';
	const sameYear = at.getFullYear() === new Date().getFullYear();
	return at.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
}

export function backupKind(backup: Backup): string | null {
	if (backup.type === 'scheduled' || /^scheduled/i.test(backup.label)) return 'Scheduled';
	if (/^(manual|backup-)/i.test(backup.label)) return 'Manual';
	return null;
}

export function backupSize(backup: Backup): number | null {
	const n = Number(backup.sizeBytes);
	return backup.sizeBytes == null || !Number.isFinite(n) || n <= 0 ? null : n;
}
