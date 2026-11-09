<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import {
		ArrowLeft,
		ArrowRight,
		Bot,
		Boxes,
		CalendarClock,
		Check,
		ChevronDown,
		Copy,
		Database,
		FileText,
		Gamepad2,
		GitBranch,
		Globe,
		History,
		Image,
		LayoutTemplate,
		LoaderCircle,
		Maximize2,
		MessageSquare,
		PenLine,
		Plus,
		RefreshCw,
		RotateCcw,
		Search,
		Shield,
		Slack,
		Terminal,
		Timer,
		Trash2,
		Webhook,
		Workflow,
		X
	} from 'lucide-svelte';
	import { film, pause, prefersReduced, reveal, whileVisible } from '$lib/motion.svelte';

	const FORMATS = [
		{ id: 'URI', value: 'postgresql://site:••••••••@site-db-rw:5432/site' },
		{ id: 'psql', value: 'psql "host=site-db-rw port=5432 dbname=site user=site"' },
		{ id: '.env', value: 'DATABASE_URL=postgresql://site:••••••••@site-db-rw:5432/site' },
		{ id: 'JDBC', value: 'jdbc:postgresql://site-db-rw:5432/site?user=site' }
	];

	const ACCESS = [
		['14:37:24.975', '10.244.4.154', 'GET /', '200', '896'],
		['14:37:25.088', '10.244.4.154', 'GET /api/health', '200', '17'],
		['14:37:25.282', '10.244.2.31', 'POST /api/signup', '201', '312'],
		['14:37:25.488', '10.244.4.154', 'GET /dashboard', '200', '2291'],
		['14:37:25.585', '10.244.1.9', 'GET /api/projects', '200', '744'],
		['14:37:25.691', '10.244.4.154', 'GET /favicon.ico', '304', '0'],
		['14:37:25.872', '10.244.2.31', 'POST /api/events', '202', '48'],
		['14:37:25.990', '10.244.4.154', 'GET /api/me', '200', '188'],
		['14:37:26.114', '10.244.1.9', 'GET /settings', '200', '1320'],
		['14:37:26.301', '10.244.4.154', 'GET /api/health', '200', '17']
	];

	const SHELL = [
		{ cmd: 'ls', out: 'Dockerfile  node_modules  package.json  src' },
		{ cmd: 'echo $NODE_ENV', out: 'production' }
	];

	const DOMAINS = [
		{ host: 'site.hackclub.dev', redirect: '' },
		{ host: 'www.site.hackclub.dev', redirect: 'site.hackclub.dev' },
		{ host: 'site.example.com', redirect: '' }
	];

	const PINGS = [
		{ icon: Slack, where: 'Slack · #deploys', text: 'Deploy succeeded: site' },
		{ icon: MessageSquare, where: 'Discord · #alerts', text: 'App crashing: api' },
		{ icon: MessageSquare, where: 'Discord · #alerts', text: 'App recovered: api' },
		{ icon: Webhook, where: 'Webhook', text: 'Backup completed: site-db' },
		{ icon: Slack, where: 'Slack · #deploys', text: 'Job run succeeded: nightly-backup #42' }
	];

	const AGO = ['now', '2m', '9m', '14m'];

	const RELEASES = {
		live: { msg: 'add signup flow', ref: '9f2c1a4', when: '12m ago' },
		previous: { msg: 'fix header spacing', ref: '7e1d2c0', when: '2h ago' }
	};

	const TEMPLATES = [
		{
			name: 'Minecraft Server',
			category: 'Games',
			about: 'Paper, Fabric or modpacks',
			icon: Gamepad2
		},
		{ name: 'n8n', category: 'Automation', about: 'Workflow automation', icon: Workflow },
		{ name: 'Open WebUI', category: 'AI', about: 'Chat with any model', icon: Bot },
		{ name: 'Immich', category: 'Media', about: 'Photo and video backup', icon: Image }
	];

	const ALSO = [
		'Persistent volumes',
		'Metrics and crash reports',
		'Teams, roles and audit logs',
		'SAML and OIDC sign-in',
		'SCIM provisioning',
		'Deployment protection',
		'Compose stacks',
		'Public status pages',
		'Node pools and quotas',
		'Command-K search'
	];

	let grid = $state<HTMLElement | null>(null);
	let active = $state(-1);
	let dbTile = $state<HTMLElement | null>(null);
	let consoleTile = $state<HTMLElement | null>(null);
	let domainTile = $state<HTMLElement | null>(null);
	let jobTile = $state<HTMLElement | null>(null);
	let tplTile = $state<HTMLElement | null>(null);
	let pingTile = $state<HTMLElement | null>(null);
	let rollTile = $state<HTMLElement | null>(null);

	let format = $state(0);
	let copied = $state(false);

	let logCount = $state(10);
	let shellOpen = $state(false);
	let shellPress = $state(false);
	let shellLines = $state<{ cmd: string; out: string }[]>([]);
	let shellDraft = $state('');

	let domain = $state('site.hackclub.dev');
	let ssl = $state(true);
	let added = $state(true);
	let addPress = $state(false);

	let running = $state(false);
	let stdout = $state(2);
	let countdown = $state('');

	let tplStage = $state<'idle' | 'hover' | 'deploying' | 'live'>('idle');

	let feed = $state(
		PINGS.slice(0, 3)
			.map((ping, key) => ({ ...ping, key }))
			.reverse()
	);
	let pingIndex = 3;
	let pingKey = 3;

	let rolled = $state(false);
	let rolling = $state(false);
	let rollPress = $state(false);
	let fresh = $state(false);

	const live = $derived(rolled ? RELEASES.previous : RELEASES.live);
	const previous = $derived(rolled ? RELEASES.live : RELEASES.previous);

	function tickClock() {
		const now = new Date();
		const next = new Date(now);
		next.setHours(3, 0, 0, 0);
		if (next <= now) next.setDate(next.getDate() + 1);
		const left = Math.floor((next.getTime() - now.getTime()) / 1000);
		const h = Math.floor(left / 3600);
		const m = Math.floor((left % 3600) / 60);
		const s = left % 60;
		countdown = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
	}

	function logLine(n: number) {
		const [, ip, req, code, bytes] = ACCESS[((n % ACCESS.length) + ACCESS.length) % ACCESS.length];
		const at = 52_644_975 + n * 137;
		const clock = [
			Math.floor(at / 3_600_000) % 24,
			Math.floor(at / 60_000) % 60,
			Math.floor(at / 1000) % 60
		].map((part) => String(part).padStart(2, '0'));
		return {
			n,
			time: `${clock.join(':')}.${String(at % 1000).padStart(3, '0')}`,
			ip,
			req,
			code,
			bytes
		};
	}

	const logs = $derived(Array.from({ length: 10 }, (_, k) => logLine(logCount - 10 + k)));

	async function type(text: string, write: (v: string) => void, signal: AbortSignal, ms = 42) {
		for (let i = 1; i <= text.length; i++) {
			write(text.slice(0, i));
			await pause(ms, signal);
		}
	}

	onMount(() => {
		tickClock();
		if (prefersReduced() || !grid) return;
		const stops: (() => void)[] = [];

		const tiles: {
			el: HTMLElement | null;
			play: (signal: AbortSignal) => Promise<void>;
			rest: () => void;
		}[] = [
			{
				el: dbTile,
				rest: () => {
					format = 0;
					copied = false;
				},
				play: async (signal) => {
					for (const next of [1, 2]) {
						format = next;
						await pause(1100, signal);
					}
					copied = true;
					await pause(1000, signal);
					copied = false;
					format = 0;
				}
			},
			{
				el: consoleTile,
				rest: () => {
					shellOpen = false;
					shellPress = false;
					shellLines = [];
					shellDraft = '';
				},
				play: async (signal) => {
					for (let i = 0; i < 4; i++) {
						logCount++;
						await pause(420, signal);
					}
					shellPress = true;
					await pause(180, signal);
					shellPress = false;
					shellOpen = true;
					await pause(450, signal);
					for (const line of SHELL) {
						await type(line.cmd, (v) => (shellDraft = v), signal, 65);
						await pause(220, signal);
						shellDraft = '';
						shellLines = [...shellLines, line];
						await pause(600, signal);
					}
					await pause(900, signal);
					shellOpen = false;
					shellLines = [];
				}
			},
			{
				el: domainTile,
				rest: () => {
					domain = 'site.hackclub.dev';
					ssl = true;
					added = true;
					addPress = false;
				},
				play: async (signal) => {
					domain = '';
					ssl = false;
					added = false;
					await pause(400, signal);
					await type('site.hackclub.dev', (v) => (domain = v), signal);
					await pause(350, signal);
					ssl = true;
					await pause(550, signal);
					addPress = true;
					await pause(160, signal);
					addPress = false;
					added = true;
				}
			},
			{
				el: jobTile,
				rest: () => {
					running = false;
					stdout = 2;
				},
				play: async (signal) => {
					running = true;
					stdout = 0;
					await pause(800, signal);
					stdout = 1;
					await pause(800, signal);
					stdout = 2;
					await pause(600, signal);
					running = false;
				}
			},
			{
				el: tplTile,
				rest: () => {
					tplStage = 'idle';
				},
				play: async (signal) => {
					tplStage = 'hover';
					await pause(700, signal);
					tplStage = 'deploying';
					await pause(1500, signal);
					tplStage = 'live';
					await pause(1300, signal);
					tplStage = 'idle';
				}
			},
			{
				el: pingTile,
				rest: () => {},
				play: async (signal) => {
					for (let i = 0; i < 2; i++) {
						feed = [{ ...PINGS[pingIndex % PINGS.length], key: pingKey++ }, ...feed].slice(0, 4);
						pingIndex++;
						await pause(1100, signal);
					}
				}
			},
			{
				el: rollTile,
				rest: () => {
					rolling = false;
					rollPress = false;
				},
				play: async (signal) => {
					rollPress = true;
					await pause(160, signal);
					rollPress = false;
					rolling = true;
					await pause(1500, signal);
					rolling = false;
					rolled = !rolled;
					fresh = true;
				}
			}
		];

		const visible = new Set<number>();
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const index = tiles.findIndex((tile) => tile.el === entry.target);
					if (entry.intersectionRatio >= 0.55) visible.add(index);
					else visible.delete(index);
				}
			},
			{ threshold: [0, 0.55, 1] }
		);
		for (const tile of tiles) if (tile.el) io.observe(tile.el);
		stops.push(() => io.disconnect());

		let turn = 0;
		stops.push(
			film(grid, async (signal) => {
				const next = tiles
					.map((_, offset) => (turn + offset) % tiles.length)
					.find((index) => visible.has(index));
				if (next === undefined) {
					await pause(400, signal);
					return;
				}
				active = next;
				try {
					await pause(300, signal);
					await tiles[next].play(signal);
					await pause(1100, signal);
				} finally {
					if (signal.aborted) tiles[next].rest();
					active = -1;
				}
				turn = next + 1;
				await pause(500, signal);
			})
		);

		if (jobTile) {
			let timer = 0;
			stops.push(
				whileVisible(
					jobTile,
					() => {
						tickClock();
						if (!timer) timer = window.setInterval(tickClock, 1000);
					},
					() => {
						clearInterval(timer);
						timer = 0;
					}
				)
			);
		}

		return () => stops.forEach((fn) => fn());
	});
