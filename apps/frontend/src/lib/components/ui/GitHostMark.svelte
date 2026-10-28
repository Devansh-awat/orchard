<script lang="ts" module>
	export type GitHost = 'github' | 'gitlab' | 'codeberg' | 'gitea' | 'bitbucket' | 'generic';

	export function gitHostOf(provider: string, host?: string | null): GitHost {
		if (host && /(^|\.)codeberg\.org$/.test(host)) return 'codeberg';
		if (['github', 'gitlab', 'gitea', 'bitbucket'].includes(provider)) return provider as GitHost;
		return 'generic';
	}
</script>

<script lang="ts">
	import { Coffee, GitBranch } from 'lucide-svelte';

	let { host, size = 16 }: { host: GitHost; size?: number } = $props();
</script>

<span class="mark mark--{host}" style:--size="{size}px" aria-hidden="true">
	{#if host === 'github'}
		<svg viewBox="0 0 24 24" fill="currentColor">
			<path
				d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48 0-.24-.01-1.03-.01-1.87-2.51.46-3.16-.61-3.36-1.17-.11-.29-.6-1.17-1.03-1.41-.35-.19-.85-.65-.01-.66.79-.01 1.35.73 1.54 1.03.9 1.51 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.93 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.28.1-2.65 0 0 .84-.27 2.75 1.03A9.4 9.4 0 0 1 12 6.8c.85 0 1.7.11 2.5.33 1.91-1.3 2.75-1.03 2.75-1.03.55 1.37.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.69 0 3.83-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .26.18.58.69.48A10.02 10.02 0 0 0 22 12c0-5.52-4.48-10-10-10z"
			/>
		</svg>
	{:else if host === 'gitlab'}
		<svg viewBox="0 0 24 24" fill="currentColor">
			<path
				d="m12 21.4-3.3-10.2H4.4L12 21.4Zm0 0 3.3-10.2h4.3L12 21.4Zm7.6-10.2L21 6.9c.1-.4 0-.8-.4-1L19 4.7c-.3-.3-.8-.1-1 .3l-1.7 6.2h3.3Zm-15.2 0L3 6.9c-.1-.4 0-.8.4-1L5 4.7c.3-.3.8-.1 1 .3l1.7 6.2H4.4Zm4.3 0L12 2.6l3.3 8.6H8.7Z"
			/>
		</svg>
	{:else if host === 'codeberg'}
		<svg viewBox="0 0 24 24" fill="currentColor">
			<path
				d="M11.955.49A12 12 0 0 0 0 12.49a12 12 0 0 0 1.832 6.373L11.838 5.928a.187.14 0 0 1 .324 0l10.006 12.935A12 12 0 0 0 24 12.49a12 12 0 0 0-12-12 12 12 0 0 0-.045 0zm.375 6.467 4.416 16.553a12 12 0 0 0 5.137-4.213z"
			/>
		</svg>
	{:else if host === 'bitbucket'}
		<svg viewBox="0 0 24 24" fill="currentColor">
			<path
				d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"
			/>
		</svg>
	{:else if host === 'gitea'}
		<Coffee {size} strokeWidth={2.25} />
	{:else}
		<GitBranch {size} />
	{/if}
</span>

<style>
	.mark {
		display: inline-grid;
		flex-shrink: 0;
		place-items: center;
		width: var(--size);
		height: var(--size);
		color: var(--text-muted);
	}
	.mark svg {
		width: 100%;
		height: 100%;
	}
	.mark--github {
		color: var(--mark-github);
	}
	.mark--gitlab {
		color: var(--mark-gitlab);
	}
	.mark--codeberg {
		color: var(--mark-codeberg);
	}
	.mark--gitea {
		color: var(--mark-gitea);
	}
	.mark--bitbucket {
		color: var(--mark-bitbucket);
	}
</style>
