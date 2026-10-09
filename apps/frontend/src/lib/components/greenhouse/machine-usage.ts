import type { SandboxRunnerId, SandboxStatus } from '$lib/types/sandbox';
import { runnerLabel } from './format';

export const USAGE_POLL_MS = 10_000;
export const NEAR_LIMIT = 0.85;
export const AT_LIMIT = 0.97;
export const COUNTDOWN_MS = 10 * 60_000;

type Count = number | null;

export interface UsageDisk {
	usedBytes: Count;
	capacityBytes: Count;
}

export interface MachineUsage {
	runner: SandboxRunnerId;
	status: SandboxStatus;
	startedAt: string | null;
	uptimeSeconds: Count;
	lastActiveAt: string | null;
	idleTimeoutMinutes: Count;
	stopsAt: string | null;
	maxLifetimeHours: Count;
	lifetimeEndsAt: string | null;
	machines: { count: number; limit: number | null } | null;
	kubernetes: {
		cpu: { usedMillicores: Count; limitMillicores: Count; requestMillicores: Count };
		memory: { usedBytes: Count; limitBytes: Count };
		disk: UsageDisk;
	} | null;
	vercel: {
		vcpus: Count;
		memoryBytes: Count;
		cpu?: { usedCores: Count; totalCores: Count };
		memory?: { usedBytes: Count; totalBytes: Count };
		sessionExpiresAt: string | null;
		sessionTimeoutMinutes: Count;
		activeCpuMs: Count;
		totalActiveCpuMs: Count;
		networkIngressBytes: Count;
		networkEgressBytes: Count;
		totalIngressBytes: Count;
		totalEgressBytes: Count;
		disk: UsageDisk;
	} | null;
	fetchedAt: string;
}

export type ResourceKey = 'cpu' | 'memory' | 'disk';
export type UsageLevel = 'near' | 'full';

export interface UsageMeter {
	key: ResourceKey;
	label: string;
	used: string | null;
	total: string;
	unit: string;
	value: string;
	fraction: number | null;
	percent: number | null;
	level: UsageLevel | null;
	caption: string;
}

export interface UsageRuntime {
	up: string | null;
	since: string | null;
	sleep: string;
	sleepDetail: string | null;
	lifetime: string | null;
}

export interface UsageNetwork {
	out: string | null;
	in: string | null;
	summary: string;
	short: string;
	total: string | null;
}

