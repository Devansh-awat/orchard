<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { animate } from 'motion';
	import { user, apiFetch, toasts, telemetry } from '$lib/stores';
	import { transition, motionEnabled } from '$lib/utils/motion.svelte';
	import SetupScene from './SetupScene.svelte';
	import SetupCard from './SetupCard.svelte';
	import SetupPasskeyStep from './SetupPasskeyStep.svelte';
	import SetupOrgStep from './SetupOrgStep.svelte';
	import SetupGithubStep from './SetupGithubStep.svelte';
	import SetupCertificateStep from './SetupCertificateStep.svelte';
	import SetupTelemetryStep from './SetupTelemetryStep.svelte';
	import SetupDoneStep from './SetupDoneStep.svelte';

	type ServerStep = { id: string; done: boolean; skipped: boolean; required: boolean };
	type Phase = 'passkey' | 'organization' | 'github' | 'certificate' | 'telemetry' | 'done';

	// 'github' and 'certificate' are client-side phases, not server steps: the
	// server only tracks what it can verify about the user (passkey, org).
	const BAND: Record<Phase, number> = {
		passkey: 0.2,
		organization: 0.34,
		github: 0.48,
		certificate: 0.62,
		telemetry: 0.8,
		done: 1
	};

	let steps = $state<ServerStep[]>([]);
	let phase = $state<Phase>('passkey');
	let askTelemetry = $state(false);
	let certificateFailed = $state(false);
	let ready = $state(false);
	let finishing = $state(false);
	let stage = $state<HTMLElement | null>(null);
	let scene = $state<ReturnType<typeof SetupScene> | null>(null);
	let card = $state<ReturnType<typeof SetupCard> | null>(null);

	const returning = $page.url.searchParams.has('created');
	const order = $derived<Phase[]>([
		'passkey',
		'organization',
		'github',
		...(certificateFailed ? (['certificate'] as const) : []),
		...(askTelemetry ? (['telemetry'] as const) : []),
		'done'
	]);
	const index = $derived(order.indexOf(phase));
	const dots = $derived(order.length - 1);

	function firstUnsettled(list: ServerStep[]): Phase | null {
		const next = list.find((s) => !s.done && !s.skipped)?.id;
		return next === 'passkey' || next === 'organization' ? next : null;
	}

	async function load() {
		void telemetry.reload().then((state) => (askTelemetry = !!state?.needsAnswer));
		void apiFetch('/apiv1/setup/certificate')
			.then((response) => (response.ok ? response.json() : null))
			.then(
				(cert) => (certificateFailed = cert?.state === 'failed' || cert?.state === 'rateLimited')
			)
			.catch(() => (certificateFailed = false));
		try {
			const response = await apiFetch('/apiv1/setup/state');
			if (!response.ok) throw new Error('unavailable');
			const data = await response.json();
			steps = data.steps ?? [];
			phase = firstUnsettled(steps) ?? 'github';
		} catch {
			phase = 'passkey';
		}
	}

	async function move(next: Phase) {
		if (next === phase) return;
		const from = stage?.firstElementChild;
		if (from && motionEnabled()) {
			await animate(
				from,
				{ opacity: [1, 0], y: [0, -12], filter: ['blur(0px)', 'blur(6px)'] },
				{ ...transition('smooth', { exit: true }) }
			).finished;
		}
		phase = next;
		await tick();
		card?.grow();
		scene?.raiseBand(BAND[next]);
		const to = stage?.firstElementChild;
		if (to && motionEnabled()) {
			animate(
				to,
				{ opacity: [0, 1], y: [14, 0], filter: ['blur(8px)', 'blur(0px)'] },
				transition('smooth')
			);
		}
	}

	async function advance() {
		const response = await apiFetch('/apiv1/setup/state');
		if (response.ok) {
			const data = await response.json();
			steps = data.steps ?? steps;
		}
		await move(firstUnsettled(steps) ?? 'github');
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
		await move(firstUnsettled(steps) ?? 'github');
	}

	function afterGithub() {
		return move(certificateFailed ? 'certificate' : askTelemetry ? 'telemetry' : 'done');
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

<SetupScene bind:this={scene} instant={returning} onSettled={() => (ready = true)} />

<div class="setup-stage" bind:this={stage} class:ready>
	{#if ready}
		<SetupCard bind:this={card} total={dots} {index}>
			{#if phase === 'passkey'}
				<SetupPasskeyStep onDone={advance} />
			{:else if phase === 'organization'}
				<SetupOrgStep onDone={advance} onSkip={() => skip('organization')} />
			{:else if phase === 'github'}
				<SetupGithubStep onDone={afterGithub} onSkip={afterGithub} />
			{:else if phase === 'certificate'}
				<SetupCertificateStep onDone={() => move(askTelemetry ? 'telemetry' : 'done')} />
			{:else if phase === 'telemetry'}
				<SetupTelemetryStep onDone={() => move('done')} />
			{:else}
				<SetupDoneStep onDone={finish} />
			{/if}
		</SetupCard>
	{/if}
</div>

<style>
	.setup-stage {
		position: fixed;
		inset: 0;
		z-index: 4;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: clamp(4.4rem, 14vh, 8rem) 1.5rem clamp(2.5rem, 6vh, 3.4rem);
		overflow-y: auto;
	}
</style>
