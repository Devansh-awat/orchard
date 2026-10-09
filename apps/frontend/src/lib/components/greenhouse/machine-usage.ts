import { apiFetch } from '$lib/stores';
import type { SandboxRunnerId, SandboxStatus } from '$lib/types/sandbox';

export const USAGE_POLL_MS = 10_000;
export const NEAR_LIMIT = 0.85;

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

export async function fetchMachineUsage(sandboxId: string): Promise<MachineUsage | null> {
	try {
		const res = await apiFetch(`/apiv1/sandboxes/${encodeURIComponent(sandboxId)}/usage`);
		return res.ok ? ((await res.json()) as MachineUsage) : null;
	} catch {
		return null;
	}
}

export interface UsageMeter {
	key: string;
	label: string;
	value: string;
	fraction: number;
	near: boolean;
}

export interface UsageView {
	meters: UsageMeter[];
	lines: string[];
	footer: string | null;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function trim(n: number, digits: number): string {
	return n.toFixed(digits).replace(/\.?0+$/, '');
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

export function bytesOf(used: number, total: number): string {
	const { size, unit } = bytesUnit(total);
	return `${trim(used / size, 1)} of ${trim(total / size, 1)} ${unit}`;
}

export function coresOf(usedMilli: number, limitMilli: number): string {
	const limit = limitMilli / 1000;
	return `${trim(usedMilli / 1000, 2)} of ${trim(limit, 2)} ${limit === 1 ? 'core' : 'cores'}`;
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

function meter(
	key: string,
	label: string,
	used: Count,
	total: Count,
	format: (used: number, total: number) => string
): UsageMeter | null {
	if (used === null || total === null || !(total > 0)) return null;
	const fraction = Math.min(1, Math.max(0, used / total));
	return { key, label, value: format(used, total), fraction, near: fraction >= NEAR_LIMIT };
}

function at(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function usageView(usage: MachineUsage, now: number, owner: boolean): UsageView {
	const meters: UsageMeter[] = [];
	const lines: string[] = [];
	const k8s = usage.kubernetes;
	if (k8s) {
		for (const m of [
			meter('cpu', 'CPU', k8s.cpu.usedMillicores, k8s.cpu.limitMillicores, coresOf),
			meter('memory', 'Memory', k8s.memory.usedBytes, k8s.memory.limitBytes, bytesOf),
			meter('disk', 'Disk', k8s.disk.usedBytes, k8s.disk.capacityBytes, bytesOf)
		]) {
			if (m) meters.push(m);
		}
	}
	const vercel = usage.vercel;
	if (vercel) {
		if (vercel.activeCpuMs !== null) {
			lines.push(`${span(vercel.activeCpuMs)} active CPU this session`);
		}
		if (vercel.memoryBytes !== null) {
			const cpus = vercel.vcpus === null ? '' : ` · ${vercel.vcpus} vCPU`;
			lines.push(`${formatBytes(vercel.memoryBytes)} memory${cpus}`);
		}
		if (vercel.networkEgressBytes !== null) {
			lines.push(`${formatBytes(vercel.networkEgressBytes)} network out`);
		}
		const disk = meter('disk', 'Disk', vercel.disk.usedBytes, vercel.disk.capacityBytes, bytesOf);
		if (disk) meters.push(disk);
	}
	const session = at(vercel?.sessionExpiresAt ?? null);
	if (session !== null && session > now) lines.push(`Session ends in ${span(session - now)}`);
	const stops = at(usage.stopsAt);
	if (stops !== null) {
		lines.push(stops > now ? `Stops in ${span(stops - now)} if idle` : 'Stops soon if idle');
	}
	const started = at(usage.startedAt);
	if (started !== null) lines.push(`Running ${span(now - started)}`);
	const lifetime = at(usage.lifetimeEndsAt);
	if (lifetime !== null && lifetime > now && lifetime - now < 24 * 3600_000) {
		lines.push(`Max lifetime ends in ${span(lifetime - now)}`);
	}
	let footer: string | null = null;
	if (usage.machines) {
		const { count, limit } = usage.machines;
		const noun = (limit ?? count) === 1 ? 'machine' : 'machines';
		const amount = limit === null ? `${count} ${noun}` : `${count} of ${limit} ${noun}`;
		footer = owner ? amount : `Host has ${amount}`;
	}
	return { meters, lines, footer };
}
