<script lang="ts">
	import '$lib/components/database/database.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import type { PageData } from './$types';
	import { Loader2, Key, Archive, Terminal as TerminalIcon, Puzzle, Settings as SettingsIcon, Activity, Cpu } from 'lucide-svelte';
	import { Tabs } from 'melt/builders';
	import DatabaseProvisioning from '$lib/components/DatabaseProvisioning.svelte';
	import {
		ConnectionTab,
		BackupsTab,
		TerminalTab,
		ExtensionsTab,
		SettingsTab,
		MetricsTab,
		ResourcesTab,
		DatabaseHeader,
		DeleteModal,
	} from '$lib/components/database';
	import type { DatabaseDetail, Backup, ExtInfo, TerminalTab as TerminalTabType } from '$lib/components/database';

	// --- Constants ---
	const SCHEDULE_PRESETS = [
		{ id: 'hourly', label: 'Every hour', cron: '0 * * * *', description: 'Top of every hour' },
		{ id: 'every6h', label: 'Every 6 hours', cron: '0 */6 * * *', description: 'Midnight, 6am, noon, 6pm (UTC)' },
		{ id: 'daily', label: 'Daily at 2am UTC', cron: '0 2 * * *', description: 'Once per day' },
		{ id: 'weekly', label: 'Weekly (Sun 2am UTC)', cron: '0 2 * * 0', description: 'Once per week' },
		{ id: 'custom', label: 'Custom cron…', cron: '', description: '' }
	] as const;

	const EXTENSION_CATALOG: Array<{ name: string; description: string; requiresPreload?: boolean }> = [
		{ name: 'pg_stat_statements', description: 'Track execution statistics for SQL statements', requiresPreload: true },
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
		{ name: 'pg_buffercache', description: 'Inspect the buffer cache' },
	];

	const PARAM_SCHEMA = [
		{ key: 'max_connections', label: 'Max Connections', kind: 'int' as const, min: 10, max: 500, defaultValue: '100', requiresRestart: true, help: 'Maximum concurrent client connections. Restart required.' },
		{ key: 'shared_buffers', label: 'Shared Buffers', kind: 'memory' as const, defaultValue: '128MB', requiresRestart: true, help: 'Memory for caching shared data. Typically 25% of system RAM. Restart required.' },
		{ key: 'work_mem', label: 'Work Memory', kind: 'memory' as const, defaultValue: '4MB', help: 'Memory per sort/hash operation.' },
		{ key: 'maintenance_work_mem', label: 'Maintenance Work Memory', kind: 'memory' as const, defaultValue: '64MB', help: 'Memory for VACUUM, CREATE INDEX, etc.' },
		{ key: 'effective_cache_size', label: 'Effective Cache Size', kind: 'memory' as const, defaultValue: '4GB', help: 'Planner hint for OS page cache size.' },
		{ key: 'log_min_duration_statement', label: 'Slow Query Log (ms)', kind: 'int' as const, min: -1, max: 600000, defaultValue: '-1', help: 'Log statements slower than this (ms). -1 disables.' },
		{ key: 'statement_timeout', label: 'Statement Timeout (ms)', kind: 'int' as const, min: 0, max: 3600000, defaultValue: '0', help: 'Abort any statement taking longer than this (ms). 0 disables.' },
		{ key: 'idle_in_transaction_session_timeout', label: 'Idle-in-Transaction Timeout (ms)', kind: 'int' as const, min: 0, max: 3600000, defaultValue: '0', help: 'Terminate sessions idle inside a transaction. 0 disables.' },
		{ key: 'synchronous_commit', label: 'Synchronous Commit', kind: 'string' as const, enum: ['on', 'off', 'local', 'remote_write', 'remote_apply'], defaultValue: 'on', help: 'Wait for WAL flush before acknowledging. Off is faster, less durable.' },
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

	// Terminal
	let logs = $state('');
	let logsLoading = $state(false);
	let tailLines = $state(200);
	let logsRef = $state<HTMLPreElement | null>(null);
	let activeConsoleTab = $state<string>('logs');
	let terminalTabs = $state<TerminalTabType[]>([]);
	let terminalCounter = 0;
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

	// Tabs
	const tabSections = [
		{ id: 'connection', label: 'Connection', icon: Key },
		{ id: 'backups', label: 'Backups', icon: Archive },
		{ id: 'terminal', label: 'Terminal', icon: TerminalIcon },
		{ id: 'extensions', label: 'Extensions', icon: Puzzle },
		{ id: 'metrics', label: 'Metrics', icon: Activity },
		{ id: 'resources', label: 'Resources', icon: Cpu },
		{ id: 'settings', label: 'Settings', icon: SettingsIcon }
	] as const;
	type TabId = (typeof tabSections)[number]['id'];
	const tabs = new Tabs<TabId>({ value: 'connection', loop: true });

	// SSE
	let dbSseUnsub: (() => void) | null = null;

	// --- Derived ---
	let filteredExtensions = $derived.by(() => {
		const q = extensionSearch.trim().toLowerCase();
		const byName = new Map<string, ExtInfo>();
		for (const e of extensions) byName.set(e.name, e);
		const merged: Array<ExtInfo & { description?: string; requiresPreload?: boolean; featured?: boolean }> = [];
		for (const c of EXTENSION_CATALOG) {
			const live = byName.get(c.name);
			if (!live) continue;
			merged.push({ ...live, description: c.description, requiresPreload: c.requiresPreload, featured: true });
			byName.delete(c.name);
		}
		for (const e of byName.values()) {
			merged.push({ ...e, description: e.comment });
		}
		if (!q) return merged;
		return merged.filter((e) =>
			e.name.toLowerCase().includes(q) ||
			(e.description || '').toLowerCase().includes(q),
		);
	});

	// --- Effects ---
	$effect(() => {
		if (tabs.value === 'extensions' && database?.mode === 'cnpg' && !extensionsLoaded && !extensionsLoading) {
			fetchExtensions();
		}
		if (tabs.value === 'settings' && database?.mode === 'cnpg' && !settingsLoaded && !settingsLoading) {
			fetchSettings();
		}
		if (tabs.value === 'backups' && database?.mode === 'cnpg' && !scheduleLoaded) {
			fetchSchedule();
		}
	});

	$effect(() => {
		if (tabs.value === 'terminal' && activeConsoleTab === 'logs' && database?.pods?.[0]?.name) {
			fetchLogs();
		}
	});

	// --- API functions ---
	async function fetchDatabase(silent = false) {
		if (!silent) loading = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}`);
			if (!response.ok) throw new Error('Failed to fetch database');
			database = await response.json();
			if (database?.backupsEnabled) fetchBackups();
			// Sync resource state
			if (!resourcesDirty) {
				resourceCpuMilli = database?.cpuRequestMilli ?? null;
				resourceMemoryBytes = database?.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null;
			}
		} catch (e) {
			if (!silent) error = e instanceof Error ? e.message : 'Failed to load database';
		} finally {
			if (!silent) loading = false;
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
					memoryRequestBytes: resourceMemoryBytes,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update resources');
			}
			toasts.add({ title: 'Resources updated', description: 'Database pod will restart with new values.', color: 'success' });
			resourcesDirty = false;
			await fetchDatabase(true);
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			savingResources = false;
		}
	}

	async function fetchBackups() {
		backupsLoading = true;
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
			toasts.add({ title: 'Backup started', description: 'Your backup is running in the background', color: 'success' });
			await fetchBackups();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to create backup', color: 'error' });
		} finally {
			creatingBackup = false;
		}
	}

	async function restoreBackup(backup: Backup) {
		if (!confirm(`Restore "${backup.label}"? This replaces all current data in this database.`)) return;
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
			toasts.add({ title: 'Restore started', description: 'The database will be restored shortly', color: 'success' });
			await fetchDatabase();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to restore', color: 'error' });
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
				if (r.ok) { scheduleCron = ''; toasts.add({ title: 'Schedule cleared', color: 'success' }); }
				else { toasts.add({ title: 'Failed to clear schedule', color: 'error' }); }
			} finally { scheduleSaving = false; }
			return;
		}
		if (schedulePreset === 'custom') { cron = scheduleCustomCron.trim(); }
		else { const preset = SCHEDULE_PRESETS.find((p) => p.id === schedulePreset); cron = preset?.cron || ''; }
		if (!cron) { toasts.add({ title: 'Enter a cron expression', color: 'error' }); return; }

		scheduleSaving = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/backup-schedule`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron }),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) { toasts.add({ title: 'Failed to save schedule', description: data.message || 'Unknown error', color: 'error' }); }
			else { scheduleCron = data.cron || cron; toasts.add({ title: 'Schedule saved', description: `Backups will run: ${scheduleCron}`, color: 'success' }); }
		} finally { scheduleSaving = false; }
	}

	async function enablePublic() {
		if (!database) return;
		togglingPublic = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/public`, { method: 'POST' });
			const data = await r.json().catch(() => ({}));
			if (!r.ok) { toasts.add({ title: 'Could not expose database', description: data.message || 'Unknown error', color: 'error' }); return; }
			toasts.add({ title: 'Database exposed', description: `${data.host}:${data.port}`, color: 'success' });
			await fetchDatabase(true);
		} finally { togglingPublic = false; }
	}

	async function disablePublic() {
		if (!database) return;
		if (!confirm('Stop exposing this database publicly? Connected clients using the public endpoint will be disconnected.')) return;
		togglingPublic = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/public`, { method: 'DELETE' });
			if (!r.ok) { const data = await r.json().catch(() => ({})); toasts.add({ title: 'Failed to disable', description: data.message || 'Unknown error', color: 'error' }); return; }
			toasts.add({ title: 'Public access disabled', color: 'success' });
			await fetchDatabase(true);
		} finally { togglingPublic = false; }
	}

	// Extensions
	async function fetchExtensions() {
		extensionsLoading = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/extensions`);
			if (r.ok) { const data = await r.json(); extensions = data.extensions || []; preloadedExts = data.sharedPreloadLibraries || []; }
			extensionsLoaded = true;
		} finally { extensionsLoading = false; }
	}

	async function installExtension(name: string, addToPreload: boolean) {
		busyExtension = name;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/extensions`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, addToPreload }),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data.success) { toasts.add({ title: 'Install failed', description: data.output || data.message || 'Unknown error', color: 'error' }); }
			else { toasts.add({ title: `${name} installed`, description: data.preloadAdded ? 'Added to shared_preload_libraries — restart required' : 'Extension is ready to use', color: 'success' }); await fetchExtensions(); }
		} finally { busyExtension = null; }
	}

	async function uninstallExtension(name: string, removeFromPreload: boolean) {
		if (!confirm(`Drop extension "${name}"? Objects that depend on it will also be dropped.`)) return;
		busyExtension = name;
		try {
			const qs = removeFromPreload ? '?removeFromPreload=true' : '';
			const r = await apiFetch(`/apiv1/databases/${dbId}/extensions/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data.success) { toasts.add({ title: 'Uninstall failed', description: data.output || data.message || 'Unknown error', color: 'error' }); }
			else { toasts.add({ title: `${name} removed`, color: 'success' }); await fetchExtensions(); }
		} finally { busyExtension = null; }
	}

	// Settings
	async function fetchSettings() {
		settingsLoading = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/settings`);
			if (r.ok) { const data = await r.json(); settings = { ...(data.parameters || {}) }; settingsDirty = false; }
			settingsLoaded = true;
		} finally { settingsLoading = false; }
	}

	function paramValue(key: string): string {
		const meta = PARAM_SCHEMA.find((p) => p.key === key);
		return settings[key] ?? (meta?.defaultValue ?? '');
	}

	function setParam(key: string, v: string) {
		settings = { ...settings, [key]: v };
		settingsDirty = true;
	}

	async function saveSettings() {
		const hasRestart = PARAM_SCHEMA.filter((p) => p.requiresRestart).some((p) => settings[p.key] !== undefined && settings[p.key] !== p.defaultValue);
		if (hasRestart && !confirm('Some of these settings require a brief database restart (~10–30s of downtime). Apply now?')) return;
		settingsSaving = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/settings`, {
				method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parameters: settings }),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) { toasts.add({ title: 'Save failed', description: data.message || 'Unknown error', color: 'error' }); }
			else { toasts.add({ title: 'Settings saved', color: 'success' }); settings = { ...(data.parameters || {}) }; settingsDirty = false; }
		} finally { settingsSaving = false; }
	}

	// Terminal / logs
	async function fetchLogs() {
		if (!database?.namespace) return;
		const pod = database.pods?.[0];
		if (!pod?.name) return;
		logsLoading = true;
		try {
			const r = await apiFetch(`/apiv1/pods/${pod.name}/logs?namespace=${database.namespace}&container=postgres&tailLines=${tailLines}`);
			if (r.ok) {
				const data = await r.json();
				logs = data.logs || '';
				requestAnimationFrame(() => { if (logsRef) logsRef.scrollTop = logsRef.scrollHeight; });
			}
		} catch { /* ignore */ } finally { logsLoading = false; }
	}

	function podShortName(name: string): string {
		const parts = name.split('-');
		return parts.length > 2 ? parts.slice(-2).join('-') : name;
	}

	function openShellTab(podName: string, container: string) {
		terminalCounter++;
		const id = `term-${Date.now()}-${terminalCounter}`;
		terminalTabs = [...terminalTabs, { id, podName, container, label: `Shell ${terminalCounter}` }];
		activeConsoleTab = id;
	}

	function closeTerminalTab(id: string) {
		terminalTabs = terminalTabs.filter((t) => t.id !== id);
		if (activeConsoleTab === id) {
			activeConsoleTab = terminalTabs.length > 0 ? terminalTabs[terminalTabs.length - 1].id : 'logs';
		}
	}

	// Delete
	function openDeleteModal() { if (!database) return; showDeleteModal = true; deleteCountdownActive = false; deleteCountdown = 10; }

	function startDeleteCountdown() {
		deleteCountdownActive = true;
		deleteCountdown = 10;
		deleteTimerInterval = setInterval(() => {
			deleteCountdown -= 1;
			if (deleteCountdown <= 0) { clearInterval(deleteTimerInterval!); deleteTimerInterval = null; executeDelete(); }
		}, 1000);
	}

	function cancelDelete() {
		showDeleteModal = false;
		deleteCountdownActive = false;
		if (deleteTimerInterval) { clearInterval(deleteTimerInterval); deleteTimerInterval = null; }
		deleteCountdown = 10;
	}

	async function executeDelete() {
		if (!database) return;
		if (deleteTimerInterval) { clearInterval(deleteTimerInterval); deleteTimerInterval = null; }
		showDeleteModal = false;
		deleteCountdownActive = false;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}`, { method: 'DELETE' });
			if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || 'Failed to delete database'); }
			toasts.add({ title: 'Database deleted', description: `${database.name} has been deleted`, color: 'success' });
			refreshTree();
			const ws = database.project?.workspace;
			if (ws) { goto(`/${orgSlug}/workspaces/${ws.slug}/projects/${database.project!.slug}`); }
			else { goto(`/${orgSlug}`); }
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to delete', color: 'error' });
		} finally { deleting = false; }
	}

	// Helpers
	function copyToClipboard(text: string, field: string) {
		navigator.clipboard.writeText(text);
		copiedField = field;
		setTimeout(() => { copiedField = null; }, 2000);
	}

	function formatBytes(bytes: number | null): string {
		if (!bytes) return '—';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let n = bytes; let i = 0;
		while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
		return `${n.toFixed(1)} ${units[i]}`;
	}

	function formatDate(s: string): string { return new Date(s).toLocaleString(); }

	function podStateLabel(): { label: string; kind: 'ready' | 'pending' | 'error' } {
		const ls = database?.liveStatus;
		if (!ls) return { label: 'Unknown', kind: 'pending' };
		if (!ls.exists) return { label: 'Not deployed', kind: 'error' };
		if (database?.status === 'restoring') return { label: 'Restoring', kind: 'pending' };
		if (ls.ready) return { label: 'Running', kind: 'ready' };
		if (ls.message) {
			const m = ls.message.toLowerCase();
			if (m.includes('crash') || m.includes('error') || m.includes('backoff')) return { label: ls.message, kind: 'error' };
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
		} catch { /* ignore */ }
	}

	// Org resource defaults/limits
	let orgDefaultCpuMilli = $state<number | null>(null);
	let orgDefaultMemoryBytes = $state<number | null>(null);
	let effectiveCpuLimit = $state<number | null>(null);
	let effectiveMemLimit = $state<number | null>(null);

	onMount(() => {
		data.databasePromise
			.then((seed: any) => {
				if (!database) {
					database = seed;
					loading = false;
					if (database?.backupsEnabled) fetchBackups();
					resourceCpuMilli = database?.cpuRequestMilli ?? null;
					resourceMemoryBytes = database?.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null;
				}
			})
			.catch(() => {});
		fetchDatabase();
		fetchQuota();
		const orgIdForSse = $selectedOrganization?.id;
		if (orgIdForSse) {
			dbSseUnsub = subscribeOrgEvents(
				orgIdForSse,
				(ev) => { if (ev.id === dbId) { fetchDatabase(true); if (database?.backupsEnabled) fetchBackups(); } },
				{ invalidateDependencies: [] },
			);
		}
		return () => { dbSseUnsub?.(); };
	});
