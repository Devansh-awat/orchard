<script lang="ts">
	import { SectionCard, Field, Input, Button, Badge, SegmentedControl } from '$lib/components/ui';
	import { frameworkLabel } from './deployment-helpers';
	import FrameworkIcon from './FrameworkIcon.svelte';
	import type { Deployment } from '$lib/types/deployment';

	let {
		deployment,
		saving = false,
		onSave
	}: {
		deployment: Deployment | null;
		saving?: boolean;
		onSave: (body: Record<string, string | null>) => void;
	} = $props();

	let buildType = $state<'dockerfile' | 'railpack'>('railpack');
	let dockerfilePath = $state('');
	let rootDirectory = $state('');
	let installCommand = $state('');
	let buildCommand = $state('');
	let startCommand = $state('');
	let outputDirectory = $state('');
	let hydratedId = '';

	$effect(() => {
		const d = deployment;
		if (!d || d.id === hydratedId) return;
		hydratedId = d.id;
		buildType = d.buildType === 'railpack' ? 'railpack' : 'dockerfile';
		dockerfilePath = d.dockerfilePath ?? '';
		rootDirectory = d.rootDirectory ?? '';
		installCommand = d.installCommand ?? '';
		buildCommand = d.buildCommand ?? '';
		startCommand = d.startCommand ?? '';
		outputDirectory = d.outputDirectory ?? '';
	});

	const detected = $derived(deployment?.detectedConfig ?? null);
	const isStatic = $derived(Boolean(outputDirectory.trim()));

	const buildOptions = [
		{ value: 'railpack', label: 'Automatic', hint: 'Detect and build with Railpack' },
		{ value: 'dockerfile', label: 'Dockerfile', hint: 'Build from a Dockerfile in the repository' }
	];

	const dirty = $derived(
		Boolean(deployment) &&
			(buildType !== (deployment?.buildType ?? 'dockerfile') ||
				dockerfilePath !== (deployment?.dockerfilePath ?? '') ||
				rootDirectory !== (deployment?.rootDirectory ?? '') ||
				installCommand !== (deployment?.installCommand ?? '') ||
				buildCommand !== (deployment?.buildCommand ?? '') ||
				startCommand !== (deployment?.startCommand ?? '') ||
				outputDirectory !== (deployment?.outputDirectory ?? ''))
	);

	function reset() {
		buildType = deployment?.buildType === 'railpack' ? 'railpack' : 'dockerfile';
		dockerfilePath = deployment?.dockerfilePath ?? '';
		rootDirectory = deployment?.rootDirectory ?? '';
		installCommand = deployment?.installCommand ?? '';
		buildCommand = deployment?.buildCommand ?? '';
		startCommand = deployment?.startCommand ?? '';
		outputDirectory = deployment?.outputDirectory ?? '';
	}

	function save() {
		if (buildType === 'dockerfile') {
			onSave({ buildType: 'dockerfile', dockerfilePath: dockerfilePath.trim() || null });
			return;
		}
		onSave({
			buildType: 'railpack',
			rootDirectory: rootDirectory.trim() || null,
			installCommand: installCommand.trim() || null,
			buildCommand: buildCommand.trim() || null,
			startCommand: startCommand.trim() || null,
			outputDirectory: outputDirectory.trim() || null
		});
	}
</script>

<div class="space-y-5">
	<SectionCard
		title="Build method"
		description="How this app is built from its source. Changes apply on the next build."
	>
		{#snippet actions()}
			<Button variant="ghost" size="sm" onclick={reset} disabled={!dirty || saving}>Discard</Button>
			<Button variant="primary" size="sm" onclick={save} loading={saving} disabled={!dirty}>
				Save
			</Button>
		{/snippet}

		<div class="space-y-4">
			<SegmentedControl
				label="Build method"
				options={buildOptions}
				value={buildType}
				onchange={(v) => (buildType = v === 'railpack' ? 'railpack' : 'dockerfile')}
				grow
			/>
			{#if buildType === 'dockerfile'}
				<Field
					label="Dockerfile path"
					hint="Path to the Dockerfile, relative to the repository root. Leave empty to use ./Dockerfile."
				>
					<Input bind:value={dockerfilePath} placeholder="Dockerfile" class="font-mono" />
				</Field>
			{/if}
		</div>
	</SectionCard>

	{#if buildType === 'railpack'}
		{#if detected}
			<SectionCard
				title="Detected by the last build"
				description="What Railpack found when it built this app."
			>
				<div class="flex flex-wrap items-center gap-2">
					{#if frameworkLabel(detected.framework)}
						<Badge tone="info">
							<span class="inline-flex items-center gap-1.5">
								<FrameworkIcon framework={detected.framework} size={13} />
								{frameworkLabel(detected.framework)}
							</span>
						</Badge>
					{/if}
					{#if detected.isStatic}
						<Badge tone="neutral">Static site</Badge>
					{/if}
					{#if detected.packageManager}
						<Badge tone="neutral">{detected.packageManager}</Badge>
					{/if}
					{#if detected.railpackVersion}
						<span class="text-xs text-muted">Railpack {detected.railpackVersion}</span>
					{/if}
				</div>
			</SectionCard>
		{/if}

		<SectionCard
			title="Build and output settings"
			description="Leave a field empty to use what we detect. Anything you set here overrides a railpack.json in the repository."
		>
			<div class="space-y-4">
				<Field
					label="Root directory"
					hint="Directory of the app inside the repository. Leave empty for a single-app repository."
				>
					<Input bind:value={rootDirectory} placeholder="apps/web" class="font-mono" />
				</Field>
				<Field label="Install command">
					<Input
						bind:value={installCommand}
						placeholder="Detected automatically"
						class="font-mono"
					/>
				</Field>
				<Field label="Build command">
					<Input bind:value={buildCommand} placeholder="Detected automatically" class="font-mono" />
				</Field>
				<Field
					label="Output directory"
					hint="Set this to serve the built files as a static site instead of running a server."
				>
					<Input
						bind:value={outputDirectory}
						placeholder="Detected automatically"
						class="font-mono"
					/>
				</Field>
				<Field label="Start command">
					<Input
						bind:value={startCommand}
						placeholder={isStatic ? 'Not used for a static site' : 'Detected automatically'}
						disabled={isStatic}
						class="font-mono"
					/>
				</Field>
			</div>
		</SectionCard>
	{/if}
</div>
