<script lang="ts">
	import { ArrowRight, Database, Globe } from 'lucide-svelte';

	type Resource = { name: string; type: string; detail?: string };

	let {
		name,
		displayName,
		author,
		version,
		resources,
		description,
		icon,
		href,
		compact = false,
		summary = false
	}: {
		name: string;
		displayName: string;
		author?: string;
		version: string;
		resources: Resource[];
		description?: string;
		icon?: string;
		href?: string;
		compact?: boolean;
		summary?: boolean;
	} = $props();

	const bakes = new Map<string, string | null>();

	let iconBroken = $state(false);
	let baked = $state<string | null>(null);

	function bake(img: HTMLImageElement) {
		if (!icon) return;
		if (bakes.has(icon)) {
			baked = bakes.get(icon) ?? null;
			return;
		}
		let out: string | null = null;
		try {
			const w = 480;
			const h = 120;
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.fillStyle = '#2f2227';
				ctx.fillRect(0, 0, w, h);
				ctx.filter = 'blur(60px) saturate(1.6)';
				for (const [scale, angle, alpha] of [
					[1.1, 0, 0.9],
					[1.45, 70, 0.55],
					[1.8, 140, 0.4]
				]) {
					ctx.save();
					ctx.globalAlpha = alpha;
					ctx.translate(w / 2, h / 2);
					ctx.rotate((angle * Math.PI) / 180);
					ctx.scale(scale, scale);
					ctx.drawImage(img, -w / 2, -w / 2, w, w);
					ctx.restore();
				}
				ctx.filter = 'none';
				ctx.globalAlpha = 1;
				const veil = ctx.createLinearGradient(0, 0, w, 0);
				veil.addColorStop(0, 'rgb(0 0 0 / 0.58)');
				veil.addColorStop(0.46, 'rgb(0 0 0 / 0.34)');
				veil.addColorStop(1, 'rgb(0 0 0 / 0.2)');
				ctx.fillStyle = veil;
				ctx.fillRect(0, 0, w, h);
				const drop = ctx.createLinearGradient(0, 0, 0, h);
				drop.addColorStop(0, 'rgb(0 0 0 / 0.06)');
				drop.addColorStop(1, 'rgb(0 0 0 / 0.22)');
				ctx.fillStyle = drop;
				ctx.fillRect(0, 0, w, h);
				out = canvas.toDataURL('image/jpeg', 0.8);
			}
		} catch {
			out = null;
		}
		bakes.set(icon, out);
		baked = out;
	}

	function plural(n: number, word: string) {
		return `${n} ${word}${n === 1 ? '' : 's'}`;
	}

	const counts = $derived.by(() => {
		const c = { deployment: 0, database: 0, ingress: 0 };
		for (const r of resources) if (r.type in c) c[r.type as keyof typeof c]++;
		return c;
	});

	const meta = $derived(
		summary
			? [author ?? 'orchard', `v${version}`]
			: [
					author ?? 'orchard',
					counts.deployment ? plural(counts.deployment, 'deployment') : null,
					counts.database ? plural(counts.database, 'database') : null,
					counts.ingress ? plural(counts.ingress, 'domain') : null,
					`v${version}`
				].filter(Boolean)
	);

	const STATUS: Record<string, string> = {
		deployment: 'Running',
		database: 'Ready',
		ingress: 'Live'
	};
</script>

<div
	class="panel"
	class:compact
	class:summary
	class:baked={!!baked}
	style:--mesh-bg={baked ? `url("${baked}")` : undefined}
