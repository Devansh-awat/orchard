export type RailStepStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface RailStep {
	id: string;
	label: string;
	done?: boolean;
	skipped?: boolean;
	status?: RailStepStatus;
	detail?: string;
	durationMs?: number | null;
}

export function railStatus(step: RailStep, current?: string): RailStepStatus {
	if (step.status) return step.status;
	if (step.done) return 'done';
	if (step.skipped) return 'skipped';
	if (current && step.id === current) return 'running';
	return 'queued';
}

export function formatStepDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const m = Math.floor(s / 60);
	const rest = Math.round(s % 60);
	return `${m}m ${String(rest).padStart(2, '0')}s`;
}
