<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { toasts } from '$lib/stores';
	import Verdict from './Verdict.svelte';
	import { Check } from 'lucide-svelte';
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
		<Dropdown
			size="sm"
			bind:value={toastPos}
			ariaLabel="Toast position"
			options={POSITIONS.map((pos) => ({ value: pos, label: pos }))}
		/>
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

<SectionCard
	title="Toast ink"
	description="A toast title is never coloured. Status lives in the glyph, a solid fill with a white glyph."
>
	<div class="grid grid-cols-2 gap-4">
		<Verdict kind="do" note="Ink title, solid glyph.">
			<span class="pill">
				<span class="dot dot--solid"><Check size={14} strokeWidth={2.5} /></span>
				<span class="ink">Signed in with your email</span>
			</span>
		</Verdict>
		<Verdict kind="dont" note="Status-coloured title on the capsule.">
			<span class="pill">
				<span class="dot dot--tint"><Check size={14} strokeWidth={2.5} /></span>
				<span class="ink ink--tone">Signed in with your email</span>
			</span>
		</Verdict>
	</div>
</SectionCard>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.625rem 1rem 0.625rem 0.625rem;
		border-radius: var(--radius-pill);
		background: var(--toast-fill);
	}
	.dot {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
	}
	.dot--solid {
		background: var(--toast-success);
		color: var(--toast-success-on);
	}
	.dot--tint {
		background: color-mix(in oklab, var(--green-7) 22%, transparent);
		color: var(--green-7);
	}
	.ink {
		font-size: 0.8125rem;
		font-weight: var(--weight-medium);
		color: var(--toast-ink);
	}
	.ink--tone {
		color: color-mix(in oklab, var(--green-7) 74%, black);
	}
</style>
