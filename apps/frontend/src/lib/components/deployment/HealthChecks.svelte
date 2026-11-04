<script lang="ts">
	import {
		Button,
		Disclosure,
		FormActions,
		Input,
		SectionCard,
		SegmentedControl,
		Stepper,
		Swap,
		ToggleRow
	} from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';
	import { presence } from '$lib/utils/transitions';
	import type { DockerfileHealthCheck } from '$lib/types/deployment';

	let {
		deployment,
		healthCheckEnabled = $bindable(false),
		healthCheckType = $bindable('http'),
		healthCheckPath = $bindable('/'),
		healthCheckPort = $bindable(80),
		healthCheckCommand = $bindable(''),
		livenessEnabled = $bindable(true),
		readinessEnabled = $bindable(true),
		startupEnabled = $bindable(false),
		healthCheckInterval = $bindable(30),
		healthCheckTimeout = $bindable(5),
		healthCheckRetries = $bindable(3),
		startupFailureThreshold = $bindable(30),
		healthCheckOverride = $bindable(false),
		savingHealthCheck,
		isEditingHealthCheck = $bindable(false),
		onSaveHealthCheck
	}: {
		deployment: any;
		healthCheckEnabled: boolean;
		healthCheckType: string;
		healthCheckPath: string;
		healthCheckPort: number;
		healthCheckCommand: string;
		livenessEnabled: boolean;
		readinessEnabled: boolean;
		startupEnabled: boolean;
		healthCheckInterval: number;
		healthCheckTimeout: number;
		healthCheckRetries: number;
		startupFailureThreshold: number;
		healthCheckOverride: boolean;
		savingHealthCheck: boolean;
		isEditingHealthCheck: boolean;
		onSaveHealthCheck: () => void;
	} = $props();

	const uid = $props.id();

	const METHODS = [
		{ value: 'http', label: 'Web endpoint' },
		{ value: 'tcp', label: 'Port' },
		{ value: 'exec', label: 'Command' }
	];

	const dockerfileHealthCheck = $derived(
		(deployment?.dockerfileHealthCheck ?? null) as DockerfileHealthCheck | null
	);
	const usingDockerfile = $derived(!!dockerfileHealthCheck && !healthCheckOverride);

	const detectedCommand = $derived.by(() => {
		const command = dockerfileHealthCheck?.command ?? [];
		if (command.length === 3 && command[1] === '-c') return command[2];
		return command.join(' ');
	});

	const detectedTiming = $derived.by(() => {
		const hc = dockerfileHealthCheck;
		if (!hc) return '';
		const parts = [`every ${hc.interval ?? 30}s`, `${hc.timeout ?? 30}s timeout`];
		parts.push(`${hc.retries ?? 3} retries`);
		if (hc.startPeriod) parts.push(`${hc.startPeriod}s to start`);
		return parts.join(' · ');
	});

	const timingNote = $derived(
		`Every ${healthCheckInterval}s, ${healthCheckRetries} ${healthCheckRetries === 1 ? 'failure' : 'failures'}`
	);

	function edit() {
		isEditingHealthCheck = true;
	}

	function discard() {
		const d = deployment ?? {};
		healthCheckEnabled = d.healthCheckEnabled ?? false;
		healthCheckType = d.healthCheckType || 'http';
		healthCheckPath = d.healthCheckPath || '/';
		healthCheckPort = d.healthCheckPort || 80;
		healthCheckCommand = d.healthCheckCommand || '';
		livenessEnabled = d.livenessEnabled ?? true;
		readinessEnabled = d.readinessEnabled ?? true;
		startupEnabled = d.startupEnabled ?? false;
		healthCheckInterval = d.healthCheckInterval ?? 30;
		healthCheckTimeout = d.healthCheckTimeout ?? 5;
		healthCheckRetries = d.healthCheckRetries ?? 3;
		startupFailureThreshold = d.startupFailureThreshold ?? 30;
		healthCheckOverride = d.healthCheckOverride ?? false;
		isEditingHealthCheck = false;
	}
</script>

