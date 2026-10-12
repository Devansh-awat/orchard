<script lang="ts">
	import { Puzzle, ShieldCheck, ShieldAlert } from 'lucide-svelte';
	import CopyChip from './CopyChip.svelte';

	let {
		id,
		name,
		version,
		description,
		publisher,
		signed,
		capabilities,
		icon
	}: {
		id: string;
		name: string;
		version: string;
		description?: string;
		publisher?: string;
		signed: boolean;
		capabilities: string[];
		icon?: string;
	} = $props();

	let iconBroken = $state(false);
</script>

<article class="panel">
	<div class="row">
		<span class="tile" aria-hidden="true">
			{#if icon && !iconBroken}
				<img
					src={icon}
					alt=""
					width="20"
					height="20"
					loading="lazy"
					onerror={() => (iconBroken = true)}
				/>
			{:else}
				<Puzzle size={18} />
			{/if}
		</span>
		<div class="min-w-0 flex-1">
			<p class="name">{name}<span class="version">{version}</span></p>
			<p class="sub">
				{description ?? id}{#if publisher}&nbsp;· by {publisher}{/if}
			</p>
		</div>
		<span class="sig" class:unsigned={!signed}>
			{#if signed}<ShieldCheck size={14} aria-hidden="true" /> Signed{:else}<ShieldAlert
					size={14}
					aria-hidden="true"
				/> Unsigned{/if}
		</span>
	</div>
	<div class="detail">
		<p class="head">Asks for</p>
		{#if capabilities.length}
			<ul class="chips">
				{#each capabilities as cap (cap)}<li>{cap}</li>{/each}
			</ul>
		{:else}
			<p class="none">Nothing beyond its own routes</p>
		{/if}
	</div>
	<div class="foot">
		<CopyChip
			text="orchardctl graft add {id}"
			label="Copy the install command"
			class="chip-white"
		/>
	</div>
</article>

<style>
	.panel {
		display: flex;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid rgb(195 16 38 / 0.14);
		border-radius: 14px;
		background: #fff;
		color: var(--color-night-800);
		box-shadow: 0 10px 30px -18px rgb(195 16 38 / 0.35);
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.9rem 1rem;
		border-bottom: 1px solid rgb(195 16 38 / 0.08);
	}

	.tile {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 8px;
		background: rgb(195 16 38 / 0.07);
		color: var(--color-crimson-deep);
	}

	.name {
		overflow: hidden;
		font-size: 16px;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.version {
		margin-left: 0.4rem;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 400;
		opacity: 0.6;
	}

	.sub {
		display: -webkit-box;
		overflow: hidden;
		margin-top: 0.15rem;
		font-size: 12.5px;
		line-height: 1.35;
		opacity: 0.7;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.sig {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.3rem;
		font-size: 12px;
		font-weight: 600;
		color: hsl(150 55% 32%);
	}

	.sig.unsigned {
		color: hsl(30 80% 38%);
	}

	.detail {
		flex: 1;
		padding: 0.85rem 1rem 0.25rem 4rem;
	}

	.head {
		font-size: 12px;
		font-weight: 600;
		opacity: 0.65;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-top: 0.35rem;
	}

	.chips li {
		padding: 0.1rem 0.45rem;
		border: 1px solid rgb(195 16 38 / 0.12);
		border-radius: 6px;
		background: rgb(195 16 38 / 0.04);
		font-family: var(--font-mono);
		font-size: 12px;
	}

	.none {
		margin-top: 0.35rem;
		font-size: 12.5px;
		opacity: 0.6;
	}

	.foot {
		padding: 0.75rem 1rem 1rem 4rem;
	}
</style>
