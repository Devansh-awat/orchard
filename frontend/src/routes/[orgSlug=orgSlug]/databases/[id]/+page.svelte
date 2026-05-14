<script lang="ts">
	import { page } from '$app/stores';
	import { goto, invalidate } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch, toasts, refreshTree, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import type { PageData } from './$types';
	import {
		ArrowLeft,
		Loader2,
		Database,
		Trash2,
		Copy,
		Check,
		Eye,
		EyeOff,
		AlertTriangle,
		X,
		Key,
		Archive,
		Terminal as TerminalIcon,
		RefreshCw,
		Puzzle,
		Settings as SettingsIcon,
		Plus,
		Container,
		ChevronDown,
		Maximize2,
		Minimize2
	} from 'lucide-svelte';
	import { fade, scale } from 'svelte/transition';
	import { Tabs } from 'melt/builders';
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import DatabaseProvisioning from '$lib/components/DatabaseProvisioning.svelte';

	interface DatabaseDetail {
		id: string;
		name: string;
		dbName: string;
		dbUser: string;
		dbPassword: string;
		host: string;
		port: number;
		status: string;
		mode?: string;
		namespace?: string;
		containerName?: string;
		storageSize?: string;
		publicEnabled?: boolean;
		publicIp?: string | null;
		publicPort?: number | null;
		publicHostname?: string | null;
		publicConnectionString?: string | null;
		pods?: Array<{
			name: string;
			status?: string;
			podIp?: string;
			containers?: Array<{ name: string; image?: string; ready?: boolean }>;
		}>;
		connectionString: string;
		internalHost: string;
		createdAt: string;
		backupsEnabled?: boolean;
		liveStatus?: {
			exists: boolean;
			size?: string;
			connections?: number;
			ready?: boolean;
			phase?: string;
			replicas?: number;
			readyReplicas?: number;
			restartCount?: number;
			message?: string;
		};
		project?: {
			id: string;
			name: string;
			slug: string;
			workspace?: {
				slug: string;
				organization?: {
					slug: string;
				};
			};
		};
		creator?: {
			username: string;
			email: string;
		};
	}

	interface Backup {
		id: string;
		label: string;
		backupName: string;
		type: string;
		status: string;
		sizeBytes: number | null;
		errorMessage: string | null;
		createdAt: string;
		completedAt: string | null;
	}

	let database = $state<DatabaseDetail | null>(null);
	let loading = $state(true);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let showPassword = $state(false);
	let showConnectionString = $state(false);
	let showPublicConnectionString = $state(false);
	let copiedField = $state<string | null>(null);

	let backups = $state<Backup[]>([]);
	let backupsLoading = $state(false);
	let creatingBackup = $state(false);
	let togglingPublic = $state(false);

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
					color: 'error',
				});
				return;
			}
			toasts.add({ title: 'Database exposed', description: `${data.host}:${data.port}`, color: 'success' });
			await fetchDatabase(true);
		} finally {
			togglingPublic = false;
		}
	}

	async function disablePublic() {
		if (!database) return;
		if (!confirm('Stop exposing this database publicly? Connected clients using the public endpoint will be disconnected.')) return;
		togglingPublic = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/public`, { method: 'DELETE' });
			if (!r.ok) {
				const data = await r.json().catch(() => ({}));
				toasts.add({ title: 'Failed to disable', description: data.message || 'Unknown error', color: 'error' });
				return;
			}
			toasts.add({ title: 'Public access disabled', color: 'success' });
			await fetchDatabase(true);
		} finally {
			togglingPublic = false;
		}
	}
	let restoringBackupId = $state<string | null>(null);

	// Backup schedule
	const SCHEDULE_PRESETS: Array<{ id: string; label: string; cron: string; description: string }> = [
		{ id: 'hourly', label: 'Every hour', cron: '0 * * * *', description: 'Top of every hour' },
		{ id: 'every6h', label: 'Every 6 hours', cron: '0 */6 * * *', description: 'Midnight, 6am, noon, 6pm (UTC)' },
		{ id: 'daily', label: 'Daily at 2am UTC', cron: '0 2 * * *', description: 'Once per day' },
		{ id: 'weekly', label: 'Weekly (Sun 2am UTC)', cron: '0 2 * * 0', description: 'Once per week' },
		{ id: 'custom', label: 'Custom cron…', cron: '', description: '' }
	];
	let scheduleCron = $state<string>('');
	let schedulePreset = $state<string>('none');
	let scheduleCustomCron = $state<string>('');
	let scheduleLoaded = $state(false);
	let scheduleSaving = $state(false);
	const MAX_BACKUPS = 10;

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
				body: JSON.stringify({ cron }),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				toasts.add({ title: 'Failed to save schedule', description: data.message || 'Unknown error', color: 'error' });
			} else {
				scheduleCron = data.cron || cron;
				toasts.add({ title: 'Schedule saved', description: `Backups will run: ${scheduleCron}`, color: 'success' });
			}
		} finally {
			scheduleSaving = false;
		}
	}

	const tabSections = [
		{ id: 'connection', label: 'Connection', icon: Key },
		{ id: 'backups', label: 'Backups', icon: Archive },
		{ id: 'terminal', label: 'Terminal', icon: TerminalIcon },
		{ id: 'extensions', label: 'Extensions', icon: Puzzle },
		{ id: 'settings', label: 'Settings', icon: SettingsIcon }
	] as const;
	type TabId = (typeof tabSections)[number]['id'];
	const tabs = new Tabs<TabId>({ value: 'connection', loop: true });

	// Extensions tab state
	interface ExtInfo {
		name: string;
		installed: boolean;
		version?: string;
		defaultVersion?: string;
		comment?: string;
	}
	let extensions = $state<ExtInfo[]>([]);
	let preloadedExts = $state<string[]>([]);
	let extensionsLoading = $state(false);
	let extensionsLoaded = $state(false);
	let extensionSearch = $state('');
	let busyExtension = $state<string | null>(null);

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

	async function fetchExtensions() {
		extensionsLoading = true;
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
				body: JSON.stringify({ name, addToPreload }),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data.success) {
				toasts.add({ title: 'Install failed', description: data.output || data.message || 'Unknown error', color: 'error' });
			} else {
				toasts.add({
					title: `${name} installed`,
					description: data.preloadAdded ? 'Added to shared_preload_libraries — restart required' : 'Extension is ready to use',
					color: 'success',
				});
				await fetchExtensions();
			}
		} finally {
			busyExtension = null;
		}
	}

	async function uninstallExtension(name: string, removeFromPreload: boolean) {
		if (!confirm(`Drop extension "${name}"? Objects that depend on it will also be dropped.`)) return;
		busyExtension = name;
		try {
			const qs = removeFromPreload ? '?removeFromPreload=true' : '';
			const r = await apiFetch(`/apiv1/databases/${dbId}/extensions/${encodeURIComponent(name)}${qs}`, {
				method: 'DELETE',
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data.success) {
				toasts.add({ title: 'Uninstall failed', description: data.output || data.message || 'Unknown error', color: 'error' });
			} else {
				toasts.add({ title: `${name} removed`, color: 'success' });
				await fetchExtensions();
			}
		} finally {
			busyExtension = null;
		}
	}

	// Settings tab state
	interface ParamMeta {
		key: string;
		label: string;
		kind: 'int' | 'memory' | 'string';
		min?: number;
		max?: number;
		enum?: string[];
		defaultValue: string;
		requiresRestart?: boolean;
		help: string;
	}
	const PARAM_SCHEMA: ParamMeta[] = [
		{ key: 'max_connections', label: 'Max Connections', kind: 'int', min: 10, max: 500, defaultValue: '100', requiresRestart: true, help: 'Maximum concurrent client connections. Restart required.' },
		{ key: 'shared_buffers', label: 'Shared Buffers', kind: 'memory', defaultValue: '128MB', requiresRestart: true, help: 'Memory for caching shared data. Typically 25% of system RAM. Restart required.' },
		{ key: 'work_mem', label: 'Work Memory', kind: 'memory', defaultValue: '4MB', help: 'Memory per sort/hash operation.' },
		{ key: 'maintenance_work_mem', label: 'Maintenance Work Memory', kind: 'memory', defaultValue: '64MB', help: 'Memory for VACUUM, CREATE INDEX, etc.' },
		{ key: 'effective_cache_size', label: 'Effective Cache Size', kind: 'memory', defaultValue: '4GB', help: 'Planner hint for OS page cache size.' },
		{ key: 'log_min_duration_statement', label: 'Slow Query Log (ms)', kind: 'int', min: -1, max: 600000, defaultValue: '-1', help: 'Log statements slower than this (ms). -1 disables.' },
		{ key: 'statement_timeout', label: 'Statement Timeout (ms)', kind: 'int', min: 0, max: 3600000, defaultValue: '0', help: 'Abort any statement taking longer than this (ms). 0 disables.' },
		{ key: 'idle_in_transaction_session_timeout', label: 'Idle-in-Transaction Timeout (ms)', kind: 'int', min: 0, max: 3600000, defaultValue: '0', help: 'Terminate sessions idle inside a transaction. 0 disables.' },
		{ key: 'synchronous_commit', label: 'Synchronous Commit', kind: 'string', enum: ['on', 'off', 'local', 'remote_write', 'remote_apply'], defaultValue: 'on', help: 'Wait for WAL flush before acknowledging. Off is faster, less durable.' },
	];

	let settings = $state<Record<string, string>>({});
	let settingsLoading = $state(false);
	let settingsLoaded = $state(false);
	let settingsSaving = $state(false);
	let settingsDirty = $state(false);

	async function fetchSettings() {
		settingsLoading = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/settings`);
			if (r.ok) {
				const data = await r.json();
				settings = { ...(data.parameters || {}) };
				settingsDirty = false;
			}
			settingsLoaded = true;
		} finally {
			settingsLoading = false;
		}
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
		const hasRestart = PARAM_SCHEMA
			.filter((p) => p.requiresRestart)
			.some((p) => settings[p.key] !== undefined && settings[p.key] !== p.defaultValue);
		if (hasRestart && !confirm('Some of these settings require a brief database restart (~10–30s of downtime). Apply now?')) return;

		settingsSaving = true;
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/settings`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ parameters: settings }),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				toasts.add({ title: 'Save failed', description: data.message || 'Unknown error', color: 'error' });
			} else {
				toasts.add({ title: 'Settings saved', color: 'success' });
				settings = { ...(data.parameters || {}) };
				settingsDirty = false;
			}
		} finally {
			settingsSaving = false;
		}
	}

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

	let filteredExtensions = $derived.by(() => {
		const q = extensionSearch.trim().toLowerCase();
		// Merge catalog entries with live list. Anything in catalog that isn't available is skipped;
		// anything available but not in catalog is shown with its pg_catalog comment.
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

	// Terminal / logs state
	let logs = $state('');
	let logsLoading = $state(false);
	let tailLines = $state(200);
	let logsRef = $state<HTMLPreElement | null>(null);
	let activeConsoleTab = $state<string>('logs');
	interface TerminalTab { id: string; podName: string; container: string; label: string; }
	let terminalTabs = $state<TerminalTab[]>([]);
	let terminalCounter = 0;
	let consoleExpanded = $state(false);

	function podShortName(name: string): string {
		const parts = name.split('-');
		return parts.length > 2 ? parts.slice(-2).join('-') : name;
	}

	function timeAgo(d?: string | null): string {
		if (!d) return '';
		const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
		const dy = Math.floor(h / 24); return `${dy}d`;
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

	async function fetchLogs() {
		if (!database?.namespace) return;
		const pod = database.pods?.[0];
		if (!pod?.name) return;
		logsLoading = true;
		try {
			const r = await apiFetch(
				`/apiv1/pods/${pod.name}/logs?namespace=${database.namespace}&container=postgres&tailLines=${tailLines}`
			);
			if (r.ok) {
				const data = await r.json();
				logs = data.logs || '';
				requestAnimationFrame(() => {
					if (logsRef) logsRef.scrollTop = logsRef.scrollHeight;
				});
			}
		} catch { /* ignore */ } finally {
			logsLoading = false;
		}
	}

	$effect(() => {
		if (tabs.value === 'terminal' && activeConsoleTab === 'logs' && database?.pods?.[0]?.name) {
			fetchLogs();
		}
	});

	// Delete confirmation modal state
	let showDeleteModal = $state(false);
	let deleteCountdownActive = $state(false);
	let deleteCountdown = $state(10);
	let deleteTimerInterval = $state<ReturnType<typeof setInterval> | null>(null);
	let deleteProgress = $derived(((10 - deleteCountdown) / 10) * 100);

	let { data } = $props<{ data: PageData }>();
	const dbId = $derived(data.dbId);
	const orgSlug = $derived($page.params.orgSlug);
	let dbSseUnsub: (() => void) | null = null;

	async function fetchDatabase(silent = false) {
		if (!silent) loading = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}`);
			if (!response.ok) throw new Error('Failed to fetch database');
			database = await response.json();
			if (database?.backupsEnabled) {
				fetchBackups();
			}
			scheduleStatusRefresh();
		} catch (e) {
			if (!silent) error = e instanceof Error ? e.message : 'Failed to load database';
		} finally {
			if (!silent) loading = false;
		}
	}

	function scheduleStatusRefresh() {
		// Status updates flow via SSE (`pod.changed` / `database.changed`).
		// No client polling.
	}

	function podStateLabel(): { label: string; kind: 'ready' | 'pending' | 'error' } {
		const ls = database?.liveStatus;
		if (!ls) return { label: 'Unknown', kind: 'pending' };
		if (!ls.exists) return { label: 'Not deployed', kind: 'error' };
		if (database?.status === 'restoring') return { label: 'Restoring', kind: 'pending' };
		if (ls.ready) return { label: 'Running', kind: 'ready' };
		if (ls.message) {
			const m = ls.message.toLowerCase();
			if (m.includes('crash') || m.includes('error') || m.includes('backoff')) {
				return { label: ls.message, kind: 'error' };
			}
			return { label: ls.message, kind: 'pending' };
		}
		if (ls.phase === 'Running') return { label: 'Starting', kind: 'pending' };
		return { label: ls.phase || 'Pending', kind: 'pending' };
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
			startBackupRefresh();
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
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to restore',
				color: 'error'
			});
		} finally {
			restoringBackupId = null;
		}
	}

	function startBackupRefresh() {
		// Backup status updates flow via SSE (`database.changed` fires when a
		// DatabaseBackup row is created/updated). The page's SSE handler calls
		// fetchBackups; nothing client-side to schedule.
	}

	function formatBytes(bytes: number | null): string {
		if (!bytes) return '—';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let n = bytes;
		let i = 0;
		while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
		return `${n.toFixed(1)} ${units[i]}`;
	}

	function formatDate(s: string): string {
		return new Date(s).toLocaleString();
	}

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

			refreshTree();
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

	function copyToClipboard(text: string, field: string) {
		navigator.clipboard.writeText(text);
		copiedField = field;
		setTimeout(() => { copiedField = null; }, 2000);
	}

	onMount(() => {
		data.databasePromise
			.then((seed: any) => {
				if (!database) {
					database = seed;
					loading = false;
					if (database?.backupsEnabled) fetchBackups();
					scheduleStatusRefresh();
				}
			})
			.catch(() => {});
		fetchDatabase();
		const orgIdForSse = $selectedOrganization?.id;
		if (orgIdForSse) {
			dbSseUnsub = subscribeOrgEvents(
				orgIdForSse,
				(ev) => {
					if (ev.id === dbId) {
						fetchDatabase(true);
						if (database?.backupsEnabled) fetchBackups();
					}
				},
				// SSE handler refetches silently; don't re-run the loader.
				{ invalidateDependencies: [] },
			);
		}
		return () => {
			dbSseUnsub?.();
		};
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
		{@const db = database}
		{#if db.project && db.project.workspace}
			<button
				onclick={() => goto(`/${orgSlug}/workspaces/${db.project!.workspace!.slug}/projects/${db.project!.slug}`)}
				class="db-back"
			>
				<ArrowLeft class="h-4 w-4" />
				{db.project.name}
			</button>
		{/if}

		<div class="db-header">
			<div class="db-header-info">
				<div class="db-header-title-row">
					<div class="db-icon-badge">
						<Database size={16} />
					</div>
					<h1 class="db-title">{database.name}</h1>
					<span class="db-status db-status-{database.status}">{database.status}</span>
				</div>
			</div>
			<button
				onclick={openDeleteModal}
				disabled={deleting}
				class="db-btn db-btn-danger"
			>
				{#if deleting}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Trash2 class="h-4 w-4" />
				{/if}
				Delete
			</button>
		</div>

		{#if database.mode === 'cnpg' && (database.status === 'provisioning' || database.status === 'restoring' || (database.status === 'error' && !database.liveStatus?.ready))}
			<DatabaseProvisioning
				dbId={dbId}
				dbName={database.name}
				onDone={() => fetchDatabase(true)}
			/>
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
			<div class="space-y-5">
				<div class="card rounded-2xl p-5">
					<p class="text-sm font-semibold mb-4" style="color: var(--center-channel-color);">Connection details</p>
					<div class="db-kv-grid">
						<span class="db-kv-label">Host (internal)</span>
						<div class="db-kv-value">
							<code class="db-kv-code">{database.host}</code>
							<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard(db.host, 'host')} aria-label="Copy host">
								{#if copiedField === 'host'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
							</button>
						</div>

						<span class="db-kv-label">Port</span>
						<div class="db-kv-value">
							<code class="db-kv-code">{database.port}</code>
							<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard(String(db.port), 'port')} aria-label="Copy port">
								{#if copiedField === 'port'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
							</button>
						</div>

						<span class="db-kv-label">Database</span>
						<div class="db-kv-value">
							<code class="db-kv-code">{database.dbName}</code>
							<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard(db.dbName, 'dbName')} aria-label="Copy database">
								{#if copiedField === 'dbName'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
							</button>
						</div>

						<span class="db-kv-label">Username</span>
						<div class="db-kv-value">
							<code class="db-kv-code">{database.dbUser}</code>
							<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard(db.dbUser, 'user')} aria-label="Copy username">
								{#if copiedField === 'user'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
							</button>
						</div>

						<span class="db-kv-label">Password</span>
						<div class="db-kv-value">
							<code class="db-kv-code">{showPassword ? db.dbPassword : '••••••••••••'}</code>
							<button class="btn btn-ghost btn-sm shrink-0" onclick={() => showPassword = !showPassword} aria-label={showPassword ? 'Hide' : 'Show'}>
								{#if showPassword}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
							</button>
							<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard(db.dbPassword, 'password')} aria-label="Copy password">
								{#if copiedField === 'password'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
							</button>
						</div>
					</div>
				</div>

				<div class="card rounded-2xl p-5">
					<p class="text-sm font-semibold mb-3" style="color: var(--center-channel-color);">Connection string</p>
					<div class="db-connstr-card">
						<code class="db-connstr-code">{showConnectionString
							? database.connectionString
							: `postgresql://${database.dbUser}:••••••••@${database.host}:${database.port}/${database.dbName}`
						}</code>
						<div class="flex gap-1 shrink-0">
							<button class="btn btn-ghost btn-sm" onclick={() => showConnectionString = !showConnectionString} aria-label={showConnectionString ? 'Hide' : 'Show'}>
								{#if showConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
							</button>
							<button class="btn btn-ghost btn-sm" onclick={() => copyToClipboard(db.connectionString, 'connstr')} aria-label="Copy connection string">
								{#if copiedField === 'connstr'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
							</button>
						</div>
					</div>
				</div>

				{#if database.mode === 'cnpg'}
					<div class="card rounded-2xl p-5">
						<div class="flex items-center justify-between mb-3 flex-wrap gap-2">
							<div>
								<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Public access</p>
								<p class="text-xs mt-1" style="color: var(--surface-muted);">
									Expose this database on a shared organization IP with a unique port.
								</p>
							</div>
							{#if database.publicEnabled}
								<button class="btn btn-secondary btn-sm" onclick={disablePublic} disabled={togglingPublic}>
									{#if togglingPublic}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
									<span>Disable</span>
								</button>
							{:else}
								<button class="btn btn-primary btn-sm" onclick={enablePublic} disabled={togglingPublic}>
									{#if togglingPublic}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
									<span>Enable</span>
								</button>
							{/if}
						</div>

						{#if database.publicEnabled && database.publicIp && database.publicPort}
							<div class="db-kv-grid">
								<span class="db-kv-label">Public host</span>
								<div class="db-kv-value">
									<code class="db-kv-code">{database.publicHostname || database.publicIp}</code>
									<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard((database.publicHostname || database.publicIp) as string, 'pubHost')} aria-label="Copy host">
										{#if copiedField === 'pubHost'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
									</button>
								</div>

								<span class="db-kv-label">Public port</span>
								<div class="db-kv-value">
									<code class="db-kv-code">{database.publicPort}</code>
									<button class="btn btn-ghost btn-sm shrink-0" onclick={() => copyToClipboard(String(database.publicPort), 'pubPort')} aria-label="Copy port">
										{#if copiedField === 'pubPort'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
									</button>
								</div>

								<span class="db-kv-label">TLS</span>
								<div class="db-kv-value">
									<span class="db-status-pill db-status-pill-completed">Let's Encrypt · verify-full</span>
								</div>
							</div>

							{#if database.publicConnectionString}
								<p class="text-xs font-semibold mt-4 mb-2" style="color: var(--surface-muted);">Public connection string</p>
								<div class="db-connstr-card">
									<code class="db-connstr-code">{showPublicConnectionString
										? database.publicConnectionString
										: `postgresql://${database.dbUser}:••••••••@${database.publicHostname || database.publicIp}:${database.publicPort}/${database.dbName}?sslmode=verify-full&sslrootcert=system`
									}</code>
									<div class="flex gap-1 shrink-0">
										<button class="btn btn-ghost btn-sm" onclick={() => showPublicConnectionString = !showPublicConnectionString} aria-label={showPublicConnectionString ? 'Hide' : 'Show'}>
											{#if showPublicConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
										</button>
										<button class="btn btn-ghost btn-sm" onclick={() => copyToClipboard(database.publicConnectionString as string, 'pubConnStr')} aria-label="Copy public connection string">
											{#if copiedField === 'pubConnStr'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
										</button>
									</div>
								</div>
							{/if}
						{:else}
							<div class="db-empty-box">
								<p class="text-sm" style="color: var(--surface-muted);">
									Not publicly exposed. Click <strong>Enable</strong> to assign a random free port on your organization's shared database IP.
									If no shared IP is configured, set one in
									<a href={`/${orgSlug}/settings`} class="db-link">organization settings</a>.
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</section>

		<!-- Backups tab -->
		<section {...tabs.getContent('backups')} hidden={undefined} class="tab-panel">
			<div class="space-y-5">
				{#if database.mode === 'cnpg' && database.backupsEnabled}
					<div class="card rounded-2xl p-5">
						<div class="flex items-center justify-between mb-3">
							<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Backup schedule</p>
							<button class="btn btn-primary btn-sm" onclick={saveSchedule} disabled={scheduleSaving}>
								{#if scheduleSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								<span>{schedulePreset === 'none' ? 'Clear' : 'Save'}</span>
							</button>
						</div>

						<div class="grid gap-3 md:grid-cols-2">
							<div>
								<p class="text-xs mb-1" style="color: var(--surface-muted);">Run backups</p>
								<select
									class="input text-sm"
									bind:value={schedulePreset}
									disabled={scheduleSaving}
								>
									<option value="none">Never (manual only)</option>
									{#each SCHEDULE_PRESETS as p}
										<option value={p.id}>{p.label}</option>
									{/each}
								</select>
							</div>
							{#if schedulePreset === 'custom'}
								<div>
									<p class="text-xs mb-1" style="color: var(--surface-muted);">Cron expression</p>
									<input
										type="text"
										class="input font-mono text-sm"
										placeholder="0 2 * * *"
										bind:value={scheduleCustomCron}
										disabled={scheduleSaving}
									/>
								</div>
							{/if}
						</div>

						{#if schedulePreset === 'custom'}
							<p class="text-xs mt-2" style="color: var(--surface-muted);">
								5 fields: <code class="db-inline-code">min hour day month weekday</code>. Interpreted in UTC.
							</p>
						{:else if schedulePreset !== 'none'}
							{@const active = SCHEDULE_PRESETS.find((p) => p.id === schedulePreset)}
							{#if active}
								<p class="text-xs mt-2" style="color: var(--surface-muted);">
									{active.description} · <code class="db-inline-code">{active.cron}</code>
								</p>
							{/if}
						{/if}
						{#if scheduleCron}
							<p class="text-xs mt-1" style="color: var(--surface-muted);">
								Currently active: <code class="db-inline-code">{scheduleCron}</code>
							</p>
						{/if}
					</div>
				{/if}

				<div class="card rounded-2xl p-5">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Backups</p>
							{#if backups.length > 0}
								<span class="db-badge-count">{backups.filter((b) => b.status === 'completed').length} / {MAX_BACKUPS}</span>
							{/if}
						</div>
						{#if (database.mode === 'cnpg' || database.mode === 'container') && database.backupsEnabled}
							<button class="btn btn-primary btn-sm" onclick={createBackup} disabled={creatingBackup}>
								{#if creatingBackup}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								<span>Create backup</span>
							</button>
						{/if}
					</div>

					{#if database.mode === 'cnpg' && database.backupsEnabled && backups.length > 0}
						<p class="text-xs mb-3" style="color: var(--surface-muted);">
							The oldest completed backup is automatically pruned when you exceed {MAX_BACKUPS}.
						</p>
					{/if}

					{#if database.mode !== 'cnpg' && database.mode !== 'container'}
						<div class="db-empty-box">
							<p class="text-sm" style="color: var(--surface-muted);">Backups require a managed database (CNPG). Recreate this database to enable backups.</p>
						</div>
					{:else if !database.backupsEnabled}
						<div class="db-empty-box">
							<p class="text-sm" style="color: var(--surface-muted);">
								Backups are disabled. Configure an R2 bucket in
								<a href={`/${orgSlug}/settings`} class="db-link">organization settings</a>
								to enable pgBackRest backups for this database.
							</p>
						</div>
					{:else if backupsLoading && backups.length === 0}
						<div class="db-empty-box flex items-center gap-2">
							<Loader2 class="h-4 w-4 animate-spin" />
							<span class="text-sm" style="color: var(--surface-muted);">Loading backups…</span>
						</div>
					{:else if backups.length === 0}
						<div class="db-empty-box">
							<p class="text-sm" style="color: var(--surface-muted);">No backups yet. Create your first backup to enable point-in-time restores.</p>
						</div>
					{:else}
						<div class="space-y-2">
							{#each backups as backup (backup.id)}
								<div class="db-list-row">
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2 flex-wrap">
											<span class="db-list-name">{backup.label}</span>
											<span class="db-status-pill db-status-pill-{backup.status}">{backup.status}</span>
										</div>
										<div class="db-list-meta">
											<span class="db-list-meta-tag">{backup.type}</span>
											<span>·</span>
											<span>{formatDate(backup.createdAt)}</span>
											{#if backup.sizeBytes}
												<span>·</span>
												<span>{formatBytes(Number(backup.sizeBytes))}</span>
											{/if}
										</div>
										{#if backup.errorMessage}
											<div class="db-list-error">{backup.errorMessage}</div>
										{/if}
									</div>
									{#if backup.status === 'completed'}
										<button
											class="btn btn-secondary btn-sm shrink-0"
											onclick={() => restoreBackup(backup)}
											disabled={restoringBackupId === backup.id}
										>
											{#if restoringBackupId === backup.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
											<span>Restore</span>
										</button>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</section>

		<!-- Terminal tab -->
		<section {...tabs.getContent('terminal')} hidden={undefined} class="tab-panel">
			{#if database.mode !== 'cnpg' && database.mode !== 'container'}
				<div class="backups-empty">
					<p class="db-hint">Terminal access requires a managed database (CNPG or container mode).</p>
				</div>
			{:else if !database.pods || !database.pods.length}
				<div class="backups-empty">
					<Loader2 class="h-4 w-4 animate-spin" />
					<p class="db-hint" style="margin: 0;">Waiting for the Postgres pod to be scheduled…</p>
				</div>
			{:else}
				{@const pod = database.pods[0]}
				<div
					class="console-panel"
					class:console-expanded={consoleExpanded}
					class:console-at-fullscreen={consoleExpanded}
				>
					<div class="console-toolbar">
						<div class="console-toolbar-left">
							<button
								class="console-tab-btn"
								class:console-tab-btn--active={activeConsoleTab === 'logs'}
								onclick={() => (activeConsoleTab = 'logs')}
							>Logs</button>
							{#each terminalTabs as ttab (ttab.id)}
								<button
									class="console-tab-btn"
									class:console-tab-btn--active={activeConsoleTab === ttab.id}
									onclick={() => (activeConsoleTab = ttab.id)}
								>
									{ttab.label}
									<span
										class="console-tab-close"
										role="button"
										tabindex="-1"
										onclick={(e) => { e.stopPropagation(); closeTerminalTab(ttab.id); }}
										onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeTerminalTab(ttab.id); } }}
									>
										<X class="h-2.5 w-2.5" />
									</span>
								</button>
							{/each}
						</div>
						<div class="console-toolbar-right">
							{#if activeConsoleTab === 'logs'}
								<button
									class="console-source-btn"
									onclick={(e) => { e.preventDefault(); tailLines = tailLines === 100 ? 200 : tailLines === 200 ? 500 : tailLines === 500 ? 1000 : 100; fetchLogs(); }}
									title="Cycle tail size"
								>
									<Container class="h-3 w-3 opacity-40" />
									<span>{podShortName(pod.name)} / postgres</span>
									<ChevronDown class="h-2.5 w-2.5 opacity-40" />
								</button>
								<button onclick={fetchLogs} disabled={logsLoading} class="console-icon-btn" title={`Refresh (tail ${tailLines})`}>
									{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
								</button>
							{/if}
							<button class="console-action-btn" onclick={() => openShellTab(pod.name, 'postgres')} title="Open shell in pod">
								<TerminalIcon class="h-3 w-3" />
								Shell
							</button>
							<button
								onclick={() => (consoleExpanded = !consoleExpanded)}
								class="console-icon-btn"
								title={consoleExpanded ? 'Collapse' : 'Expand'}
							>
								{#if consoleExpanded}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2 class="h-3.5 w-3.5" />{/if}
							</button>
						</div>
					</div>

					<div class="console-body">
						{#if activeConsoleTab === 'logs'}
							{#if logsLoading && !logs}
								<div class="console-empty">
									<Loader2 class="h-4 w-4 animate-spin" />
									<span>Loading logs...</span>
								</div>
							{:else if logs}
								<pre bind:this={logsRef} class="console-output">{logs}</pre>
							{:else}
								<div class="console-empty">
									<TerminalIcon class="h-4 w-4 opacity-30" />
									<span>No output yet</span>
								</div>
							{/if}
						{:else}
							{#each terminalTabs as ttab (ttab.id)}
								<PodTerminal
									podName={ttab.podName}
									namespace={database.namespace!}
									container={ttab.container}
									visible={activeConsoleTab === ttab.id}
								/>
							{/each}
						{/if}
					</div>
				</div>

			{/if}
		</section>

		<!-- Extensions tab -->
		<section {...tabs.getContent('extensions')} hidden={undefined} class="tab-panel">
			<div class="card rounded-2xl p-5">
				<div class="flex items-center justify-between gap-3 mb-4 flex-wrap">
					<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Extensions</p>
					{#if database.mode === 'cnpg'}
						<div class="flex items-center gap-2 flex-1 justify-end" style="min-width: 200px;">
							<input
								type="search"
								placeholder="Search extensions…"
								class="input text-sm"
								style="max-width: 20rem;"
								bind:value={extensionSearch}
							/>
							<button class="btn btn-secondary btn-sm" onclick={fetchExtensions} disabled={extensionsLoading} aria-label="Refresh">
								{#if extensionsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
							</button>
						</div>
					{/if}
				</div>

				{#if database.mode !== 'cnpg'}
					<div class="db-empty-box">
						<p class="text-sm" style="color: var(--surface-muted);">Extension management is only available for CNPG-backed databases. Recreate this database to enable it.</p>
					</div>
				{:else if extensionsLoading && filteredExtensions.length === 0}
					<div class="db-empty-box flex items-center gap-2">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span class="text-sm" style="color: var(--surface-muted);">Loading extensions…</span>
					</div>
				{:else if filteredExtensions.length === 0}
					<div class="db-empty-box">
						<p class="text-sm" style="color: var(--surface-muted);">No extensions match your search.</p>
					</div>
				{:else}
					<div class="space-y-2">
						{#each filteredExtensions as ext (ext.name)}
							<div class="db-list-row">
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="db-list-name">{ext.name}</span>
										{#if ext.installed}
											<span class="db-status-pill db-status-pill-completed">installed{ext.version ? ` · ${ext.version}` : ''}</span>
										{:else}
											<span class="db-status-pill db-status-pill-muted">available{ext.defaultVersion ? ` · ${ext.defaultVersion}` : ''}</span>
										{/if}
										{#if preloadedExts.includes(ext.name)}
											<span class="db-status-pill db-status-pill-warn">preloaded</span>
										{/if}
									</div>
									{#if ext.description}
										<div class="db-list-meta">{ext.description}</div>
									{/if}
								</div>
								{#if ext.installed}
									<button
										class="btn btn-secondary btn-sm shrink-0"
										onclick={() => uninstallExtension(ext.name, preloadedExts.includes(ext.name))}
										disabled={busyExtension === ext.name}
									>
										{#if busyExtension === ext.name}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
										<span>Uninstall</span>
									</button>
								{:else}
									<button
										class="btn btn-primary btn-sm shrink-0"
										onclick={() => installExtension(ext.name, Boolean(ext.requiresPreload))}
										disabled={busyExtension === ext.name}
									>
										{#if busyExtension === ext.name}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
										<span>Install</span>
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>

		<!-- Settings tab -->
		<section {...tabs.getContent('settings')} hidden={undefined} class="tab-panel">
			<div class="card rounded-2xl p-5">
				<div class="flex items-center justify-between mb-4">
					<p class="text-sm font-semibold" style="color: var(--center-channel-color);">PostgreSQL parameters</p>
					{#if database.mode === 'cnpg'}
						<div class="flex gap-2">
							<button class="btn btn-ghost btn-sm" onclick={() => { settingsLoaded = false; fetchSettings(); }} disabled={settingsSaving}>
								<span>Discard</span>
							</button>
							<button class="btn btn-primary btn-sm" onclick={saveSettings} disabled={settingsSaving || !settingsDirty}>
								{#if settingsSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								<span>Save</span>
							</button>
						</div>
					{/if}
				</div>

				{#if database.mode !== 'cnpg'}
					<div class="db-empty-box">
						<p class="text-sm" style="color: var(--surface-muted);">Database settings are only configurable for CNPG-backed databases.</p>
					</div>
				{:else if settingsLoading && !settingsLoaded}
					<div class="db-empty-box flex items-center gap-2">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span class="text-sm" style="color: var(--surface-muted);">Loading settings…</span>
					</div>
				{:else}
					<div class="space-y-4">
						{#each PARAM_SCHEMA as p (p.key)}
							<div class="db-setting-row">
								<div class="db-setting-info">
									<div class="flex items-center gap-2 flex-wrap">
										<label for={`param-${p.key}`} class="db-setting-label">{p.label}</label>
										<code class="db-inline-code">{p.key}</code>
										{#if p.requiresRestart}
											<span class="db-status-pill db-status-pill-warn">restart required</span>
										{/if}
									</div>
									<p class="db-setting-help">{p.help} Default: <code class="db-inline-code">{p.defaultValue}</code>.</p>
								</div>
								<div class="db-setting-control">
									{#if p.kind === 'int'}
										<input
											id={`param-${p.key}`}
											type="number"
											min={p.min}
											max={p.max}
											class="input font-mono text-sm"
											value={paramValue(p.key)}
											oninput={(e) => setParam(p.key, (e.currentTarget as HTMLInputElement).value)}
											placeholder={p.defaultValue}
										/>
									{:else if p.kind === 'memory'}
										<input
											id={`param-${p.key}`}
											type="text"
											class="input font-mono text-sm"
											value={paramValue(p.key)}
											oninput={(e) => setParam(p.key, (e.currentTarget as HTMLInputElement).value)}
											placeholder={p.defaultValue}
										/>
									{:else if p.kind === 'string' && p.enum}
										<select
											id={`param-${p.key}`}
											class="input text-sm"
											value={paramValue(p.key)}
											onchange={(e) => setParam(p.key, (e.currentTarget as HTMLSelectElement).value)}
										>
											{#each p.enum as opt}
												<option value={opt}>{opt}</option>
											{/each}
										</select>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>
		{/if}
	{/if}
</div>

{#if showDeleteModal && database}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-overlay" transition:fade={{ duration: 150 }} onclick={cancelDelete}>
		<div
			class="modal-card"
			transition:scale={{ duration: 200, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
		>
			<div class="modal-header">
				<div class="modal-icon-danger">
					<AlertTriangle size={20} />
				</div>
				<button class="modal-close" onclick={cancelDelete}>
					<X size={16} />
				</button>
			</div>

			<h2 class="modal-title">Delete "{database.name}"?</h2>
			<p class="modal-desc">
				This will permanently <strong>drop the PostgreSQL database</strong> and its user.
				All data will be lost. This cannot be undone.
			</p>

			{#if deleteCountdownActive}
				<div class="modal-progress-wrapper">
					<div class="modal-progress-track">
						<div
							class="modal-progress-fill"
							style="width: {deleteProgress}%"
						></div>
					</div>
					<span class="modal-countdown">
						{#if deleteCountdown > 0}
							Deleting in {deleteCountdown}s...
						{:else}
							Deleting now...
						{/if}
					</span>
				</div>

				<div class="modal-actions">
					<button class="db-btn modal-btn-cancel" onclick={cancelDelete}>
						Abort
					</button>
				</div>
			{:else}
				<div class="modal-actions">
					<button class="db-btn modal-btn-cancel" onclick={cancelDelete}>
						Cancel
					</button>
					<button class="db-btn db-btn-danger modal-btn-delete" onclick={startDeleteCountdown}>
						<Trash2 class="h-4 w-4" />
						Delete
					</button>
				</div>
			{/if}
		</div>
	</div>
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

	.db-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1.5rem;
		transition: color 0.15s;
	}

	.db-back:hover {
		color: var(--center-channel-color);
	}

	.db-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.db-header-info {
		flex: 1;
		min-width: 0;
	}

	.db-header-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.db-icon-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
		flex-shrink: 0;
	}

	.db-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.db-status {
		font-size: 0.75rem;
		font-weight: 500;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		text-transform: capitalize;
	}

	.db-status-ready {
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}

	.db-status-pending {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.db-status-error {
		background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
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
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
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

	.db-section {
		margin-bottom: 1.5rem;
	}

	.db-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0 0 0.75rem;
	}

	.db-credentials {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.db-cred-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		gap: 1rem;
	}

	.db-cred-row:not(:last-child) {
		border-bottom: 1px solid var(--surface-border);
	}

	.db-cred-label {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		flex-shrink: 0;
		min-width: 7rem;
	}

	.db-cred-value-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		flex: 1;
		justify-content: flex-end;
	}

	.db-cred-value {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.db-copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: color 0.15s, background-color 0.15s;
	}

	.db-copy-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.db-connstr-box {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.875rem 1.125rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.db-connstr {
		flex: 1;
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		word-break: break-all;
	}

	.db-connstr-actions {
		display: flex;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.db-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0 0 0.5rem;
	}

	.db-env-snippet {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		overflow-x: auto;
	}

	.db-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
		white-space: nowrap;
	}

	.db-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.db-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.db-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	/* Delete confirmation modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 1rem;
	}

	.modal-card {
		background-color: var(--center-channel-bg);
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		padding: 1.75rem;
		width: 100%;
		max-width: 26rem;
		box-shadow:
			0 4px 12px rgb(0 0 0 / 0.08),
			0 20px 60px rgb(0 0 0 / 0.2);
	}

	.modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.modal-icon-danger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.modal-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}

	.modal-close:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.modal-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0 0 0.5rem;
	}

	.modal-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0 0 1.25rem;
		line-height: 1.5;
	}

	.modal-desc strong {
		color: var(--error-text-color);
		font-weight: 600;
	}

	.modal-progress-wrapper {
		margin-bottom: 1.25rem;
	}

	.modal-progress-track {
		width: 100%;
		height: 0.375rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		overflow: hidden;
		margin-bottom: 0.5rem;
	}

	.modal-progress-fill {
		height: 100%;
		border-radius: 9999px;
		background-color: var(--error-text-color);
		transition: width 1s linear;
	}

	.modal-countdown {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.modal-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.modal-btn-cancel {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.modal-btn-cancel:hover {
		background-color: color-mix(in srgb, var(--surface-border) 90%, transparent);
	}

	.modal-btn-delete {
		padding: 0.4375rem 1rem;
	}

	.backups-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.db-btn-primary {
		background-color: var(--center-channel-color);
		color: var(--center-channel-bg);
	}

	.db-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.db-btn-ghost {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		color: var(--center-channel-color);
	}

	.db-btn-ghost:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
	}

	.backups-empty {
		padding: 1rem 1.125rem;
		border: 1px dashed var(--surface-border);
		border-radius: 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.backups-link {
		color: var(--link-color, #3b82f6);
		text-decoration: underline;
	}

	.backups-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		overflow: hidden;
	}

	.backup-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
	}

	.backup-row:not(:last-child) {
		border-bottom: 1px solid var(--surface-border);
	}

	.backup-main {
		flex: 1;
		min-width: 0;
	}

	.backup-label {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.backup-meta {
		display: flex;
		gap: 0.375rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin-top: 0.125rem;
		flex-wrap: wrap;
	}

	.backup-type {
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 600;
	}

	.backup-error {
		font-size: 0.75rem;
		color: var(--error-text-color);
		margin-top: 0.25rem;
		font-family: var(--font-mono);
		word-break: break-word;
	}

	.backup-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.backup-status {
		font-size: 0.6875rem;
		text-transform: capitalize;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		font-weight: 500;
	}

	.backup-status-completed {
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}

	.backup-status-running,
	.backup-status-pending {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.backup-status-failed {
		background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
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

	.db-pod-spinner {
		color: var(--surface-muted);
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
		from {
			opacity: 0;
			transform: translateY(0.75rem) scale(0.99);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.console-panel {
		position: relative;
		border-radius: 0.875rem;
		overflow: visible;
		border: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
		background-color: #0d1117;
		color: #c9d1d9;
		display: flex;
		flex-direction: column;
		height: 510px;
		transition: none;
	}
	:global(:root:not(.dark)) .console-panel {
		background-color: #1b1f27;
		color: #d0d7de;
	}

	.console-panel.console-expanded {
		position: fixed;
		z-index: 100;
		border: none;
		top: 0 !important;
		left: 0 !important;
		width: 100vw !important;
		height: 100vh !important;
		border-radius: 0;
	}
	.console-panel.console-expanded .console-body { flex: 1; min-height: 0; }
	.console-panel.console-expanded .console-output { max-height: none; height: 100%; }

	.console-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		background: rgba(255, 255, 255, 0.02);
	}

	.console-toolbar-left {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.console-toolbar-right {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	.console-tab-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3rem 0.5rem;
		border: none;
		background: transparent;
		color: rgba(201, 209, 217, 0.5);
		font-size: 0.6875rem;
		font-family: var(--font-mono);
		cursor: pointer;
		border-radius: 0.375rem;
		transition: background 0.1s, color 0.1s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.console-tab-btn:hover {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(201, 209, 217, 0.8);
	}
	.console-tab-btn--active {
		background: rgba(255, 255, 255, 0.08);
		color: #c9d1d9;
	}

	.console-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 1px;
		border-radius: 3px;
		opacity: 0.4;
		cursor: pointer;
		transition: opacity 0.1s, background 0.1s;
	}
	.console-tab-close:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.1);
	}

	.console-source-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border: none;
		background: transparent;
		color: rgba(201, 209, 217, 0.5);
		font-size: 0.625rem;
		font-family: var(--font-mono);
		cursor: pointer;
		border-radius: 0.375rem;
		transition: background 0.1s, color 0.1s;
		white-space: nowrap;
	}
	.console-source-btn:hover {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(201, 209, 217, 0.8);
	}

	.console-action-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
		color: rgba(201, 209, 217, 0.6);
		font-size: 0.625rem;
		font-family: var(--font-mono);
		cursor: pointer;
		border-radius: 0.375rem;
		transition: background 0.1s, color 0.1s, border-color 0.1s;
		white-space: nowrap;
	}
	.console-action-btn:hover {
		background: rgba(255, 255, 255, 0.06);
		color: #c9d1d9;
		border-color: rgba(255, 255, 255, 0.15);
	}

	.console-icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.375rem;
		background: transparent;
		border: none;
		color: inherit;
		cursor: pointer;
		opacity: 0.6;
		transition: opacity 0.1s, background 0.1s;
	}
	.console-icon-btn:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.08);
	}

	.console-body {
		flex: 1;
		min-height: 0;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.console-output {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-all;
		font-size: 0.6875rem;
		line-height: 1.65;
		font-family: var(--font-mono);
		font-weight: 400;
		color: #c9d1d9;
		margin: 0;
	}

	.console-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		font-size: 0.75rem;
		opacity: 0.4;
		color: inherit;
	}

	.db-pods-card {
		margin-top: 1.25rem;
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		padding: 1rem 1.125rem;
		background-color: var(--surface-bg);
	}

	.db-pods-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.625rem;
		flex-wrap: wrap;
	}

	.db-pods-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.db-pods-title {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
		margin: 0;
	}

	.db-pods-count {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: var(--surface-muted);
	}

	.db-pods-legend {
		display: flex;
		gap: 0.625rem;
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.db-pods-legend-item {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.db-pods-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 9999px;
	}

	.db-pods-dot--ready { background-color: #22c55e; }
	.db-pods-dot--other { background-color: #f59e0b; }

	.db-pods-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.db-pod-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		border: 1px solid transparent;
	}

	.db-pod-row:hover {
		background-color: color-mix(in srgb, var(--surface-border) 35%, transparent);
	}

	.db-pod-row-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.db-pod-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.db-pod-name {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--center-channel-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.db-pod-row-right {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		color: var(--surface-muted);
	}

	.db-pod-badge {
		font-size: 0.625rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
	}

	.ext-toolbar {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.ext-search {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	.ext-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		overflow: hidden;
	}

	.ext-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1rem;
	}

	.ext-row:not(:last-child) {
		border-bottom: 1px solid var(--surface-border);
	}

	.ext-main {
		flex: 1;
		min-width: 0;
	}

	.ext-name-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.ext-name {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.ext-badge {
		font-size: 0.6875rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-weight: 500;
		letter-spacing: 0.02em;
	}

	.ext-badge-on {
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}

	.ext-badge-off {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--surface-muted);
	}

	.ext-badge-preload {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.ext-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin-top: 0.125rem;
	}

	.ext-actions {
		flex-shrink: 0;
	}

	.settings-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		padding: 1rem 1.125rem;
	}

	.setting-row {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding-bottom: 1rem;
	}

	.setting-row:not(:last-child) {
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.setting-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.setting-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.setting-key {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--surface-muted);
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
	}

	.setting-control {
		display: flex;
	}

	.setting-input {
		width: 18rem;
		max-width: 100%;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		font-family: var(--font-mono);
	}

	.setting-help {
		font-size: 0.75rem;
		color: var(--surface-muted);
		line-height: 1.5;
	}

	.settings-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
		margin-top: 1rem;
	}

	.schedule-card {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		padding: 1rem 1.125rem;
	}

	.schedule-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.schedule-label {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		min-width: 8rem;
	}

	.schedule-help {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.schedule-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.375rem;
	}

	.backups-count {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		font-weight: 500;
		margin-left: 0.5rem;
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	/* Connection tab — key/value grid */
	.db-kv-grid {
		display: grid;
		grid-template-columns: 9rem 1fr;
		gap: 0.625rem 1rem;
		align-items: center;
	}

	.db-kv-label {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	.db-kv-value {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.db-kv-code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--center-channel-color);
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		background-color: var(--control-bg);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.db-connstr-card {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.75rem;
		background-color: var(--control-bg);
	}

	.db-connstr-code {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--center-channel-color);
		word-break: break-all;
		overflow-wrap: anywhere;
	}

	.db-inline-code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
		background-color: var(--control-bg);
		color: var(--center-channel-color);
	}

	/* Shared list rows (backups, extensions) */
	.db-list-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
	}

	.db-list-name {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.db-list-meta {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-top: 0.25rem;
		font-size: 0.6875rem;
		color: var(--surface-muted);
		flex-wrap: wrap;
	}

	.db-list-meta-tag {
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 600;
	}

	.db-list-error {
		margin-top: 0.375rem;
		padding: 0.375rem 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--error-text-color);
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		border-radius: 0.375rem;
		word-break: break-word;
	}

	/* Status pills */
	.db-status-pill {
		font-size: 0.625rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-weight: 500;
		letter-spacing: 0.02em;
		text-transform: capitalize;
	}

	.db-status-pill-completed {
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}

	.db-status-pill-running,
	.db-status-pill-pending {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.db-status-pill-failed {
		background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
	}

	.db-status-pill-warn {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.db-status-pill-muted {
		background-color: color-mix(in srgb, var(--surface-border) 55%, transparent);
		color: var(--surface-muted);
	}

	.db-badge-count {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		background-color: var(--control-bg);
	}

	/* Empty / info boxes */
	.db-empty-box {
		padding: 1rem 1.125rem;
		border-radius: 0.75rem;
		background-color: var(--control-bg);
		border: 1px dashed var(--surface-border);
	}

	.db-link {
		color: var(--link-color, #3b82f6);
		text-decoration: underline;
	}

	/* Settings rows */
	.db-setting-row {
		display: grid;
		grid-template-columns: 1fr 16rem;
		gap: 1rem;
		align-items: start;
		padding-bottom: 1rem;
	}

	.db-setting-row:not(:last-child) {
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.db-setting-info {
		min-width: 0;
	}

	.db-setting-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.db-setting-help {
		margin-top: 0.25rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		line-height: 1.55;
	}

	.db-setting-control {
		display: flex;
	}

	.db-setting-control > * {
		width: 100%;
	}

	@media (max-width: 640px) {
		.db-setting-row { grid-template-columns: 1fr; }
		.db-kv-grid { grid-template-columns: 1fr; }
		.db-kv-label { margin-top: 0.5rem; }
	}
</style>
