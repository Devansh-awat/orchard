import { browser } from '$app/environment';

export type LogClock = 'system' | '12' | '24';
export type LogZone = 'local' | 'utc';
export type LogDate = 'auto' | 'always' | 'never';

export interface LogDisplay {
	clock: LogClock;
	zone: LogZone;
	date: LogDate;
	milliseconds: boolean;
}

const KEY = 'log-display';

const DEFAULTS: LogDisplay = {
	clock: 'system',
	zone: 'local',
	date: 'auto',
	milliseconds: true
};

function load(): LogDisplay {
	if (!browser) return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return { ...DEFAULTS };
		const saved = JSON.parse(raw) as Partial<LogDisplay>;
		return {
			clock: saved.clock === '12' || saved.clock === '24' ? saved.clock : DEFAULTS.clock,
			zone: saved.zone === 'utc' ? 'utc' : DEFAULTS.zone,
			date: saved.date === 'always' || saved.date === 'never' ? saved.date : DEFAULTS.date,
			milliseconds:
				typeof saved.milliseconds === 'boolean' ? saved.milliseconds : DEFAULTS.milliseconds
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export const logDisplay = $state<LogDisplay>(load());

export function setLogDisplay<K extends keyof LogDisplay>(key: K, value: LogDisplay[K]) {
	logDisplay[key] = value;
	if (!browser) return;
	try {
		localStorage.setItem(KEY, JSON.stringify(logDisplay));
	} catch {}
}

export function resetLogDisplay() {
	for (const key of Object.keys(DEFAULTS) as (keyof LogDisplay)[]) {
		setLogDisplay(key, DEFAULTS[key]);
	}
}

export function isLogDisplayDefault(): boolean {
	return (Object.keys(DEFAULTS) as (keyof LogDisplay)[]).every(
		(key) => logDisplay[key] === DEFAULTS[key]
	);
}

export function logDisplaySignature(): string {
	return `${logDisplay.clock}|${logDisplay.zone}|${logDisplay.date}|${logDisplay.milliseconds}`;
}

export function clockOptions(): Intl.DateTimeFormatOptions {
	if (logDisplay.clock === '24') return { hourCycle: 'h23' };
	if (logDisplay.clock === '12') return { hour12: true };
	return {};
}
