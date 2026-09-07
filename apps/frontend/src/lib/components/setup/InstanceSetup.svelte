<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Loader2 } from 'lucide-svelte';
	import { user, apiFetch, toasts } from '$lib/stores';
	import { StepRail } from '$lib/components/ui';
	import type { RailStep } from '$lib/components/ui/steprail';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import SetupPasskeyStep from './SetupPasskeyStep.svelte';
	import SetupOrgStep from './SetupOrgStep.svelte';
	import SetupDeployStep from './SetupDeployStep.svelte';

	type ServerStep = { id: string; done: boolean; skipped: boolean; required: boolean };

	const LABELS: Record<string, string> = {
		passkey: 'Your key',
		organization: 'Your org',
		deploy: 'Your first app'
	};

	let loading = $state(true);
	let steps = $state<ServerStep[]>([]);
	let current = $state('passkey');
	let finishing = $state(false);

	const rail = $derived<RailStep[]>(
		steps.map((s) => ({ id: s.id, label: LABELS[s.id] ?? s.id, done: s.done, skipped: s.skipped }))
	);

	function firstUnsettled(list: ServerStep[]): string | null {
		return list.find((s) => !s.done && !s.skipped)?.id ?? null;
	}

	async function load() {
		try {
			const response = await apiFetch('/apiv1/setup/state');
			if (!response.ok) throw new Error('Could not load setup state');
			const data = await response.json();
			steps = data.steps ?? [];
			current = firstUnsettled(steps) ?? steps[steps.length - 1]?.id ?? 'passkey';
			if (data.complete) await finish();
		} catch {
			await finish();
		} finally {
			loading = false;
		}
	}

	async function refresh() {
		const response = await apiFetch('/apiv1/setup/state');
		if (!response.ok) return;
		const data = await response.json();
		steps = data.steps ?? [];
		const next = firstUnsettled(steps);
		if (!next) {
			await finish();
			return;
		}
		current = next;
	}

	async function skip(step: string) {
		const response = await apiFetch('/apiv1/setup/skip', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ step })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			toasts.add({ title: body?.message || 'That step cannot be skipped', color: 'error' });
			return;
		}
		const data = await response.json();
		steps = data.steps ?? steps;
		const next = firstUnsettled(steps);
		if (!next) {
			await finish();
			return;
		}
		current = next;
	}

	async function finish() {
		if (finishing) return;
		finishing = true;
		try {
			const response = await apiFetch('/apiv1/auth/me', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ setupCompleted: true })
			});
			if (response.ok) {
				const updated = await response.json();
				user.set({ ...($user as any), ...updated });
			}
		} catch {
			await goto('/', { replaceState: true });
			return;
		}
		await goto('/', { replaceState: true });
	}

	onMount(load);
</script>

{#if loading}
	<div class="setup-loading" data-motion="progress">
		<Loader2 size={20} class="animate-spin" />
	</div>
{:else}
	<div class="setup-shell">
		<div class="setup-inner" {@attach motionStagger({ index: 0 })}>
			<StepRail steps={rail} {current} />

			<div class="setup-stage">
				{#if current === 'passkey'}
					<SetupPasskeyStep onDone={refresh} />
				{:else if current === 'organization'}
					<SetupOrgStep onDone={refresh} onSkip={() => skip('organization')} />
				{:else if current === 'deploy'}
					<SetupDeployStep onDone={refresh} onSkip={() => skip('deploy')} />
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.setup-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		color: var(--text-muted);
	}

	.setup-shell {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		padding: 2.5rem 1rem;
	}

	.setup-inner {
		width: 100%;
		max-width: 34rem;
		display: flex;
		flex-direction: column;
		gap: 2.25rem;
	}

	.setup-stage {
		display: flex;
		flex-direction: column;
	}
</style>
