<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { backOut, cubicIn } from 'svelte/easing';
	import { ArrowUpRight } from 'lucide-svelte';
	import WaveEdge from './WaveEdge.svelte';
	import { links } from '$lib/links';
	import { film, pause, prefersReduced, reveal, whileVisible } from '$lib/motion.svelte';

	type Block =
		| { kind: 'user'; text: string }
		| { kind: 'say'; text: string }
		| { kind: 'tool'; tool: string; args: string; result: string; done: boolean };

	type Call = { tool: string; args: string; result: string; verb: string; ms: number };

	const CLIENTS = [
		'Claude',
		'Codex',
		'Cursor',
		'VS Code',
		'Windsurf',
		'Zed',
		'Gemini CLI',
		'Goose'
	];

	const PROMPT = 'ship hackclub/site to production and give it a postgres database';
	const INTRO = "I'll confirm GitHub access, deploy the repo, then attach a database.";
	const CALLS: Call[] = [
		{
			tool: 'list_github_deploy_targets',
			args: '',
			result: 'hackclub · app installed · linked as leafd',
			verb: 'Checking',
			ms: 900
		},
		{
			tool: 'deploy_from_github',
			args: 'projectId: "c3a9…", name: "site", githubRepo: "hackclub/site", branch: "main"',
			result: 'Created site · build started',
			verb: 'Deploying',
			ms: 1400
		},
		{
			tool: 'create_database',
			args: 'projectId: "c3a9…", name: "site-db"',
			result: 'site-db ready · postgres 16',
			verb: 'Provisioning',
			ms: 1200
		},
		{
			tool: 'set_env_vars',
			args: 'deploymentId: "4b8e…", envVars: [{"key":"DATABASE_URL",…}]',
			result: '1 variable set · pods restarting',
			verb: 'Wiring',
			ms: 900
		},
		{
			tool: 'get_deployment',
			args: 'deploymentId: "4b8e…"',
			result: 'Running · 2/2 replicas ready',
			verb: 'Verifying',
			ms: 1000
		}
	];
	const OUTRO =
		'site is live at https://site.orchard.my with Postgres attached. Both replicas are passing health checks.';

	const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

	const TOOLS = [
		'deploy_from_github',
		'create_database',
		'get_pod_logs',
		'scale_deployment',
		'rollback_deployment',
		'triage_deployment_error',
		'exec_in_pod',
		'create_database_backup',
		'validate_dns',
		'run_job',
		'set_env_vars',
		'create_ingress',
		'get_deployment_metrics',
		'restore_database'
	];
	const TOOLS_B = [
		'analyze_deployment_resources',
		'set_ingress_protection',
		'install_database_extension',
		'get_database_query_stats',
		'deploy_template',
		'enable_auto_deploy',
		'list_deployment_errors',
		'expand_database_storage',
		'update_deployment_health_check',
		'create_notification_rule',
		'get_build_logs',
		'get_deployment'
	];

	let heading = $state<HTMLElement | null>(null);
	let terminal = $state<HTMLElement | null>(null);
	let measures: HTMLElement[] = $state([]);
	let widths = $state<number[]>([]);
	let client = $state(0);

	let draft = $state('');
	let blocks = $state<Block[]>([]);
	let status = $state<string | null>(null);
	let glyph = $state(0);
	let seconds = $state(0);

	function roll(_node: Element, { dir }: { dir: 1 | -1 }) {
		const reduced = prefersReduced();
		return {
			delay: reduced || dir === -1 ? 0 : 150,
			duration: reduced ? 0 : dir === 1 ? 420 : 170,
			easing: dir === 1 ? backOut : cubicIn,
			css: (t: number, u: number) =>
				dir === 1
					? `transform: translateY(${u * 70}%) rotateX(${-u * 75}deg); filter: blur(${u * 5}px); opacity: ${t}`
					: `position: absolute; left: 50%; transform: translateX(-50%) translateY(${-u * 70}%) rotateX(${u * 75}deg); filter: blur(${u * 5}px); opacity: ${t * t}`
		};
	}

	function measure() {
		widths = measures.map((m) => m?.offsetWidth ?? 0);
	}

	function finale() {
		draft = '';
		status = null;
		blocks = [
			{ kind: 'user', text: PROMPT },
			{ kind: 'say', text: INTRO },
			...CALLS.map((c) => ({ kind: 'tool' as const, ...c, done: true })),
			{ kind: 'say', text: OUTRO }
		];
	}

	async function think(verb: string, ms: number, signal: AbortSignal) {
		status = verb;
		seconds = 0;
		const started = performance.now();
		const end = started + ms;
		while (performance.now() < end) {
			glyph = (glyph + 1) % GLYPHS.length;
			seconds = Math.floor((performance.now() - started) / 1000) + 1;
			await pause(110, signal);
		}
	}

	async function script(signal: AbortSignal) {
		draft = '';
		blocks = [];
		status = null;
		await pause(600, signal);
		for (const ch of PROMPT) {
			draft += ch;
			await pause(ch === ' ' ? 18 : 34, signal);
		}
		await pause(380, signal);
		draft = '';
		blocks = [{ kind: 'user', text: PROMPT }];
		await think('Thinking', 900, signal);
		blocks = [...blocks, { kind: 'say', text: INTRO }];
		await pause(300, signal);
		for (const call of CALLS) {
			const index = blocks.length;
			blocks = [...blocks, { kind: 'tool', ...call, done: false }];
			await think(call.verb, call.ms, signal);
			blocks = blocks.map((b, i) => (i === index && b.kind === 'tool' ? { ...b, done: true } : b));
			await pause(220, signal);
		}
		status = null;
		await pause(250, signal);
		blocks = [...blocks, { kind: 'say', text: OUTRO }];
		await pause(5200, signal);
	}

	onMount(() => {
		const stops: (() => void)[] = [];
		document.fonts.ready.then(measure);
		measure();
		const onResize = () => measure();
		window.addEventListener('resize', onResize);
		stops.push(() => window.removeEventListener('resize', onResize));

		if (prefersReduced()) {
			finale();
			return () => stops.forEach((fn) => fn());
		}

		if (heading) {
			let timer = 0;
			stops.push(
				whileVisible(
					heading,
					() => {
						if (!timer)
							timer = window.setInterval(() => (client = (client + 1) % CLIENTS.length), 1500);
					},
					() => {
						clearInterval(timer);
						timer = 0;
					}
				)
			);
		}
		if (terminal) stops.push(film(terminal, script));
		return () => stops.forEach((fn) => fn());
	});
