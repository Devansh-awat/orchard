<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Input,
		Modal,
		SectionCard,
		ToggleRow
	} from '$lib/components/ui';
	import {
		formatCpu,
		formatMemory,
		parseCpu,
		parseMemory
	} from '$lib/components/ResourcePicker.svelte';
	import SettingCommand from '$lib/components/setup/SettingCommand.svelte';
	import type { SettingChange } from '$lib/components/setup/setting-changes';

	let { change = undefined }: { change?: SettingChange } = $props();

	const MIB = 1024 ** 2;
	const MIN_MEMORY_BYTES = 64 * MIB;
	const MIN_CPU_MILLI = 50;
	const DISMISSED_KEY = 'orchard:resource-limits-notice-dismissed';

	type Mode = 'on' | 'off';
	type Org = {
		id: string;
		name: string;
		defaultPodCpuMilli: number | null;
		defaultPodMemoryBytes: number | null;
	};
	interface State {
		value: Mode;
		dbValue: Mode | null;
		envOverride: Mode | null;
		affected: { apps: number; databases: number };
		stale: { apps: number; databases: number } | null;
		fallback: Record<'app' | 'database', { cpuMilli: number; memoryBytes: number }>;
		organizations: Org[];
	}
	type Draft = { memory: string; cpu: string };

	let state = $state<State | null>(null);
	let saving = $state(false);
	let dialog = $state<Mode | null>(null);
	let drafts = $state<Record<string, Draft>>({});
	let attempted = $state(false);
	let dismissed = $state<string | null>(null);
	let toggled = $state(true);

	$effect(() => {
		if (state && dialog === null) toggled = state.value === 'on';
	});

	const memoryBytes = (draft: Draft) => (draft.memory.trim() ? parseMemory(draft.memory) : null);
	const cpuMilli = (draft: Draft) => (draft.cpu.trim() ? parseCpu(draft.cpu) : null);

	function memoryError(draft: Draft | undefined): string | null {
		if (!draft || !draft.memory.trim()) return null;
		const bytes = parseMemory(draft.memory);
		return bytes !== null && bytes >= MIN_MEMORY_BYTES
			? null
			: 'Enter at least 64 MB, for example 512 MB.';
	}

	function cpuError(draft: Draft | undefined): string | null {
		if (!draft || !draft.cpu.trim()) return null;
		const milli = parseCpu(draft.cpu);
		return milli !== null && milli >= MIN_CPU_MILLI
			? null
			: 'Enter at least 0.05 CPU, for example 0.5.';
	}

	const invalid = $derived(
		Object.values(drafts).some((draft) => memoryError(draft) || cpuError(draft))
	);

	function plural(count: number, one: string, many: string) {
		return `${count} ${count === 1 ? one : many}`;
	}

	function workloads(counts: { apps: number; databases: number }) {
		const parts = [];
		if (counts.apps > 0) parts.push(plural(counts.apps, 'app', 'apps'));
		if (counts.databases > 0) parts.push(plural(counts.databases, 'database', 'databases'));
		return parts.join(' and ');
	}

	const fallbackHint = $derived(
		state
			? `Blank uses ${formatMemory(state.fallback.app.memoryBytes)} and ${formatCpu(state.fallback.app.cpuMilli)} for apps, and ${formatMemory(state.fallback.database.memoryBytes)} and ${formatCpu(state.fallback.database.cpuMilli)} for databases. A database never gets less than 256 MB.`
			: ''
	);

	const affectedText = $derived(state ? workloads(state.affected) : '');

	const notice = $derived.by(() => {
		if (!state || dismissed === state.value) return null;
		const running = state.value === 'off' ? 'with limits' : 'without limits';
		const result = state.value === 'off' ? 'remove the limits' : 'apply the limits';
		if (state.stale === null) {
			return `Apps and databases that have not restarted since this change still run with the old setting. Restart them to ${result}.`;
		}
		const list = workloads(state.stale);
		if (!list) return null;
		const verb = state.stale.apps + state.stale.databases === 1 ? 'is' : 'are';
		return `${list} ${verb} still running ${running}. Restart them to ${result}.`;
	});

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/resource-limits');
			if (res.ok) state = await res.json();
		} catch {
			state = null;
		}
	}

	function openDialog(next: Mode) {
		if (!state || state.envOverride !== null) return;
		attempted = false;
		if (next === 'on') {
			drafts = Object.fromEntries(
				state.organizations.map((org) => [
					org.id,
					{
						memory: org.defaultPodMemoryBytes ? formatMemory(org.defaultPodMemoryBytes) : '',
						cpu: org.defaultPodCpuMilli ? String(org.defaultPodCpuMilli / 1000) : ''
					}
				])
			);
		}
		dialog = next;
	}

	async function saveDefaults() {
		if (!state) return;
		for (const org of state.organizations) {
			const draft = drafts[org.id];
			if (!draft) continue;
			const memory = memoryBytes(draft);
			const cpu = cpuMilli(draft);
			if (memory === org.defaultPodMemoryBytes && cpu === org.defaultPodCpuMilli) continue;
			const res = await apiFetch(`/apiv1/admin/organizations/${org.id}/quota`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ defaultPodMemoryBytes: memory, defaultPodCpuMilli: cpu })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body?.message || `Could not save the defaults for ${org.name}`);
			}
		}
	}

	async function confirm() {
		if (!dialog || saving) return;
		attempted = true;
		if (dialog === 'on' && invalid) return;
		const next = dialog;
		saving = true;
		try {
			if (next === 'on') await saveDefaults();
			const res = await apiFetch('/apiv1/admin/instance-settings/resource-limits', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: next })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'Could not save');
			state = body;
			dismissed = null;
			localStorage.removeItem(DISMISSED_KEY);
			dialog = null;
			await instanceFeatures.load(true);
			toasts.add({
				title: next === 'on' ? 'Resource limits on' : 'Resource limits off',
				color: 'success'
			});
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	function dismiss() {
		if (!state) return;
		dismissed = state.value;
		localStorage.setItem(DISMISSED_KEY, state.value);
	}

	onMount(() => {
		dismissed = localStorage.getItem(DISMISSED_KEY);
		void load();
	});
