<script lang="ts">
	import '$lib/components/database/database.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import { loadTerminalTabs, saveTerminalTabs, terminalTabsKey } from '$lib/terminal/tabs-store';
	import {
		apiFetch,
		toasts,
		selectedOrganization,
		subscribeOrgEvents,
		sseStatusFor
	} from '$lib/stores';
	import type { PageData } from './$types';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Breadcrumbs from '$lib/components/ui/Breadcrumbs.svelte';
	import {
		Activity,
		Archive,
		LayoutGrid,
		Pause,
		Pencil,
		Play,
		Settings as SettingsIcon
	} from 'lucide-svelte';
	import {
		ActionRow,
		Alert,
		Button,
		EmptyState,
		Modal,
		PageTabs,
		SectionCard,
		SettingsRail,
		Skeleton,
		Switch
	} from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import DatabaseProvisioning from '$lib/components/DatabaseProvisioning.svelte';
	import ResourceLimits from '$lib/components/ResourceLimits.svelte';
	import DatabaseConnect from '$lib/components/database/DatabaseConnect.svelte';
	import DatabaseHealth from '$lib/components/database/DatabaseHealth.svelte';
	import DatabaseActivity from '$lib/components/database/DatabaseActivity.svelte';
	import DatabaseObserve from '$lib/components/database/DatabaseObserve.svelte';
	import ProtectionCard from '$lib/components/database/ProtectionCard.svelte';
	import PoolerCard from '$lib/components/database/PoolerCard.svelte';
	import ReplicationCard from '$lib/components/database/ReplicationCard.svelte';
	import UsersCard from '$lib/components/database/UsersCard.svelte';
	import VersionCard from '$lib/components/database/VersionCard.svelte';
	import {
		BackupsTab,
		TerminalTab,
		ExtensionsTab,
		SettingsTab,
		DatabaseHeader,
		DeleteModal,
		DatabaseAlerts,
		QueriesTab,
		ReplicasCard,
		StorageCard
	} from '$lib/components/database';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import type {
		DatabaseDetail,
		Backup,
		ExtInfo,
		TerminalTab as TerminalTabType
	} from '$lib/components/database';

	// --- Constants ---
	const SCHEDULE_PRESETS = [
		{ id: 'hourly', label: 'Every hour', cron: '0 * * * *', description: 'Top of every hour' },
		{
			id: 'every6h',
			label: 'Every 6 hours',
			cron: '0 */6 * * *',
			description: 'Midnight, 6am, noon, 6pm (UTC)'
		},
		{ id: 'daily', label: 'Daily at 2am UTC', cron: '0 2 * * *', description: 'Once per day' },
		{
			id: 'weekly',
			label: 'Weekly (Sun 2am UTC)',
			cron: '0 2 * * 0',
			description: 'Once per week'
		},
		{ id: 'custom', label: 'Custom cron…', cron: '', description: '' }
	] as const;

	const EXTENSION_CATALOG: Array<{ name: string; description: string; requiresPreload?: boolean }> =
		[
			{
				name: 'pg_stat_statements',
				description: 'Track execution statistics for SQL statements',
				requiresPreload: true
			},
			{ name: 'pgcrypto', description: 'Cryptographic functions' },
			{ name: 'uuid-ossp', description: 'Generate UUIDs' },
			{ name: 'hstore', description: 'Key/value pair storage' },
			{ name: 'citext', description: 'Case-insensitive text type' },
			{ name: 'pg_trgm', description: 'Trigram matching / fuzzy search' },
			{ name: 'btree_gin', description: 'B-tree support for GIN indexes' },
			{ name: 'btree_gist', description: 'B-tree support for GiST indexes' },
			{ name: 'unaccent', description: 'Remove accents from text' },
			{ name: 'tablefunc', description: 'crosstab & other table functions' },
			{ name: 'ltree', description: 'Hierarchical tree-like data type' },
			{ name: 'pg_buffercache', description: 'Inspect the buffer cache' }
		];

	const PARAM_SCHEMA = [
		{
			key: 'max_connections',
			label: 'Max Connections',
			kind: 'int' as const,
			min: 10,
			max: 500,
			defaultValue: '100',
			requiresRestart: true,
			help: 'Maximum concurrent client connections. Restart required.'
		},
		{
			key: 'shared_buffers',
			label: 'Shared Buffers',
			kind: 'memory' as const,
			defaultValue: '',
			requiresRestart: true,
			autoSized: true,
			help: "Memory reserved for caching shared data, taken from this database's memory limit before anything else runs. Restart required."
		},
		{
			key: 'work_mem',
			label: 'Work Memory',
			kind: 'memory' as const,
			defaultValue: '4MB',
			help: 'Memory per sort/hash operation.'
		},
		{
			key: 'maintenance_work_mem',
			label: 'Maintenance Work Memory',
			kind: 'memory' as const,
			defaultValue: '64MB',
			help: 'Memory for VACUUM, CREATE INDEX, etc.'
		},
		{
			key: 'effective_cache_size',
			label: 'Effective Cache Size',
			kind: 'memory' as const,
			defaultValue: '4GB',
			help: 'Planner hint for OS page cache size.'
		},
		{
			key: 'log_min_duration_statement',
			label: 'Slow Query Log (ms)',
			kind: 'int' as const,
			min: -1,
			max: 600000,
			defaultValue: '-1',
			help: 'Log statements slower than this (ms). -1 disables.'
		},
		{
			key: 'statement_timeout',
			label: 'Statement Timeout (ms)',
			kind: 'int' as const,
			min: 0,
			max: 3600000,
			defaultValue: '0',
			help: 'Abort any statement taking longer than this (ms). 0 disables.'
		},
		{
			key: 'idle_in_transaction_session_timeout',
			label: 'Idle-in-Transaction Timeout (ms)',
			kind: 'int' as const,
			min: 0,
			max: 3600000,
			defaultValue: '0',
			help: 'Terminate sessions idle inside a transaction. 0 disables.'
		},
		{
			key: 'synchronous_commit',
			label: 'Synchronous Commit',
			kind: 'string' as const,
			enum: ['on', 'off', 'local', 'remote_write', 'remote_apply'],
			defaultValue: 'on',
			help: 'Wait for WAL flush before acknowledging. Off is faster, less durable.'
		}
	];

	const MAX_BACKUPS = 10;

	// --- Props & derived ---
	let { data } = $props<{ data: PageData }>();
	const dbId = $derived(data.dbId);
	const orgSlug = $derived($page.params.orgSlug);

	// --- Core state ---
	let database = $state<DatabaseDetail | null>(null);
	let loading = $state(true);
	let deleting = $state(false);
	let renameOpen = $state(false);
	let renaming = $state(false);
	let error = $state<string | null>(null);
	let showPassword = $state(false);
	let showConnectionString = $state(false);
	let showPublicConnectionString = $state(false);
	let copiedField = $state<string | null>(null);

	// Backups
	let backups = $state<Backup[]>([]);
	let backupsLoading = $state(false);
	let creatingBackup = $state(false);
	let restoringBackupId = $state<string | null>(null);
	let togglingPublic = $state(false);

	// Backup schedule
	let scheduleCron = $state<string>('');
	let schedulePreset = $state<string>('none');
	let scheduleCustomCron = $state<string>('');
	let scheduleLoaded = $state(false);
	let scheduleSaving = $state(false);

	// Extensions
	let extensions = $state<ExtInfo[]>([]);
	let preloadedExts = $state<string[]>([]);
	let extensionsLoading = $state(false);
	let extensionsLoaded = $state(false);
	let extensionSearch = $state('');
	let busyExtension = $state<string | null>(null);

	// Settings
	let settings = $state<Record<string, string>>({});
	let settingsLoading = $state(false);
	let settingsLoaded = $state(false);
	let settingsSaving = $state(false);
	let settingsDirty = $state(false);
	let settingsAdvisories = $state<{ key: string; message: string }[]>([]);
	let settingsDrift = $state<Record<string, string | null>>({});
	let settingsLoadedValues = $state<Record<string, string>>({});

	// Terminal
	let logs = $state('');
	let logsLoading = $state(false);
	let tailLines = $state(200);
	let logsRef = $state<HTMLPreElement | null>(null);
	let activeConsoleTab = $state<string>('logs');
	let logsPodName = $state<string>('');
	let logsPrevious = $state(false);
	let killedList = $state<
		{
			entryId: string;
			pod: string;
			container: string;
			reason: string;
			exitCode: number | null;
			finishedAt: string | null;
		}[]
	>([]);
	let killedLoading = $state(false);
	let killedFetched = $state(false);
	let killedLogs = $state<Record<string, string>>({});
	let killedLogsLoading = $state<string | null>(null);
	let expandedKilled = $state<string | null>(null);
	let terminalTabs = $state<TerminalTabType[]>([]);
	let terminalCounter = 0;
	let restoredTabsFor: string | null = null;
	let consoleExpanded = $state(false);

	// Delete modal
	let showDeleteModal = $state(false);
	let deleteCountdownActive = $state(false);
	let deleteCountdown = $state(10);
	let deleteTimerInterval = $state<ReturnType<typeof setInterval> | null>(null);
	let deleteProgress = $derived(((10 - deleteCountdown) / 10) * 100);

	// Resources
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let resourcesDirty = $state(false);
	let savingResources = $state(false);
	let storageSizeDraft = $state('');
	let storageDirty = $state(false);
	let expandingStorage = $state(false);
	let storageWarning = $state<string | null>(null);

	// Replicas. `replicasDirty` guards the same way `resourcesDirty` does: a
	// silent refetch must not snap the slider back while an edit is pending.
	let scaleReplicas = $state(1);
	let replicasDirty = $state(false);
	let savingReplicas = $state(false);

	type DbTab = 'overview' | 'backups' | 'observe' | 'settings';
	const TABS = [
		{ id: 'overview' as const, label: 'Overview', icon: LayoutGrid },
		{ id: 'backups' as const, label: 'Backups', icon: Archive },
		{ id: 'observe' as const, label: 'Observe', icon: Activity },
		{ id: 'settings' as const, label: 'Settings', icon: SettingsIcon }
	];
	const LEGACY_TABS: Record<string, [DbTab, string?]> = {
		connection: ['overview'],
		terminal: ['overview'],
		metrics: ['observe'],
		queries: ['observe'],
		resources: ['settings', 'resources'],
		extensions: ['settings', 'extensions']
	};
	const SETTINGS_SECTIONS = [
		'general',
		'resources',
		'protection',
		'availability',
		'version',
		'pooler',
		'users',
		'parameters',
		'extensions',
		'network',
		'danger'
	] as const;

	function routeFrom(url: URL): { tab: DbTab; section: string } {
		const raw = url.searchParams.get('tab') ?? 'overview';
		const legacy = LEGACY_TABS[raw];
		const tab: DbTab = legacy
			? legacy[0]
			: TABS.some((t) => t.id === raw)
				? (raw as DbTab)
				: 'overview';
		const s = url.searchParams.get('s');
		const section =
			s && (SETTINGS_SECTIONS as readonly string[]).includes(s) ? s : (legacy?.[1] ?? 'general');
		return { tab, section };
	}

	const route = $derived(routeFrom($page.url));
	const activeTab = $derived(route.tab);
	const settingsSection = $derived(route.section);

	function hrefFor(tab: DbTab, section?: string) {
		const url = new URL($page.url);
		if (tab === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		if (tab === 'settings' && section && section !== 'general') url.searchParams.set('s', section);
		else url.searchParams.delete('s');
		return url.pathname + url.search;
	}

	const SETTINGS_RAIL = $derived([
		{
			label: 'Database',
			items: [
				{ id: 'general', label: 'General', href: hrefFor('settings', 'general') },
				{ id: 'resources', label: 'Resources', href: hrefFor('settings', 'resources') },
				{ id: 'protection', label: 'Protection', href: hrefFor('settings', 'protection') },
				{ id: 'network', label: 'Public access', href: hrefFor('settings', 'network') }
			]
		},
		{
			label: 'Postgres',
			items: [
				{
					id: 'version',
					label: 'Version and security',
					href: hrefFor('settings', 'version')
				},
				{
					id: 'availability',
					label: 'High availability',
					href: hrefFor('settings', 'availability')
				},
				{ id: 'pooler', label: 'Connection pooler', href: hrefFor('settings', 'pooler') },
				{ id: 'users', label: 'Users', href: hrefFor('settings', 'users') },
				{ id: 'parameters', label: 'Parameters', href: hrefFor('settings', 'parameters') },
				{ id: 'extensions', label: 'Extensions', href: hrefFor('settings', 'extensions') }
			]
		},
		{
			label: 'Admin',
			items: [{ id: 'danger', label: 'Danger zone', href: hrefFor('settings', 'danger') }]
		}
	]);

	function gotoTab(tab: DbTab, section?: string) {
		goto(hrefFor(tab, section), { replaceState: true, keepFocus: true, noScroll: true });
	}

	let terminalVisited = $state(false);
	let connectOpen = $state(false);
	let showDisablePublicModal = $state(false);
	let observeView = $state<'metrics' | 'queries'>('metrics');
	$effect(() => {
		if (activeTab === 'overview') terminalVisited = true;
	});

	// SSE
	interface QueryStatsPayload {
		installed: boolean;
		queries: import('$lib/components/database/QueriesTab.svelte').QueryStat[];
	}
	let queryStats = $state<QueryStatsPayload | null>(null);
	let queryStatsLoading = $state(false);
	let queryStatsRefreshing = $state(false);
	let queryStatsResetting = $state(false);
	let queryStatsEnabling = $state(false);
	let querySearch = $state('');
	let showResetStatsModal = $state(false);
	let stoppingDb = $state(false);
	let startingDb = $state(false);
	let restartingDb = $state(false);
	let showStopModal = $state(false);
	let showRestartModal = $state(false);

	const dbStopped = $derived(
		database?.liveStatus?.phase === 'hibernated' || database?.status === 'stopped'
	);

	async function lifecycleAction(kind: 'stop' | 'start' | 'restart') {
		if (kind === 'stop') stoppingDb = true;
		else if (kind === 'start') startingDb = true;
		else restartingDb = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/${kind}`, { method: 'POST' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || `Failed to ${kind} database`);
			}
			toasts.add({
				title:
					kind === 'stop'
						? 'Database stopping'
						: kind === 'start'
							? 'Database starting'
							: 'Database restarting',
				color: 'success'
			});
			await fetchDatabase(true);
			void fetchLive();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : `Failed to ${kind} database`,
				color: 'error'
			});
		} finally {
			stoppingDb = false;
			startingDb = false;
			restartingDb = false;
		}
	}

	async function fetchQueryStats(silent = false) {
		if (silent) queryStatsRefreshing = true;
		else queryStatsLoading = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/query-stats`);
			if (response.ok) queryStats = await response.json();
		} catch {
			queryStats = queryStats ?? null;
		} finally {
			queryStatsLoading = false;
			queryStatsRefreshing = false;
		}
	}

	async function resetQueryStats() {
		queryStatsResetting = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/query-stats/reset`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to reset statistics');
			}
			toasts.add({ title: 'Statistics reset', color: 'success' });
			await fetchQueryStats(true);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to reset statistics',
				color: 'error'
			});
		} finally {
			queryStatsResetting = false;
		}
	}

	async function enableQueryStats() {
		queryStatsEnabling = true;
		try {
			await installExtension('pg_stat_statements', true);
			await fetchQueryStats(true);
		} finally {
			queryStatsEnabling = false;
		}
	}

	let dbSseUnsub: (() => void) | null = null;

	// Live updates ride the org SSE bus (redis streams). Polling is the
	// fallback and the drift-catcher: fast cadence while the bus is
	// disconnected, slow cadence while it is healthy so size/connection
	// stats stay fresh (they never emit bus events).
	let sseState = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	$effect(() => {
		const orgId = $selectedOrganization?.id;
		if (!orgId) return;
		const unsub = sseStatusFor(orgId).subscribe((v) => (sseState = v));
		return unsub;
	});

	$effect(() => {
		if (!database) return;
		const degraded = sseState !== 'connected';
		const interval = setInterval(
			() => {
				if (document.hidden) return;
				if (degraded) {
					fetchDatabase(true);
				} else {
					void fetchLive();
				}
			},
			degraded ? 10_000 : 30_000
		);
		return () => clearInterval(interval);
	});

	// --- Derived ---
	let filteredExtensions = $derived.by(() => {
		const q = extensionSearch.trim().toLowerCase();
		const byName = new Map<string, ExtInfo>();
		for (const e of extensions) byName.set(e.name, e);
		const merged: Array<
			ExtInfo & { description?: string; requiresPreload?: boolean; featured?: boolean }
		> = [];
		for (const c of EXTENSION_CATALOG) {
			const live = byName.get(c.name);
			if (!live) continue;
			merged.push({
				...live,
				description: c.description,
				requiresPreload: c.requiresPreload,
				featured: true
			});
			byName.delete(c.name);
		}
		for (const e of byName.values()) {
			merged.push({ ...e, description: e.comment });
		}
		if (!q) return merged;
		return merged.filter(
			(e) => e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q)
		);
	});

	// --- Effects ---
	$effect(() => {
		if (
			activeTab === 'settings' &&
			settingsSection === 'extensions' &&
			database?.mode === 'cnpg' &&
			!extensionsLoaded &&
			!extensionsLoading
		) {
			fetchExtensions();
		}
		if (
			(activeTab === 'overview' ||
				activeTab === 'observe' ||
				(activeTab === 'settings' && settingsSection === 'parameters')) &&
			database?.mode === 'cnpg' &&
			!settingsLoaded &&
			!settingsLoading
		) {
			fetchSettings();
		}
		if (activeTab === 'backups' && database?.mode === 'cnpg' && !scheduleLoaded) {
			fetchSchedule();
		}
		if (
			activeTab === 'observe' &&
			observeView === 'queries' &&
			database?.mode === 'cnpg' &&
			!queryStats &&
			!queryStatsLoading
		) {
			fetchQueryStats();
		}
	});

	$effect(() => {
		if (activeTab === 'overview' && activeConsoleTab === 'logs' && database?.pods?.[0]?.name) {
			untrack(fetchLogs);
		}
		if (activeTab === 'overview' && activeConsoleTab === 'killed' && !killedFetched) {
			untrack(fetchKilled);
		}
	});

	// --- API functions ---
	async function fetchDatabase(silent = false) {
		if (!silent) loading = true;
		if (!silent) error = null;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}?fast=1`);
			if (!response.ok) throw new Error('Failed to fetch database');
			const incoming = await response.json();
			database = {
				...incoming,
				pods: incoming?.pods?.length ? incoming.pods : (database?.pods ?? [])
			};
			error = null;
			if (database?.backupsEnabled) fetchBackups();
			if (!resourcesDirty) {
				resourceCpuMilli = database?.cpuRequestMilli ?? null;
				resourceMemoryBytes =
					database?.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null;
			}
			if (!replicasDirty) {
				scaleReplicas = Math.max(1, database?.replicas ?? 1);
			}
			if (!storageDirty) {
				storageSizeDraft = database?.storageSize ?? '';
			}
		} catch (e) {
			if (!silent) error = e instanceof Error ? e.message : 'Failed to load database';
		} finally {
			if (!silent) loading = false;
		}
		void fetchLive();
	}

	let liveInFlight = false;

	function mergeLiveStatus(
		prev: DatabaseDetail['liveStatus'] | undefined,
		next: DatabaseDetail['liveStatus'] | undefined
	): DatabaseDetail['liveStatus'] | undefined {
		if (!next) return prev;
		if (!prev) return next;
		return {
			...next,
			verdict: next.verdict ?? prev.verdict,
			verdictReasons: next.verdictReasons ?? prev.verdictReasons,
			size: next.size ?? prev.size,
			connections: next.connections ?? prev.connections,
			statsAt: next.statsAt ?? prev.statsAt
		};
	}

	const STATS_STALE_MS = 90_000;
	const statsStale = $derived.by(() => {
		const at = database?.liveStatus?.statsAt;
		if (!at) return !!database?.liveStatus && database.liveStatus.size == null;
		return Date.now() - Date.parse(at) > STATS_STALE_MS;
	});
	const statsAgo = $derived.by(() => {
		const at = database?.liveStatus?.statsAt;
		if (!at) return '';
		const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
		if (s < 60) return `${s}s ago`;
		const m = Math.round(s / 60);
		return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
	});

	const DB_DOWN_CONFIRM_MS = 60_000;
	const dbErrorNow = $derived(
		database?.mode === 'cnpg' && database?.status === 'error' && !database?.liveStatus?.ready
	);
	let dbErrorConfirmed = $state(false);
	let dbErrorTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (dbErrorNow) {
			dbErrorTimer ??= setTimeout(() => {
				dbErrorTimer = null;
				dbErrorConfirmed = true;
			}, DB_DOWN_CONFIRM_MS);
		} else {
			if (dbErrorTimer) {
				clearTimeout(dbErrorTimer);
				dbErrorTimer = null;
			}
			dbErrorConfirmed = false;
		}
		return () => {
			if (dbErrorTimer) {
				clearTimeout(dbErrorTimer);
				dbErrorTimer = null;
			}
		};
	});

	async function fetchLive() {
		if (liveInFlight || !database) return;
		liveInFlight = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/live`);
			if (!response.ok) return;
			const live = await response.json();
			if (!database) return;
			database.liveStatus = mergeLiveStatus(database.liveStatus, live.liveStatus);
			database.pods = live.pods;
			if (live.status) database.status = live.status;
		} catch {
			return;
		} finally {
			liveInFlight = false;
		}
	}

	async function saveResources() {
		if (!database) return;
		savingResources = true;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/resources`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cpuRequestMilli: resourceCpuMilli,
					memoryRequestBytes: resourceMemoryBytes
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update resources');
			}
			toasts.add({
				title: 'Resources updated',
				description: 'Database pod will restart with new values.',
				color: 'success'
			});
			resourcesDirty = false;
			await fetchDatabase(true);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update resources',
				color: 'error'
			});
		} finally {
			savingResources = false;
		}
	}

	const MIB = 1024 * 1024;
	const memoryBytes = $derived(
		database?.memoryRequestBytes != null
			? Number(database.memoryRequestBytes)
			: orgDefaultMemoryBytes
	);
	const memoryUpgradeBytes = $derived.by(() => {
		if (!memoryBytes) return null;
		const next = memoryBytes < 512 * MIB ? 512 * MIB : memoryBytes * 2;
		if (effectiveMemLimit != null && next > effectiveMemLimit) return null;
		return next;
	});
	let upgradingMemory = $state(false);

	async function upgradeMemory() {
		if (!database || !memoryUpgradeBytes) return;
		const toBytes = memoryUpgradeBytes;
		upgradingMemory = true;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/resources`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cpuRequestMilli: database.cpuRequestMilli ?? null,
					memoryRequestBytes: toBytes
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to raise memory');
			}
			toasts.add({
				title: `Memory raised to ${toBytes >= 1024 * MIB ? `${toBytes / (1024 * MIB)} GiB` : `${toBytes / MIB} MiB`}`,
				description: 'It restarts once with the new size.',
				color: 'success'
			});
			resourcesDirty = false;
			await fetchDatabase(true);
		} catch (e) {
			toasts.add({
				title: 'Could not raise memory',
				description: e instanceof Error ? e.message : 'Failed to raise memory',
				color: 'error'
			});
		} finally {
			upgradingMemory = false;
		}
	}

	async function expandStorage() {
		if (!database) return;
		expandingStorage = true;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/storage`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ storageSize: storageSizeDraft.trim() })
			});
			const payload = await res.json().catch(() => null);
			if (!res.ok) throw new Error(payload?.message || 'Failed to expand storage');
			const expandedTo = payload?.storageSize ?? storageSizeDraft.trim();
			database.storageSize = expandedTo;
			storageSizeDraft = expandedTo;
			storageDirty = false;
			storageWarning = payload?.warning ?? null;
			toasts.add({
				title: 'Storage expansion started',
				description: `Volumes are growing to ${expandedTo}.`,
				color: 'success'
			});
			await fetchDatabase(true);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to expand storage',
				color: 'error'
			});
		} finally {
			expandingStorage = false;
		}
	}

	async function scaleDatabase() {
		if (!database) return;
		savingReplicas = true;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/replicas`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ replicas: scaleReplicas })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to scale database');
			}
			toasts.add({
				title: `Scaling to ${scaleReplicas}`,
				description:
					scaleReplicas === 1
						? 'Read replicas are being retired.'
						: 'New replicas clone the primary before they report ready.',
				color: 'success'
			});
			replicasDirty = false;
			await fetchDatabase(true);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to scale database',
				color: 'error'
			});
		} finally {
			savingReplicas = false;
		}
	}

	async function fetchBackups() {
		if (!backups.length) backupsLoading = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/backups`);
			if (!response.ok) return;
			backups = await response.json();
		} finally {
			backupsLoading = false;
		}
	}

	async function createBackup() {
		creatingBackup = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/backups`, {
				method: 'POST',
				body: JSON.stringify({ type: 'full' }),
				headers: { 'Content-Type': 'application/json' }
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create backup');
			}
			toasts.add({
				title: 'Backup started',
				description: 'Your backup is running in the background',
				color: 'success'
			});
			await fetchBackups();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to create backup',
				color: 'error'
			});
		} finally {
			creatingBackup = false;
		}
	}

	async function restoreBackup(backup: Backup) {
		restoringBackupId = backup.id;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/restore`, {
				method: 'POST',
				body: JSON.stringify({ backupId: backup.id }),
				headers: { 'Content-Type': 'application/json' }
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to restore');
			}
			toasts.add({
				title: 'Restore started',
				description: 'The database will be restored shortly',
				color: 'success'
			});
			await fetchDatabase();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to restore',
				color: 'error'
			});
		} finally {
			restoringBackupId = null;
		}
	}

	async function fetchSchedule() {
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/backup-schedule`);
			if (r.ok) {
				const data = await r.json();
				scheduleCron = data.cron || '';
				if (scheduleCron) {
					const preset = SCHEDULE_PRESETS.find((p) => p.cron === scheduleCron);
					schedulePreset = preset ? preset.id : 'custom';
					if (schedulePreset === 'custom') scheduleCustomCron = scheduleCron;
				} else {
					schedulePreset = 'none';
				}
			}
		} finally {
			scheduleLoaded = true;
		}
	}

	async function saveSchedule() {
		let cron = '';
		if (schedulePreset === 'none') {
			scheduleSaving = true;
			try {
				const r = await apiFetch(`/apiv1/databases/${dbId}/backup-schedule`, { method: 'DELETE' });
				if (r.ok) {
					scheduleCron = '';
					toasts.add({ title: 'Schedule cleared', color: 'success' });
				} else {
					toasts.add({ title: 'Failed to clear schedule', color: 'error' });
				}
			} finally {
				scheduleSaving = false;
			}
			return;
		}
		if (schedulePreset === 'custom') {
			cron = scheduleCustomCron.trim();
		} else {
			const preset = SCHEDULE_PRESETS.find((p) => p.id === schedulePreset);
			cron = preset?.cron || '';
		}
		if (!cron) {
			toasts.add({ title: 'Enter a cron expression', color: 'error' });
			return;
		}

		scheduleSaving = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/backup-schedule`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cron })
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				toasts.add({
					title: 'Failed to save schedule',
					description: data.message || 'Unknown error',
					color: 'error'
				});
			} else {
				scheduleCron = data.cron || cron;
				toasts.add({
					title: 'Schedule saved',
					description: `Backups will run: ${scheduleCron}`,
					color: 'success'
				});
			}
		} finally {
			scheduleSaving = false;
		}
	}

	async function enablePublic() {
		if (!database) return;
		togglingPublic = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/public`, { method: 'POST' });
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				toasts.add({
					title: 'Could not expose database',
					description: data.message || 'Unknown error',
					color: 'error'
				});
				return;
			}
			toasts.add({
				title: 'Database exposed',
				description: `${data.host}:${data.port}`,
				color: 'success'
			});
			await fetchDatabase(true);
		} finally {
			togglingPublic = false;
		}
	}

	async function disablePublic() {
		if (!database) return;
		togglingPublic = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/public`, { method: 'DELETE' });
			if (!r.ok) {
				const data = await r.json().catch(() => ({}));
				toasts.add({
					title: 'Failed to disable',
					description: data.message || 'Unknown error',
					color: 'error'
				});
				return;
			}
			toasts.add({ title: 'Public access disabled', color: 'success' });
			await fetchDatabase(true);
		} finally {
			togglingPublic = false;
		}
	}

	// Extensions
	async function fetchExtensions() {
		if (!extensionsLoaded) extensionsLoading = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/extensions`);
			if (r.ok) {
				const data = await r.json();
				extensions = data.extensions || [];
				preloadedExts = data.sharedPreloadLibraries || [];
			}
			extensionsLoaded = true;
		} finally {
			extensionsLoading = false;
		}
	}

	async function installExtension(name: string, addToPreload: boolean) {
		busyExtension = name;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/extensions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, addToPreload })
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data.success) {
				toasts.add({
					title: 'Install failed',
					description: data.output || data.message || 'Unknown error',
					color: 'error'
				});
			} else {
				toasts.add({
					title: `${name} installed`,
					description: data.preloadAdded
						? 'Added to shared_preload_libraries. Restart required.'
						: 'Extension is ready to use',
					color: 'success'
				});
				await fetchExtensions();
			}
		} finally {
			busyExtension = null;
		}
	}

	async function uninstallExtension(name: string, removeFromPreload: boolean) {
		busyExtension = name;
		try {
			const qs = removeFromPreload ? '?removeFromPreload=true' : '';
			const r = await apiFetch(
				`/apiv1/databases/${dbId}/extensions/${encodeURIComponent(name)}${qs}`,
				{ method: 'DELETE' }
			);
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data.success) {
				toasts.add({
					title: 'Uninstall failed',
					description: data.output || data.message || 'Unknown error',
					color: 'error'
				});
			} else {
				toasts.add({ title: `${name} removed`, color: 'success' });
				await fetchExtensions();
			}
		} finally {
			busyExtension = null;
		}
	}

	// Settings
	async function fetchSettings() {
		if (!settingsLoaded) settingsLoading = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/settings`);
			if (r.ok) {
				const data = await r.json();
				settings = { ...(data.parameters || {}) };
				settingsLoadedValues = { ...settings };
				settingsAdvisories = data.advisories || [];
				settingsDrift = data.drift || {};
				settingsDirty = false;
			}
			settingsLoaded = true;
		} finally {
			settingsLoading = false;
		}
	}

	function paramValue(key: string): string {
		const meta = PARAM_SCHEMA.find((p) => p.key === key);
		return settings[key] ?? meta?.defaultValue ?? '';
	}

	function setParam(key: string, v: string) {
		settings = { ...settings, [key]: v };
		settingsDirty = true;
	}

	async function saveSettings() {
		settingsSaving = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/settings`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ parameters: settings })
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				toasts.add({
					title: 'Save failed',
					description: data.message || 'Unknown error',
					color: 'error'
				});
			} else {
				toasts.add({ title: 'Settings saved', color: 'success' });
				settings = { ...(data.parameters || {}) };
				settingsLoadedValues = { ...settings };
				settingsAdvisories = data.advisories || [];
				settingsDirty = false;
			}
		} finally {
			settingsSaving = false;
		}
	}

	// Terminal / logs
	async function fetchLogs() {
		if (!database?.namespace) return;
		const podName = logsPodName || database.liveStatus?.currentPrimary || database.pods?.[0]?.name;
		if (!podName) return;
		if (!logs) logsLoading = true;
		try {
			const params = new URLSearchParams({
				namespace: database.namespace,
				container: 'postgres',
				tailLines: String(tailLines)
			});
			if (logsPrevious) params.set('previous', 'true');
			const r = await apiFetch(`/apiv1/pods/${podName}/logs?${params}`);
			if (r.ok) {
				const data = await r.json();
				logs = data.logs || '';
				requestAnimationFrame(() => {
					if (logsRef) logsRef.scrollTop = logsRef.scrollHeight;
				});
			} else {
				const data = await r.json().catch(() => null);
				logs = logsPrevious
					? data?.message ||
						'No previous container to read. This pod has not restarted since it was created.'
					: '';
			}
		} catch {
			/* ignore */
		} finally {
			logsLoading = false;
		}
	}

	async function fetchKilled() {
		killedLoading = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/killed-containers`);
			killedList = r.ok ? await r.json() : [];
		} catch {
			killedList = [];
		} finally {
			killedLoading = false;
			killedFetched = true;
		}
	}

	async function toggleKilled(entryId: string) {
		if (expandedKilled === entryId) {
			expandedKilled = null;
			return;
		}
		expandedKilled = entryId;
		if (killedLogs[entryId] !== undefined) return;
		killedLogsLoading = entryId;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/killed-containers/${entryId}/logs`);
			killedLogs = { ...killedLogs, [entryId]: r.ok ? ((await r.json()).logs ?? '') : '' };
		} catch {
			killedLogs = { ...killedLogs, [entryId]: '' };
		} finally {
			killedLogsLoading = null;
		}
	}

	function podShortName(name: string): string {
		const parts = name.split('-');
		return parts.length > 2 ? parts.slice(-2).join('-') : name;
	}

	$effect(() => {
		const id = dbId;
		if (!id || restoredTabsFor === id) return;
		restoredTabsFor = id;
		const storedTabs = loadTerminalTabs(terminalTabsKey('database', id));
		if (!storedTabs) return;
		terminalTabs = storedTabs.tabs.map((t) => ({ ...t }));
		activeConsoleTab = storedTabs.active;
		terminalCounter = storedTabs.counter;
		terminalVisited = true;
	});

	$effect(() => {
		const id = dbId;
		const tabsSnapshot = terminalTabs.map((t) => ({
			id: t.id,
			podName: t.podName,
			container: t.container,
			label: t.label,
			title: t.title,
			sessionHandle: t.sessionHandle
		}));
		const active = activeConsoleTab;
		if (!id || restoredTabsFor !== id) return;
		saveTerminalTabs(terminalTabsKey('database', id), {
			tabs: tabsSnapshot,
			active,
			counter: terminalCounter
		});
	});

	function openShellTab(podName: string, container: string) {
		terminalCounter++;
		const id = `term-${Date.now()}-${terminalCounter}`;
		terminalTabs = [...terminalTabs, { id, podName, container, label: `Shell ${terminalCounter}` }];
		activeConsoleTab = id;
	}

	function setTerminalTitle(id: string, title: string) {
		const tab = terminalTabs.find((t) => t.id === id);
		if (tab) tab.title = title.trim().slice(0, 80);
	}

	function setTerminalSession(id: string, handle: string) {
		const tab = terminalTabs.find((t) => t.id === id);
		if (tab) tab.sessionHandle = handle;
	}

	function setTerminalBell(id: string) {
		const tab = terminalTabs.find((t) => t.id === id);
		if (tab && activeConsoleTab !== id) tab.bell = true;
	}

	function closeTerminalTab(id: string) {
		terminalTabs = terminalTabs.filter((t) => t.id !== id);
		if (activeConsoleTab === id) {
			activeConsoleTab =
				terminalTabs.length > 0 ? terminalTabs[terminalTabs.length - 1].id : 'logs';
		}
	}

	// Delete
	function openDeleteModal() {
		if (!database || database.deletionProtection) return;
		showDeleteModal = true;
		deleteCountdownActive = false;
		deleteCountdown = 10;
	}

	function startDeleteCountdown() {
		deleteCountdownActive = true;
		deleteCountdown = 10;
		deleteTimerInterval = setInterval(() => {
			deleteCountdown -= 1;
			if (deleteCountdown <= 0) {
				clearInterval(deleteTimerInterval!);
				deleteTimerInterval = null;
				executeDelete();
			}
		}, 1000);
	}

	function cancelDelete() {
		showDeleteModal = false;
		deleteCountdownActive = false;
		if (deleteTimerInterval) {
			clearInterval(deleteTimerInterval);
			deleteTimerInterval = null;
		}
		deleteCountdown = 10;
	}

	async function executeDelete() {
		if (!database) return;
		if (deleteTimerInterval) {
			clearInterval(deleteTimerInterval);
			deleteTimerInterval = null;
		}
		showDeleteModal = false;
		deleteCountdownActive = false;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete database');
			}
			const result = await response.json().catch(() => ({}));
			const until = result?.recoverableUntil
				? new Date(result.recoverableUntil).toLocaleDateString(undefined, {
						month: 'short',
						day: 'numeric'
					})
				: null;
			toasts.add({
				title: `${database.name} deleted`,
				description: until
					? `Bring it back from the project until ${until}.`
					: 'It had no backup, so it cannot be brought back.',
				color: 'success'
			});
			const ws = database.project?.workspace;
			if (ws) {
				goto(`/${orgSlug}/workspaces/${ws.slug}/projects/${database.project!.slug}`);
			} else if (database.project?.slug) {
				goto(`/${orgSlug}/projects/${database.project.slug}`);
			} else {
				goto(`/${orgSlug}`);
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete',
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	async function renameDatabase(name: string) {
		if (!database) return;
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}/name`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to rename');
			}
			const updated = await response.json();
			database.name = updated.name;
			renameOpen = false;
			toasts.add({ title: 'Database renamed', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to rename',
				color: 'error'
			});
		} finally {
			renaming = false;
		}
	}

	// Helpers
	function copyToClipboard(text: string, field: string) {
		navigator.clipboard.writeText(text);
		copiedField = field;
		setTimeout(() => {
			copiedField = null;
		}, 2000);
	}

	function formatBytes(bytes: number | null): string {
		if (!bytes) return '—';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let n = bytes;
		let i = 0;
		while (n >= 1024 && i < units.length - 1) {
			n /= 1024;
			i++;
		}
		return `${n.toFixed(1)} ${units[i]}`;
	}

	function formatDate(s: string): string {
		return new Date(s).toLocaleString();
	}

	function podStateLabel(): { label: string; kind: 'ready' | 'pending' | 'error' } {
		const ls = database?.liveStatus;
		if (!ls) return { label: 'Unknown', kind: 'pending' };
		if (!ls.exists) return { label: 'Not deployed', kind: 'error' };
		if (database?.status === 'restoring') return { label: 'Restoring', kind: 'pending' };
		if (ls.ready) return { label: 'Running', kind: 'ready' };
		if (ls.message) {
			const m = ls.message.toLowerCase();
			if (m.includes('crash') || m.includes('error') || m.includes('backoff'))
				return { label: ls.message, kind: 'error' };
			return { label: ls.message, kind: 'pending' };
		}
		if (ls.phase === 'Running') return { label: 'Starting', kind: 'pending' };
		return { label: ls.phase || 'Pending', kind: 'pending' };
	}

	// --- Lifecycle ---
	async function fetchQuota() {
		const orgId = $selectedOrganization?.id;
		if (!orgId) return;
		try {
			const res = await apiFetch(`/apiv1/organizations/${orgId}/quota/me`);
			if (res.ok) {
				const q = await res.json();
				orgDefaultCpuMilli = q.org?.defaultPodCpuMilli ?? null;
				orgDefaultMemoryBytes = q.org?.defaultPodMemoryBytes ?? null;
				effectiveCpuLimit = q.effectiveLimit?.cpuMilli ?? null;
				effectiveMemLimit = q.effectiveLimit?.memoryBytes ?? null;
			}
		} catch {
			/* ignore */
		}
	}

	// Org resource defaults/limits
	let orgDefaultCpuMilli = $state<number | null>(null);
	let orgDefaultMemoryBytes = $state<number | null>(null);
	let effectiveCpuLimit = $state<number | null>(null);
	let effectiveMemLimit = $state<number | null>(null);

	onMount(() => {
		data.databasePromise
			.then((seed: any) => {
				if (!database && seed) {
					database = seed;
					loading = false;
					if (database?.backupsEnabled) fetchBackups();
					resourceCpuMilli = database?.cpuRequestMilli ?? null;
					resourceMemoryBytes =
						database?.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null;
					scaleReplicas = Math.max(1, seed.replicas ?? 1);
					storageSizeDraft = seed.storageSize ?? '';
				}
			})
			.catch(() => {});
		fetchDatabase();
		fetchQuota();
		const orgIdForSse = $selectedOrganization?.id;
		if (orgIdForSse) {
			dbSseUnsub = subscribeOrgEvents(orgIdForSse, (ev) => {
				if (ev.id === dbId) {
					fetchDatabase(true);
					if (database?.backupsEnabled) fetchBackups();
					if (ev.type === 'database.changed') {
						if (extensionsLoaded) fetchExtensions();
						if (scheduleLoaded) fetchSchedule();
						if (settingsLoaded && !settingsDirty) fetchSettings();
					}
				}
			});
		}
		return () => {
			dbSseUnsub?.();
		};
	});
