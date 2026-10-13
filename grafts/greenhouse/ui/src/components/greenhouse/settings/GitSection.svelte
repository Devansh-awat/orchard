<script lang="ts">
	import { Input } from '@orchard/graft-ui';
	import { getGreenhouseApp } from '../app.svelte';
	import { branchPrefixFor } from '../branch-prefix';
	import { greenhousePrefs, type BranchPrefixMode } from '../prefs.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';

	const app = getGreenhouseApp();
	const prefs = $derived(greenhousePrefs.values);
	const login = $derived(app.ws?.pushAs ?? null);

	function example(mode: BranchPrefixMode): string {
		if (mode === 'github' && !login) return 'your-login/fix-login';
		const prefix = branchPrefixFor(mode, prefs.branchPrefixCustom, login);
		return prefix ? `${prefix}/fix-login` : 'fix-login';
	}

	const MODES: { value: BranchPrefixMode; label: string }[] = [
		{ value: 'orchard', label: 'Orchard' },
		{ value: 'github', label: 'GitHub username' },
		{ value: 'custom', label: 'Custom' },
		{ value: 'none', label: 'None' }
	];
</script>

<Card title="Branches">
	<Row title="Branch name prefix" description="Applies to new sessions">
		<div class="choices" role="radiogroup" aria-label="Branch name prefix">
			{#each MODES as mode (mode.value)}
				<label class="choice">
					<input
						type="radio"
						name="gh-branch-prefix"
						value={mode.value}
						checked={prefs.branchPrefixMode === mode.value}
						onchange={() => greenhousePrefs.set('branchPrefixMode', mode.value)}
					/>
					<span class="choice-label">{mode.label}</span>
					<span class="choice-example gh-mono">{example(mode.value)}</span>
				</label>
				{#if mode.value === 'custom' && prefs.branchPrefixMode === 'custom'}
					<div class="custom">
						<Input
							value={prefs.branchPrefixCustom}
							placeholder="team"
							aria-label="Custom branch prefix"
							autocomplete="off"
							spellcheck="false"
							maxlength={40}
							oninput={(e: Event) =>
								greenhousePrefs.set(
									'branchPrefixCustom',
									(e.currentTarget as HTMLInputElement).value
								)}
						/>
					</div>
				{/if}
			{/each}
		</div>
	</Row>
	<Row
		title="Delete branch on archive"
		description="Archiving a session also deletes its branch"
		checked={prefs.deleteBranchOnArchive}
		ontoggle={(v) => greenhousePrefs.set('deleteBranchOnArchive', v)}
	/>
</Card>

<style>
	.choices {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.choice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 1.75rem;
		cursor: pointer;
	}

	.choice input {
		flex: none;
		width: 1rem;
		height: 1rem;
		margin: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.choice-label {
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--text-default);
	}

	.choice-example {
		margin-left: auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-faint);
	}

	.custom {
		max-width: 16rem;
		padding: 0 0 0.25rem 1.5rem;
	}
</style>
