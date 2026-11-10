<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Alert,
		Badge,
		Button,
		FormActions,
		Input,
		SectionCard,
		SettingRow,
		SettingsList,
		Skeleton,
		Stack,
		Swap,
		Switch,
		ToggleRow
	} from '$lib/components/ui';

	type LimitValue = number | 'off';

	interface LimitState {
		name: string;
		env: string;
		unit: 'count' | 'GiB';
		min: number;
		offable: boolean;
		fallback: LimitValue | 'auto';
		stored: LimitValue | null;
		value: LimitValue | 'auto';
		pinned: boolean;
	}

	interface State {
		limits: LimitState[];
		nodePortExposure: {
			env: string;
			enabled: boolean;
			stored: boolean | null;
			pinned: boolean;
		};
	}

	interface Draft {
		on: boolean;
		text: string;
	}

	const COPY: Record<string, { label: string; hint: string; unit?: string }> = {
		publicPortsPerOrg: {
			label: 'Public ports per organization',
			hint: 'Node ports, app public ports and public databases, counted together.',
			unit: 'ports'
		},
		customDomainsPerOrg: {
			label: 'Custom domains per organization',
			hint: "Distinct hostnames outside the instance's own domains.",
			unit: 'domains'
		},
		customDomainCreatesPerHour: {
			label: 'New custom domains per hour',
			hint: 'How many custom domains one organization can add in an hour.',
			unit: 'per hour'
		},
		projectsPerOrg: { label: 'Projects', hint: 'Per organization.', unit: 'projects' },
		environmentsPerOrg: {
			label: 'Extra environments',
			hint: 'Per organization. Each one is a namespace.',
			unit: 'environments'
		},
		deploymentsPerOrg: { label: 'Deployments', hint: 'Per organization.', unit: 'deployments' },
		buildsPerOrg: {
			label: 'Builds at once per organization',
			hint: 'Auto is half the build pool, and no limit on a pool of 4 builds or fewer.',
			unit: 'builds'
		},
		scansPerOrg: {
			label: 'Image scans at once per organization',
			hint: 'The instance-wide scan limit still applies.',
			unit: 'scans'
		},
		volumeSizeGiB: {
			label: 'Largest volume',
			hint: 'The biggest persistent volume an app or database can ask for.'
		},
		databaseReplicas: {
			label: 'Database instances',
			hint: 'Most Postgres instances one database can run, primary included.',
			unit: 'instances'
		},
		namespaceLoadBalancers: {
			label: 'Load balancer services',
			hint: 'Public ports and public databases use these. 0 stops them.',
			unit: 'services'
		},
		namespaceNodePorts: {
			label: 'Node port services',
			hint: 'Raw node ports use these. 0 stops them.',
			unit: 'services'
		},
		ephemeralStorageGiB: {
			label: 'Scratch disk per container',
			hint: 'The ephemeral storage every container gets unless it asks for its own.'
		}
	};

	const GROUPS: { id: string; title: string; description: string; names: string[] }[] = [
		{
			id: 'exposure',
			title: 'Public exposure',
			description: 'How much one organization can open to the internet.',
			names: ['publicPortsPerOrg']
		},
		{
			id: 'domains',
			title: 'Custom domains',
			description: 'Limits on the hostnames organizations bring themselves.',
			names: ['customDomainsPerOrg', 'customDomainCreatesPerHour']
		},
		{
			id: 'size',
			title: 'Organization size',
			description:
				"A ceiling for every organization. Each organization's own limits are under Organizations, and the lower of the two applies.",
			names: ['projectsPerOrg', 'environmentsPerOrg', 'deploymentsPerOrg']
		},
		{
			id: 'storage',
			title: 'Storage and databases',
			description: 'Sizes people can ask for when they add a volume or a database.',
			names: ['volumeSizeGiB', 'databaseReplicas']
		},
		{
			id: 'builds',
			title: 'Builds and scans',
			description: 'How much of the shared build and scan capacity one organization can hold.',
			names: ['buildsPerOrg', 'scansPerOrg']
		},
		{
			id: 'namespaces',
			title: 'Namespace quotas',
			description:
				'Kubernetes quotas written into every project namespace. Saving re-applies them to the namespaces that already exist.',
			names: ['namespaceLoadBalancers', 'namespaceNodePorts', 'ephemeralStorageGiB']
		}
	];

	let state = $state<State | null>(null);
	let drafts = $state<Record<string, Draft>>({});
	let saved = $state<Record<string, Draft>>({});
	let nodePorts = $state(true);
	let savedNodePorts = $state(true);
	let saving = $state<string | null>(null);
	let attempted = $state<string | null>(null);
	let loadError = $state<string | null>(null);

	const byName = $derived(new Map((state?.limits ?? []).map((limit) => [limit.name, limit])));

	function toDraft(limit: LimitState): Draft {
		if (limit.stored === 'off') return { on: false, text: '' };
		if (typeof limit.stored === 'number') return { on: true, text: String(limit.stored) };
		return { on: limit.fallback !== 'off', text: '' };
	}

	function apply(next: State) {
		state = next;
		saved = Object.fromEntries(next.limits.map((limit) => [limit.name, toDraft(limit)]));
		drafts = Object.fromEntries(next.limits.map((limit) => [limit.name, toDraft(limit)]));
		savedNodePorts = next.nodePortExposure.enabled;
		nodePorts = next.nodePortExposure.enabled;
	}

	async function load() {
		const res = await apiFetch('/apiv1/admin/instance-limits');
		if (!res.ok) throw new Error(`Couldn't load the limits (${res.status})`);
		apply(await res.json());
	}

	function show(value: LimitValue | 'auto', limit: LimitState): string {
		if (value === 'off') return 'No limit';
		if (value === 'auto') return 'Auto';
		const plural = limit.unit === 'GiB' ? 'GiB' : (COPY[limit.name]?.unit ?? '');
		const unit = value === 1 && plural.endsWith('s') ? plural.slice(0, -1) : plural;
		return `${value.toLocaleString()} ${unit}`.trim();
	}

	function placeholder(limit: LimitState): string {
		if (limit.fallback === 'auto') return 'Auto';
		if (limit.fallback === 'off') return '';
		return String(limit.fallback);
	}

	function fieldError(limit: LimitState): string | null {
		const draft = drafts[limit.name];
		if (!draft?.on) return null;
		const text = draft.text.trim();
		if (!text) {
			return limit.fallback === 'off' ? 'Enter a number, or turn the limit off.' : null;
		}
		if (!/^\d+$/.test(text) || Number(text) < limit.min) {
			return limit.min === 0 ? 'Enter a whole number.' : `Enter a whole number from ${limit.min}.`;
		}
		return null;
	}

	function payload(limit: LimitState): LimitValue | null {
		const draft = drafts[limit.name];
		if (!draft.on) return limit.fallback === 'off' ? null : 'off';
		const text = draft.text.trim();
		return text ? Number(text) : null;
	}

	const editable = (names: string[]) =>
		names.map((name) => byName.get(name)).filter((l): l is LimitState => !!l && !l.pinned);

	const dirtyNames = (names: string[]) =>
		editable(names).filter(
			(limit) =>
				drafts[limit.name].on !== saved[limit.name].on ||
				drafts[limit.name].text.trim() !== saved[limit.name].text
		);

	function groupDirty(id: string, names: string[]) {
		const nodePortsDirty =
			id === 'exposure' && !state?.nodePortExposure.pinned && nodePorts !== savedNodePorts;
		return dirtyNames(names).length > 0 || nodePortsDirty;
	}

	function discard(id: string, names: string[]) {
		for (const limit of editable(names)) drafts[limit.name] = { ...saved[limit.name] };
		if (id === 'exposure') nodePorts = savedNodePorts;
		if (attempted === id) attempted = null;
	}

	async function save(id: string, title: string, names: string[]) {
		if (saving) return;
		attempted = id;
		if (editable(names).some((limit) => fieldError(limit))) return;
		saving = id;
		try {
			const body: { limits: Record<string, LimitValue | null>; nodePortExposure?: boolean } = {
				limits: Object.fromEntries(dirtyNames(names).map((limit) => [limit.name, payload(limit)]))
			};
			if (id === 'exposure' && !state?.nodePortExposure.pinned && nodePorts !== savedNodePorts) {
				body.nodePortExposure = nodePorts;
			}
			const res = await apiFetch('/apiv1/admin/instance-limits', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const next = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(next?.message || "Couldn't save");
			const keep = { ...drafts };
			const keepNodePorts = nodePorts;
			apply(next);
			for (const group of GROUPS) {
				if (group.id === id) continue;
				for (const name of group.names) if (keep[name]) drafts[name] = keep[name];
			}
			if (id !== 'exposure') nodePorts = keepNodePorts;
			attempted = null;
			toasts.add({ title: `${title} saved`, color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : "Couldn't save", color: 'error' });
		} finally {
			saving = null;
		}
	}

	onMount(async () => {
		try {
			await load();
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load the limits";
		}
	});
</script>

{#snippet limitRow(limit: LimitState, groupId: string)}
	{@const copy = COPY[limit.name] ?? { label: limit.name, hint: '' }}
	{@const draft = drafts[limit.name]}
	{@const error = attempted === groupId ? fieldError(limit) : null}
	{#if limit.pinned}
		<SettingRow label={copy.label}>
			{#snippet hint()}
				{copy.hint} Set by the <code>{limit.env}</code> environment variable.
			{/snippet}
			<Badge>{show(limit.value, limit)}</Badge>
		</SettingRow>
	{:else}
		<SettingRow label={copy.label} for="limit-{limit.name}">
			{#snippet hint()}
				{#if error}
					<span class="error">{error}</span>
				{:else}
					{copy.hint}
					{#if limit.fallback !== 'off' && limit.fallback !== 'auto'}
						Default {show(limit.fallback, limit)}.
					{/if}
				{/if}
			{/snippet}
			<div class="control">
				<Input
					id="limit-{limit.name}"
					type="number"
					min={String(limit.min)}
					size="sm"
					disabled={!draft.on}
					placeholder={draft.on ? placeholder(limit) : 'No limit'}
					suffix={limit.unit === 'GiB' ? 'GiB' : undefined}
					bind:value={draft.text}
				/>
				{#if limit.offable}
					<Switch label="Limit {copy.label.toLowerCase()}" bind:checked={draft.on} />
				{/if}
			</div>
		</SettingRow>
	{/if}
{/snippet}

<Swap key={state ? 'ready' : loadError ? 'error' : 'loading'}>
	{#if state}
		<Stack>
			{#each GROUPS as group (group.id)}
				<SectionCard title={group.title} description={group.description}>
					<div class="body">
						<SettingsList>
							{#each group.names as name (name)}
								{@const limit = byName.get(name)}
								{#if limit}
									{@render limitRow(limit, group.id)}
								{/if}
							{/each}
							{#if group.id === 'exposure'}
								{#if state.nodePortExposure.pinned}
									<SettingRow label="Raw node ports">
										{#snippet hint()}
											Set by the <code>{state?.nodePortExposure.env}</code> environment variable.
										{/snippet}
										<Badge>{state.nodePortExposure.enabled ? 'Allowed' : 'Off'}</Badge>
									</SettingRow>
								{:else}
									<ToggleRow
										label="Raw node ports"
										hint="Lets apps publish a port on every node's address. Public ports on the organization IP work either way."
										bind:checked={nodePorts}
									/>
								{/if}
							{/if}
						</SettingsList>
						{#if groupDirty(group.id, group.names)}
							<FormActions>
								<Button
									variant="ghost"
									disabled={saving === group.id}
									onclick={() => discard(group.id, group.names)}
								>
									Discard
								</Button>
								<Button
									variant="primary"
									loading={saving === group.id}
									onclick={() => save(group.id, group.title, group.names)}
								>
									Save
								</Button>
							</FormActions>
						{/if}
					</div>
				</SectionCard>
			{/each}
		</Stack>
	{:else if loadError}
		<Alert tone="error" title="Couldn't load the limits">{loadError}</Alert>
	{:else}
		<Stack>
			<Skeleton height="10rem" rounded="var(--radius-widget)" />
			<Skeleton height="14rem" rounded="var(--radius-widget)" />
		</Stack>
	{/if}
</Swap>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.control {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 12rem;
	}
	.error {
		color: var(--status-error);
	}
</style>
