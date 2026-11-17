<script lang="ts">
	import { onMount } from 'svelte';
	import { animate } from 'motion';
	import { fade } from 'svelte/transition';
	import {
		ArrowLeft,
		Check,
		ChevronDown,
		ChevronRight,
		Container,
		Cpu,
		EllipsisVertical,
		ExternalLink,
		Eye,
		Gauge,
		Github,
		History,
		LayoutGrid,
		LoaderCircle,
		Maximize2,
		MemoryStick,
		PanelLeft,
		Play,
		RefreshCw,
		Search,
		Settings2,
		ShieldCheck,
		Sprout,
		SquareTerminal,
		Timer,
		Variable,
		Wifi,
		X
	} from 'lucide-svelte';
	import { pause, prefersReduced, reveal, whileVisible } from '$lib/motion.svelte';

	const W = 1000;
	const H = 640;

	const STEPS = [
		{
			title: 'Pick a repo',
			body: 'Choose a repo and a branch. Orchard figures out the rest.',
			ms: 4800
		},
		{
			title: 'Watch it build',
			body: 'It builds on your own cluster, with logs streaming live.',
			ms: 5800
		},
		{
			title: "It's live",
			body: 'You get an HTTPS URL, and every push ships itself.',
			ms: 5500
		}
	];

	const NAV = [
		{ icon: Sprout, label: 'Your Apps' },
		{ icon: Timer, label: 'Jobs' },
		{ icon: Gauge, label: 'Usage' }
	];

	const BUILD = [
		{ label: 'Starting the builder', took: '1.4s' },
		{ label: 'Cloning the repo', took: '0.7s' },
		{ label: 'Building the image', took: '13.4s' },
		{ label: 'Pushing the image', took: '3.1s' },
		{ label: 'Rolling out', took: '' }
	];

	const LAYERS = [
		{ step: '[internal] load build definition from Dockerfile', took: '0.1s' },
		{ step: '[deps 1/3] FROM node:22-alpine', took: '1.8s' },
		{ step: '[deps 2/3] COPY package.json pnpm-lock.yaml ./', took: '0.2s' },
		{ step: '[deps 3/3] RUN pnpm install --frozen-lockfile', took: '7.9s' },
		{ step: '[build 2/2] RUN pnpm build', took: '5.2s' },
		{ step: 'exporting to image', took: '3.1s' }
	];

	const PODS = [
		{ name: '6d9f8', started: '2m ago' },
		{ name: 'k2x7q', started: 'just now' },
		{ name: 'm4pzt', started: 'just now' }
	];

	const RUNTIME = [
		'13:40:12.170 Starting up on port 3000',
		'13:40:12.402 GET /api/health 200 2ms',
		'13:40:13.018 GET / 200 11ms',
		'13:40:14.551 POST /api/signup 201 38ms',
		'13:40:15.209 GET /dashboard 200 24ms',
		'13:40:16.733 GET /api/projects 200 17ms'
	];

	let viewport = $state<HTMLElement | null>(null);
	let camera = $state<HTMLElement | null>(null);
	let cursor = $state<HTMLElement | null>(null);
	let fit = $state(0.8);
	let narrow = $state(false);

	let step = $state(0);
	let run = $state(0);
	let playing = $state(false);

	let repo = $state('');
	let branch = $state(false);
	let detected = $state(false);
	let port = $state(false);
	let pressing = $state(false);

	let building = $state(0);
	let layers = $state(0);
	let ticking = $state(0);

	const progress = $derived(
		Math.min(
			100,
			((building + (building === 1 ? layers / LAYERS.length : 0)) / (BUILD.length - 1)) * 100
		)
	);

	let replicas = $state(3);
	let logs = $state(RUNTIME.length);
	let pointerOn = $state(false);
	let clicking = $state(false);

	function place(el: HTMLElement) {
		let x = 0;
		let y = 0;
		let node: HTMLElement | null = el;
		while (node && node !== camera) {
			x += node.offsetLeft;
			y += node.offsetTop;
			node = node.offsetParent as HTMLElement | null;
		}
		return { x, y, w: el.offsetWidth, h: el.offsetHeight };
	}

	function target(name: string) {
		return camera?.querySelector<HTMLElement>(`[data-target="${name}"]`) ?? null;
	}

	function base() {
		if (!narrow) return { x: 0, y: 0, scale: 1 };
		const scale = W / 780;
		return { x: -206 * scale, y: 0, scale };
	}

	function frame(view: { x: number; y: number; scale: number }, instant = false) {
		if (!camera) return;
		animate(
			camera,
			view,
			instant ? { duration: 0 } : { type: 'spring', visualDuration: 0.9, bounce: 0.08 }
		);
	}

	function focus(name: string, zoom: number, pad = 34) {
		const el = target(name);
		if (!el) return;
		const box = place(el);
		const scale = Math.max(zoom, base().scale);
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		const x = Math.min(0, Math.max(W - W * scale, W / 2 - cx * scale));
		const centered = H / 2 - cy * scale;
		const y = Math.min(0, Math.max(H - H * scale, Math.max(centered, pad - box.y * scale)));
		frame({ x, y, scale });
	}

	async function point(name: string, signal: AbortSignal, dx = 0.5, dy = 0.5) {
		const el = target(name);
		if (!el || !cursor) return;
		const box = place(el);
		pointerOn = true;
		await animate(
			cursor,
			{ x: box.x + box.w * dx, y: box.y + box.h * dy },
			{ type: 'spring', visualDuration: 0.6, bounce: 0.12 }
		).finished;
		signal.throwIfAborted();
	}

	async function click(signal: AbortSignal) {
		clicking = true;
		await pause(160, signal);
		clicking = false;
	}

	function settle(i: number) {
		step = i;
		pointerOn = false;
		clicking = false;
		repo = 'hackclub/site';
		branch = true;
		detected = true;
		port = true;
		pressing = false;
		building = i > 1 ? BUILD.length : 1;
		layers = i > 1 ? LAYERS.length : 4;
		ticking = 6.2;
		replicas = 3;
		logs = RUNTIME.length;
		frame(base(), true);
	}

	async function scene(i: number, signal: AbortSignal) {
		step = i;
		run += 1;
		pointerOn = false;
		clicking = false;
		frame(base(), true);
		if (i === 0) {
			repo = '';
			branch = false;
			detected = false;
			port = false;
			pressing = false;
			if (cursor) animate(cursor, { x: 860, y: 560 }, { duration: 0 });
			await pause(500, signal);
			focus('page-a', 1.2, 40);
			await point('repo', signal, 0.4);
			await click(signal);
			for (const ch of 'hackclub/site') {
				repo += ch;
				await pause(45, signal);
			}
			await pause(200, signal);
			branch = true;
			await pause(320, signal);
			detected = true;
			await pause(360, signal);
			port = true;
			await pause(600, signal);
			frame(base());
			await point('deploy', signal);
			pressing = true;
			await click(signal);
			pressing = false;
			await pause(700, signal);
		} else if (i === 1) {
			building = 0;
			layers = 0;
			ticking = 0;
			await pause(350, signal);
			focus('page-b', 1.26, 40);
			for (let t = 0; t < 8; t++) {
				ticking = t * 0.3;
				await pause(90, signal);
			}
			building = 1;
			for (let l = 1; l <= LAYERS.length; l++) {
				layers = l;
				ticking = l * 2.2;
				await pause(l === 4 ? 620 : 380, signal);
			}
			building = 2;
			await pause(650, signal);
			building = 3;
			await pause(650, signal);
			building = BUILD.length;
			frame(base());
			await pause(900, signal);
		} else {
			replicas = 1;
			logs = 1;
			await pause(400, signal);
			logs = 3;
			await point('thumb', signal);
			focus('replicas', 1.45);
			await pause(500, signal);
			clicking = true;
			for (let r = 2; r <= 3; r++) {
				replicas = r;
				await pause(80, signal);
				const thumb = target('thumb');
				if (thumb && cursor) {
					const box = place(thumb);
					await animate(
						cursor,
						{ x: box.x + box.w / 2, y: box.y + box.h / 2 },
						{ type: 'spring', visualDuration: 0.35, bounce: 0 }
					).finished;
				}
				await pause(380, signal);
			}
			clicking = false;
			for (let l = 4; l <= RUNTIME.length; l++) {
				logs = l;
				await pause(260, signal);
			}
			await pause(500, signal);
			frame(base());
			await pause(1100, signal);
		}
	}

	let ctrl: AbortController | null = null;
	let visible = false;
	let next = 0;

	function play() {
		ctrl?.abort(new DOMException('restart', 'AbortError'));
		const current = new AbortController();
		ctrl = current;
		playing = true;
		(async () => {
			while (!current.signal.aborted) {
				const i = next;
				await scene(i, current.signal);
				next = (i + 1) % STEPS.length;
			}
		})().catch(() => {});
	}

	function halt() {
		ctrl?.abort(new DOMException('hidden', 'AbortError'));
		ctrl = null;
		playing = false;
	}

	function jump(i: number) {
		next = i;
		if (!prefersReduced() && visible) {
			play();
			return;
		}
		settle(i);
	}

	onMount(() => {
		const el = viewport;
		if (!el) return;
		const ro = new ResizeObserver(() => {
			fit = el.clientWidth / W;
			narrow = el.clientWidth < 560;
		});
		ro.observe(el);
		if (prefersReduced()) {
			settle(2);
			return () => ro.disconnect();
		}
		const stop = whileVisible(
			el,
			() => {
				visible = true;
				if (!ctrl) play();
			},
			() => {
				visible = false;
				halt();
			}
		);
		return () => {
			ro.disconnect();
			stop();
		};
	});