</script>

<div class="db-page">
	{#if loading}
		<div class="db-skeleton">
			<div style="margin-bottom: 1.5rem;">
				<Skeleton width="4rem" height="0.875rem" />
			</div>
			<div
				style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem;"
			>
				<div style="display: flex; align-items: center; gap: 0.75rem;">
					<Skeleton width="2rem" height="2rem" />
					<Skeleton width="10rem" height="1.25rem" />
					<Skeleton width="3.5rem" height="1rem" rounded="9999px" />
				</div>
				<Skeleton width="5rem" height="2rem" />
			</div>
			<div style="display: flex; gap: 0.75rem; margin-bottom: 1.5rem;">
				<Skeleton height="4rem" rounded="0.75rem" class="flex-1" />
				<Skeleton height="4rem" rounded="0.75rem" class="flex-1" />
				<Skeleton height="4rem" rounded="0.75rem" class="flex-1" />
			</div>
			<Skeleton height="12rem" rounded="0.75rem" />
		</div>
	{:else if error}
		<EmptyState title="Couldn't load this database" description={error} />
	{:else if database}
		{@const ls = database.liveStatus}
		{@const isUnhealthy = !!(
			(ls?.message &&
				/oomkilled|out of memory|crashloopbackoff|back-?off|error/i.test(ls.message)) ||
			(ls?.exists !== false && ls?.ready === false && database.status === 'ready')
		)}
		<Breadcrumbs
			crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				...(database.project
					? [
							{
								label: database.project.name || database.project.slug,
								href: `/${orgSlug}/projects/${database.project.slug}`
							}
						]
					: []),
				{ label: database.name }
			]}
		/>
		<DatabaseHeader
			{database}
			{deleting}
			onOpenDeleteModal={openDeleteModal}
			onRename={() => (renameOpen = true)}
			stopped={dbStopped}
			stopping={stoppingDb}
			starting={startingDb}
			restarting={restartingDb}
			onStop={() => (showStopModal = true)}
			onStart={() => lifecycleAction('start')}
			onRestart={() => (showRestartModal = true)}
			onConnect={database.status === 'ready' ? () => (connectOpen = true) : undefined}
			statusOverride={dbStopped
				? 'stopped'
				: database.status === 'restarting' || database.status === 'upgrading'
					? undefined
					: isUnhealthy
						? 'unhealthy'
						: undefined}
		/>

		<div class="db-tabs-bar">
			<PageTabs
				label="Database sections"
				tabs={TABS}
				value={activeTab}
				onchange={(v) => gotoTab(v as DbTab)}
			/>
		</div>

		<DatabaseAlerts
			{database}
			{memoryBytes}
			memoryUpgrade={memoryUpgradeBytes
				? { toBytes: memoryUpgradeBytes, busy: upgradingMemory, run: upgradeMemory }
				: null}
			onGoToBackups={() => gotoTab('backups')}
			onGoToResources={() => gotoTab('settings', 'resources')}
			onViewLogs={() => {
				gotoTab('overview');
				activeConsoleTab = 'logs';
			}}
		/>

		{#if database.mode === 'cnpg' && (database.status === 'provisioning' || database.status === 'restoring' || dbErrorConfirmed)}
			<DatabaseProvisioning {dbId} dbName={database.name} onDone={() => fetchDatabase(true)} />
		{:else}
			{#if terminalVisited}
				<div class="db-overview" hidden={activeTab !== 'overview'}>
					<section class="db-console" aria-label="Console">
						<TerminalTab
							{database}
							visible={activeTab === 'overview'}
							{logs}
							{logsLoading}
							bind:logsRef
							bind:activeConsoleTab
							bind:terminalTabs
							bind:consoleExpanded
							bind:tailLines
							bind:logsPodName
							bind:logsPrevious
							{killedList}
							{killedLoading}
							{killedLogs}
							{killedLogsLoading}
							{expandedKilled}
							onFetchLogs={fetchLogs}
							onFetchKilled={fetchKilled}
							onToggleKilled={toggleKilled}
							onOpenShellTab={openShellTab}
							onCloseTerminalTab={closeTerminalTab}
							onTerminalTitle={setTerminalTitle}
							onTerminalBell={setTerminalBell}
							onTerminalSession={setTerminalSession}
							{podShortName}
						/>
					</section>
					<div class="db-side">
						{#if database.mode !== 'shared'}
							<DatabaseHealth
								{database}
								maxConnections={settingsLoaded
									? Number(paramValue('max_connections')) || null
									: null}
								backupsHref={hrefFor('backups')}
								versionHref={hrefFor('settings', 'version')}
								settingsHref={hrefFor('settings', 'resources')}
							/>
							<DatabaseActivity databaseId={database.id} observeHref={hrefFor('observe')} />
						{/if}
					</div>
				</div>
			{/if}

			{#if activeTab === 'backups'}
				<section class="db-panel">
					<BackupsTab
						{database}
						{orgSlug}
						{backups}
						{backupsLoading}
						{creatingBackup}
						{restoringBackupId}
						bind:schedulePreset
						bind:scheduleCustomCron
						{scheduleCron}
						{scheduleLoaded}
						{scheduleSaving}
						maxBackups={MAX_BACKUPS}
						schedulePresets={[...SCHEDULE_PRESETS]}
						onCreateBackup={createBackup}
						onRestoreBackup={restoreBackup}
						onRestoreConfirmed={restoreBackup}
						onSaveSchedule={saveSchedule}
						onRecoveryChanged={() => fetchDatabase(true)}
						{formatBytes}
						{formatDate}
					/>
				</section>
			{:else if activeTab === 'observe'}
				<section class="db-panel db-stack">
					<DatabaseObserve
						{database}
						bind:view={observeView}
						active={activeTab === 'observe'}
						defaultCpuMilli={orgDefaultCpuMilli}
						defaultMemoryBytes={orgDefaultMemoryBytes}
						maxConnections={settingsLoaded ? Number(paramValue('max_connections')) || null : null}
						stats={queryStats}
						loading={queryStatsLoading}
						refreshing={queryStatsRefreshing}
						resetting={queryStatsResetting}
						enabling={queryStatsEnabling}
						bind:querySearch
						onRefresh={() => fetchQueryStats(true)}
						onReset={() => (showResetStatsModal = true)}
						onEnable={enableQueryStats}
					/>
				</section>
			{:else if activeTab === 'settings'}
				<section class="db-panel db-settings">
					<SettingsRail
						groups={SETTINGS_RAIL}
						activeId={settingsSection}
						label="Database settings"
					/>
					<div class="db-stack">
						{#if settingsSection === 'general'}
							<SectionCard title="General">
								<SettingsList>
									<ActionRow label="Name" hint={database.name}>
										<Button size="sm" icon={Pencil} onclick={() => (renameOpen = true)}
											>Rename</Button
										>
									</ActionRow>
									<ActionRow
										label="Engine"
										hint={database.pgMajor ? `Postgres ${database.pgMajor}` : 'Postgres'}
									>
										<span></span>
									</ActionRow>
									<ActionRow
										label="Database and user"
										hint={`${database.dbName} · ${database.dbUser}`}
									>
										<span></span>
									</ActionRow>
								</SettingsList>
							</SectionCard>
						{:else if settingsSection === 'resources'}
							{#if database.mode === 'shared'}
								<EmptyState
									title="Resources need a dedicated database"
									description="A shared database runs on capacity Orchard manages."
								/>
							{:else}
								<ResourceLimits
									entity={database}
									bind:resourceCpuMilli
									bind:resourceMemoryBytes
									{orgDefaultCpuMilli}
									{orgDefaultMemoryBytes}
									{effectiveCpuLimit}
									{effectiveMemLimit}
									bind:resourcesDirty
									{savingResources}
									onSaveResources={saveResources}
								/>
								{#if database.mode === 'cnpg'}
									<StorageCard
										{database}
										bind:value={storageSizeDraft}
										bind:dirty={storageDirty}
										saving={expandingStorage}
										warning={storageWarning}
										onExpand={expandStorage}
									/>
									<ReplicasCard
										{database}
										bind:replicas={scaleReplicas}
										bind:replicasDirty
										saving={savingReplicas}
										onScale={scaleDatabase}
									/>
								{/if}
							{/if}
						{:else if settingsSection === 'protection'}
							<ProtectionCard
								{database}
								onchanged={(next) => {
									if (!database) return;
									database.deletionProtection = next.deletionProtection;
									database.ddlCheckpoints = next.ddlCheckpoints;
									database.restoreTests = next.restoreTests;
								}}
							/>
						{:else if settingsSection === 'version'}
							{#if database.mode === 'cnpg'}
								<VersionCard
									{database}
									onupgrade={() => {
										fetchDatabase(true);
										gotoTab('backups');
									}}
								/>
							{:else}
								<EmptyState title="Upgrades need a dedicated database" />
							{/if}
						{:else if settingsSection === 'availability'}
							{#if database.mode === 'cnpg'}
								<ReplicationCard {database} resourcesHref={hrefFor('settings', 'resources')} />
							{:else}
								<EmptyState title="High availability needs a dedicated database" />
							{/if}
						{:else if settingsSection === 'pooler'}
							{#if database.mode === 'cnpg'}
								<PoolerCard
									{database}
									onchanged={(p) => {
										if (database) database.poolerEnabled = p.enabled;
									}}
								/>
							{:else}
								<EmptyState title="The pooler needs a dedicated database" />
							{/if}
						{:else if settingsSection === 'users'}
							{#if database.mode === 'cnpg'}
								<UsersCard {database} />
							{:else}
								<EmptyState title="Users need a dedicated database" />
							{/if}
						{:else if settingsSection === 'parameters'}
							<SettingsTab
								{database}
								paramSchema={PARAM_SCHEMA}
								{settingsLoading}
								{settingsLoaded}
								{settingsSaving}
								{settingsDirty}
								{settingsAdvisories}
								{settingsDrift}
								onFetchSettings={() => {
									settingsLoaded = false;
									fetchSettings();
								}}
								onSaveSettings={saveSettings}
								savedValues={settingsLoadedValues}
								onDiscardSettings={fetchSettings}
								{paramValue}
								{setParam}
							/>
						{:else if settingsSection === 'extensions'}
							<ExtensionsTab
								{database}
								{filteredExtensions}
								{preloadedExts}
								{extensionsLoading}
								bind:extensionSearch
								{busyExtension}
								onFetchExtensions={fetchExtensions}
								onInstallExtension={installExtension}
								onUninstallExtension={uninstallExtension}
							/>
						{:else if settingsSection === 'network'}
							<SectionCard title="Public access">
								<SettingsList>
									<ActionRow
										label="Reachable from the internet"
										hint={database.publicEnabled
											? `On port ${database.publicPort ?? ''}. Anyone with the password can connect.`
											: 'Off. Only apps in this project can connect.'}
									>
										<Switch
											label="Public access"
											checked={!!database.publicEnabled}
											disabled={togglingPublic || database.mode !== 'cnpg'}
											onchange={(on) => (on ? enablePublic() : (showDisablePublicModal = true))}
										/>
									</ActionRow>
								</SettingsList>
							</SectionCard>
						{:else if settingsSection === 'danger'}
							<SectionCard title="Danger zone" tone="danger">
								<SettingsList>
									{#if dbStopped}
										<ActionRow label="Start this database" hint="Apps reconnect once it is ready.">
											<Button
												size="sm"
												icon={Play}
												loading={startingDb}
												onclick={() => lifecycleAction('start')}>Start</Button
											>
										</ActionRow>
									{:else}
										<ActionRow
											label="Stop this database"
											hint="Apps lose their connection until you start it again. Data stays on disk."
										>
											<Button
												size="sm"
												icon={Pause}
												loading={stoppingDb}
												onclick={() => (showStopModal = true)}>Stop</Button
											>
										</ActionRow>
									{/if}
									<ActionRow
										label="Delete this database"
										hint={database.deletionProtection
											? 'Deletion protection is on. Turn it off in Protection to delete.'
											: 'Kept for 30 days in Recently deleted on the project, then removed with its backups.'}
									>
										<Button
											variant="danger"
											size="sm"
											loading={deleting}
											disabled={!!database.deletionProtection}
											onclick={openDeleteModal}>Delete database</Button
										>
									</ActionRow>
								</SettingsList>
							</SectionCard>
						{/if}
					</div>
				</section>
			{/if}
		{/if}
	{/if}
</div>

{#if database}
	<Modal bind:open={connectOpen} title="Connect to {database.name}" size="md">
		<DatabaseConnect
			{database}
			settingsHref={hrefFor('settings', 'network')}
			onnavigate={() => (connectOpen = false)}
		/>
	</Modal>
	<RenameModal
		bind:open={renameOpen}
		title="Rename database"
		value={database.name}
		saving={renaming}
		onSave={renameDatabase}
	/>
{/if}

<ConfirmModal
	bind:open={showDisablePublicModal}
	title="Turn off public access?"
	description="Clients connecting over the public address are disconnected. Apps in this project keep working."
	confirmLabel="Turn off"
	onconfirm={disablePublic}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={showStopModal}
	title="Stop this database?"
	description="Apps using it will lose their connection until you start it again. Your data stays on disk."
	confirmLabel="Stop database"
	onconfirm={() => lifecycleAction('stop')}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={showRestartModal}
	title="Restart this database?"
	description="Instances restart one at a time. Expect a brief interruption while connections fail over."
	confirmLabel="Restart"
	danger={false}
	onconfirm={() => lifecycleAction('restart')}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={showResetStatsModal}
	title="Reset query statistics?"
	description="All recorded query timings and counts start over from zero. This does not affect your data or running queries."
	confirmLabel="Reset statistics"
	danger={false}
	onconfirm={resetQueryStats}
	oncancel={() => {}}
/>

{#if showDeleteModal && database}
	<DeleteModal
		databaseName={database.name}
		recoverable={!!database.liveStatus?.lastSuccessfulBackup ||
			backups.some((b) => b.status === 'completed')}
		{deleteCountdownActive}
		{deleteCountdown}
		{deleteProgress}
		onStartDeleteCountdown={startDeleteCountdown}
		onCancelDelete={cancelDelete}
	/>
{/if}

<style>
	.db-page {
		--section-r: var(--radius-widget);
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		max-width: 100rem;
		margin: 0 auto;
		padding: 1.5rem;
	}
	.db-page :global(.bc) {
		align-self: flex-start;
		width: fit-content;
		padding: 0.3125rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--bg-surface) 94%, transparent);
		box-shadow: var(--elev-1);
	}
	.db-skeleton {
		padding: 2.5rem 0;
	}
	.db-overview {
		display: grid;
		grid-template-columns: minmax(0, 1.618fr) minmax(21rem, 1fr);
		gap: 1rem;
		height: max(26rem, calc(100dvh - 16.875rem));
		min-height: 0;
	}
	.db-overview[hidden] {
		display: none;
	}
	.db-console {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		border-radius: calc(var(--radius-widget) * var(--corner-scale));
		corner-shape: var(--corner);
		overflow: clip;
	}
	.db-console > :global(*) {
		flex: 1 1 auto;
		min-height: 0;
	}
	.db-side > :global(.widget:last-child) {
		flex: 1 1 auto;
	}
	.db-side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		min-height: 0;
		margin: -2px;
		padding: 2px;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.db-panel {
		min-width: 0;
	}
	.db-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	.db-settings {
		display: grid;
		grid-template-columns: 12rem minmax(0, 1fr);
		gap: var(--space-6);
		align-items: start;
	}
	@media (max-width: 64rem) {
		.db-overview {
			grid-template-columns: minmax(0, 1fr);
			height: auto;
		}
		.db-console {
			height: 32rem;
		}
	}
	@media (max-width: 900px) {
		.db-settings {
			grid-template-columns: 1fr;
			gap: var(--space-4);
		}
	}
</style>
