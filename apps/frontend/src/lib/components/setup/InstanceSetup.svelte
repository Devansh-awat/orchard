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
	import SetupStorageStep from './SetupStorageStep.svelte';
	import SetupTelemetryStep from './SetupTelemetryStep.svelte';
	import SetupLimitsStep from './SetupLimitsStep.svelte';
	import SetupNetworkStep from './SetupNetworkStep.svelte';
	import SetupMcpStep from './SetupMcpStep.svelte';
	import SetupEmailStep from './SetupEmailStep.svelte';
	import SetupDoneStep from './SetupDoneStep.svelte';
	import type { SetupOverview } from './setup-overview';

	type ServerStep = { id: string; done: boolean; skipped: boolean; required: boolean };
	type Phase =
		| 'passkey'
		| 'organization'
		| 'github'
		| 'storage'
		| 'limits'
		| 'network'
		| 'mcp'
		| 'email'
		| 'certificate'
		| 'telemetry'
		| 'done';

	// Only passkey and organization gate setup on the server. The rest are
	// client-side phases that the overview decides to show or leave out.
	const BAND: Record<Phase, number> = {
		passkey: 0.2,
		organization: 0.3,
		github: 0.4,
		storage: 0.48,
		limits: 0.56,
		network: 0.64,
		mcp: 0.7,
		email: 0.76,
		certificate: 0.82,
		telemetry: 0.9,
		done: 1
	};

	let steps = $state<ServerStep[]>([]);
	let phase = $state<Phase>('passkey');
	let askTelemetry = $state(false);
	let askStorage = $state(false);
	let askLimits = $state(false);
	let overview = $state<SetupOverview | null>(null);
	let ready = $state(false);
	let finishing = $state(false);
	let stage = $state<HTMLElement | null>(null);
	let scene = $state<ReturnType<typeof SetupScene> | null>(null);
	let card = $state<ReturnType<typeof SetupCard> | null>(null);

	const RESUME_KEY = 'orchard:instance-setup';
	const returning = $page.url.searchParams.has('created');
	const skipped = $derived(new Set(overview?.skipped ?? []));
	const askGithub = $derived(
		returning ||
			(overview?.items.find((item) => item.id === 'github')?.state !== 'configured' &&
				!skipped.has('github'))
	);
	const askNetwork = $derived(
		!!overview &&
			!overview.installer &&
			!skipped.has('network') &&
			(!overview.publicIp || !overview.cname || !overview.appDomain)
	);
	const askMcp = $derived(!!overview && !overview.installer && !skipped.has('mcp'));
	const askEmail = $derived(
		!!overview && !overview.emailConfigured && !overview.locked.email && !skipped.has('email')
	);
	const askCertificate = $derived(
		!!overview && !['perHost', 'external', 'unconfigured'].includes(overview.certificate.state)
	);
	const order = $derived<Phase[]>([
		'passkey',
		'organization',
		...(askGithub ? (['github'] as const) : []),
		...(askStorage && !skipped.has('storage') ? (['storage'] as const) : []),
		...(askLimits ? (['limits'] as const) : []),
		...(askNetwork ? (['network'] as const) : []),
		...(askMcp ? (['mcp'] as const) : []),
		...(askEmail ? (['email'] as const) : []),
		...(askCertificate ? (['certificate'] as const) : []),
		...(askTelemetry ? (['telemetry'] as const) : []),
		'done'
	]);
	const index = $derived(order.indexOf(phase));
	const dots = $derived(order.length - 1);

	function firstUnsettled(list: ServerStep[]): Phase | null {
		const next = list.find((s) => !s.done && !s.skipped)?.id;
		return next === 'passkey' || next === 'organization' ? next : null;
	}

	async function loadOverview() {
		try {
			const response = await apiFetch('/apiv1/setup/overview');
			if (response.ok) overview = await response.json();
		} catch {
			overview = null;
		}
	}

	function firstAfterAccount(): Phase {
		return order[order.indexOf('organization') + 1] ?? 'done';
	}

	function nextAfter(current: Phase): Phase {
		return order[order.indexOf(current) + 1] ?? 'done';
	}

	async function load() {
		sessionStorage.setItem(RESUME_KEY, '1');
		const answers = Promise.all([
			telemetry.reload().then((state) => (askTelemetry = !!state?.needsAnswer)),
			apiFetch('/apiv1/admin/instance-config/storage')
				.then((response) => (response.ok ? response.json() : null))
				.then((section) => {
					askStorage = !!section && !section.configured && section.lockedFields.length === 0;
				})
				.catch(() => (askStorage = false)),
			apiFetch('/apiv1/admin/instance-settings/resource-limits')
				.then((response) => (response.ok ? response.json() : null))
				.then(
					(limits) =>
						(askLimits =
							!!limits?.newInstance && limits.dbValue === null && limits.envOverride === null)
				)
				.catch(() => (askLimits = false)),
			loadOverview()
		]);
		try {
			const response = await apiFetch('/apiv1/setup/state');
			if (!response.ok) throw new Error('unavailable');
			const data = await response.json();
			steps = data.steps ?? [];
			await answers;
			await tick();
			phase = firstUnsettled(steps) ?? firstAfterAccount();
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
		await move(firstUnsettled(steps) ?? firstAfterAccount());
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
		await move(firstUnsettled(steps) ?? firstAfterAccount());
	}

	async function record(step: string) {
		const response = await apiFetch('/apiv1/setup/skip', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ step })
		}).catch(() => null);
		if (!response?.ok) {
			toasts.add({ title: 'Could not save that. It will be asked again.', color: 'error' });
		}
	}

	async function advanceFrom(current: Phase, skippedStep?: string) {
		const next = nextAfter(current);
		if (skippedStep) await record(skippedStep);
		if (next === 'done') await loadOverview();
		await move(next);
	}

	async function finish(href = '/') {
		if (finishing) return;
		finishing = true;
		sessionStorage.removeItem(RESUME_KEY);
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
			await goto(href, { replaceState: true });
			return;
		}
		await goto(href, { replaceState: true });
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
				<SetupGithubStep
					onDone={() => advanceFrom('github')}
					onSkip={() => advanceFrom('github', 'github')}
				/>
			{:else if phase === 'storage'}
				<SetupStorageStep
					onDone={() => advanceFrom('storage')}
					onSkip={() => advanceFrom('storage', 'storage')}
				/>
			{:else if phase === 'limits'}
				<SetupLimitsStep onDone={() => advanceFrom('limits')} />
			{:else if phase === 'network' && overview}
				<SetupNetworkStep
					{overview}
					onDone={() => advanceFrom('network')}
					onSkip={() => advanceFrom('network', 'network')}
				/>
			{:else if phase === 'mcp' && overview}
				<SetupMcpStep {overview} onDone={() => advanceFrom('mcp', 'mcp')} />
			{:else if phase === 'email'}
				<SetupEmailStep
					onDone={() => advanceFrom('email')}
					onSkip={() => advanceFrom('email', 'email')}
				/>
			{:else if phase === 'certificate'}
				<SetupCertificateStep onDone={() => advanceFrom('certificate')} />
			{:else if phase === 'telemetry'}
				<SetupTelemetryStep onDone={() => advanceFrom('telemetry')} />
			{:else}
				<SetupDoneStep {overview} onDone={finish} />
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