</script>

{#if state}
	<SectionCard
		title="Resource limits"
		description="Choose whether apps and databases are held to a limit on this server."
	>
		<div class="body">
			{#if state.envOverride !== null}
				<div class="locked">
					<Badge tone="neutral">env override</Badge>
					<span>
						Pinned to <span class="font-mono">{state.envOverride}</span> by the
						<span class="font-mono">INSTANCE_RESOURCE_LIMITS</span> env var.
					</span>
				</div>
				{#if change}
					<SettingCommand {change} />
				{/if}
			{:else}
				<ToggleRow
					bind:checked={toggled}
					label="Limit apps and databases"
					hint={state.value === 'on'
						? 'Apps and databases get their own limits or the organization default.'
						: "Apps and databases can use all of this server's resources."}
					disabled={saving}
					onchange={() => openDialog(state?.value === 'on' ? 'off' : 'on')}
				/>
			{/if}
			{#if notice}
				<Alert tone="info" title="Restart to apply">
					{notice}
					{#snippet actions()}
						<Button size="sm" variant="ghost" onclick={dismiss}>Dismiss</Button>
					{/snippet}
				</Alert>
			{/if}
		</div>
	</SectionCard>

	<Modal
		bind:open={
			() => dialog === 'off',
			(v) => {
				if (!v && dialog === 'off') dialog = null;
			}
		}
		title="Turn off resource limits?"
	>
		<p class="copy">
			Existing apps and databases keep their current limits until they restart, then run without
			limits. To apply it now, restart them.
		</p>
		<p class="copy">One app can use up the whole server while limits are off.</p>
		{#snippet footer()}
			<Button variant="ghost" disabled={saving} onclick={() => (dialog = null)}>Cancel</Button>
			<Button variant="primary" loading={saving} onclick={confirm}>Turn off limits</Button>
		{/snippet}
	</Modal>

	<Modal
		bind:open={
			() => dialog === 'on',
			(v) => {
				if (!v && dialog === 'on') dialog = null;
			}
		}
		title="Turn on resource limits?"
		size="lg"
	>
		<div class="on">
			<Alert tone="warning" title="Apps may be killed for using too much memory">
				Every app and database without its own limits gets the organization default at its next
				restart. Apps using more than that may be killed for memory. Nothing restarts now.
				{#if affectedText}
					This affects {affectedText}.
				{/if}
			</Alert>

			<p class="hint">{fallbackHint}</p>

			<div class="orgs">
				{#each state.organizations as org (org.id)}
					<div class="org">
						{#if state.organizations.length > 1}
							<p class="org-name">{org.name}</p>
						{/if}
						<div class="fields">
							<Field
								label="Default memory limit"
								for="limit-memory-{org.id}"
								error={attempted ? memoryError(drafts[org.id]) : null}
							>
								<Input
									id="limit-memory-{org.id}"
									placeholder={formatMemory(state.fallback.app.memoryBytes)}
									bind:value={drafts[org.id].memory}
								/>
							</Field>
							<Field
								label="Default CPU limit"
								for="limit-cpu-{org.id}"
								error={attempted ? cpuError(drafts[org.id]) : null}
							>
								<Input
									id="limit-cpu-{org.id}"
									placeholder={String(state.fallback.app.cpuMilli / 1000)}
									bind:value={drafts[org.id].cpu}
								/>
							</Field>
						</div>
					</div>
				{/each}
			</div>
		</div>
		{#snippet footer()}
			<Button variant="ghost" disabled={saving} onclick={() => (dialog = null)}>Cancel</Button>
			<Button variant="primary" loading={saving} onclick={confirm}>Turn on limits</Button>
		{/snippet}
	</Modal>
{/if}

<style>
	.body,
	.on {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.locked {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.copy {
		font-size: var(--text-body);
		color: var(--text-default);
	}
	.copy + .copy {
		margin-top: var(--space-2);
		color: var(--text-muted);
	}
	.hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.orgs {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-height: 22rem;
		overflow-y: auto;
	}
	.org-name {
		margin-bottom: var(--space-2);
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		align-items: start;
	}
</style>
