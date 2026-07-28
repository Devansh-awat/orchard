<script lang="ts">
	import { SectionCard, Field, Input, Button, Badge, Alert } from '$lib/components/ui';
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
		rootDirectory = d.rootDirectory ?? '';
		installCommand = d.installCommand ?? '';
		buildCommand = d.buildCommand ?? '';
		startCommand = d.startCommand ?? '';
		outputDirectory = d.outputDirectory ?? '';
	});

	const detected = $derived(deployment?.detectedConfig ?? null);
	const isStatic = $derived(Boolean(outputDirectory.trim()));

	const dirty = $derived(
		Boolean(deployment) &&
			(rootDirectory !== (deployment?.rootDirectory ?? '') ||
				installCommand !== (deployment?.installCommand ?? '') ||
				buildCommand !== (deployment?.buildCommand ?? '') ||
				startCommand !== (deployment?.startCommand ?? '') ||
				outputDirectory !== (deployment?.outputDirectory ?? ''))
	);

	function reset() {
		rootDirectory = deployment?.rootDirectory ?? '';
		installCommand = deployment?.installCommand ?? '';
		buildCommand = deployment?.buildCommand ?? '';
		startCommand = deployment?.startCommand ?? '';
		outputDirectory = deployment?.outputDirectory ?? '';
	}

	function save() {
		onSave({
			rootDirectory: rootDirectory.trim() || null,
			installCommand: installCommand.trim() || null,
			buildCommand: buildCommand.trim() || null,
			startCommand: startCommand.trim() || null,
			outputDirectory: outputDirectory.trim() || null
		});
	}
</script>

<div class="space-y-5">
	{#if deployment?.buildType !== 'railpack'}
		<Alert tone="info" title="This app builds from a Dockerfile">
			Build settings apply to automatic builds. Switch the build type to change how this app is
			built.
		</Alert>
	{:else}
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
			{#snippet actions()}
				<Button variant="ghost" size="sm" onclick={reset} disabled={!dirty || saving}>
					Discard
				</Button>
				<Button variant="primary" size="sm" onclick={save} loading={saving} disabled={!dirty}>
					Save
				</Button>
			{/snippet}

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