</script>

<section id="how" class="scroll-mt-24 pt-[clamp(3rem,5vw,80px)] pb-[clamp(6rem,10vw,160px)]">
	<div class="shell">
		<h2 {@attach reveal()} class="section-title text-crimson max-sm:text-left">What is Orchard?</h2>
		<p
			{@attach reveal({ index: 1 })}
			class="section-lead mx-auto mt-2 max-w-[640px] text-balance text-crimson-deep max-sm:text-left"
		>
			An open-source platform as a service that runs on your own servers. Connect a repo, and
			Orchard builds it, runs it, and gives it a URL.
		</p>

		<div
			class="mt-[clamp(2.5rem,5vw,72px)] grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-12"
		>
			<ol class="flex flex-col gap-3">
				{#each STEPS as s, i (s.title)}
					<li {@attach reveal({ index: i + 2 })}>
						<button
							type="button"
							onclick={() => jump(i)}
							aria-current={step === i ? 'step' : undefined}
							class="focus-ring w-full rounded-2xl p-5 text-left transition-[background-color,box-shadow,opacity] duration-300 {step ===
							i
								? 'bg-white/75 shadow-[0_18px_40px_-24px_rgb(195_16_38/0.45)] ring-1 ring-crimson/10'
								: 'hover:bg-white/35'}"
						>
							<span class="flex items-baseline gap-3">
								<span class="font-mono text-sm text-crimson-deep tabular-nums">{i + 1}</span>
								<span class="text-xl font-semibold text-crimson-deep">{s.title}</span>
							</span>
							<span class="mt-2 block pl-7 text-pretty text-crimson-deep">{s.body}</span>
							<span class="mt-4 ml-7 block h-1 overflow-hidden rounded-full bg-crimson/10">
								{#if step === i && playing}
									{#key run}
										<span
											class="step-bar block h-full rounded-full bg-crimson"
											style:animation-duration="{s.ms}ms"
										></span>
									{/key}
								{:else if step === i}
									<span class="block h-full w-full rounded-full bg-crimson"></span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ol>

			<div {@attach reveal({ index: 3, y: 24 })}>
				<div
					bind:this={viewport}
					class="relative overflow-hidden rounded-2xl border-4 border-crimson bg-[#f4f3f3] shadow-[0_40px_80px_-40px_rgb(120_0_20/0.55)]"
					style:aspect-ratio="{W} / {H}"
					aria-hidden="true"
				>
					<div
						class="app absolute top-0 left-0 origin-top-left"
						style:width="{W}px"
						style:height="{H}px"
						style:transform="scale({fit})"
					>
						<div bind:this={camera} class="relative size-full origin-top-left">
							<aside
								class="absolute top-[10px] bottom-[10px] left-[10px] flex w-[196px] flex-col rounded-[14px] border border-[#e8e4e4] bg-white p-[10px]"
							>
								<div class="flex items-center gap-2 px-1 py-1">
									<img
										src="/logo/logoiconcolor.svg"
										alt=""
										width="28"
										height="28"
										class="size-7 rounded-[8px]"
									/>
									<span class="flex-1 text-[14px] font-semibold">Orchard</span>
									<ChevronDown size={14} class="text-[#75696b]" />
								</div>
								<div
									class="mt-2 flex items-center gap-2 rounded-[8px] border border-[#e8e4e4] px-2.5 py-1.5 text-[12px] text-[#75696b]"
								>
									<Search size={13} />
									<span class="flex-1">Search</span>
									<span class="rounded bg-[#f1eeee] px-1 text-[10px]">⌘K</span>
								</div>
								<p class="mt-4 px-2 text-[11px] text-[#75696b]">Platform</p>
								<ul class="mt-1.5 flex flex-col gap-0.5">
									{#each NAV as item, n (item.label)}
										{@const Icon = item.icon}
										<li
											class="flex items-center gap-2.5 rounded-[8px] px-2 py-[6px] text-[13px] {n ===
											0
												? 'bg-[#fbe9eb] font-medium text-[#b8323f]'
												: 'text-[#3a3233]'}"
										>
											<Icon size={15} strokeWidth={1.75} />
											{item.label}
										</li>
									{/each}
								</ul>
								<div class="mt-auto flex items-center gap-2 border-t border-[#efeaea] px-1 pt-2.5">
									<span
										class="size-6 rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffadbd,#b8323f)]"
									></span>
									<span class="flex-1 font-mono text-[12px]">alfd</span>
									<PanelLeft size={14} class="text-[#75696b]" />
								</div>
							</aside>

							<div class="absolute top-0 right-0 bottom-0 left-[216px]">
								{#key step}
									<div
										class="absolute inset-0"
										in:fade={{ duration: 260, delay: 140 }}
										out:fade={{ duration: 140 }}
									>
										{#if step === 0}
											<div
												data-target="page-a"
												class="mx-auto flex h-full w-[470px] flex-col pt-10"
											>
												<p class="flex items-center gap-1.5 text-[12px] text-[#75696b]">
													Home <ChevronRight size={11} /> Homelab <ChevronRight size={11} />
													<span class="font-semibold text-[#1c1718]">New app</span>
												</p>
												<p class="mt-2 text-[24px] font-bold">New app</p>
												<p class="text-[13px] text-[#75696b]">
													Configure and launch a new service.
												</p>

												<div
													data-target="form"
													class="mt-4 rounded-[14px] border border-[#e8e4e4] bg-white"
												>
													<div
														class="flex items-center justify-between border-b border-[#efeaea] px-4 py-3"
													>
														<span class="text-[11px] font-semibold tracking-[0.1em] text-[#75696b]">
															SOURCE
														</span>
														<span class="flex rounded-[8px] bg-[#f1eeee] p-0.5 text-[11px]">
															<span class="flex items-center gap-1 px-2 py-1 text-[#75696b]">
																<Container size={11} /> Image
															</span>
															<span
																class="flex items-center gap-1 rounded-[6px] bg-white px-2 py-1 font-semibold shadow-sm"
															>
																<Github size={11} /> GitHub
															</span>
														</span>
													</div>
													<div class="flex flex-col gap-3 px-4 py-4 text-[13px]">
														<div>
															<p class="font-medium">Repository</p>
															<div class="mt-1.5 grid grid-cols-[150px_1fr] gap-2">
																<span
																	class="flex items-center gap-2 rounded-[8px] border border-[#e8e4e4] px-2.5 py-2"
																>
																	<span
																		class="grid size-4 place-items-center rounded-[4px] bg-[#e5484d] text-[9px] font-bold text-white"
																		>h</span
																	>
																	<span class="flex-1">hackclub</span>
																	<ChevronDown size={12} class="text-[#75696b]" />
																</span>
																<span
																	data-target="repo"
																	class="flex items-center gap-2 rounded-[8px] border px-2.5 py-2 transition-colors {repo
																		? 'border-[#b8323f]/60 ring-2 ring-[#b8323f]/15'
																		: 'border-[#e8e4e4]'}"
																>
																	<Github size={13} class="text-[#3a3233]" />
																	<span class="flex-1 truncate">
																		{#if repo}{repo}{:else}<span class="text-[#b3a9ab]"
																				>Search repositories</span
																			>{/if}
																	</span>
																	{#if repo}<X size={12} class="text-[#75696b]" />{/if}
																</span>
															</div>
														</div>
														<div>
															<p class="font-medium">Branch</p>
															<span
																class="mt-1.5 flex items-center justify-between rounded-[8px] border border-[#e8e4e4] px-2.5 py-2"
															>
																<span class={branch ? '' : 'text-[#b3a9ab]'}>
																	{branch ? 'main' : 'Select a branch'}
																</span>
																{#if branch}<X size={12} class="text-[#75696b]" />{/if}
															</span>
														</div>
														<div class="flex items-center justify-between gap-3">
															<p class="font-medium">Build with</p>
															<span
																class="detect flex w-[230px] items-center gap-2 rounded-[8px] border border-[#e8e4e4] px-2.5 py-2"
																class:detect-on={detected}
															>
																<Container size={13} class="text-[#3a3233]" />
																<span class="flex-1">{detected ? 'Dockerfile' : 'Detecting…'}</span>
																{#if detected}
																	<span
																		class="rounded bg-[#e6f6f0] px-1.5 text-[10px] font-semibold text-[#0e8f69]"
																		>found</span
																	>
																{/if}
																<ChevronDown size={12} class="text-[#75696b]" />
															</span>
														</div>
														<div
															class="flex items-center justify-between gap-3 border-t border-[#efeaea] pt-3"
														>
															<span>
																<span class="block font-medium">Ports</span>
																<span class="block text-[11px] text-[#75696b]">
																	The port your app listens on inside the container.
																</span>
															</span>
															<span
																class="detect rounded-[8px] border border-[#e8e4e4] px-3 py-1.5 font-mono text-[12px]"
																class:detect-on={port}
															>
																{port ? '3000 · http' : '-'}
															</span>
														</div>
													</div>
												</div>

												<div
													class="mt-auto mb-3 flex items-center justify-end gap-4 rounded-[14px] border border-[#e8e4e4] bg-white/90 px-4 py-2.5"
												>
													<span class="text-[13px] text-[#3a3233]">Cancel</span>
													<span
														data-target="deploy"
														class="rounded-full bg-[#b8323f] px-4 py-1.5 text-[13px] font-semibold text-white transition-transform duration-150 {pressing
															? 'scale-90'
															: ''}"
													>
														Deploy
													</span>
												</div>
											</div>
										{:else if step === 1}
											<div
												data-target="page-b"
												class="mx-auto flex h-full w-[470px] flex-col pt-10 pb-3"
											>
												<p class="flex items-center gap-1.5 text-[12px] text-[#75696b]">
													<ArrowLeft size={13} /> Back to project
												</p>
												<div
													class="mt-3 flex min-h-0 flex-1 flex-col rounded-[16px] border border-[#e8e4e4] bg-white px-5 pt-5 pb-4"
												>
													<p class="flex items-center justify-center gap-2 text-[19px] font-bold">
														<span
															class="size-2.5 rounded-full {building >= BUILD.length
																? 'bg-[#10b981]'
																: 'bg-[#f5a15a]'}"
														></span>
														{building >= BUILD.length ? 'site is live' : 'Building site'}
													</p>
													<p class="mt-1 text-center font-mono text-[11px] text-[#75696b]">
														main · Dockerfile
													</p>
													<p class="mt-2 flex justify-center">
														<span
															class="flex items-center gap-1.5 rounded-full border border-[#e8e4e4] px-3 py-1 font-mono text-[11px] text-[#b8323f]"
														>
															site.myorchardinstance.orchard.my <ExternalLink size={10} />
														</span>
													</p>

													<div
														data-target="progress"
														class="mt-4 flex flex-col gap-0.5 text-[13px]"
													>
														{#each BUILD as b, n (b.label)}
															<div
																class="flex items-center gap-2 rounded-[8px] px-2.5 py-[5px] transition-colors duration-300 {building ===
																n
																	? 'bg-[#fbe9eb] shadow-[0_6px_16px_-10px_rgb(184_50_63/0.6)]'
																	: ''}"
															>
																{#if building > n}
																	<span
																		class="grid size-4 place-items-center rounded-full bg-[#10b981] text-white"
																	>
																		<Check size={10} strokeWidth={3.5} />
																	</span>
																{:else if building === n}
																	<LoaderCircle size={16} class="spin text-[#b8323f]" />
																{:else}
																	<span class="size-4 rounded-full border-2 border-[#e2dcdc]"
																	></span>
																{/if}
																<span
																	class="flex-1 {building === n
																		? 'font-semibold text-[#b8323f]'
																		: building > n
																			? 'text-[#1c1718]'
																			: 'text-[#b3a9ab]'}"
																>
																	{b.label}
																</span>
																{#if building > n && b.took}
																	<span class="font-mono text-[11px] text-[#75696b]">{b.took}</span>
																{:else if building === n}
																	<span
																		class="font-mono text-[11px] font-bold text-[#b8323f] tabular-nums"
																		>{ticking.toFixed(1)}s</span
																	>
																{/if}
															</div>
														{/each}
													</div>

													<div class="mt-3 h-[6px] overflow-hidden rounded-full bg-[#f1eeee]">
														<div
															class="h-full rounded-full bg-[#b8323f] transition-[width] duration-500 ease-out"
															style:width="{progress}%"
														></div>
													</div>

													<div
														class="mt-3 min-h-0 flex-1 overflow-hidden rounded-[10px] border border-[#e8e4e4] bg-[#faf8f8]"
													>
														<p
															class="flex items-center justify-between border-b border-[#efeaea] px-3 py-2 text-[12px]"
														>
															<span>
																<span class="font-semibold">Logs</span>
																<span class="ml-1.5 text-[#75696b]">{layers} steps</span>
															</span>
															<span
																class="rounded-[6px] border border-[#e8e4e4] bg-white px-1.5 py-0.5 text-[10px]"
																>Raw logs</span
															>
														</p>
														<ul class="flex flex-col px-3 py-1.5 font-mono text-[10.5px]">
															{#each LAYERS.slice(0, layers) as layer (layer.step)}
																<li
																	class="flex items-center gap-2 py-[3px]"
																	in:fade={{ duration: 180 }}
																>
																	<Check size={11} strokeWidth={3} class="text-[#10b981]" />
																	<span class="flex-1 truncate text-[#3a3233]">{layer.step}</span>
																	<span class="text-[#75696b]">{layer.took}</span>
																</li>
															{/each}
														</ul>
													</div>
												</div>
											</div>
										{:else}
											<div class="flex h-full flex-col gap-2.5 py-2.5 pr-2.5">
												<p
													class="flex items-center gap-1.5 self-start rounded-full border border-[#e8e4e4] bg-white px-3 py-1.5 text-[12px] text-[#75696b]"
												>
													Home <ChevronRight size={11} /> Homelab <ChevronRight size={11} />
													<span class="font-semibold text-[#1c1718]">site</span>
												</p>
												<div
													class="flex items-start justify-between rounded-[14px] border border-[#e8e4e4] bg-white px-5 py-4"
												>
													<div>
														<p class="flex items-center gap-2">
															<span class="text-[24px] font-medium">site</span>
															<span
																class="flex items-center gap-1.5 rounded-full bg-[#e6f6f0] px-2 py-0.5 text-[11px] font-medium text-[#0e8f69]"
															>
																<span class="size-1.5 rounded-full bg-[#10b981]"></span>Running
															</span>
															<span
																class="rounded-full border border-[#e8e4e4] px-2 py-0.5 text-[11px] text-[#3a3233]"
																>Production</span
															>
														</p>
														<p class="mt-1 font-mono text-[12px] font-bold">hackclub/site</p>
														<p
															class="mt-2 inline-flex items-center gap-1 rounded-full bg-[#f4f1f1] px-2.5 py-1 text-[11px] text-[#3a3233]"
														>
															site.myorchardinstance.orchard.my <ExternalLink size={10} />
														</p>
													</div>
													<span class="flex items-center gap-2">
														<span
															class="flex items-center gap-1.5 rounded-[8px] border border-[#e8e4e4] px-2.5 py-1.5 text-[12px] font-medium"
														>
															<Play size={11} /> Restart
														</span>
														<EllipsisVertical size={14} class="text-[#75696b]" />
													</span>
												</div>
												<div
													class="flex items-center gap-4 rounded-[14px] border border-[#e8e4e4] bg-white px-2 py-1.5 text-[12px] text-[#3a3233]"
												>
													<span
														class="flex items-center gap-1.5 rounded-[8px] bg-[#f4f1f1] px-2.5 py-1 font-medium text-[#1c1718]"
													>
														<LayoutGrid size={12} /> Overview
													</span>
													<span class="flex items-center gap-1.5"
														><Variable size={12} /> Variables</span
													>
													<span class="flex items-center gap-1.5"
														><History size={12} /> Activity</span
													>
													<span class="flex items-center gap-1.5"><Eye size={12} /> Observe</span>
													<span class="flex items-center gap-1.5"><Wifi size={12} /> Network</span>
													<span class="flex items-center gap-1.5 max-xl:hidden"
														><ShieldCheck size={12} /> Security</span
													>
													<span class="flex items-center gap-1.5"
														><Settings2 size={12} /> Settings</span
													>
												</div>
												<div class="flex min-h-0 flex-1 gap-2.5">
													<div
														class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-[#1c1d21] text-[#d9d9de]"
													>
														<p
															class="flex items-center justify-between border-b border-white/8 px-3 py-2 text-[11px]"
														>
															<span class="rounded-[6px] bg-white/8 px-1.5 py-0.5">Logs</span>
															<span class="flex items-center gap-2.5 font-mono text-[#a3a3ab]">
																6d9f8 / site <RefreshCw size={11} /> Live
																<span
																	class="flex items-center gap-1 rounded-[5px] border border-white/10 px-1.5 py-0.5"
																	><SquareTerminal size={10} /> Shell</span
																>
																<Maximize2 size={11} />
															</span>
														</p>
														<ul class="flex flex-col gap-1 px-3 py-2.5 font-mono text-[10.5px]">
															{#each RUNTIME.slice(0, logs) as line (line)}
																<li class="truncate" in:fade={{ duration: 160 }}>{line}</li>
															{/each}
														</ul>
													</div>
													<div class="flex w-[210px] shrink-0 flex-col gap-2">
														<div
															class="rounded-[14px] border border-[#e8e4e4] bg-white px-3 py-2.5"
														>
															<p
																class="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-[#75696b]"
															>
																<Cpu size={11} /> CPU
															</p>
															<p class="font-mono text-[16px] font-bold">{12 * replicas + 18}m</p>
														</div>
														<div
															class="rounded-[14px] border border-[#e8e4e4] bg-white px-3 py-2.5"
														>
															<p
																class="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-[#75696b]"
															>
																<MemoryStick size={11} class="text-[#b8323f]" /> MEMORY
															</p>
															<p class="font-mono text-[16px] font-bold">{34 * replicas} MB</p>
														</div>
														<div
															data-target="replicas"
															class="flex flex-1 flex-col rounded-[14px] border border-[#e8e4e4] bg-white px-3 py-2.5"
														>
															<p
																class="flex items-center justify-between text-[11px] font-medium text-[#75696b]"
															>
																REPLICAS
																<span class="text-[16px] font-bold text-[#1c1718] tabular-nums"
																	>{replicas}</span
																>
															</p>
															<div class="relative mt-2 h-[14px]">
																<span
																	class="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 rounded-full bg-[#f1eeee]"
																></span>
																<span
																	class="absolute top-1/2 left-0 h-[4px] -translate-y-1/2 rounded-full bg-[#ffc9d2] transition-[width] duration-300"
																	style:width="{(replicas / 20) * 100}%"
																></span>
																<span
																	data-target="thumb"
																	class="absolute top-1/2 size-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#b8323f] bg-white transition-[left] duration-300"
																	style:left="{(replicas / 20) * 100}%"
																></span>
															</div>
															<p class="mt-1 flex justify-between text-[10px] text-[#75696b]">
																<span>0</span><span>20</span>
															</p>
															<p
																class="mt-2 flex items-center justify-between border-t border-[#efeaea] pt-2 text-[11px]"
															>
																<span class="font-medium text-[#75696b]">PODS {replicas}</span>
																<span class="flex items-center gap-1 text-[#0e8f69]">
																	<span class="size-1.5 rounded-full bg-[#10b981]"></span>{replicas} ready
																</span>
															</p>
															<ul class="mt-1.5 flex flex-col gap-1">
																{#each PODS as pod, n (pod.name)}
																	<li
																		class="pod flex items-center justify-between rounded-[8px] px-2 py-1 {n ===
																		0
																			? 'bg-[#f7f4f4]'
																			: ''}"
																		class:pod-on={replicas > n}
																	>
																		<span>
																			<span class="block font-mono text-[11px] font-bold"
																				>{pod.name}</span
																			>
																			<span class="block text-[10px] text-[#75696b]"
																				>Started {pod.started}</span
																			>
																		</span>
																		<span
																			class="flex items-center gap-1 rounded-full bg-[#e6f6f0] px-1.5 py-0.5 text-[10px] font-medium text-[#0e8f69]"
																		>
																			<span class="size-1.5 rounded-full bg-[#10b981]"></span>Ready
																		</span>
																	</li>
																{/each}
															</ul>
														</div>
													</div>
												</div>
											</div>
										{/if}
									</div>
								{/key}
							</div>

							<div
								bind:this={cursor}
								class="cursor pointer-events-none absolute top-0 left-0 z-10"
								class:cursor-on={pointerOn}
							>
								<span class="ripple" class:ripple-on={clicking}></span>
								<svg
									viewBox="0 0 24 24"
									class="cursor-arrow size-[22px] drop-shadow-[0_2px_3px_rgb(0_0_0/0.3)]"
									class:cursor-down={clicking}
								>
									<path
										d="M4 2.5 L4 19.5 L8.6 15.2 L11.6 21.6 L14.6 20.2 L11.7 14 L18 14 Z"
										fill="#141011"
										stroke="#fff"
										stroke-width="1.6"
										stroke-linejoin="round"
									/>
								</svg>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</section>

<style>
	.step-bar {
		width: 0;
		animation: step-fill linear forwards;
	}

	@keyframes step-fill {
		to {
			width: 100%;
		}
	}

	.app {
		font-family: var(--font-sans);
		color: #1c1718;
	}

	.detect {
		transition:
			box-shadow 0.4s ease,
			border-color 0.4s ease;
	}

	.detect-on {
		border-color: rgb(16 185 129 / 0.55);
		box-shadow: 0 0 0 3px rgb(16 185 129 / 0.14);
	}

	.pod {
		opacity: 0;
		transform: translateY(6px) scale(0.96);
		transition:
			opacity 0.25s ease,
			transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.pod-on {
		opacity: 1;
		transform: none;
	}

	.cursor {
		opacity: 0;
		transition: opacity 0.25s ease;
	}

	.cursor-on {
		opacity: 1;
	}

	.cursor-arrow {
		transition: transform 0.12s ease;
		transform-origin: 4px 2px;
	}

	.cursor-down {
		transform: scale(0.84);
	}

	.ripple {
		position: absolute;
		left: -14px;
		top: -14px;
		width: 32px;
		height: 32px;
		border-radius: 999px;
		border: 2px solid #b8323f;
		opacity: 0;
		transform: scale(0.3);
	}

	.ripple-on {
		animation: ripple 0.5s ease-out;
	}

	@keyframes ripple {
		from {
			opacity: 0.8;
			transform: scale(0.3);
		}
		to {
			opacity: 0;
			transform: scale(1.3);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.detect,
		.pod,
		.cursor,
		.cursor-arrow {
			transition: none;
		}

		.step-bar,
		.ripple-on {
			animation: none;
		}
	}
</style>
