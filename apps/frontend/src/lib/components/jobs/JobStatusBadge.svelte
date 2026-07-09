<script lang="ts" module>
	import type { RunStatus } from '$lib/types/jobs';

	export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
		pending: 'Queued',
		running: 'Running',
		succeeded: 'Succeeded',
		failed: 'Failed',
		canceled: 'Canceled',
		skipped: 'Skipped',
		timed_out: 'Timed out'
	};

	export function runBadgeTone(
		status: RunStatus
	): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
		if (status === 'succeeded') return 'success';
		if (status === 'failed' || status === 'timed_out') return 'error';
		if (status === 'running') return 'info';
		return 'neutral';
	}

	export function runPillTone(status: RunStatus): 'online' | 'warn' | 'error' | 'muted' {
		if (status === 'succeeded') return 'online';
		if (status === 'failed' || status === 'timed_out') return 'error';
		if (status === 'running') return 'warn';
		return 'muted';
	}
</script>

<script lang="ts">
	import { Badge } from '$lib/components/ui';

	let { status }: { status: RunStatus } = $props();
</script>

<Badge tone={runBadgeTone(status)}>
	<span class="job-status-dot" class:job-status-dot--pulse={status === 'running'}></span>
	{RUN_STATUS_LABELS[status]}
</Badge>
