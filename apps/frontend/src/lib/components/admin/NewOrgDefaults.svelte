<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Alert,
		Field,
		FieldGrid,
		FormActions,
		Button,
		Input,
		SectionCard
	} from '$lib/components/ui';

	const MIB = 1024 ** 2;

	interface Defaults {
		cpuLimitMilli: number | null;
		memoryLimitBytes: number | null;
		maxProjects: number | null;
		maxEnvironments: number | null;
		maxDeployments: number | null;
	}
	interface State {
		value: Defaults;
		stored: Defaults | null;
		fallback: Defaults;
	}
	type Draft = Record<'cpu' | 'memory' | 'projects' | 'environments' | 'deployments', string>;

	const FIELDS: { id: keyof Draft; label: string; unit: string; example: string }[] = [
		{ id: 'cpu', label: 'CPU', unit: 'millicores', example: '4000' },
		{ id: 'memory', label: 'Memory', unit: 'MiB', example: '8192' },
		{ id: 'projects', label: 'Projects', unit: 'projects', example: '50' },
		{ id: 'environments', label: 'Environments', unit: 'environments', example: '100' },
		{ id: 'deployments', label: 'Deployments', unit: 'deployments', example: '200' }
	];

	let state = $state<State | null>(null);
	let draft = $state<Draft>(emptyDraft());
	let saved = $state<Draft>(emptyDraft());
	let saving = $state(false);
	let attempted = $state(false);

	function emptyDraft(): Draft {
		return { cpu: '', memory: '', projects: '', environments: '', deployments: '' };
	}

	function toDraft(value: Defaults): Draft {
		const text = (n: number | null) => (n ? String(n) : '');
		return {
			cpu: text(value.cpuLimitMilli),
			memory: text(value.memoryLimitBytes ? Math.round(value.memoryLimitBytes / MIB) : null),
			projects: text(value.maxProjects),
			environments: text(value.maxEnvironments),
			deployments: text(value.maxDeployments)
		};
	}

	function parse(text: string): number | null {
		const trimmed = text.trim();
		if (!trimmed) return null;
		return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : NaN;
	}

	function fieldError(id: keyof Draft): string | null {
		return Number.isNaN(parse(draft[id]))
			? 'Enter a whole number above 0, or leave it blank.'
			: null;
	}

	const invalid = $derived(FIELDS.some((f) => Number.isNaN(parse(draft[f.id]))));
	const dirty = $derived(FIELDS.some((f) => draft[f.id].trim() !== saved[f.id]));
	const anyCap = $derived(!!state && Object.values(state.value).some((v) => v !== null));

	function apply(next: State) {
		state = next;
		saved = toDraft(next.value);
		draft = { ...saved };
	}

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/new-org-defaults');
			if (res.ok) apply(await res.json());
		} catch {
			state = null;
		}
	}

	async function save() {
		if (saving) return;
		attempted = true;
		if (invalid) return;
		saving = true;
		try {
			const memoryMi = parse(draft.memory);
			const res = await apiFetch('/apiv1/admin/instance-settings/new-org-defaults', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cpuLimitMilli: parse(draft.cpu),
					memoryLimitBytes: memoryMi === null ? null : memoryMi * MIB,
					maxProjects: parse(draft.projects),
					maxEnvironments: parse(draft.environments),
					maxDeployments: parse(draft.deployments)
				})
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || "Couldn't save");
			apply(body);
			attempted = false;
			toasts.add({ title: 'New organization defaults saved', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	function discard() {
		draft = { ...saved };
		attempted = false;
	}

	onMount(load);
</script>

{#if state}
	<SectionCard
		title="New organization limits"
		description="The limits a new organization starts with. Blank means no limit."
	>
		<div class="body">
			{#if !anyCap}
				<Alert tone="warning" title="New organizations are unlimited">
					Anyone who can create an organization can use as much compute as the server has and create
					as many projects, environments and deployments as they like. If sign-up is open, set
					limits here.
				</Alert>
			{/if}
			<p class="hint">
				Applied once, when an organization is created. Changing these never touches an organization
				that already exists; edit those one by one under Organizations.
			</p>
			<FieldGrid>
				{#each FIELDS as field (field.id)}
					<Field
						label={field.label}
						for="new-org-{field.id}"
						error={attempted ? fieldError(field.id) : null}
					>
						<Input
							id="new-org-{field.id}"
							type="number"
							min="1"
							bind:value={draft[field.id]}
							placeholder="Unlimited"
							suffix={field.unit}
						/>
					</Field>
				{/each}
			</FieldGrid>
			<FormActions>
				<Button variant="ghost" disabled={!dirty || saving} onclick={discard}>Discard</Button>
				<Button variant="primary" loading={saving} disabled={!dirty} onclick={save}>Save</Button>
			</FormActions>
		</div>
	</SectionCard>
{/if}

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
