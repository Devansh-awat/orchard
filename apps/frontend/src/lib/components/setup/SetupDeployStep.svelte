<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		Box,
		Github,
		LayoutTemplate,
		Layers,
		Database,
		Clock,
		ArrowRight,
		ExternalLink,
		Lock,
		Loader2
	} from 'lucide-svelte';
	import { Alert, Button, Field, Input, SectionCard } from '$lib/components/ui';
	import { apiFetch, organizations, toasts } from '$lib/stores';
	import { motionStagger, springHover, springPop } from '$lib/utils/motion.svelte';

	let {
		onDone,
		onSkip
	}: { onDone: () => Promise<void> | void; onSkip: () => Promise<void> | void } = $props();

	type Phase = 'pick' | 'image' | 'github' | 'running' | 'done';

	const SOURCES = [
		{
			id: 'image',
			icon: Box,
			title: 'A container image',
			body: 'Anything already published to a registry. Fastest way to see this working.',
			inline: true
		},
		{
			id: 'github',
			icon: Github,
			title: 'A GitHub repo',
			body: 'Built here from your Dockerfile. Public repos need no setup at all.',
			inline: true
		},
		{
			id: 'template',
			icon: LayoutTemplate,
			title: 'A template',
			body: 'WordPress, Ghost, Redis and more, wired up for you. Needs a domain you own.',
			inline: false
		},
		{
			id: 'compose',
			icon: Layers,
			title: 'A compose stack',
			body: 'A whole docker-compose file, every service deployed together.',
			inline: false
		},
		{
			id: 'database',
			icon: Database,
			title: 'A managed database',
			body: 'Postgres with backups, replicas and a connection string.',
			inline: false
		},
		{
			id: 'job',
			icon: Clock,
			title: 'A scheduled job',
			body: 'Cron or one-off tasks, with logs and retries.',
			inline: false
		}
	];

	let phase = $state<Phase>('pick');
	let error = $state<string | null>(null);
	let busy = $state(false);

	let appName = $state('hello');
	let image = $state('nginxdemos/hello:latest');
	let port = $state('80');
	let repoUrl = $state('');
	let branch = $state('main');
	let dockerfilePath = $state('Dockerfile');

	let deploymentId = $state<string | null>(null);
	let liveUrl = $state<string | null>(null);
	let certState = $state<string | null>(null);
	let statusLabel = $state('Starting');
	let poll: ReturnType<typeof setInterval> | null = null;

	const orgId = $derived(($organizations?.[0] as any)?.id ?? null);
	const certReady = $derived(certState === 'ready' || certState === 'unknown' || certState === null);

	onDestroy(() => {
		if (poll) clearInterval(poll);
	});

	async function ensureProject(): Promise<string> {
		const response = await apiFetch('/apiv1/projects', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ organizationId: orgId, name: appName.trim() || 'hello' })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new Error(body?.message || 'Could not create a project');
		}
		return (await response.json()).id;
	}

	function watch(id: string) {
		deploymentId = id;
		phase = 'running';
		poll = setInterval(async () => {
			try {
				const response = await apiFetch(`/apiv1/deployments/${id}`);
				if (!response.ok) return;
				const d = await response.json();

				statusLabel = d.buildStatus === 'building' ? 'Building your image' : (d.status ?? 'Starting');

				const ingress = (d.ingresses ?? [])[0];
				if (ingress?.host) {
					liveUrl = `https://${ingress.host}`;
					certState = ingress.certificateStatus?.state ?? null;
				}

				const failed = d.buildStatus === 'failed' || d.status === 'failed';
				if (failed) {
					error = 'The deployment failed. You can dig into it after setup.';
					if (poll) clearInterval(poll);
					phase = 'done';
					return;
				}

				if (liveUrl && (d.status === 'running' || (d.availableReplicas ?? 0) > 0)) {
					if (poll) clearInterval(poll);
					phase = 'done';
				}
			} catch {
				/* keep polling */
			}
		}, 3000);
	}

	async function deployImage() {
		if (busy || !orgId) return;
		busy = true;
		error = null;
		try {
			const projectId = await ensureProject();
			const response = await apiFetch(`/apiv1/projects/${projectId}/deployments`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: appName.trim() || 'hello',
					image: image.trim(),
					port: Number(port) || 80,
					autoUrl: true
				})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || 'Could not create the deployment');
			}
			watch((await response.json()).id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not deploy';
		} finally {
			busy = false;
		}
	}

	async function deployGithub() {
		if (busy || !orgId) return;
		busy = true;
		error = null;
		try {
			const projectId = await ensureProject();
			const response = await apiFetch(`/apiv1/projects/${projectId}/deployments/from-github`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: appName.trim() || 'hello',
					repoUrl: repoUrl.trim(),
					branch: branch.trim() || 'main',
					dockerfilePath: dockerfilePath.trim() || 'Dockerfile',
					autoUrl: true
				})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || 'Could not start the build');
			}
			watch((await response.json()).id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not deploy';
		} finally {
			busy = false;
		}
	}

	async function finish() {
		if (poll) clearInterval(poll);
		await onDone();
	}
</script>

