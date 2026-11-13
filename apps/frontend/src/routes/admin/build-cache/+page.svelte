<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Alert,
		Button,
		FormActions,
		Input,
		Modal,
		SectionCard,
		SettingRow,
		SettingsList,
		Skeleton,
		Stack,
		Swap,
		Switch,
		ToggleRow,
		TopList
	} from '$lib/components/ui';
	import Metric from '$lib/components/ui/Metric.svelte';
	import { formatMemory } from '$lib/utils/format';

	interface Settings {
		enabled: boolean;
		maxGiB: number | null;
		maxAgeDays: number;
	}

	interface View {
		available: boolean;
		pvcName: string | null;
		pvcSize: string | null;
		settings: Settings;
		defaults: Settings;
		idleMinutes: number;
	}

	interface Usage {
		totalBytes: number;
		diskBytes: number | null;
		diskUsedBytes: number | null;
		tenants: { name: string; bytes: number; lastUsedAt: string | null }[];
	}

	interface PruneResult {
		freedBytes: number;
		totalBytes: number;
		removed: string[];
		skipped: { name: string; reason: 'in-use' | 'recent' }[];
	}

	const url = '/apiv1/admin/build-cache';

	let view = $state<View | null>(null);
	let loadError = $state<string | null>(null);
	let usage = $state<Usage | null>(null);
	let usageError = $state<string | null>(null);
	let measuring = $state(false);
	let saving = $state(false);
	let pruning = $state<'idle' | 'all' | null>(null);
	let confirmAll = $state(false);

	let budgetOn = $state(false);
	let budgetText = $state('');
	let ageText = $state('');

	function seed(next: View) {
		view = next;
		budgetOn = next.settings.maxGiB !== null;
		budgetText = next.settings.maxGiB === null ? '' : String(next.settings.maxGiB);
		ageText = String(next.settings.maxAgeDays);
	}

	const budgetValue = $derived(budgetOn ? Number(budgetText) : null);
	const ageValue = $derived(Number(ageText));
	const budgetError = $derived(
		budgetOn && (!Number.isInteger(budgetValue) || (budgetValue ?? 0) < 1)
			? 'Enter a whole number of GiB, 1 or more.'
			: null
	);
	const ageError = $derived(
		!Number.isInteger(ageValue) || ageValue < 1 || ageValue > 365
			? 'Enter a number of days from 1 to 365.'
			: null
	);
	const dirty = $derived(
		!!view && (budgetValue !== view.settings.maxGiB || ageValue !== view.settings.maxAgeDays)
	);

	async function errorOf(res: Response, fallback: string) {
		const body = await res.json().catch(() => ({}));
		return new Error(body?.message || fallback);
	}

	async function load() {
		try {
			const res = await apiFetch(url);
			if (!res.ok) throw await errorOf(res, `The server answered ${res.status}.`);
			seed(await res.json());
			loadError = null;
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load the build cache";
		}
	}

	async function measure() {
		measuring = true;
		try {
			const res = await apiFetch(`${url}/usage`);
			if (!res.ok) throw await errorOf(res, "Couldn't measure the cache");
			usage = await res.json();
			usageError = null;
		} catch (e) {
			usageError = e instanceof Error ? e.message : "Couldn't measure the cache";
		} finally {
			measuring = false;
		}
	}

	async function patch(body: Partial<Settings>, done: string) {
		saving = true;
		try {
			const res = await apiFetch(url, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw await errorOf(res, "Couldn't save");
			seed(await res.json());
			toasts.add({ title: done, color: 'success' });
		} catch (e) {
			if (view) seed({ ...view });
			toasts.add({ title: e instanceof Error ? e.message : "Couldn't save", color: 'error' });
		} finally {
			saving = false;
		}
	}

	function toggleEnabled() {
		if (!view) return;
		const next = !view.settings.enabled;
		void patch(
			{ enabled: next },
			next ? 'Builds use the shared cache again' : 'Builds no longer use the shared cache'
		);
	}

	function saveLimits() {
		if (budgetError || ageError) return;
		void patch({ maxGiB: budgetValue, maxAgeDays: ageValue }, 'Cache limits saved');
	}

	async function prune(mode: 'idle' | 'all') {
		confirmAll = false;
		pruning = mode;
		try {
			const res = await apiFetch(`${url}/prune`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode })
			});
			if (!res.ok) throw await errorOf(res, "Couldn't prune the cache");
			const result: PruneResult = await res.json();
			const busy = result.skipped.filter((s) => s.reason === 'in-use').length;
			toasts.add({
				title:
					result.removed.length === 0
						? 'Nothing to prune'
						: `Freed ${formatMemory(result.freedBytes)} from ${result.removed.length} ${result.removed.length === 1 ? 'environment' : 'environments'}`,
				description: busy ? `${busy} with a build running were left alone.` : undefined,
				color: 'success'
			});
			await measure();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't prune the cache",
				color: 'error'
			});
		} finally {
			pruning = null;
		}
	}

	const diskShare = $derived(
		usage?.diskBytes ? Math.round(((usage.diskUsedBytes ?? 0) / usage.diskBytes) * 100) : null
	);

	onMount(async () => {
		await load();
		if (view?.available) await measure();
	});
</script>