</script>

<div class="db-page">
	{#if loading}
		<div class="db-skeleton">
			<div class="skeleton" style="width: 4rem; height: 0.875rem; margin-bottom: 1.5rem;"></div>
			<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem;">
				<div style="display: flex; align-items: center; gap: 0.75rem;">
					<div class="skeleton" style="width: 2rem; height: 2rem; border-radius: 0.5rem;"></div>
					<div class="skeleton" style="width: 10rem; height: 1.25rem;"></div>
					<div class="skeleton" style="width: 3.5rem; height: 1rem; border-radius: 9999px;"></div>
				</div>
				<div class="skeleton" style="width: 5rem; height: 2rem; border-radius: 0.5rem;"></div>
			</div>
			<div style="display: flex; gap: 0.75rem; margin-bottom: 1.5rem;">
				<div class="skeleton" style="flex: 1; height: 4rem; border-radius: 0.75rem;"></div>
				<div class="skeleton" style="flex: 1; height: 4rem; border-radius: 0.75rem;"></div>
				<div class="skeleton" style="flex: 1; height: 4rem; border-radius: 0.75rem;"></div>
			</div>
			<div class="skeleton" style="width: 100%; height: 12rem; border-radius: 0.75rem;"></div>
		</div>
	{:else if error}
		<div class="db-error">{error}</div>
	{:else if database}
		<DatabaseHeader {database} {orgSlug} {deleting} onOpenDeleteModal={openDeleteModal} />

		{#if database.mode === 'cnpg' && (database.status === 'provisioning' || database.status === 'restoring' || (database.status === 'error' && !database.liveStatus?.ready))}
			<DatabaseProvisioning dbId={dbId} dbName={database.name} onDone={() => fetchDatabase(true)} />
		{:else}

		{#if database.liveStatus}
			{@const state = podStateLabel()}
			<div class="db-stats">
				{#if database.mode === 'container'}
					<div class="db-stat db-stat-pod">
						<span class="db-stat-label">Pod State</span>
						<div class="db-pod-state-row">
							<span class="db-pod-dot db-pod-dot-{state.kind}" aria-hidden="true"></span>
							<span class="db-stat-value" title={database.liveStatus.message ?? ''}>{state.label}</span>
							{#if state.kind === 'pending'}
								<Loader2 class="h-3.5 w-3.5 animate-spin db-pod-spinner" />
							{/if}
						</div>
						{#if typeof database.liveStatus.readyReplicas === 'number' && typeof database.liveStatus.replicas === 'number'}
							<span class="db-pod-sub">{database.liveStatus.readyReplicas} / {database.liveStatus.replicas} ready{#if database.liveStatus.restartCount}· {database.liveStatus.restartCount} restarts{/if}</span>
						{/if}
					</div>
				{/if}
				<div class="db-stat">
					<span class="db-stat-label">Size</span>
					<span class="db-stat-value">{database.liveStatus.size ?? 'N/A'}</span>
				</div>
				<div class="db-stat">
					<span class="db-stat-label">Connections</span>
					<span class="db-stat-value">{database.liveStatus.connections ?? 0}</span>
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

		<!-- Tab nav -->
		<nav class="dep-tabs" {...tabs.triggerList}>
			<div class="dep-tabs-inner">
				{#each tabSections as tab}
					{@const Icon = tab.icon}
					<button class="tabs-trigger dep-tab" {...tabs.getTrigger(tab.id)}>
						<Icon class="h-3.5 w-3.5" />
						<span>{tab.label}</span>
					</button>
				{/each}
			</div>
		</nav>

		<!-- Connection tab -->
		<section {...tabs.getContent('connection')} hidden={undefined} class="tab-panel">
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

		<!-- Backups tab -->
		<section {...tabs.getContent('backups')} hidden={undefined} class="tab-panel">
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

		<!-- Terminal tab -->
		<section {...tabs.getContent('terminal')} hidden={undefined} class="tab-panel">
			<TerminalTab
				{database}
				{logs}
				{logsLoading}
				bind:logsRef
				bind:activeConsoleTab
				bind:terminalTabs
				bind:consoleExpanded
				bind:tailLines
				onFetchLogs={fetchLogs}
				onOpenShellTab={openShellTab}
				onCloseTerminalTab={closeTerminalTab}
				{podShortName}
			/>
		</section>

		<!-- Extensions tab -->
		<section {...tabs.getContent('extensions')} hidden={undefined} class="tab-panel">
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

		<!-- Metrics tab -->
		<section {...tabs.getContent('metrics')} hidden={undefined} class="tab-panel">
			{#if database?.mode !== 'shared'}
				<div class="card rounded-2xl p-5">
					<MetricsTab databaseId={database?.id ?? null} />
				</div>
			{:else}
				<div class="db-empty-state">
					<p>Metrics are not available for shared databases. Create a dedicated (CNPG) database for full metrics.</p>
				</div>
			{/if}
		</section>

		<!-- Resources tab -->
		<section {...tabs.getContent('resources')} hidden={undefined} class="tab-panel">
			{#if database?.mode !== 'shared'}
				<ResourcesTab
					{database}
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
				<div class="db-empty-state">
					<p>Resource configuration is not available for shared databases.</p>
				</div>
			{/if}
		</section>

		<!-- Settings tab -->
		<section {...tabs.getContent('settings')} hidden={undefined} class="tab-panel">
			<SettingsTab
				{database}
				paramSchema={PARAM_SCHEMA}
				{settingsLoading}
				{settingsLoaded}
				{settingsSaving}
				{settingsDirty}
				onFetchSettings={() => { settingsLoaded = false; fetchSettings(); }}
				onSaveSettings={saveSettings}
				{paramValue}
				{setParam}
			/>
		</section>
		{/if}
	{/if}
</div>

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
		max-width: 52rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.db-skeleton {
		padding: 2.5rem 0;
	}

	.db-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
	}

	.db-stats {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	.db-stat {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 1.125rem;
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		min-width: 6rem;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.03), 0 1px 2px rgb(0 0 0 / 0.02);
	}

	.db-stat-label {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}

	.db-stat-value {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.db-empty-state {
		padding: 2rem 1.5rem;
		text-align: center;
		color: var(--surface-muted);
		font-size: 0.875rem;
		border: 1px dashed var(--surface-border);
		border-radius: 0.75rem;
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
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.db-pod-dot-ready {
		background-color: #22c55e;
		box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 20%, transparent);
	}

	.db-pod-dot-pending {
		background-color: #f59e0b;
		box-shadow: 0 0 0 3px color-mix(in srgb, #f59e0b 20%, transparent);
	}

	.db-pod-dot-error {
		background-color: var(--error-text-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	.db-pod-sub {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin-top: 0.125rem;
	}

	.dep-tabs {
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		position: relative;
		margin-bottom: 1.5rem;
	}

	.dep-tabs-inner {
		display: flex;
		gap: 0.125rem;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.dep-tabs-inner::-webkit-scrollbar {
		display: none;
	}

	.dep-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.625rem 0.875rem;
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--surface-muted);
		position: relative;
		cursor: pointer;
	}

	.dep-tab:hover {
		color: var(--center-channel-color);
		background: transparent;
	}

	.dep-tab[data-active] {
		color: var(--center-channel-color);
		background: transparent;
	}

	.dep-tab[data-active]::after {
		content: '';
		position: absolute;
		bottom: -1px;
		left: 0.5rem;
		right: 0.5rem;
		height: 2px;
		border-radius: 2px 2px 0 0;
		background-color: var(--sidebar-text-active-border, var(--center-channel-color));
	}

	.tab-panel {
		display: none;
		color: var(--center-channel-color);
	}

	.tab-panel[data-active] {
		display: block;
		animation: tab-panel-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes tab-panel-in {
		from { opacity: 0; transform: translateY(0.75rem) scale(0.99); }
		to { opacity: 1; transform: none; }
	}
</style>
