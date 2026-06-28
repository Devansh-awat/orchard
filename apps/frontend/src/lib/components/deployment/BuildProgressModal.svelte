<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { Check, Clock, Maximize2, Minimize2, X } from '@jis3r/icons';
	import { motionPopover, motionBackdrop } from '$lib/utils/motion.svelte';
	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';
	import AnimatedNumber from '$lib/components/AnimatedNumber.svelte';

	let {
		deployment,
		// Build modal
		showBuildModal = $bindable(),
		showBuildModalRender = $bindable(),
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
		showBuildModalRender: boolean;
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
</script>

<!-- Build Progress Modal -->
{#if showBuildModalRender}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Build progress"
		onclick={(e) => {
			if (e.target === e.currentTarget) onMinimizeBuildModal();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onMinimizeBuildModal();
		}}
		{@attach motionBackdrop(
			() => !showBuildModal,
			() => {
				showBuildModalRender = false;
			}
		)}
	>
		<div
			class="build-modal card w-full max-w-2xl rounded-2xl shadow-2xl"
			{@attach motionPopover({
				closing: () => !showBuildModal,
				onClosed: () => {},
				from: { y: 14, scale: 0.94, opacity: 0 },
				stiffness: 460,
				damping: 30,
				mass: 0.95
			})}
		>
			<div
				class="flex items-center justify-between border-b px-6 py-4"
				style="border-color: var(--surface-border);"
			>
				<div class="flex items-center gap-3">
					<h2 class="text-lg font-semibold">Rebuilding {deployment?.name ?? 'deployment'}</h2>
					<div class="flex items-center gap-1.5 text-sm" style="color: var(--surface-muted);">
						<Clock size={14} class="h-3.5 w-3.5" />
						<AnimatedNumber value={buildElapsed} format={formatBuildElapsed} class="font-mono" />
					</div>
				</div>
				<button
					onclick={onMinimizeBuildModal}
					class="btn-icon rounded-lg p-1.5 transition-colors"
					title="Minimize"
				>
					<Minimize2 size={16} class="h-4 w-4" />
				</button>
			</div>

			<div class="p-6">
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
			</div>

			<div
				class="flex justify-end gap-3 border-t px-6 py-4"
				style="border-color: var(--surface-border);"
			>
				{#if buildModalStatus === 'failed'}
					<button onclick={onCloseBuildModal} class="btn btn-secondary text-sm"> Close </button>
				{:else if canCancelBuild}
					<button onclick={onCancelBuild} disabled={cancelingBuild} class="btn btn-danger text-sm">
						{#if cancelingBuild}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
							Cancelling...
						{:else}
							<X size={14} />
							Cancel build
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Floating Build Card -->
{#if showBuildCardRender}
	<button
		class="build-card fixed bottom-6 right-6 z-40 w-72 cursor-pointer rounded-xl shadow-lg hover:shadow-xl"
		style="transform-origin: bottom right;"
		onclick={onExpandBuildCard}
		{@attach motionPopover({
			closing: () => !(showBuildCard && !showBuildModal),
			onClosed: () => {
				showBuildCardRender = false;
			},
			from: { y: 18, scale: 0.86, opacity: 0 },
			stiffness: 500,
			damping: 28,
			mass: 0.9
		})}
	>
		<div class="flex items-center justify-between px-4 py-3">
			<div class="flex items-center gap-2 min-w-0">
				{#if buildModalStatus === 'building' || buildModalStatus === 'pending'}
					<Loader2 class="h-4 w-4 animate-spin shrink-0 text-primary-500" />
				{:else if buildModalStatus === 'failed'}
					<X size={16} class="shrink-0 text-red-500" />
				{:else if buildModalStatus === 'running'}
					<Check size={16} class="h-4 w-4 shrink-0 text-green-500" />
				{/if}
				<span class="truncate text-sm font-medium">{deployment?.name ?? 'Build'}</span>
			</div>
			<div class="flex items-center gap-2 shrink-0">
				<div class="flex items-center gap-1 text-xs font-mono" style="color: var(--surface-muted);">
					<Clock size={12} class="h-3 w-3" />
					<AnimatedNumber value={buildElapsed} format={formatBuildElapsed} />
				</div>
				<Maximize2 size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
			</div>
		</div>
		<div class="px-4 pb-3">
			<div class="build-card-track h-1.5 w-full overflow-hidden rounded-full">
				<div
					class="h-full transition-all duration-500 ease-out rounded-full {buildModalStatus ===
					'failed'
						? 'bg-red-500'
						: buildModalStatus === 'running'
							? 'bg-green-500'
							: 'bg-primary-500'}"
					style="width: {buildProgressValue()}%"
				></div>
			</div>
			<p class="mt-1.5 text-xs" style="color: var(--surface-muted);">
				{#if buildModalStatus === 'building'}
					{buildModalStep === 'cloning'
						? 'Scheduling builder...'
						: buildModalStep === 'building'
							? 'Building image...'
							: buildModalStep === 'pushing'
								? 'Pushing image...'
								: buildModalStep === 'deploying'
									? 'Creating deployment...'
									: 'Building...'}
				{:else if buildModalStatus === 'pending'}
					Starting build...
				{:else if buildModalStatus === 'failed'}
					Build failed
				{:else if buildModalStatus === 'running'}
					Build complete
				{/if}
			</p>
		</div>
	</button>
{/if}
