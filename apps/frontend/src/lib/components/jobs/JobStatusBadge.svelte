<script lang="ts">
	import type { RunStatus } from '$lib/types/jobs';
	import { StatusBadge, runStatus } from '$lib/components/ui';

	let { status }: { status: RunStatus } = $props();
</script>

<StatusBadge meta={runStatus(status)} />
