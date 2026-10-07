<script lang="ts">
	import '$lib/components/database/database.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
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
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import {
		Loader2,
		Key,
		Archive,
		Terminal as TerminalIcon,
		Puzzle,
		Settings as SettingsIcon,
		Activity,
		Cpu,
		Timer
	} from 'lucide-svelte';
	import { UnderlineTabs, Skeleton, EmptyState } from '$lib/components/ui';
	import DatabaseProvisioning from '$lib/components/DatabaseProvisioning.svelte';
	import DeploymentMetrics from '$lib/components/DeploymentMetrics.svelte';
	import ResourceLimits from '$lib/components/ResourceLimits.svelte';
	import {
		ConnectionTab,
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
	import Anomalies from '$lib/components/anomalies/Anomalies.svelte';
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

	// Tabs
	const tabSections = [
		{ id: 'connection', label: 'Connection', icon: Key },
		{ id: 'backups', label: 'Backups', icon: Archive },
		{ id: 'terminal', label: 'Terminal', icon: TerminalIcon },
		{ id: 'extensions', label: 'Extensions', icon: Puzzle },
		{ id: 'queries', label: 'Queries', icon: Timer },
		{ id: 'metrics', label: 'Metrics', icon: Activity },
		{ id: 'resources', label: 'Resources', icon: Cpu },
		{ id: 'settings', label: 'Settings', icon: SettingsIcon }
	];
	let activeTab = $state('connection');
	let terminalVisited = $state(false);
	$effect(() => {
		if (activeTab === 'terminal') terminalVisited = true;
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
			activeTab === 'extensions' &&
			database?.mode === 'cnpg' &&
			!extensionsLoaded &&
			!extensionsLoading
		) {
			fetchExtensions();
		}
		if (
			activeTab === 'settings' &&
			database?.mode === 'cnpg' &&
			!settingsLoaded &&
			!settingsLoading
		) {
			fetchSettings();
		}
		if (activeTab === 'backups' && database?.mode === 'cnpg' && !scheduleLoaded) {
			fetchSchedule();
		}
		if (activeTab === 'queries' && database?.mode === 'cnpg' && !queryStats && !queryStatsLoading) {
			fetchQueryStats();
		}
	});

	$effect(() => {
		if (activeTab === 'terminal' && activeConsoleTab === 'logs' && database?.pods?.[0]?.name) {
			fetchLogs();
		}
		if (activeTab === 'terminal' && activeConsoleTab === 'killed' && !killedFetched) {
			fetchKilled();
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
		if (!confirm(`Restore "${backup.label}"? This replaces all current data in this database.`))
			return;
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
		if (
			!confirm(
				'Stop exposing this database publicly? Connected clients using the public endpoint will be disconnected.'
			)
		)
			return;
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
		if (!confirm(`Drop extension "${name}"? Objects that depend on it will also be dropped.`))
			return;
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
		const hasRestart = PARAM_SCHEMA.filter((p) => p.requiresRestart).some(
			(p) => (settings[p.key] ?? '') !== (settingsLoadedValues[p.key] ?? '')
		);
		if (
			hasRestart &&
			!confirm(
				'Some of these settings require a brief database restart (~10–30s of downtime). Apply now?'
			)
		)
			return;
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
		const podName = logsPodName || database.pods?.[0]?.name;
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
		if (!database) return;
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
			toasts.add({
				title: 'Database deleted',
				description: `${database.name} has been deleted`,
				color: 'success'
			});
			const ws = database.project?.workspace;
			if (ws) {
				goto(`/${orgSlug}/workspaces/${ws.slug}/projects/${database.project!.slug}`);
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
		<div class="db-error">{error}</div>
	{:else if database}
		{@const ls = database.liveStatus}
		{@const isUnhealthy = !!(
			(ls?.message &&
				/oomkilled|out of memory|crashloopbackoff|back-?off|error/i.test(ls.message)) ||
			(ls?.exists !== false && ls?.ready === false && database.status === 'ready')
		)}
		<Breadcrumb
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
			statusOverride={dbStopped
				? 'stopped'
				: database.status === 'restarting'
					? undefined
					: isUnhealthy
						? 'unhealthy'
						: undefined}
		/>

		<DatabaseAlerts
			{database}
			onGoToBackups={() => {
				activeTab = 'backups';
			}}
			onGoToResources={() => {
				activeTab = 'resources';
			}}
			onViewLogs={() => {
				activeTab = 'terminal';
				activeConsoleTab = 'logs';
			}}
		/>

		{#if database.mode === 'cnpg' && (database.status === 'provisioning' || database.status === 'restoring' || dbErrorConfirmed)}
			<DatabaseProvisioning {dbId} dbName={database.name} onDone={() => fetchDatabase(true)} />
		{:else}
			<Anomalies scope={{ kind: 'database', id: dbId }} hideResource />
			{#if database.liveStatus}
				{@const state = podStateLabel()}
				<div class="db-stats">
					{#if database.mode === 'container'}
						<div class="db-stat db-stat-pod">
							<span class="db-stat-label">Pod State</span>
							<div class="db-pod-state-row">
								<span class="db-pod-dot db-pod-dot-{state.kind}" aria-hidden="true"></span>
								<span class="db-stat-value" title={database.liveStatus.message ?? ''}
									>{state.label}</span
								>
								{#if state.kind === 'pending'}
									<Loader2 class="h-3.5 w-3.5 animate-spin db-pod-spinner" />
								{/if}
							</div>
							{#if typeof database.liveStatus.readyReplicas === 'number' && typeof database.liveStatus.replicas === 'number'}
								<span class="db-pod-sub"
									>{database.liveStatus.readyReplicas} / {database.liveStatus.replicas} ready{#if database.liveStatus.restartCount}·
										{database.liveStatus.restartCount} restarts{/if}</span
								>
							{/if}
						</div>
					{/if}
					<div
						class="db-stat"
						class:db-stat--stale={statsStale}
						title={statsAgo ? `As of ${statsAgo}` : ''}
					>
						<span class="db-stat-label">Size</span>
						<span class="db-stat-value">{database.liveStatus.size ?? '—'}</span>
					</div>
					<div
						class="db-stat"
						class:db-stat--stale={statsStale}
						title={statsAgo ? `As of ${statsAgo}` : ''}
					>
						<span class="db-stat-label">Connections</span>
						<span class="db-stat-value">{database.liveStatus.connections ?? '—'}</span>
					</div>
					<div class="db-stat">
						<span class="db-stat-label">Port</span>
						<span class="db-stat-value">{database.port}</span>
					</div>
					{#if database.mode === 'container' && database.storageSize}
						<div class="db-stat">
							<span class="db-stat-label">Storage</span>
							<span class="db-stat-value">{database.storageSize}</span>
						</div>
					{/if}
				</div>
			{/if}

			<div class="db-tabs">
				<UnderlineTabs
					tabs={tabSections}
					bind:value={activeTab}
					variant="toolbar"
					label="Database sections"
				/>
			</div>

			{#if activeTab === 'connection'}
				<section class="db-tab-panel">
					<ConnectionTab
						{database}
						{orgSlug}
						bind:copiedField
						bind:showPassword
						bind:showConnectionString
						bind:showPublicConnectionString
						{togglingPublic}
						onEnablePublic={enablePublic}
						onDisablePublic={disablePublic}
						onCopy={copyToClipboard}
					/>
				</section>
			{:else if activeTab === 'backups'}
				<section class="db-tab-panel">
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
						onSaveSchedule={saveSchedule}
						{formatBytes}
						{formatDate}
					/>
				</section>
			{:else if activeTab === 'extensions'}
				<section class="db-tab-panel">
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
				</section>
			{:else if activeTab === 'queries'}
				<section class="db-tab-panel">
					<QueriesTab
						{database}
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
			{:else if activeTab === 'metrics'}
				<section class="db-tab-panel">
					{#if database?.mode !== 'shared'}
						<div class="card rounded-2xl p-5">
							<DeploymentMetrics kind="database" id={database?.id ?? null} />
						</div>
					{:else}
						<EmptyState
							title="Metrics need a dedicated database"
							description="Create a dedicated database for full metrics."
						/>
					{/if}
				</section>
			{:else if activeTab === 'resources'}
				<section class="db-tab-panel">
					{#if database?.mode !== 'shared'}
						{#if database?.mode === 'cnpg'}
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
					{:else}
						<EmptyState
							title="Resources need a dedicated database"
							description="Resource configuration is not available for shared databases."
						/>
					{/if}
				</section>
			{:else if activeTab === 'settings'}
				<section class="db-tab-panel">
					<SettingsTab
						{database}
						paramSchema={PARAM_SCHEMA}
						{settingsLoading}
						{settingsLoaded}
						{settingsSaving}
						{settingsDirty}
						{settingsAdvisories}
						onFetchSettings={() => {
							settingsLoaded = false;
							fetchSettings();
						}}
						onSaveSettings={saveSettings}
						{paramValue}
						{setParam}
					/>
				</section>
			{/if}
			{#if terminalVisited}
				<section class="db-tab-panel" hidden={activeTab !== 'terminal'}>
					<TerminalTab
						{database}
						visible={activeTab === 'terminal'}
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
			{/if}
		{/if}
	{/if}
</div>

{#if database}
	<RenameModal
		bind:open={renameOpen}
		title="Rename database"
		value={database.name}
		saving={renaming}
		onSave={renameDatabase}
	/>
{/if}

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
		{deleteCountdownActive}
		{deleteCountdown}
		{deleteProgress}
		onStartDeleteCountdown={startDeleteCountdown}
		onCancelDelete={cancelDelete}
	/>
{/if}

<style>
	.db-page {
		max-width: 100rem;
		margin: 0 auto;
		padding: 1.5rem;
	}

	.db-page :global(.bc) {
		align-self: flex-start;
		width: fit-content;
		margin-bottom: 1rem;
		padding: 0.3125rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--bg-surface) 94%, transparent);
		box-shadow: var(--elev-1);
	}

	.db-skeleton {
		padding: 2.5rem 0;
	}

	.db-error {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
	}

	.db-stats {
		display: flex;
		align-items: stretch;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
		row-gap: 0.5rem;
	}

	.db-stat {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.25rem 1.25rem;
		min-width: 7.5rem;
	}

	.db-stat--stale .db-stat-value {
		color: var(--text-muted);
		transition: color var(--dur-base) ease;
	}

	.db-stat:not(:first-child) {
		border-left: 1px solid var(--rule);
	}

	.db-stat:first-child {
		padding-left: 0;
	}

	.db-stat-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 500;
		color: var(--text-faint);
		white-space: nowrap;
	}

	.db-stat-value {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		white-space: nowrap;
	}

	.db-empty-state {
		padding: 2rem 1.5rem;
		text-align: center;
		color: var(--surface-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		border: 1px dashed var(--surface-border);
		border-radius: var(--radius-md);
	}

	.db-stat-pod {
		min-width: 10rem;
	}

	.db-pod-state-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.db-pod-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-pill);
		flex-shrink: 0;
	}

	.db-pod-dot-ready {
		background-color: var(--online-indicator);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--online-indicator) 20%, transparent);
	}

	.db-pod-dot-pending {
		background-color: var(--away-indicator);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--away-indicator) 20%, transparent);
	}

	.db-pod-dot-error {
		background-color: var(--error-text-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	.db-pod-sub {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		margin-top: 0.125rem;
	}

	.db-tabs {
		margin-bottom: 1.5rem;
	}

	.db-tab-panel {
		color: var(--center-channel-color);
		animation: tab-panel-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes tab-panel-in {
		from {
			opacity: 0;
			transform: translateY(0.75rem) scale(0.99);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
