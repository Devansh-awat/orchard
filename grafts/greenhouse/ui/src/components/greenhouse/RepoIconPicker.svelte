<script lang="ts">
	import { Github, RotateCcw } from 'lucide-svelte';
	import PopoverPanel from '@orchard/graft-ui/components/ui/PopoverPanel.svelte';
	import RepoIcon from './RepoIcon.svelte';
	import { REPO_EMOJI, REPO_ICON_LUCIDE, isRepoEmoji, repoIconLabel } from './repo-icon';
	import type { GhRepo } from './types';

	let {
		open = $bindable(false),
		x = 0,
		y = 0,
		repo,
		onpick
	}: {
		open?: boolean;
		x?: number;
		y?: number;
		repo: GhRepo;
		onpick: (icon: string | null) => void;
	} = $props();

	let typed = $state('');
	const candidate = $derived(typed.trim());
	const valid = $derived(isRepoEmoji(candidate));
	const current = $derived(repo.icon ?? null);

	let panel = $state<HTMLElement | null>(null);

	$effect(() => {
		if (!open) {
			typed = '';
			return;
		}
		const frame = requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const target =
					panel?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
					panel?.querySelector<HTMLElement>('button');
				target?.focus();
			})
		);
		return () => cancelAnimationFrame(frame);
	});

	function pick(icon: string | null) {
		open = false;
		if (icon !== current) onpick(icon);
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (valid) pick(candidate);
	}
</script>

<PopoverPanel bind:open placement="bottom-start">
	{#snippet trigger(props)}
		<span
			{...props}
			class="anchor"
			style:left="{x}px"
			style:top="{y - 6}px"
			aria-hidden="true"
			tabindex="-1"
		></span>
	{/snippet}
	<div class="picker" role="dialog" aria-label="Icon for {repo.name}" bind:this={panel}>
		<div class="head">
			<RepoIcon name={repo.name} github={repo.github} icon={current} size={20} />
			<span class="head-name">{repo.name}</span>
		</div>
		<div class="grid" role="group" aria-label="Symbols">
			{#each REPO_ICON_LUCIDE as name (name)}
				{@const value = `lucide:${name}`}
				<button
					type="button"
					class="cell"
					aria-pressed={current === value}
					aria-label={repoIconLabel(name)}
					title={repoIconLabel(name)}
					onclick={() => pick(value)}
				>
					<RepoIcon name={repo.name} icon={value} size={20} />
				</button>
			{/each}
		</div>
		<div class="grid" role="group" aria-label="Emoji">
			{#each REPO_EMOJI as emoji (emoji)}
				<button
					type="button"
					class="cell cell--emoji"
					aria-pressed={current === emoji}
					aria-label={emoji}
					onclick={() => pick(emoji)}
				>
					{emoji}
				</button>
			{/each}
		</div>
		<form class="custom" onsubmit={submit}>
			<input
				class="gh-field"
				bind:value={typed}
				placeholder="Any other emoji"
				aria-label="Any other emoji"
				aria-invalid={candidate !== '' && !valid}
				autocomplete="off"
				spellcheck="false"
			/>
			<button type="submit" class="gh-btn" disabled={!valid}>Use</button>
		</form>
		{#if candidate !== '' && !valid}
			<p class="hint">Use a single emoji.</p>
		{/if}
		<div class="foot">
			{#if repo.github}
				<button
					type="button"
					class="gh-btn gh-btn--ghost"
					aria-pressed={current === 'github'}
					title="{repo.github.owner}/{repo.github.name}"
					onclick={() => pick('github')}
				>
					<Github size={14} strokeWidth={1.75} /> Use GitHub avatar
				</button>
			{/if}
			<span class="grow"></span>
			<button
				type="button"
				class="gh-btn gh-btn--ghost"
				disabled={current === null}
				onclick={() => pick(null)}
			>
				<RotateCcw size={14} strokeWidth={1.75} /> Reset
			</button>
		</div>
	</div>
</PopoverPanel>

<style>
	.anchor {
		position: fixed;
		width: 1px;
		height: 1px;
		pointer-events: none;
	}

	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: max-content;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.head-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 600;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(10, var(--gh-icon));
		gap: 0.25rem;
	}

	.cell {
		display: grid;
		place-items: center;
		width: var(--gh-icon);
		height: var(--gh-icon);
		border-radius: var(--gh-r-control);
		transition: background-color var(--dur-fast) ease;
	}

	.cell:hover,
	.cell[aria-pressed='true'] {
		background: var(--gh-hover);
	}

	.cell[aria-pressed='true'] {
		box-shadow: inset 0 0 0 1px var(--focus-ring-color);
	}

	.cell:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.cell--emoji {
		font-size: 1rem;
		line-height: 1;
	}

	.custom {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.custom .gh-field[aria-invalid='true'] {
		border-color: var(--status-error);
	}

	.hint {
		margin: -0.5rem 0 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 -0.5rem -0.25rem;
	}

	.grow {
		flex: 1;
	}
</style>