<SectionCard title="Health checks">
	<div class="hc-body" oninput={edit}>
		<SettingsList>
			{#if dockerfileHealthCheck}
				<SettingRow
					label={usingDockerfile
						? "Using your Dockerfile's HEALTHCHECK"
						: "Replacing your Dockerfile's HEALTHCHECK"}
				>
					{#snippet hint()}<span class="hc-detected"
							><code>{detectedCommand}</code><span>{detectedTiming}</span></span
						>{/snippet}
					<Button
						size="sm"
						variant="secondary"
						onclick={() => {
							healthCheckOverride = !healthCheckOverride;
							edit();
						}}
					>
						{usingDockerfile ? 'Set your own' : "Use the Dockerfile's"}
					</Button>
				</SettingRow>
			{/if}
			{#if !usingDockerfile}
				<ToggleRow
					label="Check this app"
					hint={healthCheckEnabled
						? 'Orchard recovers the app when the check fails'
						: 'Crashes and hangs go unnoticed until someone looks'}
					bind:checked={healthCheckEnabled}
					onchange={edit}
				/>
				{#if healthCheckEnabled}
					<div class="hc-more" in:presence out:presence>
						<SettingsList>
							<SettingRow label="Check with">
								<SegmentedControl
									label="Health check method"
									options={METHODS}
									bind:value={healthCheckType}
									onchange={edit}
								/>
							</SettingRow>
							<Swap key={healthCheckType}>
								<SettingsList>
									{#if healthCheckType === 'http'}
										<SettingRow label="Path" hint="Returns 2xx while healthy" for="{uid}-path" wide>
											<Input
												id="{uid}-path"
												bind:value={healthCheckPath}
												placeholder="/health"
												mono
											/>
										</SettingRow>
									{:else if healthCheckType === 'exec'}
										<SettingRow
											label="Command"
											hint="Runs in the container and should exit 0"
											for="{uid}-cmd"
											wide
										>
											<Input
												id="{uid}-cmd"
												bind:value={healthCheckCommand}
												placeholder="cat /tmp/healthy"
												mono
											/>
										</SettingRow>
									{/if}
									{#if healthCheckType !== 'exec'}
										<SettingRow label="Port" for="{uid}-port">
											<Stepper
												id="{uid}-port"
												label="Port"
												bind:value={healthCheckPort}
												min={1}
												max={65535}
												onchange={edit}
											/>
										</SettingRow>
									{/if}
								</SettingsList>
							</Swap>
							<ToggleRow
								label="Restart the container when it fails"
								bind:checked={livenessEnabled}
								onchange={edit}
							/>
							<ToggleRow
								label="Stop sending traffic until it passes"
								bind:checked={readinessEnabled}
								onchange={edit}
							/>
							<ToggleRow
								label="Allow extra time on startup"
								bind:checked={startupEnabled}
								onchange={edit}
							/>
							<Disclosure title="Timing" note={timingNote}>
								<SettingsList>
									<SettingRow label="Check every" for="{uid}-interval">
										<Stepper
											id="{uid}-interval"
											label="Check every"
											bind:value={healthCheckInterval}
											min={1}
											max={3600}
											suffix="s"
											onchange={edit}
										/>
									</SettingRow>
									<SettingRow label="Wait up to" for="{uid}-timeout">
										<Stepper
											id="{uid}-timeout"
											label="Wait up to"
											bind:value={healthCheckTimeout}
											min={1}
											max={3600}
											suffix="s"
											onchange={edit}
										/>
									</SettingRow>
									<SettingRow label="Fail after" for="{uid}-retries">
										<Stepper
											id="{uid}-retries"
											label="Fail after"
											bind:value={healthCheckRetries}
											min={1}
											max={100}
											suffix="tries"
											onchange={edit}
										/>
									</SettingRow>
									{#if startupEnabled}
										<SettingRow label="Startup grace" for="{uid}-startup">
											<Stepper
												id="{uid}-startup"
												label="Startup grace"
												bind:value={startupFailureThreshold}
												min={1}
												max={1000}
												suffix="tries"
												onchange={edit}
											/>
										</SettingRow>
									{/if}
								</SettingsList>
							</Disclosure>
						</SettingsList>
					</div>
				{/if}
			{/if}
		</SettingsList>
		<FormActions hint="Saving restarts your app.">
			<Button
				variant="ghost"
				disabled={!isEditingHealthCheck || savingHealthCheck}
				onclick={discard}>Discard</Button
			>
			<Button
				variant="primary"
				loading={savingHealthCheck}
				disabled={!isEditingHealthCheck}
				onclick={onSaveHealthCheck}>Save</Button
			>
		</FormActions>
	</div>
</SectionCard>

<style>
	.hc-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.hc-detected {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
		min-width: 0;
	}
	.hc-detected code {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
