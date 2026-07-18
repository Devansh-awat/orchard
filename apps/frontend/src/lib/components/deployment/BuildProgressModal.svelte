<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { Check, Clock, Maximize2, X } from '@jis3r/icons';
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

<!-- Floating Build widget (bottom-right): current build + queued-behind, one card -->
<div class="pointer-events-none fixed right-6 bottom-6 z-40 flex w-72 flex-col">
	{#if cardVisible}
		<div
			class="build-card pointer-events-auto w-full overflow-hidden rounded-xl shadow-lg"
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
			<button
				type="button"
				class="build-card-main w-full cursor-pointer text-left hover:opacity-90"
				onclick={onExpandBuildCard}
			>
				<div class="flex items-center justify-between px-4 py-3">
					<div class="flex items-center gap-2 min-w-0">
						{#if cardStatus === 'building' || cardStatus === 'pending'}
							<Loader2 class="h-4 w-4 animate-spin shrink-0 text-primary-500" />
						{:else if cardStatus === 'failed'}
							<X size={16} class="shrink-0 text-red-500" />
						{:else if cardStatus === 'running'}
							<Check size={16} class="h-4 w-4 shrink-0 text-green-500" />
						{/if}
						<span class="truncate text-sm font-medium">{cardName}</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<div
							class="flex items-center gap-1 text-xs font-mono"
							style="color: var(--surface-muted);"
						>
							<Clock size={12} class="h-3 w-3" />
							<AnimatedNumber value={cardElapsed} format={formatBuildElapsed} />
						</div>
						<Maximize2 size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
					</div>
				</div>
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
			</button>
			<div class="pointer-events-auto">
				<BuildQueue deploymentId={deployment?.id ?? ''} />
			</div>
		</div>
	{/if}
</div>
