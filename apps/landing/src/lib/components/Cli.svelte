<script lang="ts">
	import { inView } from 'motion';
	import { reveal, prefersReduced } from '$lib/motion.svelte';

	type Line = { kind: 'cmd' | 'ok' | 'dim' | 'out'; text: string };

	const lines: Line[] = [
		{ kind: 'cmd', text: 'orchard auth login' },
		{ kind: 'ok', text: 'logged in as lfd' },
		{ kind: 'cmd', text: 'orchard deploy list' },
		{ kind: 'dim', text: 'id        name    status    replicas' },
		{ kind: 'out', text: '10da87db  site    running   1' },
		{ kind: 'out', text: '6627c0c6  api     running   3' },
		{ kind: 'cmd', text: 'orchard deploy scale api 5' },
		{ kind: 'ok', text: 'scaled api to 5 replicas' }
	];

	let shown = $state<string[]>([]);
	let done = $state(false);

	function play(node: HTMLElement) {
		if (prefersReduced()) {
			shown = lines.map((l) => l.text);
			done = true;
			return;
		}
		let cancelled = false;
		const stop = inView(
			node,
			() => {
				(async () => {
					for (let i = 0; i < lines.length; i++) {
						if (cancelled) return;
						const line = lines[i];
						if (line.kind === 'cmd') {
							shown = [...shown, ''];
							for (const ch of line.text) {
								if (cancelled) return;
								shown = [...shown.slice(0, -1), shown[shown.length - 1] + ch];
								await new Promise((r) => setTimeout(r, 26));
							}
							await new Promise((r) => setTimeout(r, 240));
						} else {
							shown = [...shown, line.text];
							await new Promise((r) => setTimeout(r, 130));
						}
					}
					done = true;
				})();
			},
			{ amount: 0.5 }
		);
		return {
			destroy() {
				cancelled = true;
				stop();
			}
		};
	}
</script>

<section id="cli" class="section-y scroll-mt-16">
	<div class="section-x grid items-center gap-8 md:gap-6 lg:grid-cols-12">
		<div class="lg:col-span-6">
			<div
				use:play
				class="panel-surface overflow-hidden rounded-2xl font-mono text-[0.84375rem] text-primary-100"
			>
				<div class="min-h-[17rem] p-7">
					{#each shown as text, i (i)}
						{@const kind = lines[i].kind}
						<div>
							{#if kind === 'cmd'}
								<span class="text-primary-300">$</span>
								<span>{text}</span>{#if i === shown.length - 1 && !done}<span class="caret"
										>&nbsp;</span
									>{/if}
							{:else if kind === 'ok'}
								<span class="text-emerald-400">✓</span> <span>{text}</span>
							{:else if kind === 'dim'}
								<span class="text-primary-100/50">{text}</span>
							{:else}
								<span>{text}</span>
							{/if}
						</div>
					{/each}
					{#if shown.length === 0}
						<span class="caret">&nbsp;</span>
					{/if}
				</div>
			</div>
		</div>
		<div class="lg:col-span-5 lg:col-start-8">
			<h2
				{@attach reveal()}
				class="max-w-[20ch] text-4xl font-semibold tracking-tight text-balance text-ink-900 md:text-5xl"
			>
				The same platform, in your terminal.
			</h2>
			<p {@attach reveal({ index: 1 })} class="mt-5 max-w-[48ch] text-lg text-pretty text-ink-700">
				The CLI speaks the same API as the dashboard. Output is readable in a terminal and JSON when
				piped, so your scripts get the same powers you do.
			</p>
			<code
				{@attach reveal({ index: 2 })}
				class="mt-7 inline-block rounded-full bg-shell-50 px-4 py-2 font-mono text-sm text-ink-700 outline-1 -outline-offset-1 outline-[var(--hairline)]"
			>
				brew install --cask leafdtk/tap/orchard-cli
			</code>
		</div>
	</div>
</section>

<style>
	.caret {
		display: inline-block;
		width: 8px;
		background: var(--color-primary-300);
		animation: blink 1s steps(1) infinite;
	}

	@keyframes blink {
		50% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none;
		}
	}
</style>