>
	<div class="head">
		<span class="tile tile-lg" aria-hidden="true">
			{#if icon && !iconBroken}
				<img
					src={icon}
					alt=""
					width="40"
					height="40"
					loading="lazy"
					decoding="async"
					crossorigin="anonymous"
					onload={(e) => bake(e.currentTarget)}
					onerror={() => (iconBroken = true)}
				/>
			{:else}
				{displayName.slice(0, 1).toUpperCase()}
			{/if}
		</span>
		<div class="min-w-0 flex-1">
			<p class="truncate text-[17px] leading-tight font-semibold">{displayName}</p>
			<p class="meta">
				{#each meta as m, i (i)}
					{#if i > 0}<span class="dot" aria-hidden="true">·</span>{/if}<span>{m}</span>
				{/each}
			</p>
		</div>
		{#if !summary}
			<span class="count"><span class="led" aria-hidden="true"></span>{resources.length}</span>
		{/if}
		{#if href}
			<span class="go" aria-hidden="true"><ArrowRight size={14} /></span>
		{/if}
	</div>
	<ul class="cards">
		{#each resources as r (r.name)}
			<li class="card">
				<span class="tile tile-sm tile-{r.type}" aria-hidden="true">
					{#if r.type === 'database'}
						<Database size={16} />
					{:else if r.type === 'ingress'}
						<Globe size={16} />
					{:else}
						{r.name.slice(0, 1).toUpperCase()}
					{/if}
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-[14px] leading-tight font-semibold">{r.name}</p>
					{#if r.detail}
						<p class="truncate text-[12px] opacity-70">{r.detail}</p>
					{/if}
				</div>
				<p class="status"><span class="led" aria-hidden="true"></span>{STATUS[r.type] ?? r.type}</p>
			</li>
		{/each}
	</ul>
	{#if description}
		<p class="blurb">{description}</p>
	{/if}
</div>

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
		font-family: var(--font-sans);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		min-height: 4.5rem;
		padding: 0.9rem 1rem;
		background: linear-gradient(140deg, hsl(352 42% 52%), hsl(14 40% 42%));
		color: #fff;
	}

	.baked .head {
		background: var(--mesh-bg) center / cover no-repeat;
	}

	.meta {
		display: block;
		overflow: hidden;
		margin-top: 0.15rem;
		font-size: 12.5px;
		line-height: 1.3;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: rgb(255 255 255 / 0.78);
	}

	.meta > span {
		margin-right: 0.35rem;
	}

	.dot {
		opacity: 0.6;
	}

	.tile {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		border-radius: 10px;
		font-weight: 700;
	}

	.tile-lg {
		width: 40px;
		height: 40px;
		overflow: hidden;
		font-size: 18px;
		background: #fff;
		color: var(--color-night-700);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.18);
	}

	.tile-lg img {
		width: 40px;
		height: 40px;
		object-fit: contain;
	}

	.summary .blurb {
		flex: 1;
		-webkit-line-clamp: 3;
		max-height: none;
		margin-top: 0.85rem;
	}

	.tile-sm {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		font-size: 14px;
		background: hsl(352 70% 94%);
		color: hsl(352 60% 40%);
	}

	.tile-database {
		background: hsl(212 70% 94%);
		color: hsl(212 55% 40%);
	}

	.tile-ingress {
		background: hsl(160 55% 92%);
		color: hsl(160 45% 30%);
	}

	.count,
	.go {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.35rem;
		border-radius: 999px;
		padding: 0.3rem 0.65rem;
		font-size: 12.5px;
		font-weight: 600;
		background: rgb(255 255 255 / 0.18);
		color: #fff;
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.16);
	}

	.go {
		padding: 0.4rem;
	}

	.led {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: #1f9d6a;
	}

	.head .led {
		background: #9df3c6;
	}

	.cards {
		display: grid;
		flex: 1;
		align-content: start;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0.6rem;
		padding: 0.75rem;
		background: #fbf7f8;
	}

	.summary .cards {
		display: none;
	}

	.compact .cards {
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
	}

	.card {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		border: 1px solid rgb(20 13 16 / 0.07);
		border-radius: 10px;
		padding: 0.6rem 0.7rem;
		background: #fff;
	}

	.blurb {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		overflow: hidden;
		margin: 0.75rem 1rem 0.9rem;
		max-height: 2.9em;
		font-size: 13.5px;
		line-height: 1.45;
		color: var(--color-night-700);
		opacity: 0.85;
	}

	.status {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.35rem;
		font-size: 11.5px;
		opacity: 0.8;
	}
</style>
