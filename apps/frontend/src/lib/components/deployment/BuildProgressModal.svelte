<script lang="ts">
	import { Loader2, ChevronDown, GripHorizontal } from 'lucide-svelte';
	import { Check, Clock, Maximize2, X } from '@jis3r/icons';
	import { springRotate, springCollapse } from '$lib/utils/motion.svelte';
	import { page } from '$app/stores';
	import { motionPopover } from '$lib/utils/motion.svelte';
	import { Button, Modal } from '$lib/components/ui';
	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';
	import AnimatedNumber from '$lib/components/AnimatedNumber.svelte';
	import BuildQueue from './BuildQueue.svelte';

	let {
		deployment,
		// Build modal
		showBuildModal = $bindable(),
		buildModalStatus,
		buildModalStep,
		buildModalError,
		buildModalWarnings,
		buildModalTimestamps,
		accumulatedBuildLogs,
		buildElapsed,
		buildProgressValue,
		canCancelBuild,
		cancelingBuild,
		onMinimizeBuildModal,
		onCancelBuild,
		onCloseBuildModal,
		formatBuildElapsed,
		// Build card
		showBuildCard = $bindable(),
		showBuildCardRender = $bindable(),
		onExpandBuildCard
	}: {
		deployment: any;
		showBuildModal: boolean;
		buildModalStatus: string;
		buildModalStep: string | null;
		buildModalError: string | null;
		buildModalWarnings: Array<{ podName: string; message: string; timestamp: string }>;
		buildModalTimestamps: Record<string, number> | null;
		accumulatedBuildLogs: string | null;
		buildElapsed: number;
		buildProgressValue: () => number;
		canCancelBuild: boolean;
		cancelingBuild: boolean;
		onMinimizeBuildModal: () => void;
		onCancelBuild: () => void;
		onCloseBuildModal: () => void;
		formatBuildElapsed: (seconds: number) => string;
		showBuildCard: boolean;
		showBuildCardRender: boolean;
		onExpandBuildCard: () => void;
	} = $props();

	// `?buildqueue=demo` fakes an in-flight build so the merged widget (current
	// build + queued-behind) can be reviewed without a live deploy.
	const demo = $derived($page.url.searchParams.get('buildqueue') === 'demo');
	const cardVisible = $derived(showBuildCardRender || demo);
	const cardStatus = $derived(demo ? 'building' : buildModalStatus);
	const cardStep = $derived(demo ? 'building' : buildModalStep);
	const cardElapsed = $derived(demo ? 47 : buildElapsed);
	const cardProgress = $derived(demo ? 64 : buildProgressValue());
	const cardName = $derived(deployment?.name ?? (demo ? 'widget' : 'App'));

	// Real-widget behaviour: draggable by the header, collapsible, and both the
	// position and collapsed state persist across visits.
	const POS_KEY = 'build-widget-pos';
	const COLLAPSED_KEY = 'build-widget-collapsed';
	const WIDGET_W = 288;

	function loadPos(): { x: number; y: number } | null {
		if (typeof localStorage === 'undefined') return null;
		try {
			const raw = localStorage.getItem(POS_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	let pos = $state<{ x: number; y: number } | null>(loadPos());
	let collapsed = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === 'true'
	);

	function toggleCollapsed() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(COLLAPSED_KEY, String(collapsed));
		} catch {
			// ignore
		}
	}

	let dragging = $state(false);
	let dragStart = { px: 0, py: 0, x: 0, y: 0 };

	function currentXY(el: HTMLElement): { x: number; y: number } {
		if (pos) return pos;
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.top };
	}

	function onHeaderPointerDown(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		const widget = (e.currentTarget as HTMLElement).closest('.build-widget') as HTMLElement | null;
		if (!widget) return;
		const start = currentXY(widget);
		dragStart = { px: e.clientX, py: e.clientY, x: start.x, y: start.y };
		dragging = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onHeaderPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const w = window.innerWidth;
		const h = window.innerHeight;
		const nx = Math.min(Math.max(8, dragStart.x + (e.clientX - dragStart.px)), w - WIDGET_W - 8);
		const ny = Math.min(Math.max(8, dragStart.y + (e.clientY - dragStart.py)), h - 56);
		pos = { x: nx, y: ny };
	}

	function onHeaderPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		if (pos) {
			try {
				localStorage.setItem(POS_KEY, JSON.stringify(pos));
			} catch {
				// ignore
			}
		}
	}
</script>

<!-- Build Progress Modal -->
<Modal
	bind:open={showBuildModal}
	title="Redeploying {deployment?.name ?? 'app'}"
	size="lg"
	onclose={onMinimizeBuildModal}