<div class="step" {@attach motionStagger({ index: 0 })}>
	{#if phase === 'pick'}
		<SectionCard
			title="Put something on it"
			description="Here is everything Orchard can deploy. Pick one now, the rest are waiting for you afterwards."
		>
			<div class="grid">
				{#each SOURCES as source, i (source.id)}
					{@const Icon = source.icon}
					<button
						type="button"
						class="src"
						class:src-soon={!source.inline}
						disabled={!source.inline}
						{@attach motionStagger({ index: i })}
						{@attach springHover()}
						onclick={() => (phase = source.id as Phase)}
					>
						<span class="src-icon"><Icon size={17} /></span>
						<span class="src-title">{source.title}</span>
						<span class="src-body">{source.body}</span>
						{#if source.inline}
							<span class="src-go"><ArrowRight size={14} /></span>
						{:else}
							<span class="src-tag">after setup</span>
						{/if}
					</button>
				{/each}
			</div>

			<div class="actions">
				<Button onclick={onSkip}>Skip for now</Button>
			</div>
		</SectionCard>
	{:else if phase === 'image'}
		<SectionCard title="Deploy an image" description="It comes up on a real URL on your domain.">
			{#if error}<Alert tone="error" title="Could not deploy">{error}</Alert>{/if}
			<div class="form">
				<Field label="Name" for="d-name"><Input id="d-name" bind:value={appName} /></Field>
				<Field label="Image" for="d-image"><Input id="d-image" bind:value={image} /></Field>
				<Field label="Port" for="d-port"><Input id="d-port" bind:value={port} /></Field>
			</div>
			<div class="actions">
				<Button onclick={() => (phase = 'pick')}>Back</Button>
				<Button variant="primary" loading={busy} onclick={deployImage}>Deploy</Button>
			</div>
		</SectionCard>
	{:else if phase === 'github'}
		<SectionCard
			title="Deploy from GitHub"
			description="A public repo works right now. Private repos need the GitHub App, which you can connect afterwards."
		>
			{#if error}<Alert tone="error" title="Could not deploy">{error}</Alert>{/if}
			<div class="form">
				<Field label="Name" for="g-name"><Input id="g-name" bind:value={appName} /></Field>
				<Field label="Repository" for="g-repo">
					<Input id="g-repo" bind:value={repoUrl} placeholder="https://github.com/owner/repo" />
				</Field>
				<Field label="Branch" for="g-branch"><Input id="g-branch" bind:value={branch} /></Field>
				<Field label="Dockerfile" for="g-df"><Input id="g-df" bind:value={dockerfilePath} /></Field>
			</div>
			<div class="actions">
				<Button onclick={() => (phase = 'pick')}>Back</Button>
				<Button variant="primary" loading={busy} disabled={!repoUrl.trim()} onclick={deployGithub}>
					Build and deploy
				</Button>
			</div>
		</SectionCard>
	{:else if phase === 'running'}
		<SectionCard title="Bringing it up" description="This usually takes under a minute.">
			<div class="running">
				<span class="running-spin" data-motion="progress"><Loader2 size={18} class="animate-spin" /></span>
				<div>
					<p class="running-label">{statusLabel}</p>
					{#if liveUrl}
						<p class="running-url">{liveUrl}</p>
					{/if}
				</div>
			</div>
			<div class="actions">
				<Button onclick={finish}>Continue without waiting</Button>
			</div>
		</SectionCard>
	{:else}
		<SectionCard title="It is live" description="That is the whole loop. Everything else works the same way.">
			{#if error}
				<Alert tone="warning" title="Not quite">{error}</Alert>
			{:else if liveUrl}
				<a
					class="live"
					href={liveUrl}
					target="_blank"
					rel="noreferrer"
					{@attach springPop(() => phase === 'done')}
					{@attach springHover()}
				>
					<span class="live-lock" class:live-lock-on={certReady}><Lock size={14} /></span>
					<span class="live-url">{liveUrl}</span>
					<ExternalLink size={15} />
				</a>
				{#if certState === 'issuing'}
					<p class="muted">The certificate is still being issued, so the first load may warn.</p>
				{:else if certState === 'failed' || certState === 'rateLimited'}
					<Alert tone="warning" title="Certificate not issued">
						The app is running but its certificate did not issue. The domain page has the reason.
					</Alert>
				{/if}
			{/if}
			<div class="actions">
				<Button variant="primary" onclick={finish}>Finish setup</Button>
			</div>
		</SectionCard>
	{/if}
</div>

<style>
	.step {
		display: flex;
		flex-direction: column;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.625rem;
	}

	@media (max-width: 32rem) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.src {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-areas: 'icon title' 'body body';
		align-items: center;
		gap: 0.375rem 0.625rem;
		padding: 0.875rem;
		text-align: left;
		border: 1px solid var(--border-default);
		border-radius: 0.75rem;
		background: var(--bg-surface);
		cursor: pointer;
	}

	.src:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.src-soon {
		cursor: default;
		opacity: 0.62;
	}

	.src-icon {
		grid-area: icon;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.875rem;
		height: 1.875rem;
		border-radius: 0.5rem;
		background: var(--accent-subtle);
		color: var(--accent);
	}

	.src-title {
		grid-area: title;
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--text-fg);
	}

	.src-body {
		grid-area: body;
		font-size: 0.75rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	.src-go {
		position: absolute;
		top: 0.875rem;
		right: 0.875rem;
		color: var(--text-faint);
	}

	.src-tag {
		position: absolute;
		top: 0.875rem;
		right: 0.875rem;
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}

	.running {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.running-spin {
		color: var(--accent);
	}

	.running-label {
		margin: 0;
		font-weight: 500;
		color: var(--text-fg);
	}

	.running-url,
	.muted {
		margin: 0.125rem 0 0;
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
		color: var(--text-faint);
	}

	.muted {
		font-family: inherit;
		margin-top: 0.75rem;
	}

	.live {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--status-success-border);
		border-radius: 0.75rem;
		background: var(--status-success-bg);
		color: var(--text-fg);
		text-decoration: none;
		font-family: ui-monospace, monospace;
		font-size: 0.8125rem;
		overflow: hidden;
	}

	.live-lock {
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.live-lock-on {
		color: var(--status-success);
	}

	.live-url {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