<Swap key={view ? 'ready' : loadError ? 'error' : 'loading'}>
	{#if view && !view.available}
		<SectionCard title="Build cache">
			<Alert tone="info" title="This instance has no shared build cache">
				Builds keep their layers in BuildKit or S3 instead. Turn on <code
					>builders.localCache.enabled</code
				> in the Helm values to give builds a shared cache volume.
			</Alert>
		</SectionCard>
	{:else if view}
		<Stack>
			<SectionCard
				title="Build cache"
				description="Builds reuse layers from earlier builds of the same app, so unchanged steps are skipped."
			>
				<SettingsList>
					<ToggleRow
						checked={view.settings.enabled}
						label="Reuse layers between builds"
						hint="Off, every build starts from scratch: slower builds, no cache on disk. What is already cached stays until you prune it."
						disabled={saving}
						onchange={toggleEnabled}
					/>
				</SettingsList>
			</SectionCard>

			<SectionCard
				title="Disk usage"
				description={view.pvcName
					? `Stored on the ${view.pvcName} volume${view.pvcSize ? `, requested at ${view.pvcSize}` : ''}.`
					: undefined}
			>
				<div class="body">
					{#if usage}
						<div class="metrics">
							<Metric label="Build cache" value={formatMemory(usage.totalBytes)} size="sm" />
							<Metric label="Environments cached" value={usage.tenants.length} size="sm" />
							{#if diskShare !== null}
								<Metric
									label="Disk used"
									value={diskShare}
									unit="%"
									tone={diskShare >= 85 ? 'error' : diskShare >= 70 ? 'warning' : 'neutral'}
									detail="Everything on the disk, not just the cache"
									size="sm"
								/>
							{/if}
						</div>
						{#if usage.tenants.length}
							<TopList
								label="Cache size by environment"
								format={formatMemory}
								items={usage.tenants.map((t) => ({
									id: t.name,
									label: t.name,
									value: t.bytes
								}))}
							/>
						{/if}
					{:else if usageError}
						<Alert tone="error" title="Couldn't measure the cache">{usageError}</Alert>
					{:else}
						<Skeleton height="6rem" rounded="var(--radius-widget)" />
					{/if}
					<FormActions>
						<Button variant="ghost" loading={measuring} onclick={measure}>Measure again</Button>
						<Button
							loading={pruning === 'idle'}
							disabled={pruning !== null}
							onclick={() => prune('idle')}
						>
							Prune idle caches
						</Button>
						<Button
							variant="danger"
							loading={pruning === 'all'}
							disabled={pruning !== null}
							onclick={() => (confirmAll = true)}
						>
							Prune everything
						</Button>
					</FormActions>
				</div>
			</SectionCard>

			<SectionCard
				title="Automatic pruning"
				description="Checked before every build. A cache with a build running, or used in the last {view.idleMinutes} minutes, is never removed."
			>
				<div class="body">
					<SettingsList>
						<SettingRow label="Size budget" for="cache-budget">
							{#snippet hint()}
								{#if budgetError}
									<span class="error">{budgetError}</span>
								{:else}
									Over this, the least recently used environments are removed first. Off, only a
									disk above 80% full triggers pruning.
								{/if}
							{/snippet}
							<div class="control">
								<Input
									id="cache-budget"
									type="number"
									min="1"
									size="sm"
									disabled={!budgetOn}
									placeholder={budgetOn ? '20' : 'No budget'}
									suffix="GiB"
									bind:value={budgetText}
								/>
								<Switch label="Limit the build cache size" bind:checked={budgetOn} />
							</div>
						</SettingRow>
						<SettingRow label="Remove caches unused for" for="cache-age">
							{#snippet hint()}
								{#if ageError}
									<span class="error">{ageError}</span>
								{:else}
									Default {view?.defaults.maxAgeDays} days.
								{/if}
							{/snippet}
							<div class="control">
								<Input
									id="cache-age"
									type="number"
									min="1"
									max="365"
									size="sm"
									suffix="days"
									bind:value={ageText}
								/>
							</div>
						</SettingRow>
					</SettingsList>
					{#if dirty}
						<FormActions>
							<Button variant="ghost" disabled={saving} onclick={() => view && seed(view)}>
								Discard
							</Button>
							<Button variant="primary" loading={saving} onclick={saveLimits}>Save</Button>
						</FormActions>
					{/if}
				</div>
			</SectionCard>
		</Stack>
	{:else if loadError}
		<Alert tone="error" title="Couldn't load the build cache">{loadError}</Alert>
	{:else}
		<Stack>
			<Skeleton height="8rem" rounded="var(--radius-widget)" />
			<Skeleton height="12rem" rounded="var(--radius-widget)" />
		</Stack>
	{/if}
</Swap>

<Modal bind:open={confirmAll} title="Prune the whole build cache?" size="sm">
	<p class="muted">
		Every environment's next build starts from scratch and takes longer. Environments with a build
		running right now are left alone.
	</p>
	{#snippet footer()}
		<FormActions>
			<Button variant="ghost" onclick={() => (confirmAll = false)}>Cancel</Button>
			<Button variant="danger" onclick={() => prune('all')}>Prune everything</Button>
		</FormActions>
	{/snippet}
</Modal>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.metrics {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-6);
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
	.muted {
		color: var(--text-muted);
	}
</style>