>
	<div
		class="mb-4 flex items-center gap-1.5 text-sm"
		style="color: var(--surface-muted);"
		title="Elapsed time"
	>
		<Clock size={14} class="h-3.5 w-3.5" />
		<AnimatedNumber value={buildElapsed} format={formatBuildElapsed} class="font-mono" />
	</div>

	<DeploymentProgress
		status={deployment?.status ?? 'pending'}
		buildStatus={buildModalStatus}
		buildStep={buildModalStep}
		buildLogs={accumulatedBuildLogs}
		buildError={buildModalError}
		isGitHubDeploy={true}
		warnings={buildModalWarnings}
		buildStepTimestamps={buildModalTimestamps}
	/>

	{#snippet footer()}
		{#if buildModalStatus === 'failed'}
			<Button variant="secondary" onclick={onCloseBuildModal}>Close</Button>
		{:else if canCancelBuild}
			<Button variant="danger" loading={cancelingBuild} onclick={onCancelBuild}>
				{#if cancelingBuild}
					Cancelling...
				{:else}
					<X size={14} />
					Cancel deployment
				{/if}
			</Button>
		{/if}
	{/snippet}
</Modal>

<!-- Floating Build widget: current build + queued-behind, draggable + collapsible -->
<div
	class="pointer-events-none fixed z-40 flex w-72 flex-col"
	class:build-widget--pinned={!pos}
	style={pos ? `left:${pos.x}px; top:${pos.y}px;` : 'right:1.5rem; bottom:1.5rem;'}
>
	{#if cardVisible}
		<div
			class="build-widget build-card pointer-events-auto w-full overflow-hidden rounded-xl shadow-lg"
			class:build-widget--dragging={dragging}
			style="transform-origin: bottom right;"
			{@attach motionPopover({
				closing: () => !demo && !(showBuildCard && !showBuildModal),
				onClosed: () => {
					showBuildCardRender = false;
				},
				from: { y: 18, scale: 0.86, opacity: 0 },
				stiffness: 500,
				damping: 28,
				mass: 0.9
			})}
		>
			<div
				class="build-widget-header flex items-center gap-2 px-3 py-2.5"
				onpointerdown={onHeaderPointerDown}
				onpointermove={onHeaderPointerMove}
				onpointerup={onHeaderPointerUp}
			>
				<GripHorizontal
					size={13}
					class="build-widget-grip shrink-0"
					style="color: var(--surface-muted);"
				/>
				{#if cardStatus === 'building' || cardStatus === 'pending'}
					<Loader2 class="h-4 w-4 animate-spin shrink-0 text-primary-500" />
				{:else if cardStatus === 'failed'}
					<X size={16} class="shrink-0 text-red-500" />
				{:else if cardStatus === 'running'}
					<Check size={16} class="h-4 w-4 shrink-0 text-green-500" />
				{/if}
				<span class="truncate text-sm font-medium">{cardName}</span>
				<div class="ml-auto flex items-center gap-1.5 shrink-0">
					<div
						class="flex items-center gap-1 text-xs font-mono"
						style="color: var(--surface-muted);"
					>
						<Clock size={12} class="h-3 w-3" />
						<AnimatedNumber value={cardElapsed} format={formatBuildElapsed} />
					</div>
					<button
						type="button"
						class="build-widget-btn"
						aria-label={collapsed ? 'Expand widget' : 'Collapse widget'}
						onclick={toggleCollapsed}
					>
						<span {@attach springRotate(() => !collapsed, { rest: -90, on: 0 })}>
							<ChevronDown size={15} />
						</span>
					</button>
					<button
						type="button"
						class="build-widget-btn"
						aria-label="Open build details"
						onclick={onExpandBuildCard}
					>
						<Maximize2 size={13} class="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			<div {@attach springCollapse(() => collapsed)}>
				<div class="build-widget-body">
					<div class="px-4 pb-3">
						<div class="build-card-track h-1.5 w-full overflow-hidden rounded-full">
							<div
								class="h-full transition-all duration-500 ease-out rounded-full {cardStatus ===
								'failed'
									? 'bg-red-500'
									: cardStatus === 'running'
										? 'bg-green-500'
										: 'bg-primary-500'}"
								style="width: {cardProgress}%"
							></div>
						</div>
						<p class="mt-1.5 text-xs" style="color: var(--surface-muted);">
							{#if cardStatus === 'building'}
								{cardStep === 'cloning'
									? 'Scheduling builder...'
									: cardStep === 'building'
										? 'Building image...'
										: cardStep === 'pushing'
											? 'Pushing image...'
											: cardStep === 'deploying'
												? 'Creating app...'
												: 'Building...'}
							{:else if cardStatus === 'pending'}
								Starting deployment...
							{:else if cardStatus === 'failed'}
								Deployment failed
							{:else if cardStatus === 'running'}
								Deployment complete
							{/if}
						</p>
					</div>
					<BuildQueue deploymentId={deployment?.id ?? ''} />
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.build-widget-header {
		cursor: grab;
		touch-action: none;
		user-select: none;
		border-bottom: 1px solid transparent;
	}

	.build-widget--dragging .build-widget-header {
		cursor: grabbing;
	}

	.build-widget-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		color: var(--surface-muted);
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.build-widget-btn:hover {
		background-color: color-mix(in srgb, var(--center-channel-color) 8%, transparent);
		color: var(--center-channel-color);
	}

	.build-widget--dragging {
		box-shadow:
			0 12px 40px rgb(0 0 0 / 0.22),
			0 2px 8px rgb(0 0 0 / 0.12);
	}
</style>