</script>

{#snippet head(Icon: typeof Database, title: string, body: string)}
	<div>
		<p class="flex items-center gap-2.5">
			<span class="grid size-8 place-items-center rounded-lg bg-crimson/10 text-crimson">
				<Icon size={17} strokeWidth={2} aria-hidden="true" />
			</span>
			<span class="text-lg font-semibold text-crimson-deep">{title}</span>
		</p>
		<p class="mt-2.5 text-base leading-normal text-pretty text-crimson-deep">{body}</p>
	</div>
{/snippet}

<section id="features" class="scroll-mt-24 py-[clamp(6rem,10vw,160px)]">
	<div class="shell">
		<h2 {@attach reveal()} class="section-title text-crimson">Features</h2>
		<p
			{@attach reveal({ index: 1 })}
			class="section-lead mx-auto mt-2 max-w-[640px] text-balance text-crimson-deep"
		>
			Everything your app needs once it's live.
		</p>

		<ul bind:this={grid} class="mt-[clamp(2.5rem,5vw,64px)] grid gap-4 lg:grid-cols-6">
			<li
				bind:this={dbTile}
				{@attach reveal({ index: 0, y: 24 })}
				class:tile-on={active === 0}
				class="tile lg:col-span-3"
			>
				{@render head(
					Database,
					'Postgres databases',
					'A full Postgres next to your app, with backups and extensions.'
				)}
				<div class="window h-[252px] p-3.5" aria-hidden="true">
					<p class="flex items-center gap-2.5">
						<span class="grid size-8 place-items-center rounded-lg bg-[#fbe9eb] text-[#b8323f]"
							><Database size={15} /></span
						>
						<span class="text-[15px] font-semibold">site-db</span>
						<span
							class="flex items-center gap-1 rounded-full bg-[#e6f6f0] px-2 py-0.5 text-[10.5px] font-medium text-[#0e8f69]"
							><span class="size-1.5 rounded-full bg-[#10b981]"></span>Ready</span
						>
						<span class="ml-auto flex gap-1 font-mono text-[10px] text-[#75696b]">
							<span class="rounded bg-[#f4f1f1] px-1.5 py-0.5">PG 17</span>
							<span class="rounded bg-[#f4f1f1] px-1.5 py-0.5">10Gi</span>
						</span>
					</p>
					<p class="mt-3 flex gap-3 border-b border-[#efeaea] pb-2 text-[11.5px] text-[#75696b]">
						<span class="rounded-md bg-[#f4f1f1] px-2 py-0.5 font-medium text-[#1c1718]"
							>Connection</span
						>
						<span class="py-0.5">Backups</span>
						<span class="py-0.5">Terminal</span>
						<span class="py-0.5">Extensions</span>
						<span class="py-0.5 max-sm:hidden">Queries</span>
					</p>
					<div class="mt-3 rounded-lg border border-[#e8e4e4] bg-[#faf8f8]">
						<p class="flex gap-0.5 p-1 text-[11px]">
							{#each FORMATS as f, i (f.id)}
								<span
									class="rounded-md px-2.5 py-1 transition-colors duration-300 {format === i
										? 'bg-white font-semibold text-[#1c1718] shadow-sm'
										: 'text-[#75696b]'}">{f.id}</span
								>
							{/each}
						</p>
						<div class="flex items-center gap-3 border-t border-[#efeaea] px-3 py-2.5">
							<p
								class="relative h-[34px] min-w-0 flex-1 overflow-hidden font-mono text-[11px] leading-[17px]"
							>
								{#key format}
									<span
										class="absolute inset-0 break-all"
										in:fly={{ y: 8, duration: 260 }}
										out:fade={{ duration: 120 }}
									>
										{FORMATS[format].value}
									</span>
								{/key}
							</p>
							<span
								class="flex shrink-0 items-center gap-1 rounded-md border bg-white px-2 py-1 text-[11px] font-medium transition-colors {copied
									? 'border-[#10b981]/40 text-[#0e8f69]'
									: 'border-[#e8e4e4]'}"
							>
								{#if copied}<Check size={11} strokeWidth={3} />Copied{:else}<Copy
										size={11}
									/>Copy{/if}
							</span>
						</div>
					</div>
					<p class="mt-2.5 grid grid-cols-[64px_1fr] gap-y-1 px-1 text-[11px]">
						<span class="font-medium">Host</span><span class="truncate font-mono text-[#75696b]"
							>site-db-rw.orchard.svc.cluster.local</span
						>
						<span class="font-medium">Port</span><span class="font-mono text-[#75696b]">5432</span>
					</p>
				</div>
			</li>

			<li
				bind:this={consoleTile}
				{@attach reveal({ index: 1, y: 24 })}
				class:tile-on={active === 1}
				class="tile lg:col-span-3"
			>
				{@render head(
					Terminal,
					'Logs and shell',
					'Stream logs live, or open a shell in any running container.'
				)}
				<div class="window h-[252px] text-[11px]" aria-hidden="true">
					<div
						class="flex h-[37px] items-center justify-between gap-2 border-b border-[#efeaea] px-2"
					>
						<span class="flex items-center gap-1">
							<span
								class="rounded-md px-2 py-1 transition-colors {shellOpen
									? 'text-[#75696b]'
									: 'bg-[#f1eeee] font-medium'}">Logs</span
							>
							{#if shellOpen}
								<span
									class="flex items-center gap-1.5 rounded-md bg-[#f1eeee] px-2 py-1 font-medium"
									in:fly={{ x: -6, duration: 220 }}
								>
									<Terminal size={10} /> 6d9f8 / site <X size={9} class="text-[#75696b]" />
								</span>
							{/if}
						</span>
						<span class="flex items-center gap-2.5 text-[#75696b]">
							{#if !shellOpen}
								<span class="flex items-center gap-1 max-sm:hidden"
									><Boxes size={11} /> 6d9f8 / site <ChevronDown size={9} /></span
								>
								<RefreshCw size={11} class="max-sm:hidden" />
								<span class="flex items-center gap-1.5 font-medium text-[#0e8f69]"
									><span class="size-1.5 rounded-full bg-[#10b981]"></span>Live</span
								>
							{/if}
							<span
								class="flex items-center gap-1 rounded-md border border-[#e8e4e4] px-1.5 py-0.5 font-medium text-[#3a3233] transition {shellPress
									? 'scale-90 bg-[#f1eeee]'
									: 'bg-white'}"
							>
								<Terminal size={10} /> Shell
							</span>
							<Maximize2 size={11} />
						</span>
					</div>
					<div
						class="h-[calc(100%-37px)] overflow-hidden bg-[#f7f5f5] px-3 py-2 font-mono leading-[1.75] text-[#3a3233]"
					>
						{#if !shellOpen}
							<ul class="flex h-full flex-col justify-end">
								{#each logs as line (line.n)}
									<li class="truncate whitespace-nowrap" in:fade={{ duration: 160 }}>
										<span class="text-[#b3a9ab]">{line.time}</span>
										{line.ip} "{line.req} HTTP/1.1"
										<span class={line.code.startsWith('2') ? 'text-[#0e8f69]' : 'text-[#b45309]'}
											>{line.code}</span
										>
										{line.bytes}
									</li>
								{/each}
							</ul>
						{:else}
							<ul class="flex flex-col">
								{#each shellLines as line (line.cmd)}
									<li><span class="text-[#b8323f]">/app $</span> {line.cmd}</li>
									<li class="text-[#75696b]">{line.out}</li>
								{/each}
								<li>
									<span class="text-[#b8323f]">/app $</span>
									{shellDraft}<span class="caret ml-px text-[#3a3233]/60"></span>
								</li>
							</ul>
						{/if}
					</div>
				</div>
			</li>

			<li
				bind:this={domainTile}
				{@attach reveal({ index: 0, y: 24 })}
				class:tile-on={active === 2}
				class="tile lg:col-span-2"
			>
				{@render head(Globe, 'Custom domains', 'Bring your own domain.')}
				<div class="window h-[214px] p-3" aria-hidden="true">
					<p class="flex items-center justify-between">
						<span class="text-[13px] font-semibold">Domains</span>
						<span
							class="flex items-center gap-1 rounded-md border border-[#e8e4e4] px-1.5 py-0.5 text-[10.5px] text-[#3a3233]"
							><Plus size={10} /> Add domain</span
						>
					</p>
					<div class="relative mt-2.5 h-[166px]">
						{#if !added}
							<div class="absolute inset-0 flex flex-col gap-2" out:fade={{ duration: 140 }}>
								<p
									class="rounded-md border px-2 py-1.5 font-mono text-[11px] {domain
										? 'border-[#b8323f]/50'
										: 'border-[#e8e4e4]'}"
								>
									{#if domain}{domain}{:else}<span class="text-[#b3a9ab]">app.example.com</span
										>{/if}
								</p>
								<div class="rounded-md bg-[#f7f4f4] px-2 py-1.5 font-mono text-[10.5px]">
									<p class="grid grid-cols-[46px_40px_1fr] text-[#75696b]">
										<span>Type</span><span>Name</span><span>Value</span>
									</p>
									<p class="mt-0.5 grid grid-cols-[46px_40px_1fr_auto] items-center">
										<span>CNAME</span><span>site</span><span>orchard.example.com</span><Copy
											size={10}
											class="text-[#75696b]"
										/>
									</p>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span>
										<span class="block text-[11px] font-medium">Enable SSL</span>
										<span class="block text-[10px] text-[#75696b]">Let's Encrypt certificate</span>
									</span>
									<span class="switch" class:switch-on={ssl}><span></span></span>
								</div>
								<p class="mt-auto flex justify-end gap-2 text-[11px]">
									<span class="rounded-md border border-[#e8e4e4] px-2 py-1">Cancel</span>
									<span
										class="rounded-md bg-[#b8323f] px-2 py-1 font-semibold text-white transition-transform {addPress
											? 'scale-90'
											: ''}">Add domain</span
									>
								</p>
							</div>
						{:else}
							<ul class="absolute inset-0 flex flex-col gap-1.5">
								{#each DOMAINS as d, i (d.host)}
									<li
										class="flex items-center justify-between gap-2 rounded-xl border border-[#e8e4e4] bg-white px-2.5 py-2"
										in:fly={{ y: 8, duration: 320, delay: 170 + i * 80 }}
									>
										<span class="min-w-0">
											{#if d.redirect}
												<span class="block text-[10px] text-[#75696b]"
													>301 redirect to {d.redirect}</span
												>
											{/if}
											<span class="block truncate text-[12px] font-medium">https://{d.host}</span>
										</span>
										<span class="flex shrink-0 gap-1.5 text-[#75696b]">
											{#if d.redirect}<PenLine size={13} />{:else}<Shield size={13} />{/if}
											<Trash2 size={13} />
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>
			</li>

			<li
				bind:this={jobTile}
				{@attach reveal({ index: 1, y: 24 })}
				class:tile-on={active === 3}
				class="tile lg:col-span-2"
			>
				{@render head(CalendarClock, 'Jobs and pipelines', 'Run nightly backups or pipelines.')}
				<div class="window h-[214px] p-3" aria-hidden="true">
					<p class="flex items-center gap-1.5 text-[10.5px] text-[#75696b]">
						<ArrowLeft size={10} /> nightly-backup
					</p>
					<p class="mt-1 flex items-center gap-2">
						<span class="text-[15px] font-bold">Run #42</span>
						{#if running}
							<span
								class="flex items-center gap-1 rounded-full bg-[#fdf1e4] px-2 py-0.5 text-[10.5px] font-medium text-[#b45309]"
								><LoaderCircle size={10} class="spin" /> Running</span
							>
						{:else}
							<span
								class="flex items-center gap-1 rounded-full bg-[#e6f6f0] px-2 py-0.5 text-[10.5px] font-medium text-[#0e8f69]"
								><span class="size-1.5 rounded-full bg-[#10b981]"></span>Succeeded</span
							>
						{/if}
					</p>
					<p class="mt-0.5 truncate text-[10.5px] text-[#75696b]">
						<span class="font-mono">0 3 * * *</span> · next run in
						<span class="font-mono tabular-nums">{countdown}</span>
					</p>
					<div class="mt-2.5 rounded-lg border border-[#e8e4e4] bg-[#faf8f8] p-2">
						<p
							class="flex items-center gap-1 text-[9.5px] font-semibold tracking-wider text-[#75696b]"
						>
							<FileText size={9} /> SCRIPT
						</p>
						<p class="mt-1 flex items-center gap-2 text-[11.5px]">
							{#if running}
								<LoaderCircle size={13} class="spin text-[#b8323f]" />
							{:else}
								<span class="grid size-3.5 place-items-center rounded-full bg-[#10b981] text-white"
									><Check size={9} strokeWidth={3.5} /></span
								>
							{/if}
							<span class="font-medium">back up site-db</span>
							<span class="ml-auto font-mono text-[10.5px] text-[#75696b]"
								>{running ? '…' : '12s'}</span
							>
						</p>
						<ul
							class="mt-1.5 min-h-[44px] rounded-md border border-[#efeaea] bg-white px-2 py-1.5 font-mono text-[10px] leading-[1.6] text-[#3a3233]"
						>
							{#if stdout > 0}<li in:fade={{ duration: 160 }}>
									<span class="text-[#b3a9ab]">03:00:01</span> pg_dump: dumping site-db
								</li>{/if}
							{#if stdout > 1}<li in:fade={{ duration: 160 }}>
									<span class="text-[#b3a9ab]">03:00:12</span> uploaded 124 MB
								</li>{/if}
						</ul>
					</div>
				</div>
			</li>

			<li
				bind:this={tplTile}
				{@attach reveal({ index: 2, y: 24 })}
				class:tile-on={active === 4}
				class="tile lg:col-span-2"
			>
				{@render head(
					LayoutTemplate,
					'Templates',
					'Spin up a Minecraft server, n8n, Open WebUI and 90 more apps in one click.'
				)}
				<div class="window h-[214px] p-3" aria-hidden="true">
					<p class="flex items-center justify-between gap-2">
						<span class="text-[13px] font-semibold">Templates</span>
						<span
							class="flex w-[48%] items-center gap-1 rounded-md border border-[#e8e4e4] px-1.5 py-0.5 text-[10px] text-[#75696b]"
							><Search size={10} class="shrink-0" /><span class="truncate">Search templates</span
							></span
						>
					</p>
					<ul class="mt-2.5 grid grid-cols-2 gap-1.5">
						{#each TEMPLATES as template, i (template.name)}
							{@const Icon = template.icon}
							<li class="tpl-card" class:tpl-hot={i === 0 && tplStage !== 'idle'}>
								<span class="flex items-center justify-between gap-1">
									<span
										class="grid size-6 place-items-center rounded-md bg-[#fbe9eb] text-[#b8323f]"
										><Icon size={12} /></span
									>
									{#if i === 0 && tplStage === 'deploying'}
										<span class="tpl-badge bg-[#fbe9eb] text-[#b8323f]" in:fade={{ duration: 150 }}
											><LoaderCircle size={9} class="spin" /> Deploying</span
										>
									{:else if i === 0 && tplStage === 'live'}
										<span class="tpl-badge bg-[#e7f7ef] text-[#047857]" in:fade={{ duration: 150 }}
											><span class="size-1.5 rounded-full bg-[#10b981]"></span> Running</span
										>
									{:else}
										<span class="tpl-badge bg-[#f4f1f1] text-[#75696b]">{template.category}</span>
									{/if}
								</span>
								<span class="mt-1.5 block truncate text-[11px] font-semibold">{template.name}</span>
								<span class="block truncate text-[9.5px] text-[#75696b]">{template.about}</span>
							</li>
						{/each}
					</ul>
				</div>
			</li>

			<li
				bind:this={pingTile}
				{@attach reveal({ index: 0, y: 24 })}
				class:tile-on={active === 5}
				class="tile lg:col-span-3"
			>
				{@render head(
					Slack,
					'Alerts',
					'Hear about deploys and crashes in Slack, Discord, email, or a webhook.'
				)}
				<div class="window h-[150px]" aria-hidden="true">
					<div class="h-full bg-[#faf8f8]">
						<ol class="feed flex h-full flex-col gap-2 p-3">
							{#each feed as ping, i (ping.key)}
								{@const Icon = ping.icon}
								<li
									animate:flip={{ duration: 450, easing: cubicOut }}
									in:fly={{ y: -12, duration: 450, easing: cubicOut }}
									class="flex shrink-0 items-center gap-3 rounded-xl bg-white px-3 py-2 shadow-[0_8px_20px_-14px_rgb(120_0_20/0.45)] ring-1 ring-[#efeaea]"
								>
									<span
										class="grid size-8 shrink-0 place-items-center rounded-lg bg-[#fbe9eb] text-[#b8323f]"
									>
										<Icon size={15} strokeWidth={2} />
									</span>
									<span class="min-w-0 flex-1">
										<span
											class="flex items-baseline justify-between gap-2 text-[10.5px] text-[#75696b]"
										>
											<span class="truncate font-medium">{ping.where}</span>
											<span class="shrink-0">{AGO[i]}</span>
										</span>
										<span class="block truncate text-[12.5px] font-semibold">{ping.text}</span>
									</span>
								</li>
							{/each}
						</ol>
					</div>
				</div>
			</li>

			<li
				bind:this={rollTile}
				{@attach reveal({ index: 1, y: 24 })}
				class:tile-on={active === 6}
				class="tile lg:col-span-3"
			>
				{@render head(History, 'Rollbacks', 'Mess something up? Go back to an earlier build.')}
				<div class="window h-[150px]" aria-hidden="true">
					<div
						class="grid h-full grid-cols-2 items-center gap-3 px-4 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,1.2fr)_minmax(0,1fr)]"
					>
						<div class="flex min-w-0 flex-col gap-0.5">
							{#key previous.ref}
								<span class="truncate text-[13px] font-semibold text-[#75696b]" in:fade
									>{previous.msg}</span
								>
								<span class="font-mono text-[10.5px] tracking-wide text-[#75696b]" in:fade
									>{previous.ref}</span
								>
								<span class="truncate text-[10.5px] text-[#9a8f91]" in:fade
									>{previous.when} · push by leafd</span
								>
							{/key}
							<span
								class="mt-1.5 inline-flex w-fit items-center gap-1 rounded-md border border-[#e8e4e4] bg-white px-2 py-1 text-[11px] font-medium transition-transform {rollPress
									? 'scale-90'
									: ''}"
							>
								{#if rolling}<LoaderCircle size={11} class="spin" />{:else}<RotateCcw
										size={11}
									/>{/if}
								Roll back
							</span>
						</div>
						<div class="rp hidden sm:flex">
							<span class="rp-dot"></span>
							<span class="rp-line"></span>
							{#if rolling}<span class="rp-runner"></span>{/if}
							<span class="rp-chip">
								<ArrowRight size={10} />
								<span class="flex items-center gap-0.5"><Timer size={10} />41s</span>
								<span class="flex items-center gap-0.5"><GitBranch size={10} />main</span>
							</span>
							<span class="rp-line"></span>
							<span class="rp-dot rp-dot-end"></span>
						</div>
						<div class="flex min-w-0 flex-col items-end gap-0.5 text-right">
							<span
								class="mb-0.5 flex items-center gap-1.5 rounded-full bg-[#10b981] px-2 py-0.5 text-[10.5px] font-semibold text-white"
								><span class="size-1.5 rounded-full bg-white"></span>Live</span
							>
							{#key live.ref}
								<span
									class="max-w-full truncate text-[14px] font-bold"
									in:fly={{ y: 6, duration: 300 }}>{live.msg}</span
								>
								<span class="font-mono text-[10.5px] tracking-wide text-[#75696b]" in:fade
									>{live.ref}</span
								>
								<span class="max-w-full truncate text-[10.5px] text-[#9a8f91]" in:fade
									>{fresh ? 'just now · by leafd' : `${live.when} · push by leafd`}</span
								>
							{/key}
						</div>
					</div>
				</div>
			</li>
		</ul>

		<div {@attach reveal({ index: 3 })} class="mt-10 flex flex-col items-center gap-4">
			<h3 class="text-sm font-semibold tracking-[0.12em] text-crimson-deep uppercase">
				Also in the box
			</h3>
			<ul class="flex max-w-[900px] flex-wrap justify-center gap-2">
				{#each ALSO as item (item)}
					<li
						class="rounded-lg bg-white/60 px-3 py-1.5 text-[15px] text-crimson-deep ring-1 ring-crimson/10"
					>
						{item}
					</li>
				{/each}
			</ul>
		</div>
	</div>
</section>

<style>
	.tile {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 1.25rem;
		border-radius: 1rem;
		padding: 1.5rem;
		background: rgb(255 255 255 / 0.62);
		box-shadow: inset 0 0 0 1px rgb(249 68 90 / 0.1);
	}

	.tile {
		transition:
			background-color 0.5s ease,
			box-shadow 0.5s ease;
	}

	.tile.tile-on {
		background: rgb(255 255 255 / 0.85);
		box-shadow:
			inset 0 0 0 1px rgb(249 68 90 / 0.22),
			0 22px 48px -34px rgb(120 0 20 / 0.55);
	}

	.window {
		transition: box-shadow 0.5s ease;
		position: relative;
		margin-top: auto;
		overflow: hidden;
		border-radius: 0.9rem;
		background: #fff;
		color: #1c1718;
		box-shadow:
			0 0 0 1px #ece6e6,
			0 20px 40px -30px rgb(120 0 20 / 0.5);
	}

	.tpl-card {
		border-radius: 0.5rem;
		border: 1px solid #ece8e8;
		background: #fff;
		padding: 0.5rem;
		transition:
			border-color 0.2s ease,
			box-shadow 0.2s ease;
	}

	.tpl-card.tpl-hot {
		border-color: #e79aa3;
		box-shadow: 0 0 0 1px rgb(184 50 63 / 0.25);
	}

	.tpl-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border-radius: 0.25rem;
		padding: 0.0625rem 0.375rem;
		font-size: 9px;
		font-weight: 500;
	}

	.feed {
		mask-image: linear-gradient(to bottom, #000 64%, transparent 98%);
	}

	.switch {
		position: relative;
		flex: none;
		width: 26px;
		height: 15px;
		border-radius: 999px;
		background: #e2dcdc;
		transition: background-color 0.25s ease;
	}

	.switch span {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 11px;
		height: 11px;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
		transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.switch-on {
		background: #b8323f;
	}

	.switch-on span {
		transform: translateX(11px);
	}

	.rp {
		position: relative;
		min-width: 0;
		height: 2.5rem;
		align-items: center;
	}

	.rp-line {
		flex: 1;
		height: 0;
		border-top: 1.5px dashed #a39495;
	}

	.rp-dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: #a39495;
	}

	.rp-dot-end {
		background: #33d6a6;
		box-shadow: 0 0 0 4px rgb(51 214 166 / 0.18);
	}

	.rp-chip {
		position: relative;
		z-index: 1;
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.45rem;
		margin: 0 0.25rem;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: #fff;
		box-shadow: inset 0 0 0 1px #efdddf;
		color: #75696b;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		white-space: nowrap;
	}

	.rp-runner {
		position: absolute;
		top: 50%;
		left: 0;
		width: 0.375rem;
		height: 0.375rem;
		margin-top: -0.1875rem;
		border-radius: 50%;
		background: #ff8c37;
		animation: rp-run 1.5s linear infinite;
	}

	@keyframes rp-run {
		from {
			left: 0;
			opacity: 0;
		}
		10% {
			opacity: 1;
		}
		90% {
			opacity: 1;
		}
		to {
			left: 100%;
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.switch,
		.switch span {
			transition: none;
		}

		.rp-runner {
			animation: none;
		}
	}
</style>
