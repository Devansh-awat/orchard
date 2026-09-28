<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowUpRight } from 'lucide-svelte';
	import CopyChip from './CopyChip.svelte';
	import { brewInstall, links } from '$lib/links';
	import { film, hover, pause, prefersReduced, reveal } from '$lib/motion.svelte';

	type Line = { kind: 'cmd' | 'ok' | 'dim'; text: string };

	const LINES: Line[] = [
		{ kind: 'cmd', text: 'orchard auth login' },
		{ kind: 'ok', text: 'logged in to https://orchard.my as leafd' },
		{ kind: 'cmd', text: 'orchard up' },
		{ kind: 'ok', text: 'created deployment site (dockerfile build)' },
		{ kind: 'ok', text: 'uploaded 1.8MB (214 files), build started' },
		{ kind: 'dim', text: '#5 [deps 3/3] RUN pnpm install --frozen-lockfile' },
		{ kind: 'dim', text: '#6 [build 2/2] RUN pnpm build' },
		{ kind: 'ok', text: 'live at https://site.orchard.my' },
		{ kind: 'cmd', text: 'orchard deploy scale site 3' },
		{ kind: 'ok', text: 'scaled site to 3 replicas' }
	];

	let terminal = $state<HTMLElement | null>(null);
	let shown = $state<string[]>([]);
	let typing = $state(false);

	async function script(signal: AbortSignal) {
		shown = [];
		await pause(500, signal);
		for (const line of LINES) {
			if (line.kind === 'cmd') {
				shown = [...shown, ''];
				typing = true;
				for (const ch of line.text) {
					shown = [...shown.slice(0, -1), shown[shown.length - 1] + ch];
					await pause(ch === ' ' ? 20 : 42, signal);
				}
				typing = false;
				await pause(380, signal);
			} else {
				shown = [...shown, line.text];
				await pause(line.kind === 'dim' ? 260 : 420, signal);
			}
		}
		await pause(4200, signal);
	}

	onMount(() => {
		const el = terminal;
		if (!el) return;
		if (prefersReduced()) {
			shown = LINES.map((l) => l.text);
			return;
		}
		return film(el, script);
	});
</script>

<section id="cli" class="scroll-mt-24 py-[clamp(5rem,9vw,144px)]">
	<div class="shell grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-12">
		<div class="order-2 lg:order-1 lg:col-span-7" {@attach reveal({ y: 24 })}>
			<div
				bind:this={terminal}
				class="overflow-hidden rounded-2xl border-4 border-crimson bg-night-900 shadow-[0_40px_80px_-40px_rgb(120_0_20/0.55)]"
				role="img"
				aria-label="A terminal: orchard auth login, then orchard up deploys the current directory live at site.orchard.my, then orchard deploy scale site 3 scales it to three replicas."
			>
				<div
					class="flex items-center justify-between border-b border-night-700 px-4 py-3 font-mono text-[12px] text-night-300"
				>
					<span>~/site</span>
					<span>zsh</span>
				</div>
				<div
					class="min-h-[23rem] p-6 font-mono text-[clamp(12px,1.1vw,14px)] leading-[1.85] text-night-100"
				>
					{#each shown as text, i (i)}
						{@const kind = LINES[i].kind}
						<p class="break-all">
							{#if kind === 'cmd'}
								<span class="text-rose">$</span>
								<span>{text}</span>{#if typing && i === shown.length - 1}<span
										class="caret ml-0.5 text-night-300"
									></span>{/if}
							{:else if kind === 'ok'}
								<span class="text-live">✓</span> <span>{text}</span>
							{:else}
								<span class="pl-4 text-night-300">{text}</span>
							{/if}
						</p>
					{/each}
					{#if !typing}
						<p><span class="text-rose">$</span> <span class="caret text-night-300"></span></p>
					{/if}
				</div>
			</div>
		</div>

		<div class="order-1 lg:order-2 lg:col-span-5">
			<h2
				{@attach reveal()}
				class="text-[clamp(2rem,3.6vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-balance text-crimson"
			>
				Ship from your terminal.
			</h2>
			<p
				{@attach reveal({ index: 1 })}
				class="mt-5 max-w-[48ch] text-[clamp(1rem,1.4vw,1.2rem)] leading-[1.55] font-medium text-pretty text-crimson-deep"
			>
				Type
				<code
					class="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-[0.88em] whitespace-nowrap ring-1 ring-crimson/10"
					>orchard up</code
				>
				and your project is live. Check logs or roll back without leaving your terminal.
			</p>
			<div {@attach reveal({ index: 2 })} class="mt-8 flex flex-col items-start gap-4">
				<CopyChip
					prompt
					text={brewInstall}
					label="Copy the Homebrew install command"
					class="bg-white text-crimson-deep ring-1 ring-crimson/15 hover:bg-white/70 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-crimson-deep"
				/>
				<a {@attach hover()} href={links.cli} class="pill-solid px-5 py-3 font-semibold">
					CLI reference <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" />
				</a>
			</div>
		</div>
	</div>
</section>
