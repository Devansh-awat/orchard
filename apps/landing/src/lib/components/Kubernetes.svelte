<script lang="ts">
	import { onMount } from 'svelte';
	import { scroll } from 'motion';
	import { Check } from 'lucide-svelte';
	import WaveEdge from './WaveEdge.svelte';
	import { MARK_RING, MARK_VIEWBOX, PETALS, petalBox } from '$lib/mark';
	import { prefersReduced } from '$lib/motion.svelte';
	import type { MarkScene, Vec3 } from '$lib/mark3d';

	type Feature = {
		title: string;
		body: string;
		yaml: string;
		at: Vec3;
		tilt: number;
		wide?: boolean;
	};

	const FEATURES: Feature[] = [
		{
			title: 'Rolling deploys',
			body: 'New pods have to go ready before the old ones stop.',
			yaml: 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  strategy:\n    rollingUpdate:\n      maxSurge: 25%\n      maxUnavailable: 0',
			at: [-24, 26, 16],
			tilt: -5,
			wide: true
		},
		{
			title: 'Self-healing',
			body: 'A pod that crashes gets restarted, even at 3am.',
			yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: site\nspec:\n  replicas: 3',
			at: [28, 2, 16],
			tilt: 5
		},
		{
			title: 'Postgres failover',
			body: 'Run 2 or more instances and a standby takes over if the primary’s server dies.',
			yaml: 'apiVersion: postgresql.cnpg.io/v1\nkind: Cluster\nmetadata:\n  name: site-db\nspec:\n  instances: 2',
			at: [22, -26, 12],
			tilt: -3,
			wide: true
		},
		{
			title: 'Node maintenance',
			body: 'Apps with 2 or more replicas keep a pod running while you drain a server.',
			yaml: 'apiVersion: policy/v1\nkind: PodDisruptionBudget\nspec:\n  minAvailable: 1',
			at: [-30, 2, 4],
			tilt: -4,
			wide: true
		},
		{
			title: 'Node pools',
			body: 'Run heavy apps on the big box and everything else on the cheap ones.',
			yaml: 'kind: Deployment\nspec:\n  template:\n    spec:\n      tolerations:\n        - key: gpu\n          effect: NoSchedule',
			at: [-26, -22, 12],
			tilt: 3
		},
		{
			title: 'Resource quotas',
			body: 'Cap each project’s CPU and memory, so one can’t starve the others.',
			yaml: 'apiVersion: v1\nkind: ResourceQuota\nmetadata:\n  name: orchard-org-quota\nspec:\n  hard:\n    requests.cpu: 4000m\n    pods: "200"',
			at: [26, 30, 8],
			tilt: 4,
			wide: true
		}
	];

	function parse(yaml: string) {
		return yaml.split('\n').map((line) => {
			const match = line.match(/^(\s*(?:- )?)([^:]+):(.*)$/);
			if (!match) return { indent: '', key: line, value: '' };
			return { indent: match[1], key: match[2], value: match[3] };
		});
	}

	let section = $state<HTMLElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let ring = $state<HTMLElement | null>(null);
	let cards: HTMLElement[] = $state([]);
	let handled = $state(0);
	let active = $state(0);
	let still = $state(false);
	let flat = $state(false);

	const STORY_START = 0.2;
	const STORY_LENGTH = 0.4;

	function smoothstep(a: number, b: number, v: number) {
		const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
		return t * t * (3 - 2 * t);
	}

	onMount(() => {
		const el = section;
		const surface = canvas;
		if (!el || !surface) return;
		still = prefersReduced();

		let scene: MarkScene | null = null;
		let wide = window.innerWidth >= 1024;
		let disposed = false;
		let visible = false;
		let snapped = false;
		let progress = 0;
		const cleanups: (() => void)[] = [];
		const step = STORY_LENGTH / FEATURES.length;

		const pulls = () => {
			if (still) return FEATURES.map(() => 1);
			return FEATURES.map((_, i) => {
				const start = STORY_START + step * i;
				return smoothstep(start, start + step * 1.4, progress);
			});
		};

		const focus = () => {
			const at = Math.floor((progress - STORY_START) / step);
			return Math.min(FEATURES.length - 1, Math.max(0, at));
		};

		const layout = () => {
			wide = window.innerWidth >= 1024;
			if (!scene) return;
			scene.offset = [0, 0];
			scene.scale = wide ? 0.78 : 0.95;
			scene.resize();
		};

		const shockwave = () => {
			const s = scene;
			const r = ring;
			if (!s || !r) return;
			const center = s.project([s.offset[0], s.offset[1], 0]);
			r.style.left = `${center.x}px`;
			r.style.top = `${center.y}px`;
			r.classList.remove('ring-go');
			void r.offsetWidth;
			r.classList.add('ring-go');
		};

		const place = (time: number) => {
			const s = scene;
			if (!s) return;
			const [ox, oy] = s.offset;
			const narrow = window.innerWidth < 640;
			const spread = wide ? 1 : narrow ? 0.55 : 0.75;
			const shrink = narrow ? 0.66 : wide ? 0.92 : 0.8;
			const w = surface.clientWidth;
			const h = surface.clientHeight;
			const each = pulls();
			let absorbed = 0;
			FEATURES.forEach((m, i) => {
				const card = cards[i];
				if (!card) return;
				const pull = each[i];
				if (pull > 0.9) absorbed += 1;
				const bob = Math.sin(time * 0.7 + i * 1.9) * 1.2 * (1 - pull);
				const loose = 1 - pull;
				const point = s.project([
					ox + m.at[0] * spread * loose,
					oy + (m.at[1] * spread + bob) * loose,
					m.at[2] * loose
				]);
				const scale = point.scale * shrink * (1 - pull * 0.75);
				const halfW = (card.offsetWidth * scale) / 2 + 8;
				const halfH = (card.offsetHeight * scale) / 2 + 8;
				const x = Math.min(Math.max(point.x, halfW), w - halfW);
				const y = Math.min(Math.max(point.y, halfH + (wide ? 72 : 8)), h - halfH);
				card.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) rotate(${m.tilt * loose}deg) scale(${scale})`;
				card.style.opacity = String(1 - smoothstep(0.55, 0.95, pull));
			});
			if (absorbed !== handled) handled = absorbed;
			const next = focus();
			if (next !== active) active = next;
			s.assembly = each.reduce((sum, v) => sum + v, 0) / each.length;
			if (!snapped && s.assembly >= 0.985) {
				snapped = true;
				shockwave();
			} else if (snapped && s.assembly < 0.6) {
				snapped = false;
			}
		};

		const boot = async () => {
			try {
				const { createMarkScene } = await import('$lib/mark3d');
				if (disposed) return;
				scene = createMarkScene(surface, { onFrame: place });
			} catch (error) {
				console.error('[kubernetes] 3d mark unavailable', error);
				flat = true;
				handled = FEATURES.length;
				return;
			}
			layout();
			if (still) {
				scene.assembly = 1;
				scene.renderOnce();
				place(0);
				return;
			}
			const io = new IntersectionObserver(
				(entries) => {
					visible = entries.some((e) => e.isIntersecting);
					if (visible) scene?.start();
					else scene?.stop();
				},
				{ rootMargin: '120px 0px' }
			);
			io.observe(el);
			cleanups.push(() => io.disconnect());
			const onMove = (e: PointerEvent) => {
				if (!visible) return;
				scene?.pointer(
					(e.clientX / window.innerWidth) * 2 - 1,
					(e.clientY / window.innerHeight) * 2 - 1
				);
			};
			window.addEventListener('pointermove', onMove, { passive: true });
			cleanups.push(() => window.removeEventListener('pointermove', onMove));
			cleanups.push(
				scroll(
					(p: number) => {
						progress = p;
						if (scene) scene.turn = -0.5 * p;
					},
					{ target: el, offset: ['start end', 'end start'] }
				)
			);
		};

		const warm = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				warm.disconnect();
				import('$lib/mark3d').catch(() => {});
			},
			{ rootMargin: '900px 0px' }
		);
		warm.observe(el);
		const near = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				near.disconnect();
				boot();
			},
			{ rootMargin: '300px 0px' }
		);
		near.observe(el);
		if (still) handled = FEATURES.length;

		const onResize = () => layout();
		window.addEventListener('resize', onResize);

		return () => {
			disposed = true;
			warm.disconnect();
			near.disconnect();
			window.removeEventListener('resize', onResize);
			cleanups.forEach((fn) => fn());
			scene?.dispose();
		};
	});
</script>

<section
	id="kubernetes"
	bind:this={section}
	class="relative overflow-x-clip bg-crimson text-white"
	aria-labelledby="kubernetes-title"
>
	<WaveEdge fill="#f9445a" class="absolute inset-x-0 bottom-full" />
	<div class="k8s-glow pointer-events-none absolute inset-0" aria-hidden="true"></div>

	<div
		class="shell layout relative grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-x-10"
	>
		<div class="visual lg:order-2">
			<div class="visual-frame">
				<canvas
					bind:this={canvas}
					class="absolute inset-0 size-full"
					class:hidden={flat}
					aria-hidden="true"
				></canvas>
				<span bind:this={ring} class="shock pointer-events-none absolute" aria-hidden="true"></span>

				{#if flat}
					<div
						class="absolute top-1/2 left-1/2 aspect-square w-[min(70%,440px)] -translate-x-1/2 -translate-y-1/2"
						aria-hidden="true"
					>
						<svg viewBox={MARK_VIEWBOX} class="size-full">
							<path d={MARK_RING} fill="#fff1f3" fill-rule="evenodd" />
						</svg>
						{#each PETALS as petal, i (i)}
							{@const b = petalBox(petal)}
							<div
								class="absolute rounded-full bg-[#fff1f3]"
								style:left="{b.left}%"
								style:top="{b.top}%"
								style:width="{b.size}%"
								style:height="{b.size}%"
							></div>
						{/each}
					</div>
				{:else}
					<div class="pointer-events-none absolute inset-0" aria-hidden="true">
						{#each FEATURES as m, i (m.title)}
							<div
								bind:this={cards[i]}
								class="k8s-card absolute top-0 left-0 w-max rounded-xl bg-cream px-3.5 py-3 font-mono text-[11px] leading-[1.55] text-crimson-deep"
								class:max-sm:hidden={!m.wide}
								style:opacity="0"
							>
								{#each parse(m.yaml) as line, l (l)}
									<p class="whitespace-pre">
										{line.indent}<span class="text-crimson-deep/70">{line.key}:</span><span
											class:font-bold={line.key === 'kind'}>{line.value}</span
										>
									</p>
								{/each}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<div class="story lg:order-1">
			<header>
				<h2
					id="kubernetes-title"
					class="text-[clamp(2rem,3.6vw,3rem)] leading-[1.1] font-bold tracking-[-0.025em] text-balance"
				>
					<span class="block">Real Kubernetes.</span>
					<span class="block">No YAML.</span>
				</h2>
			</header>

			<ol class="captions" class:captions-all={still || flat}>
				{#each FEATURES as m, i (m.title)}
					<li class="caption" class:caption-on={still || flat || active === i}>
						<p class="text-[1.0625rem] font-bold">{m.title}</p>
						<p class="mt-1.5 text-base leading-normal text-pretty">{m.body}</p>
					</li>
				{/each}
			</ol>

			{#if !still && !flat}
				<div class="-mt-2 flex gap-1.5" aria-hidden="true">
					{#each FEATURES as m, i (m.title)}
						<span
							class="tick grid size-5 place-items-center rounded-full"
							class:tick-on={handled > i}
						>
							<Check size={11} strokeWidth={3.5} />
						</span>
					{/each}
				</div>
			{/if}

			<p class="text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-bold text-balance">
				Never touch YAML again.
			</p>
		</div>
	</div>

	<WaveEdge fill="#ffdfe3" class="absolute inset-x-0 bottom-0 z-10" />
</section>

<style>
	.k8s-glow {
		background:
			radial-gradient(40% 30% at 75% 30%, rgb(255 255 248 / 0.16), transparent 70%),
			radial-gradient(60% 50% at 70% 60%, rgb(195 16 38 / 0.3), transparent 75%);
	}

	.layout {
		min-height: max(100svh, 620px);
	}

	.visual {
		position: relative;
	}

	.visual-frame {
		position: absolute;
		inset: 0;
	}

	.story {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: clamp(1.5rem, 4vh, 2.5rem);
		padding-block: clamp(5rem, 11vh, 7rem) clamp(5rem, 12vh, 7rem);
	}

	.captions {
		display: grid;
		max-width: 360px;
	}

	.caption {
		grid-area: 1 / 1;
		border-radius: 1rem;
		padding: 1rem 1.25rem;
		background: var(--color-cream);
		color: var(--color-crimson-deep);
		opacity: 0;
		transform: translateY(8px) scale(0.97);
		transform-origin: 0 50%;
		transition:
			opacity 0.25s ease,
			transform 0.4s cubic-bezier(0.34, 1.4, 0.64, 1);
		box-shadow: 0 24px 50px -28px rgb(80 0 14 / 0.6);
	}

	.caption-on {
		opacity: 1;
		transform: none;
	}

	.captions-all {
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0.75rem;
		max-width: none;
	}

	.captions-all .caption {
		grid-area: auto;
	}

	.k8s-card {
		box-shadow:
			0 1px 0 rgb(255 255 255 / 0.8) inset,
			0 18px 40px -18px rgb(90 0 16 / 0.55);
		will-change: transform, opacity;
	}

	.tick {
		background: rgb(255 255 255 / 0.22);
		color: transparent;
		transform: scale(0.7);
		transition:
			transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
			background-color 0.3s ease,
			color 0.3s ease;
	}

	.tick-on {
		background: var(--color-cream);
		color: var(--color-crimson-deep);
		transform: none;
	}

	.shock {
		width: 360px;
		height: 360px;
		margin: -180px 0 0 -180px;
		border-radius: 999px;
		border: 2px solid rgb(255 255 255 / 0.7);
		opacity: 0;
		transform: scale(0.5);
	}

	.shock:global(.ring-go) {
		animation: shock 0.9s cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
	}

	@keyframes shock {
		0% {
			opacity: 0.85;
			transform: scale(0.55);
		}
		100% {
			opacity: 0;
			transform: scale(1.6);
		}
	}

	@media (max-width: 1023px) {
		.visual {
			margin-inline: -1.5rem;
		}

		.visual-frame {
			position: relative;
			height: 38svh;
			min-height: 260px;
		}

		.k8s-card {
			display: none;
		}

		.story {
			justify-content: flex-start;
			padding-block: 1.5rem 7rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caption,
		.tick {
			transition: none;
		}

		.shock:global(.ring-go) {
			animation: none;
		}
	}
</style>
