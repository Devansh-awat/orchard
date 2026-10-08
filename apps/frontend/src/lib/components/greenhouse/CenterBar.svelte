<script lang="ts">
	import {
		Archive,
		ChevronRight,
		Copy,
		Ellipsis,
		ExternalLink,
		GitFork,
		Link,
		PanelLeft,
		PanelRight,
		Pencil,
		Rocket,
		Share2
	} from 'lucide-svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { previewStatus } from '$lib/components/ui/status';
	import { toasts } from '$lib/stores';
	import { getGreenhouseApp } from './app.svelte';
	import AvatarStack from './AvatarStack.svelte';
	import OpenIn from './OpenIn.svelte';
	import { modKey, repoHue, repoInitial } from './format';
	import { VIEWER_ONLY, hostOnly, isLegacy } from './workspace.svelte';

	let { onrename, compact = false }: { onrename: () => void; compact?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const session = $derived(ws?.session ?? null);
	const mod = modKey();

	const preview = $derived(
		session && (session.previewDeploymentId || session.previewUrl)
			? previewStatus(session.previewStatus)
			: null
	);

	let menuOpen = $state(false);
	let branchOpen = $state(false);

	async function copy(text: string, title: string) {
		await navigator.clipboard.writeText(text);
		toasts.add({ title, color: 'success' });
	}

	function shareLink() {
		if (!session || !app.machine) return;
		const url = `${location.origin}/sandboxes/${app.machine.id}?session=${session.id}`;
		void copy(url, 'Session link copied');
	}

	function follow(userId: string) {
		if (!ws) return;
		ws.live.follow(ws.live.following === userId ? null : userId);
	}
</script>

<div class="bar" data-align="topbar">
	{#if !app.layout.leftOpen && !compact}
		<button
			type="button"
			class="gh-ibtn"
			aria-label="Show sidebar"
			title="Show sidebar ({mod}B)"
			onclick={() => app.layout.toggle('left')}
		>
			<PanelLeft size={16} strokeWidth={1.75} />
		</button>
	{/if}
	{#if session && ws}
		<div class="crumbs">
			<span class="avatar" data-align="center-edge" style="--hue: var({repoHue(session.repo)})"
				>{repoInitial(session.repo)}</span
			>
			<span class="repo" data-align="title">{session.repo}</span>
			<span class="sep"><ChevronRight size={16} strokeWidth={1.75} /></span>
			<Menu bind:open={branchOpen} placement="bottom-start">
				{#snippet trigger(props, isOpen)}
					<button
						{...props}
						type="button"
						class="branch gh-mono"
						data-align="title"
						aria-expanded={isOpen}
						title="{session.branch}, branch actions"
					>
						{session.branch}
					</button>
				{/snippet}
				<MenuItem onclick={() => copy(session.branch, 'Branch copied')}>
					<Copy size={14} /> Copy branch name
				</MenuItem>
				<MenuItem onclick={() => copy(session.worktreePath, 'Path copied')}>
					<Copy size={14} /> Copy worktree path
				</MenuItem>
				{#if session.baseBranch}
					<div class="gh-menu-head">Based on {session.baseBranch}</div>
				{/if}
			</Menu>
			<Menu bind:open={menuOpen} placement="bottom-start">
				{#snippet trigger(props, isOpen)}
					<button
						{...props}
						type="button"
						class="gh-ibtn"
						aria-label="Session actions"
						title="Session actions"
						aria-expanded={isOpen}
					>
						<Ellipsis size={16} strokeWidth={1.75} />
					</button>
				{/snippet}
				<MenuItem
					onclick={onrename}
					disabled={!ws.canEdit}
					title={ws.canEdit ? undefined : VIEWER_ONLY}
				>
					<Pencil size={14} /> Rename
				</MenuItem>
				<MenuItem
					onclick={() => ws.forkSession(session)}
					disabled={!ws.canEdit || isLegacy(session)}
					title={ws.canEdit ? 'New session branched from this one' : VIEWER_ONLY}
				>
					<GitFork size={14} /> Fork session
				</MenuItem>
				<MenuItem onclick={shareLink}><Link size={14} /> Copy link for guests</MenuItem>
				<MenuItem onclick={() => (app.sheet = 'share')}
					><Share2 size={14} /> {ws.isOwner ? 'Share machine…' : 'People on this machine'}</MenuItem
				>
				<MenuItem
					onclick={() => (app.sheet = 'preview')}
					disabled={!ws.isOwner || isLegacy(session)}
					title={ws.isOwner ? undefined : hostOnly('deploy previews')}
				>
					<Rocket size={14} />
					{session.previewDeploymentId ? 'Preview deploy…' : 'Deploy preview…'}
				</MenuItem>
				<div class="gh-menu-sep"></div>
				<MenuItem
					onclick={() => ws.archiveSession(session, true)}
					disabled={!ws.canEdit || isLegacy(session)}
					title={ws.canEdit ? undefined : VIEWER_ONLY}
				>
					<Archive size={14} /> Archive
				</MenuItem>
			</Menu>
		</div>
	{:else}
		<div class="crumbs">
			<span class="repo" data-align="title"
				>{app.home || !ws ? 'Home' : (app.machine?.name ?? 'Greenhouse')}</span
			>
		</div>
	{/if}
	<span class="grow"></span>
	{#if ws && ws.live.others.length > 0}
		<AvatarStack
			users={ws.live.others}
			following={ws.live.following}
			size={20}
			onpick={(u) => follow(u.id)}
		/>
	{/if}
	{#if session && preview && !compact}
		{#if session.previewUrl}
			<a
				class="preview"
				href={session.previewUrl}
				target="_blank"
				rel="noopener"
				title="Preview: {preview.label}. Opens {session.previewUrl}"
			>
				<StatusDot meta={preview} size={8} />
				<span data-align="title">Preview</span>
				<ExternalLink size={14} strokeWidth={1.75} />
			</a>
		{:else}
			<button
				type="button"
				class="preview"
				title="Preview: {preview.label}"
				onclick={() => (app.sheet = 'preview')}
			>
				<StatusDot meta={preview} size={8} />
				<span data-align="title">Preview · {preview.label}</span>
			</button>
		{/if}
	{/if}
	{#if session && !compact}
		<OpenIn />
	{/if}
	{#if !app.home && !compact}
		<button
			type="button"
			class="gh-ibtn"
			aria-label={app.layout.rightOpen ? 'Hide panel' : 'Show panel'}
			title="{app.layout.rightOpen ? 'Hide' : 'Show'} panel ({mod}⌥B)"
			onclick={() => app.layout.toggle('right')}
		>
			<PanelRight size={16} strokeWidth={1.75} />
		</button>
	{/if}
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-bar);
		padding: 0 var(--gh-edge);
		border-bottom: 1px solid var(--gh-line);
		min-width: 0;
	}

	.bar > :global(.gh-ibtn:first-child) {
		margin-left: calc(-1 * var(--gh-ibtn-inset));
	}

	.bar > :global(.gh-ibtn:last-child) {
		margin-right: calc(-1 * var(--gh-ibtn-inset));
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.avatar {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
		border-radius: 0.25rem;
		background: color-mix(in oklab, var(--hue) 22%, var(--gh-editor));
		color: color-mix(in oklab, var(--hue) 80%, var(--text-default));
		font-size: var(--text-micro);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
	}

	.repo {
		flex: none;
		font-weight: 600;
		color: var(--gh-text);
	}

	.sep {
		display: inline-grid;
		margin: 0 -0.25rem;
		color: var(--gh-faint);
	}

	.branch {
		min-width: 0;
		max-width: 28rem;
		height: var(--gh-icon);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-muted);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-ui);
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.branch:hover,
	.branch[aria-expanded='true'] {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.grow {
		flex: 1;
	}

	.preview {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-icon);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.preview:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}
</style>