export interface UsageView {
	live: boolean;
	meters: UsageMeter[];
	measured: UsageMeter[];
	time: string[];
	runtime: UsageRuntime;
	network: UsageNetwork | null;
	machines: string | null;
	machinesDetail: string | null;
	footer: string | null;
	limits: string | null;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function trim(n: number, digits: number): string {
	return n.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

function bytesUnit(reference: number): { size: number; unit: string } {
	if (reference >= GB) return { size: GB, unit: 'GB' };
	if (reference >= MB) return { size: MB, unit: 'MB' };
	return { size: 1024, unit: 'KB' };
}

export function formatBytes(bytes: number): string {
	const { size, unit } = bytesUnit(bytes);
	return `${trim(bytes / size, bytes / size >= 10 ? 0 : 1)} ${unit}`;
}

export function span(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	return `${minutes}m`;
}

export function minutesLabel(minutes: number): string {
	if (minutes >= 48 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function countdown(ms: number): string {
	return ms < 60_000 ? 'under a minute' : span(ms);
}

function coreAmount(cores: number): string {
	if (cores === 0) return '0';
	return trim(cores, cores < 0.1 ? 2 : 1);
}

function coreUnit(total: number): string {
	return total === 1 ? 'core' : 'cores';
}

interface Amount {
	used: string | null;
	total: string;
	unit: string;
}

function coresAmount(used: number | null, total: number): Amount {
	return {
		used: used === null ? null : coreAmount(used),
		total: trim(total, 2),
		unit: coreUnit(total)
	};
}

function bytesAmount(used: number | null, total: number): Amount {
	const { size, unit } = bytesUnit(total);
	return {
		used: used === null ? null : trim(used / size, 1),
		total: trim(total / size, 1),
		unit
	};
}

function valid(n: Count): n is number {
	return n !== null && Number.isFinite(n) && n >= 0;
}

function meter(
	key: ResourceKey,
	label: string,
	used: Count,
	total: Count,
	amount: (used: number | null, total: number) => Amount,
	caption: string
): UsageMeter | null {
	if (!valid(total) || total <= 0) return null;
	const measured = valid(used) ? used : null;
	const a = amount(measured, total);
	const fraction = measured === null ? null : Math.min(1, measured / total);
	const level: UsageLevel | null =
		fraction === null
			? null
			: fraction >= AT_LIMIT
				? 'full'
				: fraction >= NEAR_LIMIT
					? 'near'
					: null;
	return {
		key,
		label,
		used: a.used,
		total: a.total,
		unit: a.unit,
		value: a.used === null ? `${a.total} ${a.unit}` : `${a.used} of ${a.total} ${a.unit}`,
		fraction,
		percent: fraction === null ? null : Math.round(fraction * 100),
		level,
		caption
	};
}

function at(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function meters(usage: MachineUsage): UsageMeter[] {
	const runner = runnerLabel(usage.runner);
	const out: (UsageMeter | null)[] = [];
	const k8s = usage.kubernetes;
	if (k8s) {
		const request = k8s.cpu.requestMillicores;
		const reserved = valid(request) && request > 0 ? ` · ${trim(request / 1000, 2)} reserved` : '';
		const cpuUsed = valid(k8s.cpu.usedMillicores) ? k8s.cpu.usedMillicores / 1000 : null;
		const cpuTotal = valid(k8s.cpu.limitMillicores) ? k8s.cpu.limitMillicores / 1000 : null;
		out.push(
			meter('cpu', 'CPU', cpuUsed, cpuTotal, coresAmount, `${runner} limit${reserved}`),
			meter(
				'memory',
				'Memory',
				k8s.memory.usedBytes,
				k8s.memory.limitBytes,
				bytesAmount,
				`${runner} limit`
			),
			meter('disk', 'Disk', k8s.disk.usedBytes, k8s.disk.capacityBytes, bytesAmount, 'Home volume')
		);
	}
	const vercel = usage.vercel;
	if (vercel) {
		const cores = vercel.cpu?.totalCores ?? vercel.vcpus;
		const memory = vercel.memory?.totalBytes ?? vercel.memoryBytes;
		const vcpu = valid(cores) ? `${trim(cores, 2)} vCPU · ` : '';
		const mem = valid(memory) ? `${formatBytes(memory)} · ` : '';
		out.push(
			meter('cpu', 'CPU', vercel.cpu?.usedCores ?? null, cores, coresAmount, `${vcpu}${runner}`),
			meter(
				'memory',
				'Memory',
				vercel.memory?.usedBytes ?? null,
				memory,
				bytesAmount,
				`${mem}${runner}`
			),
			meter(
				'disk',
				'Disk',
				vercel.disk.usedBytes,
				vercel.disk.capacityBytes,
				bytesAmount,
				'Home drive'
			)
		);
	}
	return out.filter((m): m is UsageMeter => m !== null);
}

function clockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function runtime(usage: MachineUsage, now: number): UsageRuntime {
	const started = at(usage.startedAt);
	const idle =
		valid(usage.idleTimeoutMinutes) && usage.idleTimeoutMinutes > 0
			? usage.idleTimeoutMinutes
			: null;
	const stops = at(usage.stopsAt);
	let sleep = idle === null ? 'Never sleeps when idle' : `Sleeps after ${minutesLabel(idle)} idle`;
	let sleepDetail: string | null = null;
	if (stops !== null) {
		const left = stops - now;
		if (left <= 0) sleep = 'Sleeping soon';
		else if (left < COUNTDOWN_MS) sleep = `Sleeps in ${countdown(left)}`;
		const lastActive = at(usage.lastActiveAt);
		if (lastActive !== null) sleepDetail = `Last active ${span(Math.max(0, now - lastActive))} ago`;
	}
	const hours =
		valid(usage.maxLifetimeHours) && usage.maxLifetimeHours > 0 ? usage.maxLifetimeHours : null;
	const ends = at(usage.lifetimeEndsAt);
	const left =
		usage.status === 'running' && ends !== null && ends > now
			? `, stops in ${span(ends - now)}`
			: '';
	return {
		up: started === null ? null : `Up ${span(now - started)}`,
		since: started === null ? null : `Since ${clockTime(started)}`,
		sleep,
		sleepDetail,
		lifetime: hours === null ? null : `Runs at most ${minutesLabel(hours * 60)}${left}`
	};
}

function network(usage: MachineUsage): UsageNetwork | null {
	const v = usage.vercel;
	if (!v) return null;
	const out = valid(v.networkEgressBytes) ? formatBytes(v.networkEgressBytes) : null;
	const inn = valid(v.networkIngressBytes) ? formatBytes(v.networkIngressBytes) : null;
	if (out === null && inn === null) return null;
	const parts = [out === null ? null : `${out} out`, inn === null ? null : `${inn} in`];
	const totalOut = valid(v.totalEgressBytes) ? formatBytes(v.totalEgressBytes) : null;
	const totalIn = valid(v.totalIngressBytes) ? formatBytes(v.totalIngressBytes) : null;
	const total =
		totalOut === null && totalIn === null
			? null
			: `${[totalOut && `${totalOut} out`, totalIn && `${totalIn} in`].filter(Boolean).join(' · ')} all time`;
	return {
		out,
		in: inn,
		summary: parts.filter(Boolean).join(' · '),
		short: (parts[0] ?? parts[1]) as string,
		total
	};
}

function machinesDetail(usage: MachineUsage): string | null {
	if (!usage.machines) return null;
	const { count, limit } = usage.machines;
	if (limit === null) return 'No machine limit';
	if (count >= limit) return 'At the machine limit';
	const room = limit - count;
	return `Room for ${room} more`;
}

function machinesLabel(usage: MachineUsage, owner: boolean): string | null {
	if (!usage.machines) return null;
	const { count, limit } = usage.machines;
	const noun = (limit ?? count) === 1 ? 'machine' : 'machines';
	const amount = limit === null ? `${count} ${noun}` : `${count} of ${limit} ${noun}`;
	return owner ? amount : `Host has ${amount}`;
}

function unmeasured(m: UsageMeter): UsageMeter {
	return {
		...m,
		used: null,
		value: `${m.total} ${m.unit}`,
		fraction: null,
		percent: null,
		level: null
	};
}

export function usageView(usage: MachineUsage, now: number, owner: boolean): UsageView {
	const all = meters(usage);
	const live = usage.status === 'running';
	const measured = live ? all.filter((m) => m.fraction !== null) : [];
	const rt = runtime(usage, now);
	const time: string[] = [];
	if (live) {
		if (rt.up) time.push(rt.up);
		time.push(rt.sleep);
		const ends = at(usage.lifetimeEndsAt);
		if (ends !== null && ends > now && ends - now < 3600_000) {
			time.push(`Lifetime ends in ${countdown(ends - now)}`);
		}
	}
	const limits = all.length
		? all
				.map((m) => `${m.total} ${m.unit}${m.key === 'cpu' ? '' : ` ${m.label.toLowerCase()}`}`)
				.join(' · ')
		: null;
	const net = live ? network(usage) : null;
	const machines = machinesLabel(usage, owner);
	return {
		live,
		meters: live ? all : all.map(unmeasured),
		measured,
		time,
		runtime: rt,
		network: net,
		machines,
		machinesDetail: machinesDetail(usage),
		footer: [machines, net?.short].filter(Boolean).join(' · ') || null,
		limits
	};
}