</script>

<section id="agents" class="relative scroll-mt-24 bg-crimson text-white">
	<WaveEdge fill="#f9445a" class="absolute inset-x-0 bottom-full" />

	<div
		class="shell grid grid-cols-1 items-center gap-12 py-[clamp(5rem,9vw,144px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16"
	>
		<div>
			<h2
				bind:this={heading}
				{@attach reveal()}
				aria-label="Let your agent drive."
				class="relative text-[clamp(2rem,3.6vw,3rem)] leading-[1.1] font-bold tracking-[-0.03em]"
			>
				<span class="block" aria-hidden="true">
					Let
					<span
						class="slot relative inline-flex justify-center overflow-hidden rounded-[0.2em] bg-white px-[0.18em] align-baseline text-crimson"
						style:width={widths[client] ? `${widths[client]}px` : undefined}
					>
						{#key client}
							<span
								class="inline-block whitespace-nowrap"
								in:roll={{ dir: 1 }}
								out:roll={{ dir: -1 }}
							>
								{CLIENTS[client]}
							</span>
						{/key}
					</span>
				</span>
				<span class="block" aria-hidden="true">drive.</span>
				<span
					class="pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap"
					aria-hidden="true"
				>
					{#each CLIENTS as name, i (name)}
						<span bind:this={measures[i]} class="absolute top-0 left-0 inline-block px-[0.18em]"
							>{name}</span
						>
					{/each}
				</span>
			</h2>
			<p
				{@attach reveal({ index: 1 })}
				class="mt-6 max-w-[30ch] text-[1.5rem] leading-[1.35] font-medium text-pretty text-white"
			>
				Say what you want. Your agent does the rest.
			</p>
			<p
				{@attach reveal({ index: 2 })}
				class="mt-5 text-[1.1875rem] leading-[1.5] font-bold text-pretty text-white"
			>
				<span class="block">New to servers? You don’t need to be.</span>
				<span class="block">Already know how? Skip the infra and just ship.</span>
			</p>

			<div {@attach reveal({ index: 3 })} class="mt-9">
				<a href={links.mcp} class="pill gap-2 px-5 py-3 font-semibold">
					Set up MCP <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" />
				</a>
			</div>
		</div>

		<div {@attach reveal({ index: 2, y: 28 })}>
			<div
				class="overflow-hidden rounded-xl bg-[#fbfaf7] text-[#2a2520] shadow-[0_50px_100px_-40px_rgb(60_0_10/0.75)] ring-1 ring-black/10"
				role="img"
				aria-label="A Claude Code session: asked to ship hackclub/site with a Postgres database, the agent calls Orchard's list_github_deploy_targets, deploy_from_github, create_database, set_env_vars and get_deployment tools, then reports the app is live."
			>
				<div
					class="relative flex items-center gap-2 border-b border-black/8 bg-[#f1eee8] px-3.5 py-2.5"
				>
					<span class="size-3 rounded-full bg-[#ff5f57]"></span>
					<span class="size-3 rounded-full bg-[#febc2e]"></span>
					<span class="size-3 rounded-full bg-[#28c840]"></span>
					<span
						class="pointer-events-none absolute inset-x-0 text-center font-mono text-[12px] text-black/50"
						>claude · ~/site</span
					>
				</div>

				<div
					bind:this={terminal}
					class="term flex h-[380px] flex-col justify-end overflow-hidden px-4 pt-3 pb-3.5 font-mono text-[12.5px] leading-[1.6] sm:h-[440px]"
				>
					<div class="flex flex-col gap-3">
						{#each blocks as block, i (i)}
							<div in:fade={{ duration: prefersReduced() ? 0 : 180 }}>
								{#if block.kind === 'user'}
									<p class="text-[#8a847b]">
										<span class="mr-1.5">&gt;</span>{block.text}
									</p>
								{:else if block.kind === 'say'}
									<p class="flex gap-2">
										<span class="shrink-0">⏺</span>
										<span>{block.text}</span>
									</p>
								{:else}
									<p class="flex gap-2">
										<span
											class="shrink-0 {block.done ? 'text-[#3a9a5b]' : 'running text-[#9a948b]'}"
											>⏺</span
										>
										<span class="min-w-0 break-words">
											<span class="font-bold">orchard - {block.tool}</span>
											<span class="text-[#8a847b]">(MCP)</span>{#if block.args}<span
													class="text-[#8a847b]">({block.args})</span
												>{/if}
										</span>
									</p>
									{#if block.done}
										<p class="flex gap-2 pl-[1.1em] text-[#8a847b]" in:fade={{ duration: 160 }}>
											<span class="shrink-0">⎿</span>
											<span>{block.result}</span>
										</p>
									{/if}
								{/if}
							</div>
						{/each}
					</div>

					<p class="mt-3 h-5 text-[#c9643f]">
						{#if status}
							<span class="inline-block w-[1.1em]">{GLYPHS[glyph]}</span>{status}…
							<span class="text-[#8a847b]">({seconds}s · esc to interrupt)</span>
						{/if}
					</p>

					<div class="mt-2 rounded-lg border border-[#d9d3c9] px-3 py-2">
						<span class="text-[#8a847b]">&gt;</span>
						<span class="ml-1">{draft}</span><span class="caret ml-px text-[#2a2520]/70"></span>
					</div>
					<p class="mt-1.5 px-1 text-[11px] text-[#8a847b]">? for shortcuts</p>
				</div>
			</div>
		</div>
	</div>

	<div class="marquee-mask flex flex-col gap-3 pb-[clamp(6rem,10vw,152px)]" aria-hidden="true">
		{#each [TOOLS, TOOLS_B] as row, r (r)}
			<div
				class="flex w-max {r ? 'marquee marquee-reverse' : 'marquee'}"
				style:--marquee-period="{r ? 70 : 60}s"
			>
				{#each [0, 1] as copy (copy)}
					<div class="flex gap-3 pr-3">
						{#each row as tool (tool)}
							<span
								class="rounded-lg bg-white/10 px-3.5 py-2 font-mono text-[13px] whitespace-nowrap text-cream ring-1 ring-white/15"
							>
								{tool}
							</span>
						{/each}
					</div>
				{/each}
			</div>
		{/each}
	</div>

	<WaveEdge fill="#ffdfe3" class="absolute inset-x-0 bottom-0" />
</section>

<style>
	.slot {
		perspective: 400px;
		transition: width 0.4s cubic-bezier(0.34, 1.4, 0.64, 1);
		box-shadow: 0 0.08em 0 rgb(195 16 38 / 0.35);
	}

	.running {
		animation: blink 0.9s steps(1) infinite;
	}

	.marquee-mask {
		mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent);
		overflow: hidden;
	}

	@media (prefers-reduced-motion: reduce) {
		.slot {
			transition: none;
		}

		.running {
			animation: none;
		}
	}
</style>
