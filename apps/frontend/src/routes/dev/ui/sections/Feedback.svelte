<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { toasts } from '$lib/stores';
	import type { ToastInput, ToastPosition } from '$lib/stores/toast';

	const POSITIONS: ToastPosition[] = [
		'top-left',
		'top-center',
		'top-right',
		'bottom-left',
		'bottom-center',
		'bottom-right'
	];
	let toastPos = $state<ToastPosition>('bottom-right');

	function fire(toast: Omit<ToastInput, 'position'>) {
		toasts.add({ ...toast, position: toastPos });
	}

	function fakeDeploy() {
		toasts.promise(new Promise((r) => setTimeout(r, 2200)), {
			loading: 'Deploying web',
			success: 'web is live',
			error: 'Deploy failed',
			description: 'hackclub-site.orchard.my now serves 4f2a9c1.',
			position: toastPos
		});
	}
</script>

<SectionCard title="Feedback">
	<div class="flex flex-col gap-3">
		<Select size="sm" bind:value={toastPos} aria-label="Toast position">
			{#each POSITIONS as pos (pos)}<option value={pos}>{pos}</option>{/each}
		</Select>
		<div class="flex flex-wrap gap-2">
			<Button size="sm" onclick={() => fire({ title: 'Changes saved', color: 'success' })}
				>Success</Button
			>
			<Button
				size="sm"
				onclick={() =>
					fire({
						title: 'Build failed',
						description: 'worker exited with code 137 while installing dependencies.',
						color: 'error'
					})}>Error</Button
			>
			<Button
				size="sm"
				onclick={() =>
					fire({
						title: 'Memory is running low',
						description: 'api has used 92% of its 512 MB limit for 10 minutes.',
						color: 'warning'
					})}>Warning</Button
			>
			<Button size="sm" onclick={() => fire({ title: 'Domain verified', color: 'info' })}
				>Info</Button
			>
			<Button
				size="sm"
				onclick={() =>
					fire({
						title: 'Preview is ready',
						description: 'feat/sponsors deployed to its own URL.',
						color: 'info',
						action: { label: 'Open preview', onClick: () => {} }
					})}>Action</Button
			>
			<Button size="sm" onclick={fakeDeploy}>Promise</Button>
		</div>
		<Alert tone="warning" title="Memory is close to the limit"
			>worker has used 92% of 512 MB for 10 minutes.</Alert
		>
		<Alert tone="error" title="Build failed">
			Dependency install exited with code 1.
			{#snippet actions()}<Button size="sm">View logs</Button>{/snippet}
		</Alert>
		<div class="flex items-center gap-3 text-muted">
			<Spinner />
			<Spinner size={20} />
			<Skeleton width="8rem" height="0.75rem" />
		</div>
	</div>
</SectionCard>
