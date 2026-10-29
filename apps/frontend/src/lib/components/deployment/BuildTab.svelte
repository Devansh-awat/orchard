<script lang="ts">
	import {
		SectionCard,
		Input,
		Button,
		Badge,
		SegmentedControl,
		FormActions,
		Swap
	} from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';
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
	let dockerfileTarget = $state('');
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
		dockerfileTarget = d.dockerfileTarget ?? '';
		rootDirectory = d.rootDirectory ?? '';
		installCommand = d.installCommand ?? '';
		buildCommand = d.buildCommand ?? '';
		startCommand = d.startCommand ?? '';
		outputDirectory = d.outputDirectory ?? '';
	});

	const detected = $derived(deployment?.detectedConfig ?? null);
	const isStatic = $derived(Boolean(outputDirectory.trim()));

	const uid = $props.id();

	const buildOptions = [
		{ value: 'railpack', label: 'Automatic', hint: 'Detect and build with Railpack' },
		{ value: 'dockerfile', label: 'Dockerfile', hint: 'Build from a Dockerfile in the repository' }
	];

	const dirty = $derived(
		Boolean(deployment) &&
			(buildType !== (deployment?.buildType ?? 'dockerfile') ||
				dockerfilePath !== (deployment?.dockerfilePath ?? '') ||
				dockerfileTarget !== (deployment?.dockerfileTarget ?? '') ||
				rootDirectory !== (deployment?.rootDirectory ?? '') ||
				installCommand !== (deployment?.installCommand ?? '') ||
				buildCommand !== (deployment?.buildCommand ?? '') ||
				startCommand !== (deployment?.startCommand ?? '') ||
				outputDirectory !== (deployment?.outputDirectory ?? ''))
	);

	function reset() {
		buildType = deployment?.buildType === 'railpack' ? 'railpack' : 'dockerfile';
		dockerfilePath = deployment?.dockerfilePath ?? '';
		dockerfileTarget = deployment?.dockerfileTarget ?? '';
		rootDirectory = deployment?.rootDirectory ?? '';
		installCommand = deployment?.installCommand ?? '';
		buildCommand = deployment?.buildCommand ?? '';
		startCommand = deployment?.startCommand ?? '';
		outputDirectory = deployment?.outputDirectory ?? '';
	}

	function save() {
		if (buildType === 'dockerfile') {
			onSave({
				buildType: 'dockerfile',
				dockerfilePath: dockerfilePath.trim() || null,
				dockerfileTarget: dockerfileTarget.trim() || null,
				startCommand: startCommand.trim() || null
			});
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

<SectionCard title="Build">
	<div class="bt-body">
		<SettingsList>
			<SettingRow label="Method">
				<SegmentedControl
					label="Build method"
					options={buildOptions}
					value={buildType}
					onchange={(v) => (buildType = v === 'railpack' ? 'railpack' : 'dockerfile')}
				/>
			</SettingRow>
			<Swap key={buildType}>
				<SettingsList>
					{#if buildType === 'dockerfile'}
						<SettingRow label="Dockerfile" for="{uid}-path" wide>
							<Input id="{uid}-path" bind:value={dockerfilePath} placeholder="Dockerfile" mono />
						</SettingRow>
						<SettingRow label="Build stage" for="{uid}-target" wide>
							<Input
								id="{uid}-target"
								bind:value={dockerfileTarget}
								placeholder="Final stage"
								mono
							/>
						</SettingRow>
						<SettingRow
							label="Start command"
							hint="Applies without a rebuild"
							for="{uid}-start"
							wide
						>
							<Input
								id="{uid}-start"
								bind:value={startCommand}
								placeholder="Whatever the image starts"
								mono
							/>
						</SettingRow>
					{:else}
						{#if detected}
							<SettingRow label="Detected">
								{#if frameworkLabel(detected.framework)}
									<Badge tone="info">
										<span class="bt-badge">
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
									<span class="bt-version">Railpack {detected.railpackVersion}</span>
								{/if}
							</SettingRow>
						{/if}
						<SettingRow label="Root directory" for="{uid}-root" wide>
							<Input
								id="{uid}-root"
								bind:value={rootDirectory}
								placeholder="Repository root"
								mono
							/>
						</SettingRow>
						<SettingRow label="Install command" for="{uid}-install" wide>
							<Input
								id="{uid}-install"
								bind:value={installCommand}
								placeholder="Detected automatically"
								mono
							/>
						</SettingRow>
						<SettingRow label="Build command" for="{uid}-build" wide>
							<Input
								id="{uid}-build"
								bind:value={buildCommand}
								placeholder="Detected automatically"
								mono
							/>
						</SettingRow>
						<SettingRow
							label="Output directory"
							hint="Serves these files as a static site"
							for="{uid}-output"
							wide
						>
							<Input
								id="{uid}-output"
								bind:value={outputDirectory}
								placeholder="Detected automatically"
								mono
							/>
						</SettingRow>
						<SettingRow label="Start command" for="{uid}-start" wide>
							<Input
								id="{uid}-start"
								bind:value={startCommand}
								placeholder={isStatic ? 'Not used for a static site' : 'Detected automatically'}
								disabled={isStatic}
								mono
							/>
						</SettingRow>
					{/if}
				</SettingsList>
			</Swap>
		</SettingsList>
		<FormActions
			hint={buildType === 'railpack'
				? 'Applies on the next build, over any railpack.json.'
				: 'Applies on the next build.'}
		>
			<Button variant="ghost" onclick={reset} disabled={!dirty || saving}>Discard</Button>
			<Button variant="primary" onclick={save} loading={saving} disabled={!dirty}>Save</Button>
		</FormActions>
	</div>
</SectionCard>

<style>
	.bt-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.bt-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
	.bt-version {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
