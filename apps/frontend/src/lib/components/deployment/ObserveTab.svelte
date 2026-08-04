<script lang="ts">
	import { onDestroy, untrack, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		demoHttpMetrics,
		demoOverview,
		demoErrors,
		demoKilled,
		DEMO_KILLED_LOGS
	} from '$lib/utils/observe-demo';
	import { formatRelativeTime, ansiToHtml, explainExitCode, podLabel } from '$lib/utils/format';
	import { Button, Select, SegmentedControl, Menu, MenuItem } from '$lib/components/ui';
	import DeploymentMetrics from '$lib/components/DeploymentMetrics.svelte';
	import { slide } from '$lib/utils/transitions';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import {
		Clock,
		Boxes,
		Cpu,
		MemoryStick,
		Activity,
		AlertTriangle,
		Search,
		Loader2,
		ChevronDown,
		UserPlus,
		ChevronRight,
		CheckCircle2,
		Terminal as TerminalIcon,
		Copy,
		Check,
		ArrowDown,
		PartyPopper
	} from 'lucide-svelte';

	let {
		deployment,
		active = true,
		activeTab = $bindable('metrics')
	}: {
		deployment: any;
		active?: boolean;
		activeTab?: SubTab;
	} = $props();

	type SubTab = 'metrics' | 'logs' | 'http' | 'errors' | 'killed';

	type KilledContainer = {
		entryId: string;
		pod: string;
		container: string;
		reason: string;
		exitCode: number | null;
		finishedAt: string | null;
		capturedAt: string;
	};
	type LogLevel = 'all' | 'debug' | 'info' | 'warn' | 'error';
	type ErrorTimeWindow = '15m' | '1h' | '6h' | '24h';

	type DetectedRuntime = {
		language: string;
		framework: string | null;
		version: string | null;
		confidence: 'high' | 'medium' | 'low';
		detectedFrom: string;
	};

	type ErrorAssignee = { id: string; username: string; imageUrl?: string | null };
	type ErrorDeploy = {
		commitSha: string | null;
		commitMessage: string | null;
		branch: string | null;
		triggerType: string | null;
		triggeredBy: string | null;
		at: string;
		count?: number;
	};
	type ErrorGroup = {
		fingerprint: string;
		type: string;
		message: string;
		count: number;
		status?: 'unresolved' | 'resolved' | 'ignored';
		firstSeen: string;
		lastSeen: string;
		assignee?: ErrorAssignee | null;
		githubIssueUrl?: string | null;
		stackTrace?: string | null;
		firstDeploy?: ErrorDeploy | null;
		deployCount?: number;
		deploys?: ErrorDeploy[];
		samples?: Array<{ timestamp?: string; message: string; stackTrace?: string }>;
		trend?: 'rising' | 'stable' | 'falling';
	};

	const LANGUAGE_COLORS: Record<string, string> = {
		node: '#68a063',
		python: '#3776ab',
		go: '#00add8',
		ruby: '#cc342d',
		java: '#f89820',
		dotnet: '#512bd4',
		rust: '#dea584',
		php: '#777bb4',
		elixir: '#6e4a7e'
	};

	const FRAMEWORK_NAMES: Record<string, string> = {
		nextjs: 'Next.js',
		sveltekit: 'SvelteKit',
		nuxt: 'Nuxt',
		astro: 'Astro',
		remix: 'Remix',
		express: 'Express',
		fastify: 'Fastify',
		django: 'Django',
		flask: 'Flask',
		fastapi: 'FastAPI',
		rails: 'Rails',
		gin: 'Gin',
		echo: 'Echo',
		fiber: 'Fiber',
		spring: 'Spring',
		laravel: 'Laravel',
		phoenix: 'Phoenix'
	};

	const LANGUAGE_DISPLAY: Record<string, string> = {
		node: 'Node.js',
		python: 'Python',
		go: 'Go',
		ruby: 'Ruby',
		java: 'Java',
		dotnet: '.NET',
		rust: 'Rust',
		php: 'PHP',
		elixir: 'Elixir'
	};

	const ERROR_WINDOWS: { id: ErrorTimeWindow; label: string; minutes: number }[] = [
		{ id: '15m', label: '15m', minutes: 15 },
		{ id: '1h', label: '1h', minutes: 60 },
		{ id: '6h', label: '6h', minutes: 360 },
		{ id: '24h', label: '24h', minutes: 1440 }
	];

	// Incremental log loading: start with a small tail, grow it as the user
	// scrolls up. LOG_MAX_LINES matches the backend cap and bounds search too.
	const LOG_INITIAL_LINES = 1000;
	const LOG_PAGE_SIZE = 2000;
	const LOG_MAX_LINES = 20000;

	function chooseStep(ms: number): number {
		if (ms <= 30 * 60 * 1000) return 15_000;
		return 30_000;
	}

	let logSearch = $state('');
	let logLevel = $state<LogLevel>('all');
	let logLevelSet = $state<Set<string>>(new Set());
	let showLogFilters = $state(false);
	const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'log'];
	let logSince = $state<number>(0);
	const LOG_WINDOWS = [
		{ label: 'Any time', ms: 0 },
		{ label: '5m', ms: 5 * 60_000 },
		{ label: '15m', ms: 15 * 60_000 },
		{ label: '1h', ms: 60 * 60_000 },
		{ label: '6h', ms: 6 * 60 * 60_000 },
		{ label: '24h', ms: 24 * 60 * 60_000 }
	];

	// Search grammar: bare terms must all match, -term excludes, "quoted phrase"
	// matches literally. Everything is case-insensitive.
	function parseQuery(raw: string) {
		const include: string[] = [];
		const exclude: string[] = [];
		const re = /-?"[^"]*"|-?\S+/g;
		for (const tokenRaw of raw.match(re) ?? []) {
			let t = tokenRaw;
			const neg = t.startsWith('-');
			if (neg) t = t.slice(1);
			t = t.replace(/^"|"$/g, '').toLowerCase();
			if (!t) continue;
			(neg ? exclude : include).push(t);
		}
		return { include, exclude };
	}
	let liveTail = $state(false);
	let logTail = $state(1000);
	let logsAtMax = $state(false);
	let loadingMoreLogs = $state(false);
	let lastLoadMoreAt = 0;
	let expandedLogs = $state(new Set<string>());
	let logEntries = $state<any[]>([]);
	let logsLoading = $state(false);
	let logsError = $state<string | null>(null);
	let overview = $state<any>(null);
	let overviewLoading = $state(false);
	let capabilities = $state<any>(null);
	let errorGroups = $state<ErrorGroup[]>([]);
	let errorStatusFilter = $state<'unresolved' | 'resolved' | 'ignored' | 'all'>('unresolved');
	let updatingError = $state<string | null>(null);
	let orgMembers = $state<ErrorAssignee[]>([]);
	let errorRepoUrl = $state<string | null>(null);

	const visibleErrors = $derived(
		errorStatusFilter === 'all'
			? errorGroups
			: errorGroups.filter((g) => (g.status ?? 'unresolved') === errorStatusFilter)
	);

	async function setErrorStatus(g: ErrorGroup, status: 'unresolved' | 'resolved' | 'ignored') {
		if (!deployment?.id) return;
		updatingError = g.fingerprint;
		const prev = g.status;
		g.status = status;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/errors/${encodeURIComponent(g.fingerprint)}`,
				{
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ status })
				}
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch (err) {
			g.status = prev;
			toasts.error(`Could not update error: ${(err as Error).message}`);
		} finally {
			updatingError = null;
		}
	}

	async function assignError(g: ErrorGroup, assigneeId: string | null) {
		if (!deployment?.id) return;
		updatingError = g.fingerprint;
		const prev = g.assignee;
		g.assignee = assigneeId ? (orgMembers.find((m) => m.id === assigneeId) ?? null) : null;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/errors/${encodeURIComponent(g.fingerprint)}`,
				{
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ assigneeId })
				}
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch (err) {
			g.assignee = prev;
			toasts.error(`Could not assign error: ${(err as Error).message}`);
		} finally {
			updatingError = null;
		}
	}

	let errorsLoading = $state(false);
	let errorsError = $state<string | null>(null);
	let errorWindow = $state<ErrorTimeWindow>('1h');
	let metricsWindowMs = $state(60 * 60 * 1000);
	let metricsPaused = $state(false);
	let metricsGroupBy = $state<'none' | 'pod'>('none');
	const METRIC_RANGES = [
		{ id: '5m', ms: 5 * 60 * 1000 },
		{ id: '15m', ms: 15 * 60 * 1000 },
		{ id: '30m', ms: 30 * 60 * 1000 },
		{ id: '1h', ms: 60 * 60 * 1000 },
		{ id: '6h', ms: 6 * 60 * 60 * 1000 },
		{ id: '24h', ms: 24 * 60 * 60 * 1000 },
		{ id: '7d', ms: 7 * 24 * 60 * 60 * 1000 }
	];
	let expandedErrors = $state(new Set<string>());
	let Line: any = $state(null);
	let chartReady = $state(false);
	let logsFetchSeq = 0;
	let errorsFetchSeq = 0;
	let liveTailHandle: ReturnType<typeof setInterval> | null = null;
	let logViewerEl = $state<HTMLDivElement | null>(null);
	let userScrolledUp = $state(false);
	let copiedId = $state<string | null>(null);
	let prevLogCount = 0;

	const demo = $derived($page.url.searchParams.has('demo'));
	const hasIngress = $derived(demo || (deployment?.ingresses?.length ?? 0) > 0);

	const filteredLogs = $derived.by(() => {
		let entries = logEntries;
		if (logLevelSet.size > 0) {
			entries = entries.filter((e: any) => logLevelSet.has((e.level ?? 'log').toLowerCase()));
		} else if (logLevel !== 'all') {
			entries = entries.filter((e: any) => (e.level ?? '').toLowerCase() === logLevel);
		}
		if (logSince > 0) {
			const cutoff = Date.now() - logSince;
			entries = entries.filter((e: any) => {
				if (!e.timestamp) return false;
				const t = new Date(e.timestamp).getTime();
				return Number.isFinite(t) && t >= cutoff;
			});
		}
		const q = logSearch.trim();
		if (q) {
			const { include, exclude } = parseQuery(q);
			entries = entries.filter((e: any) => {
				const hay = ((e.raw ?? e.message ?? '') as string).toLowerCase();
				return include.every((t) => hay.includes(t)) && !exclude.some((t) => hay.includes(t));
			});
		}
		return entries;
	});

	function stripLeadingTime(line: string): string {
		// The Time column already shows this, and ansiToHtml would otherwise
		// render the same stamp again as an inline pill. Mirrors ISO_TS_RE.
		return line
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/g, '')
			.replace(/^(?:\x1b\[[0-9;]*m|\s)*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\s+/, '');
	}

	function deployLabel(d: ErrorDeploy): string {
		if (d.triggerType === 'manual' || d.triggeredBy) {
			return d.triggeredBy ? `Deployed by @${d.triggeredBy}` : 'Deployed manually';
		}
		if (d.branch) return `Pushed to ${d.branch}`;
		return 'Deployed';
	}

	function fmtLogTime(ts?: string): string {
		if (!ts) return '';
		const d = new Date(ts);
		if (Number.isNaN(d.getTime())) return '';
		const p = (n: number, w = 2) => String(n).padStart(w, '0');
		return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
	}

	function toggleLogLevel(level: string) {
		const next = new Set(logLevelSet);
		if (next.has(level)) next.delete(level);
		else next.add(level);
		logLevelSet = next;
	}

	function clearLogFilters() {
		logLevelSet = new Set();
		logSearch = '';
		logSince = 0;
	}

	const RENDER_WINDOW_STEP = 1000;
	let renderWindow = $state(RENDER_WINDOW_STEP);
	const visibleLogs = $derived(
		(filteredLogs.length > renderWindow ? filteredLogs.slice(-renderWindow) : filteredLogs)
			.slice()
			.reverse()
	);
	const hiddenLogCount = $derived(filteredLogs.length - visibleLogs.length);

	function keyEntries(entries: any[]) {
		const seen = new Map<string, number>();
		for (const e of entries) {
			const base = `${e.timestamp ?? ''}|${e.raw ?? e.message ?? ''}`;
			const n = seen.get(base) ?? 0;
			seen.set(base, n + 1);
			e._key = n ? `${base}#${n}` : base;
		}
	}

	function mergeEntries(prev: any[], next: any[]): any[] {
		keyEntries(next);
		if (!prev.length) return next;
		const prevByKey = new Map(prev.map((e) => [e._key, e]));
		return next.map((n) => prevByKey.get(n._key) ?? n);
	}

	function toggleLog(key: string) {
		const next = new Set(expandedLogs);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedLogs = next;
	}

	function fullTimestamp(ts: string | number | undefined): string {
		if (!ts) return '';
		const d = new Date(ts);
		return isNaN(d.getTime()) ? String(ts) : d.toISOString();
	}

	const visibleTabs = $derived(
		(['metrics', 'logs', 'http', 'errors', 'killed'] as SubTab[]).filter(
			(t) => t !== 'http' || hasIngress
		)
	);

	$effect(() => {
		if (!visibleTabs.includes(activeTab)) activeTab = 'metrics';
	});

	let killedList = $state<KilledContainer[]>([]);
	let killedLoading = $state(false);
	let killedError = $state<string | null>(null);
	let killedFetched = $state(false);
	let expandedKilled = $state<string | null>(null);
	let killedLogs = $state<Record<string, string>>({});
	let killedLogsLoading = $state<string | null>(null);

	async function fetchKilled() {
		if (!deployment?.id) return;
		if (demo) {
			killedList = demoKilled();
			killedFetched = true;
			killedError = null;
			killedLoading = false;
			return;
		}
		killedLoading = true;
		killedError = null;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/killed-containers`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			killedList = await res.json();
			killedFetched = true;
		} catch (e) {
			killedError = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			killedLoading = false;
		}
	}

	async function toggleKilled(entryId: string) {
		if (expandedKilled === entryId) {
			expandedKilled = null;
			return;
		}
		expandedKilled = entryId;
		if (killedLogs[entryId] !== undefined || !deployment?.id) return;
		if (demo) {
			killedLogs = { ...killedLogs, [entryId]: DEMO_KILLED_LOGS[entryId] ?? '' };
			return;
		}
		killedLogsLoading = entryId;
		try {
			const res = await apiFetch(
				`/apiv1/deployments/${deployment.id}/killed-containers/${encodeURIComponent(entryId)}/logs`
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			killedLogs = { ...killedLogs, [entryId]: data.logs || '' };
		} catch {
			killedLogs = { ...killedLogs, [entryId]: '' };
		} finally {
			killedLogsLoading = null;
		}
	}

	$effect(() => {
		if (activeTab === 'killed' && !killedFetched) {
			untrack(() => {
				fetchKilled();
			});
		}
	});

	async function copyToClipboard(text: string, id: string) {
		await navigator.clipboard.writeText(text);
		copiedId = id;
		toasts.add({
			title: 'Copied',
			description: 'Copied to clipboard',
			color: 'success',
			duration: 2000
		});
		setTimeout(() => {
			if (copiedId === id) copiedId = null;
		}, 2000);
	}

	function handleLogScroll() {
		if (!logViewerEl) return;
		const { scrollTop, scrollHeight, clientHeight } = logViewerEl;
		// Newest sits at the top, so "away from live" means scrolled down and
		// older lines load as you approach the bottom.
		userScrolledUp = scrollTop > 60;

		if (scrollHeight - scrollTop - clientHeight > 80) return;
		const now = Date.now();
		if (now - lastLoadMoreAt < 400) return;
		lastLoadMoreAt = now;

		// First reveal already-loaded rows hidden by the render window, then fall
		// back to fetching earlier lines from the server.
		if (hiddenLogCount > 0) {
			renderWindow += RENDER_WINDOW_STEP;
			return;
		}

		// Scroll-to-top loads earlier logs (disabled while filtering — search/level
		// already scan the whole window server-side).
		if (logSearch.trim() || logLevel !== 'all') return;
		if (loadingMoreLogs || logsAtMax || logTail >= LOG_MAX_LINES) return;
		loadingMoreLogs = true;
		logTail = Math.min(logTail + LOG_PAGE_SIZE, LOG_MAX_LINES);
		fetchLogs({ preserveScroll: true }).finally(() => {
			loadingMoreLogs = false;
		});
	}

	function scrollToBottom() {
		if (!logViewerEl) return;
		logViewerEl.scrollTo({ top: 0, behavior: 'smooth' });
	}

	$effect(() => {
		const count = filteredLogs.length;
		if (count > prevLogCount && liveTail && logViewerEl && !userScrolledUp) {
			tick().then(() => {
				if (logViewerEl) logViewerEl.scrollTop = 0;
			});
		}
		prevLogCount = count;
	});

	if (browser) {
		Promise.all([import('chart.js'), import('svelte5-chartjs')])
			.then(([{ Chart, LinearScale, PointElement, LineElement, Filler, Decimation }, mod]) => {
				Chart.register(LinearScale, PointElement, LineElement, Filler, Decimation);
				Line = mod.Line;
				chartReady = true;
			})
			.catch(() => {});
	}

	async function fetchCapabilities() {
		if (!deployment?.id) return;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/capabilities`
			);
			if (res.ok) capabilities = await res.json();
		} catch {}
	}

	async function fetchOverview() {
		if (!deployment?.id) return;
		if (demo) {
			overview = demoOverview();
			overviewLoading = false;
			return;
		}
		overviewLoading = true;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/overview`
			);
			if (res.ok) overview = await res.json();
		} catch {
		} finally {
			overviewLoading = false;
		}
	}

	async function fetchLogs(opts?: { preserveScroll?: boolean }) {
		if (!deployment?.id) return;
		const seq = ++logsFetchSeq;
		if (!logEntries.length) logsLoading = true;
		logsError = null;
		const q = logSearch.trim();
		const filtering = q.length > 0 || logLevel !== 'all' || logLevelSet.size > 0 || logSince > 0;
		const params = new URLSearchParams();
		// When filtering, scan the whole retained window server-side so matches
		// aren't limited to the lines currently loaded in the browser. Otherwise
		// load just the current tail (grown incrementally on scroll-up).
		params.set('tailLines', String(filtering ? LOG_MAX_LINES : logTail));
		if (logLevel !== 'all') params.set('level', logLevel);
		if (q) params.set('search', q);

		// Capture scroll geometry so we can re-anchor after prepending earlier logs.
		const el = logViewerEl;
		const preserve = opts?.preserveScroll === true && !!el;
		const prevHeight = preserve && el ? el.scrollHeight : 0;
		const prevTop = preserve && el ? el.scrollTop : 0;
		const prevCount = logEntries.length;

		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/logs/structured?${params}`
			);
			if (seq !== logsFetchSeq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			const next = body?.entries ?? body?.logs ?? body ?? [];
			logEntries = mergeEntries(logEntries, next);
			// k8s caps tailLines at the retained buffer; if asking for more didn't
			// yield more entries, we've reached the start of available logs.
			if (opts?.preserveScroll && next.length <= prevCount) logsAtMax = true;
			if (preserve) {
				requestAnimationFrame(() => {
					if (!logViewerEl) return;
					const delta = logViewerEl.scrollHeight - prevHeight;
					logViewerEl.scrollTop = prevTop + delta;
				});
			}
		} catch (err) {
			if (seq !== logsFetchSeq) return;
			logsError = (err as Error).message;
		} finally {
			if (seq === logsFetchSeq) logsLoading = false;
		}
	}

	const detectedRuntime = $derived<DetectedRuntime | null>(capabilities?.runtime ?? null);

	const runtimeDisplay = $derived.by(() => {
		const rt = detectedRuntime;
		if (!rt || rt.language === 'unknown') return null;
		const name = rt.framework
			? (FRAMEWORK_NAMES[rt.framework] ?? rt.framework)
			: (LANGUAGE_DISPLAY[rt.language] ?? rt.language);
		const color = LANGUAGE_COLORS[rt.language] ?? 'var(--surface-muted)';
		return { name, color, version: rt.version };
	});

	const statOffset = $derived(runtimeDisplay ? 1 : 0);

	const errorWindowMinutes = $derived(
		ERROR_WINDOWS.find((w) => w.id === errorWindow)?.minutes ?? 60
	);

	const totalErrorCount = $derived(errorGroups.reduce((sum, g) => sum + g.count, 0));
	const uniqueErrorTypes = $derived(new Set(errorGroups.map((g) => g.type)).size);

	async function fetchErrors() {
		if (!deployment?.id) return;
		if (demo) {
			errorGroups = demoErrors(errorWindowMinutes);
			errorsError = null;
			errorsLoading = false;
			return;
		}
		const seq = ++errorsFetchSeq;
		if (!errorGroups.length) errorsLoading = true;
		errorsError = null;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/errors?window=${errorWindowMinutes}`
			);
			if (seq !== errorsFetchSeq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			errorGroups = body?.errors ?? [];
			errorRepoUrl = body?.repoUrl ?? null;
			if (Array.isArray(body?.assignable)) orgMembers = body.assignable;
		} catch (err) {
			if (seq !== errorsFetchSeq) return;
			errorsError = (err as Error).message;
		} finally {
			if (seq === errorsFetchSeq) errorsLoading = false;
		}
	}

	function toggleError(fingerprint: string) {
		const next = new Set(expandedErrors);
		if (next.has(fingerprint)) next.delete(fingerprint);
		else next.add(fingerprint);
		expandedErrors = next;
	}

	let bootstrappedId: string | null = null;
	$effect(() => {
		const id = deployment?.id;
		if (!id || !active || id === bootstrappedId) return;
		bootstrappedId = id;
		untrack(() => {
			fetchCapabilities();
			fetchOverview();
			fetchLogs();
		});
	});

	$effect(() => {
		const tab = activeTab;
		const window = errorWindow;
		if (tab !== 'errors') return;
		untrack(() => {
			fetchErrors();
		});
	});

	// Debounced server-backed search/level: refetch so filtering spans the whole
	// retained window, not just the lines already in the browser.
	$effect(() => {
		const q = logSearch;
		const lvl = logLevel;
		const id = deployment?.id;
		if (!id) return;
		const handle = setTimeout(() => {
			untrack(() => {
				logsAtMax = false;
				if (!q.trim() && lvl === 'all') logTail = LOG_INITIAL_LINES;
				fetchLogs();
			});
		}, 300);
		return () => clearTimeout(handle);
	});

	$effect(() => {
		if (!liveTail || !active) return;
		const id = deployment?.id;
		if (!id) return;
		// The SSE stream is the wake-up signal: refetch structured entries only
		// when new lines actually arrive. The 2s poll only runs while the stream
		// has not connected (older server or proxy trouble).
		let streamHealthy = false;
		let debounce: ReturnType<typeof setTimeout> | null = null;
		const es = new EventSource(
			`/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/stream?tailLines=1`
		);
		es.onopen = () => (streamHealthy = true);
		es.onmessage = (e) => {
			try {
				const data = JSON.parse(e.data);
				if (data.type === 'heartbeat' || debounce) return;
				debounce = setTimeout(() => {
					debounce = null;
					fetchLogs();
				}, 250);
			} catch {
				/* ignore malformed frames */
			}
		};
		liveTailHandle = setInterval(() => {
			if (!streamHealthy) fetchLogs();
		}, 2000);
		return () => {
			es.close();
			if (debounce) clearTimeout(debounce);
			if (liveTailHandle) {
				clearInterval(liveTailHandle);
				liveTailHandle = null;
			}
		};
	});

	onDestroy(() => {
		if (liveTailHandle) clearInterval(liveTailHandle);
	});

	function levelColor(level: string): string {
		switch ((level ?? '').toLowerCase()) {
			case 'debug':
				return 'var(--surface-muted)';
			case 'info':
				return '#3aa8ff';
			case 'warn':
			case 'warning':
				return 'var(--away-indicator)';
			case 'error':
			case 'fatal':
				return '#d04a4a';
			default:
				return 'var(--surface-muted)';
		}
	}

	function levelBg(level: string): string {
		switch ((level ?? '').toLowerCase()) {
			case 'debug':
				return 'rgba(140,140,150,0.1)';
			case 'info':
				return 'rgba(58,168,255,0.12)';
			case 'warn':
			case 'warning':
				return 'rgba(255,165,0,0.12)';
			case 'error':
			case 'fatal':
				return 'rgba(208,74,74,0.12)';
			default:
				return 'rgba(140,140,150,0.1)';
		}
	}

	function formatTick(t: number): string {
		const d = new Date(t);
		const h = String(d.getHours()).padStart(2, '0');
		const m = String(d.getMinutes()).padStart(2, '0');
		return `${h}:${m}`;
	}

	const fmtReqRate = (v: number) =>
		v >= 1000 ? `${(v / 1000).toFixed(1)}k/s` : `${v.toFixed(1)}/s`;
	const fmtPercent = (v: number) => `${v.toFixed(2)}%`;
	const fmtLatency = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`);

	const overviewStats = $derived.by(() => {
		const pods = deployment?.pods ?? [];
		const running = pods.filter((p: any) => (p.status ?? '').toLowerCase() === 'ready').length;
		const total = pods.length;
		const cpuReq = deployment?.cpuRequestMilli ?? 0;
		const memReq = deployment?.memoryRequestBytes ?? 0;
		const cpuPct = overview?.cpuPercent ?? 0;
		const memPct = overview?.memoryPercent ?? 0;
		const uptimeRaw = overview?.uptime ?? null;
		const uptime = uptimeRaw ? (Date.now() - new Date(uptimeRaw).getTime()) / 1000 : null;
		const reqRate = overview?.httpRequestRate ?? null;
		const errorRate = overview?.httpErrorRate ?? null;
		const avgLatency = overview?.httpAvgLatency ?? null;

		return {
			running,
			total,
			cpuReq,
			memReq,
			cpuPct,
			memPct,
			uptime,
			reqRate,
			errorRate,
			avgLatency
		};
	});

	const stripStats = $derived(
		[
			runtimeDisplay && {
				label: 'Runtime',
				value: runtimeDisplay.name,
				sub: runtimeDisplay.version ?? null
			},
			{ label: 'Uptime', value: formatUptime(overviewStats.uptime), sub: null },
			{
				label: 'Pods',
				value: `${overviewStats.running}/${overviewStats.total}`,
				sub: null
			},
			hasIngress && {
				label: 'Req/s',
				value: overviewStats.reqRate != null ? fmtReqRate(overviewStats.reqRate) : '–',
				sub: null
			},
			hasIngress && {
				label: 'Error rate',
				value: overviewStats.errorRate != null ? fmtPercent(overviewStats.errorRate) : '–',
				sub: null
			},
			hasIngress && {
				label: 'Avg latency',
				value: overviewStats.avgLatency != null ? fmtLatency(overviewStats.avgLatency) : '–',
				sub: null
			}
		].filter(Boolean) as { label: string; value: string; sub: string | null }[]
	);

	const TAB_LABELS: Record<SubTab, string> = {
		metrics: 'Metrics',
		logs: 'Logs',
		http: 'HTTP',
		errors: 'Errors',
		killed: 'Killed'
	};

	function highlightStack(stack: string): string {
		return stack
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(
				/^(\w+(?:Error|Exception|Fault|Failure)[^\n]*)/m,
				'<span style="color: var(--error-text-color); font-weight: 600;">$1</span>'
			)
			.replace(/^(    at .+)$/gm, '<span style="color: var(--surface-muted);">$1</span>')
			.replace(/^(Traceback .+)$/gm, '<span style="color: var(--surface-muted);">$1</span>');
	}

	function formatUptime(seconds: number | null): string {
		if (seconds == null) return '–';
		if (seconds < 60) return `${Math.floor(seconds)}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
		return `${Math.floor(seconds / 86400)}d`;
	}
</script>

<div class="observe-root">
	<div class="ov-vitals">
		<div class="ov-statrow">
			{#each stripStats as stat, i (stat.label)}
				<div class="ov-statcell" {@attach motionStagger({ index: i, from: { y: 8, opacity: 0 } })}>
					<span class="ov-statcell-label">{stat.label}</span>
					<span class="ov-statcell-value"
						>{stat.value}{#if stat.sub}<span class="ov-statcell-sub">{stat.sub}</span>{/if}</span
					>
				</div>
			{/each}
		</div>
	</div>

	<div class="ov-viewbar">
		<div class="ov-seg-scroll">
			<SegmentedControl
				label="Observability view"
				bind:value={activeTab}
				options={visibleTabs.map((tab) => ({ value: tab, label: TAB_LABELS[tab] }))}
			/>
		</div>

		<div class="ov-viewbar-controls">
			{#if activeTab === 'metrics' || (activeTab === 'http' && hasIngress)}
				{#if activeTab === 'metrics'}
					<SegmentedControl
						label="Group metrics by"
						bind:value={metricsGroupBy}
						options={[
							{ value: 'none', label: 'Total' },
							{ value: 'pod', label: 'By pod' }
						]}
					/>
				{/if}
				<Select
					value={String(metricsWindowMs)}
					class="ov-range-select"
					aria-label="Metrics time range"
					onchange={(e) => (metricsWindowMs = Number((e.currentTarget as HTMLSelectElement).value))}
				>
					{#each METRIC_RANGES as r (r.id)}
						<option value={String(r.ms)}>Last {r.id}</option>
					{/each}
				</Select>
				<Button
					size="sm"
					variant="secondary"
					onclick={() => (metricsPaused = !metricsPaused)}
					aria-label={metricsPaused ? 'Resume live metrics' : 'Pause live metrics'}
				>
					{metricsPaused ? 'Paused' : 'Live'}
				</Button>
			{:else if activeTab === 'logs'}
				<div class="observe-log-search">
					<span class="observe-log-search-icon"><Search class="h-3.5 w-3.5" /></span>
					<input
						type="text"
						class="observe-log-search-input"
						placeholder="Search logs..."
						bind:value={logSearch}
					/>
				</div>

				<Button
					size="sm"
					variant={showLogFilters ? 'primary' : 'secondary'}
					onclick={() => (showLogFilters = !showLogFilters)}
				>
					Filters{logLevelSet.size ? ` (${logLevelSet.size})` : ''}
				</Button>

				<Button
					size="sm"
					variant={liveTail ? 'primary' : 'secondary'}
					onclick={() => (liveTail = !liveTail)}
				>
					{#if liveTail}
						<span class="observe-tail-dot"></span>
					{/if}
					Live
				</Button>
			{:else if activeTab === 'errors'}
				<SegmentedControl
					label="Error status"
					bind:value={errorStatusFilter}
					options={[
						{ value: 'unresolved', label: 'Open' },
						{ value: 'resolved', label: 'Resolved' },
						{ value: 'ignored', label: 'Ignored' },
						{ value: 'all', label: 'All' }
					]}
				/>
				{#if errorsLoading}
					<Loader2 class="h-3.5 w-3.5 animate-spin text-faint" />
				{/if}
				<SegmentedControl
					label="Error time window"
					bind:value={errorWindow}
					options={ERROR_WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
				/>
			{:else if activeTab === 'killed'}
				<span class="kc-hint">Terminated in the last 24h</span>
				<Button size="sm" variant="secondary" loading={killedLoading} onclick={() => fetchKilled()}
					>Refresh</Button
				>
			{/if}
		</div>
	</div>

	<div class="observe-body">
		{#if activeTab === 'metrics'}
			<DeploymentMetrics
				kind="deployment"
				id={deployment?.id ?? null}
				active={active && activeTab === 'metrics'}
				showTitle={false}
				showHeader={false}
				bind:windowMs={metricsWindowMs}
				bind:paused={metricsPaused}
				bind:groupBy={metricsGroupBy}
			/>
		{:else if activeTab === 'logs'}
			{#if showLogFilters}
				<div class="lg-filters" transition:slide={{ duration: 150 }}>
					<div class="lg-filter-group">
						<span class="lg-filter-label">Level</span>
						{#each LOG_LEVELS as lvl (lvl)}
							<button
								type="button"
								class="lg-chip"
								class:lg-chip--on={logLevelSet.has(lvl)}
								aria-pressed={logLevelSet.has(lvl)}
								onclick={() => toggleLogLevel(lvl)}
								style={logLevelSet.has(lvl)
									? `color:${levelColor(lvl)}; background:${levelBg(lvl)};`
									: ''}
							>
								{lvl.toUpperCase()}
							</button>
						{/each}
					</div>
					<div class="lg-filter-group">
						<span class="lg-filter-label">Since</span>
						{#each LOG_WINDOWS as w (w.label)}
							<button
								type="button"
								class="lg-chip"
								class:lg-chip--time={logSince === w.ms}
								aria-pressed={logSince === w.ms}
								onclick={() => (logSince = w.ms)}
							>
								{w.label}
							</button>
						{/each}
					</div>

					{#if logLevelSet.size || logSearch || logSince}
						<button type="button" class="lg-filter-clear" onclick={clearLogFilters}>
							Clear filters
						</button>
					{/if}
				</div>
			{/if}

			<div class="observe-log-viewer" bind:this={logViewerEl} onscroll={handleLogScroll}>
				<div class="lg-head" aria-hidden="true">
					<span>Time</span>
					<span>Level</span>
					<span>Message</span>
				</div>
				{#if logsLoading && !logEntries.length}
					<div class="observe-log-skeleton">
						{#each Array(12) as _, i (i)}
							<div class="observe-skeleton-line" style="animation-delay: {i * 60}ms;">
								<div class="observe-skeleton-num"></div>
								<div class="observe-skeleton-ts"></div>
								<div class="observe-skeleton-badge"></div>
								<div class="observe-skeleton-msg" style="width: {40 + Math.random() * 45}%;"></div>
							</div>
						{/each}
					</div>
				{:else if logsError}
					<div class="observe-empty">
						<AlertTriangle class="h-5 w-5" style="color: var(--error-text-color);" />
						<span>Failed to load logs: {logsError}</span>
					</div>
				{:else if filteredLogs.length === 0}
					<div class="observe-empty">
						<div class="observe-empty-icon-ring">
							<TerminalIcon class="h-5 w-5" style="color: var(--surface-muted);" />
						</div>
						<span>No log entries{logSearch || logLevel !== 'all' ? ' matching filters' : ''}</span>
					</div>
				{:else}
					{#each visibleLogs as entry, i (entry._key)}
						{@const detail = (entry.lines?.length ?? 0) > 1 ? entry.lines.slice(1) : []}
						{@const key = entry._key}
						{@const open = expandedLogs.has(key)}
						{@const headline = ansiToHtml(
							stripLeadingTime(entry.lines?.[0] ?? entry.message ?? '')
						)}
						<div class="lg-row" class:lg-row--alt={i % 2 === 1} class:lg-row--open={open}>
							<span class="lg-time">{fmtLogTime(entry.timestamp)}</span>
							<span
								class="lg-level"
								style="color: {levelColor(entry.level)}; background: {levelBg(entry.level)};"
							>
								{(entry.level ?? 'log').toUpperCase()}
							</span>
							<div class="lg-msg-cell">
								<button
									type="button"
									class="lg-msg-btn"
									class:lg-msg-btn--expandable={detail.length > 0}
									onclick={() => detail.length > 0 && toggleLog(key)}
								>
									{#if detail.length > 0}
										<ChevronRight
											class="observe-log-caret"
											style="transform: rotate({open ? 90 : 0}deg);"
										/>
									{/if}
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									<span class="lg-msg">{@html headline}</span>
									{#if detail.length > 0 && !open}
										<span class="lg-more">+{detail.length}</span>
									{/if}
								</button>
								{#if detail.length > 0 && open}
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									<pre class="observe-log-detail">{@html ansiToHtml(detail.join('\n'), true)}</pre>
								{/if}
							</div>
						</div>
					{/each}
					{#if !logSearch.trim() && logLevel === 'all'}
						{#if loadingMoreLogs}
							<div class="observe-log-loadmore">
								<Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading earlier logs…
							</div>
						{:else if logsAtMax || logTail >= LOG_MAX_LINES}
							<div class="observe-log-loadmore observe-log-loadmore--end">
								Start of available logs
							</div>
						{:else}
							<div class="observe-log-loadmore observe-log-loadmore--hint">
								Scroll down to load earlier logs
							</div>
						{/if}
					{/if}
				{/if}
				{#if userScrolledUp && filteredLogs.length > 0}
					<button class="observe-scroll-bottom" onclick={scrollToBottom} type="button">
						<ArrowDown class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		{:else if activeTab === 'http'}
			{#if !hasIngress}
				<div class="observe-empty-state">
					<div class="observe-empty-icon-ring">
						<Activity class="h-8 w-8" style="color: var(--surface-muted);" />
					</div>
					<p class="observe-empty-title">No ingress configured</p>
					<p class="observe-empty-desc">Add a domain to see HTTP metrics</p>
				</div>
			{:else}
				<DeploymentMetrics
					kind="deployment"
					source="http"
					id={deployment?.id ?? null}
					active={active && activeTab === 'http'}
					showTitle={false}
					showHeader={false}
					bind:windowMs={metricsWindowMs}
					bind:paused={metricsPaused}
				/>
			{/if}
		{:else if activeTab === 'errors'}
			{#if errorsError}
				<div class="observe-empty">
					<AlertTriangle class="h-5 w-5" style="color: var(--error-text-color);" />
					<span>Failed to load errors: {errorsError}</span>
				</div>
			{:else if errorsLoading && !errorGroups.length}
				<div class="observe-empty">
					<Loader2 class="h-5 w-5 animate-spin" />
					<span>Loading errors...</span>
				</div>
			{:else if errorGroups.length === 0}
				<div class="observe-empty-state">
					<div class="observe-empty-icon-ring observe-empty-icon-ring--celebrate">
						<PartyPopper class="h-10 w-10" style="color: var(--online-indicator);" />
					</div>
					<p class="observe-empty-title">All clear</p>
					<p class="observe-empty-desc">
						No errors in the selected time window. Your app is running clean.
					</p>
				</div>
			{:else}
				<div class="observe-errors-summary">
					<div class="observe-errors-summary-stat">
						<span class="observe-errors-summary-value">{totalErrorCount.toLocaleString()}</span>
						<span class="observe-errors-summary-label">total errors</span>
					</div>
					<div class="observe-errors-summary-stat">
						<span class="observe-errors-summary-value">{uniqueErrorTypes}</span>
						<span class="observe-errors-summary-label">unique types</span>
					</div>
				</div>

				<div class="observe-errors-list">
					{#each visibleErrors as group, i (group.fingerprint)}
						{@const isExpanded = expandedErrors.has(group.fingerprint)}
						{@const status = group.status ?? 'unresolved'}
						<div
							class="observe-error-card"
							class:eg-card--done={status !== 'unresolved'}
							{@attach motionStagger({
								index: i,
								from: { y: 6, opacity: 0 }
							})}
						>
							<button
								class="observe-error-header"
								onclick={() => toggleError(group.fingerprint)}
								type="button"
							>
								<ChevronRight
									class="h-3.5 w-3.5 observe-error-chevron"
									style="transform: rotate({isExpanded
										? 90
										: 0}deg); transition: transform var(--dur-fast) ease; flex-shrink: 0;"
								/>
								<div class="observe-error-main">
									<div class="eg-headline">{group.message}</div>
									<div class="observe-error-titlerow">
										<span class="observe-error-type">{group.type}</span>
										{#if status !== 'unresolved'}
											<span class="eg-status eg-status--{status}">{status}</span>
										{/if}
										<span class="observe-error-fp">{group.fingerprint.slice(0, 8)}</span>
										{#if group.assignee}
											<span class="eg-chip">@{group.assignee.username}</span>
										{/if}
									</div>
									<div class="observe-error-meta">
										<Clock class="h-3 w-3" />
										Last seen {formatRelativeTime(new Date(group.lastSeen))}
										<span class="observe-error-meta-sep">&middot;</span>
										{group.deployCount ?? 0} deploy{(group.deployCount ?? 0) === 1 ? '' : 's'}
									</div>
									{#if group.firstDeploy}
										{@const d = group.firstDeploy}
										<div class="eg-origin">
											<span class="eg-origin-label">First seen after</span>
											{#if d.commitSha && errorRepoUrl}
												<a
													class="eg-sha"
													href={`${errorRepoUrl}/commit/${d.commitSha}`}
													target="_blank"
													rel="noopener noreferrer"
													onclick={(e) => e.stopPropagation()}>{d.commitSha.slice(0, 7)}</a
												>
											{:else if d.commitSha}
												<span class="eg-sha">{d.commitSha.slice(0, 7)}</span>
											{/if}
											{#if d.commitMessage}
												<span class="eg-origin-msg">{d.commitMessage}</span>
											{/if}
											<span class="eg-origin-by">{deployLabel(d)}</span>
										</div>
									{/if}
								</div>
								<div class="observe-error-stats">
									<span class="observe-error-count-num">{group.count.toLocaleString()}</span>
									<span class="observe-error-count-label"
										>{group.count === 1 ? 'event' : 'events'}</span
									>
								</div>
							</button>

							<div class="eg-actions">
								{#if status === 'unresolved'}
									<Button
										size="sm"
										variant="secondary"
										disabled={updatingError === group.fingerprint}
										onclick={() => setErrorStatus(group, 'resolved')}>Resolve</Button
									>
									<Button
										size="sm"
										variant="ghost"
										disabled={updatingError === group.fingerprint}
										onclick={() => setErrorStatus(group, 'ignored')}>Ignore</Button
									>
								{:else}
									<Button
										size="sm"
										variant="secondary"
										disabled={updatingError === group.fingerprint}
										onclick={() => setErrorStatus(group, 'unresolved')}>Reopen</Button
									>
								{/if}

								<Menu placement="bottom-start">
									{#snippet trigger(attrs, _open)}
										<button class="eg-assign" type="button" {...attrs}>
											{#if group.assignee}
												<span class="eg-avatar">
													{#if group.assignee.imageUrl}
														<img src={group.assignee.imageUrl} alt="" />
													{:else}
														{group.assignee.username.slice(0, 1).toUpperCase()}
													{/if}
												</span>
												<span>@{group.assignee.username}</span>
											{:else}
												<UserPlus class="h-3 w-3" />
												<span>Assign</span>
											{/if}
											<ChevronDown class="h-3 w-3 eg-assign-caret" />
										</button>
									{/snippet}
									<MenuItem onclick={() => assignError(group, null)}>
										<span class="eg-menu-row">Unassigned</span>
									</MenuItem>
									{#each orgMembers as m (m.id)}
										<MenuItem onclick={() => assignError(group, m.id)}>
											<span class="eg-avatar">
												{#if m.imageUrl}
													<img src={m.imageUrl} alt="" />
												{:else}
													{m.username.slice(0, 1).toUpperCase()}
												{/if}
											</span>
											<span class="eg-menu-row">@{m.username}</span>
										</MenuItem>
									{/each}
								</Menu>

								{#if group.githubIssueUrl}
									<a
										class="eg-issue-link"
										href={group.githubIssueUrl}
										target="_blank"
										rel="noopener noreferrer">GitHub issue</a
									>
								{/if}
							</div>

							{#if isExpanded}
								<div class="observe-error-detail">
									<dl class="eg-facts">
										<div class="eg-fact">
											<dt>First seen</dt>
											<dd title={fullTimestamp(group.firstSeen)}>
												{formatRelativeTime(new Date(group.firstSeen))}
											</dd>
										</div>
										<div class="eg-fact">
											<dt>Last seen</dt>
											<dd title={fullTimestamp(group.lastSeen)}>
												{formatRelativeTime(new Date(group.lastSeen))}
											</dd>
										</div>
										<div class="eg-fact">
											<dt>Events</dt>
											<dd>{group.count.toLocaleString()}</dd>
										</div>
										<div class="eg-fact">
											<dt>Assigned</dt>
											<dd>{group.assignee ? `@${group.assignee.username}` : 'Nobody'}</dd>
										</div>
									</dl>

									{#if group.deploys?.length}
										<h4 class="eg-section">Deploys affected</h4>
										<div class="eg-table" role="table">
											<div class="eg-trow eg-trow--head" role="row">
												<span role="columnheader">Commit</span>
												<span role="columnheader">Change</span>
												<span role="columnheader" class="eg-num">Events</span>
												<span role="columnheader" class="eg-num">Deployed</span>
											</div>
											{#each group.deploys as d, di (d.commitSha ?? di)}
												<div class="eg-trow" role="row">
													{#if d.commitSha && errorRepoUrl}
														<a
															class="eg-sha"
															role="cell"
															href={`${errorRepoUrl}/commit/${d.commitSha}`}
															target="_blank"
															rel="noopener noreferrer">{d.commitSha.slice(0, 7)}</a
														>
													{:else}
														<span class="eg-sha" role="cell"
															>{d.commitSha ? d.commitSha.slice(0, 7) : 'none'}</span
														>
													{/if}
													<span class="eg-deploy-msg" role="cell"
														>{d.commitMessage ?? deployLabel(d)}</span
													>
													<span class="eg-num" role="cell">{d.count}</span>
													<span class="eg-num eg-muted" role="cell"
														>{formatRelativeTime(new Date(d.at))}</span
													>
												</div>
											{/each}
										</div>
									{/if}

									{#if group.stackTrace}
										<h4 class="eg-section">Stack trace</h4>
										<div class="observe-stack-wrapper">
											<!-- eslint-disable-next-line svelte/no-at-html-tags -->
											<pre class="observe-error-stack">{@html highlightStack(
													group.stackTrace
												)}</pre>
											<button
												class="observe-stack-copy"
												onclick={() =>
													copyToClipboard(group.stackTrace ?? '', `stack-${group.fingerprint}`)}
												type="button"
											>
												{#if copiedId === `stack-${group.fingerprint}`}<Check
														class="h-3 w-3"
													/>{:else}<Copy class="h-3 w-3" />{/if}
											</button>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{:else if activeTab === 'killed'}
			{#if killedError}
				<div class="observe-empty">
					<AlertTriangle class="h-5 w-5" style="color: var(--error-text-color);" />
					<span>Failed to load killed containers: {killedError}</span>
				</div>
			{:else if killedLoading && !killedList.length}
				<div class="observe-empty">
					<Loader2 class="h-5 w-5 animate-spin" />
					<span>Loading...</span>
				</div>
			{:else if killedList.length === 0}
				<div class="observe-empty-state">
					<div class="observe-empty-icon-ring observe-empty-icon-ring--celebrate">
						<PartyPopper class="h-10 w-10" style="color: var(--online-indicator);" />
					</div>
					<p class="observe-empty-title">No recently killed containers</p>
					<p class="observe-empty-desc">
						Nothing has crashed or been OOMKilled in the last 24 hours
					</p>
				</div>
			{:else}
				<div class="observe-errors-list">
					{#each killedList as k, i (k.entryId)}
						{@const isExpanded = expandedKilled === k.entryId}
						{@const why = explainExitCode(k.exitCode, k.reason)}
						<div
							class="observe-error-card"
							{@attach motionStagger({
								index: i,
								from: { y: 6, opacity: 0 }
							})}
						>
							<button
								class="observe-error-header"
								onclick={() => toggleKilled(k.entryId)}
								type="button"
							>
								<ChevronRight
									class="h-3.5 w-3.5 observe-error-chevron"
									style="transform: rotate({isExpanded
										? 90
										: 0}deg); transition: transform var(--dur-fast) ease; flex-shrink: 0;"
								/>
								<div class="observe-error-main">
									<div class="eg-headline">{why?.short ?? k.reason}</div>
									<div class="observe-error-titlerow">
										<span class="kc-reason kc-reason--{why?.severity ?? 'error'}">{k.reason}</span>
										{#if k.exitCode != null}
											<span class="observe-error-fp">exit {k.exitCode}</span>
										{/if}
										<span class="kc-pod">{podLabel(k.pod)} / {k.container}</span>
									</div>
									{#if k.finishedAt}
										<div class="observe-error-meta">
											<Clock class="h-3 w-3" />
											{formatRelativeTime(new Date(k.finishedAt))}
											<span class="observe-error-meta-sep">&middot;</span>
											<span title={fullTimestamp(k.finishedAt)}
												>{new Date(k.finishedAt).toLocaleTimeString()}</span
											>
										</div>
									{/if}
								</div>
							</button>

							{#if isExpanded}
								<div class="observe-error-detail">
									{#if killedLogsLoading === k.entryId}
										<div class="observe-empty">
											<Loader2 class="h-4 w-4 animate-spin" />
											<span>Loading captured logs...</span>
										</div>
									{:else if killedLogs[k.entryId]}
										<div class="observe-stack-wrapper">
											<!-- eslint-disable-next-line svelte/no-at-html-tags -->
											<pre class="observe-error-stack observe-killed-logs">{@html ansiToHtml(
													killedLogs[k.entryId]
												)}</pre>
											<button
												class="observe-stack-copy"
												onclick={() =>
													copyToClipboard(killedLogs[k.entryId], `killed-${k.entryId}`)}
												type="button"
											>
												{#if copiedId === `killed-${k.entryId}`}<Check
														class="h-3 w-3"
													/>{:else}<Copy class="h-3 w-3" />{/if}
											</button>
										</div>
									{:else}
										<p class="observe-empty-desc">
											No logs were captured for this container before it died
										</p>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.observe-root {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.ov-vitals {
		padding: 0 var(--space-1);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.ov-vitals::-webkit-scrollbar {
		display: none;
	}
	.ov-statrow {
		display: flex;
		align-items: stretch;
		min-width: min-content;
	}
	.ov-statcell {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding-right: var(--space-5);
		min-width: 0;
	}
	.ov-statcell + .ov-statcell {
		padding-left: var(--space-5);
		border-left: 1px solid var(--rule);
	}
	.ov-statcell-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.ov-statcell-value {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
		color: var(--text-default);
		white-space: nowrap;
	}
	.ov-statcell-sub {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		margin-left: 0.3125rem;
	}

	.ov-viewbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.ov-viewbar-controls {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}
	.ov-viewbar-controls :global(.ov-level-select) {
		width: auto;
		flex: none;
	}
	.ov-viewbar-controls :global(.ov-level-select .ui-select) {
		width: 9.5rem;
		padding-top: 0.5rem;
		padding-bottom: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}

	.ov-seg-scroll {
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}
	.ov-seg-scroll::-webkit-scrollbar {
		display: none;
	}

	.observe-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.observe-log-search {
		position: relative;
		width: 14rem;
		flex: none;
	}

	.observe-log-search-icon {
		position: absolute;
		left: 0.625rem;
		top: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		color: var(--text-faint);
		pointer-events: none;
	}

	.observe-log-search-input {
		width: 100%;
		padding: 0.5rem 0.75rem 0.5rem 1.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background-color: var(--bg-surface);
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-family: inherit;
		outline: none;
		transition: border-color var(--dur-fast) var(--ease-out);
	}

	.observe-log-search-input:focus {
		border-color: var(--accent);
	}

	.observe-log-search-input::placeholder {
		color: var(--text-faint);
	}

	.observe-tail-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		animation: observe-pulse 1.6s ease-out infinite;
	}

	@keyframes observe-pulse {
		0% {
			box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent);
		}
		70% {
			box-shadow: 0 0 0 6px transparent;
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}

	.observe-log-viewer {
		position: relative;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		color: var(--text-default);
		min-height: 300px;
		max-height: 620px;
		overflow-y: auto;
		font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
		font-size: var(--text-caption);
		line-height: 1.65;
	}

	.observe-log-entry {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 16px;
		border-bottom: 1px solid rgba(120, 120, 128, 0.06);
		min-width: 0;
	}

	.observe-log-entry--alt {
		background-color: var(--fill-quiet);
	}

	.observe-log-entry:hover {
		background-color: var(--fill-quiet);
	}

	.observe-log-num {
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-variant-numeric: tabular-nums;
		min-width: 28px;
		text-align: right;
		flex-shrink: 0;
		user-select: none;
	}

	.observe-log-level-badge {
		display: inline-block;
		padding: 0px 4px;
		border-radius: var(--radius-xs);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.03em;
		white-space: nowrap;
		flex-shrink: 0;
		min-width: 40px;
		text-align: center;
	}

	.observe-log-msg {
		color: inherit;
		white-space: pre-wrap;
		word-break: break-all;
		min-width: 0;
	}

	.observe-log-body {
		min-width: 0;
		flex: 1;
	}

	.observe-log-headline {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding: 0;
		background: none;
		border: none;
		text-align: left;
		font: inherit;
		color: inherit;
		cursor: default;
	}

	.observe-log-headline--btn {
		cursor: pointer;
	}

	:global(.observe-log-caret) {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
		color: var(--surface-muted);
		align-self: center;
		transition: transform var(--dur-fast) ease;
	}

	.observe-log-more {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: #8b949e;
		background-color: var(--fill-quiet);
		border-radius: var(--radius-xs);
		padding: 0 4px;
		align-self: center;
	}

	.observe-log-detail {
		margin: var(--space-1) 0 var(--space-2) var(--space-5);
		padding: var(--space-2) var(--space-3);
		background-color: var(--fill-quiet);
		border: 1px solid var(--rule);
		border-radius: var(--radius-xs);
		color: var(--text-default);
		font-size: var(--text-caption);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
	}

	.observe-log-loadmore {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 8px 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		border-bottom: 1px solid var(--rule);
	}

	.observe-log-loadmore--end {
		font-style: italic;
		color: var(--text-faint);
	}

	.observe-log-loadmore--hint {
		color: var(--text-muted);
	}

	.observe-log-skeleton {
		padding: 8px 0;
	}

	.observe-skeleton-line {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 16px;
	}

	.observe-skeleton-num {
		width: 28px;
		height: 10px;
		border-radius: var(--radius-xs);
		background: rgba(120, 120, 128, 0.06);
		animation: observe-shimmer 1.4s linear infinite;
		background-size: 200% 100%;
		background-image: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
		flex-shrink: 0;
	}

	.observe-skeleton-ts {
		width: 72px;
		height: 10px;
		border-radius: var(--radius-xs);
		background: rgba(120, 120, 128, 0.06);
		animation: observe-shimmer 1.4s linear infinite;
		background-size: 200% 100%;
		background-image: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
		flex-shrink: 0;
	}

	.observe-skeleton-badge {
		width: 40px;
		height: 14px;
		border-radius: var(--radius-xs);
		background: rgba(120, 120, 128, 0.06);
		animation: observe-shimmer 1.4s linear infinite;
		background-size: 200% 100%;
		background-image: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
		flex-shrink: 0;
	}

	.observe-skeleton-msg {
		height: 10px;
		border-radius: var(--radius-xs);
		background: rgba(120, 120, 128, 0.06);
		animation: observe-shimmer 1.4s linear infinite;
		background-size: 200% 100%;
		background-image: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
	}

	.observe-skeleton-label {
		width: 80px;
		height: 12px;
		border-radius: var(--radius-xs);
		background: rgba(120, 120, 128, 0.06);
		animation: observe-shimmer 1.4s linear infinite;
		background-size: 200% 100%;
		background-image: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
	}

	.observe-scroll-bottom {
		position: sticky;
		bottom: 10px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 1px solid var(--surface-border);
		background: var(--surface-bg);
		color: var(--surface-muted);
		box-shadow: var(--elev-2);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background var(--dur-fast) ease;
		margin: 0 auto;
		z-index: 2;
	}

	.observe-scroll-bottom:hover {
		color: var(--center-channel-color);
		background: var(--center-channel-bg);
	}

	.observe-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 48px 24px;
		color: var(--surface-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}

	.observe-empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 64px 24px;
		text-align: center;
	}

	.observe-empty-icon-ring {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		border-radius: 50%;
		border: 2px dashed rgba(120, 120, 128, 0.2);
	}

	.observe-empty-icon-ring--celebrate {
		width: 68px;
		height: 68px;
		border-color: color-mix(in srgb, var(--online-indicator) 25%, transparent);
	}

	.observe-empty-title {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.observe-empty-desc {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		margin: 0;
		max-width: 360px;
	}

	.observe-chart-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.observe-chart-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4) var(--space-4) var(--space-3);
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		min-width: 0;
	}

	.observe-chart-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.observe-chart-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
	}

	.observe-chart-current {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.observe-chart-area {
		position: relative;
		height: 140px;
		min-width: 0;
	}

	.observe-chart-skeleton {
		width: 100%;
		height: 100%;
		border-radius: var(--radius-xs);
		background: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
		background-size: 200% 100%;
		animation: observe-shimmer 1.4s linear infinite;
	}

	@keyframes observe-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}

	.observe-killed-hint {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.observe-killed-logs {
		max-height: 400px;
		overflow-y: auto;
		white-space: pre-wrap;
	}

	.observe-errors-summary {
		display: flex;
		align-items: baseline;
		gap: var(--space-4);
		padding: 0 var(--space-1);
	}

	.observe-errors-summary-stat {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.observe-errors-summary-value {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text-default);
	}

	.observe-errors-summary-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.observe-errors-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.observe-error-card {
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
		transition: box-shadow var(--dur-base) var(--ease-out);
	}

	.observe-error-card:hover {
		box-shadow: var(--elev-2);
	}

	.observe-error-header {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 16px;
		width: 100%;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: var(--center-channel-color);
		font-family: inherit;
		transition: background var(--dur-fast) ease;
	}

	.observe-error-header:hover {
		background: rgba(120, 120, 128, 0.04);
	}

	:global(.observe-error-chevron) {
		margin-top: 4px;
		color: var(--surface-muted);
		flex-shrink: 0;
	}

	.observe-error-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.observe-error-titlerow {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.observe-error-type {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--center-channel-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex-shrink: 1;
	}

	.observe-error-fp {
		font-family: 'SF Mono', 'Cascadia Code', monospace;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		background: rgba(120, 120, 128, 0.1);
		padding: 1px 8px;
		border-radius: var(--radius-xs);
		flex-shrink: 0;
	}

	.observe-error-stats {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		flex-shrink: 0;
		line-height: 1.05;
	}

	.observe-error-count-num {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 700;
		color: var(--center-channel-color);
		font-variant-numeric: tabular-nums;
	}

	.observe-error-count-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
	}

	.observe-error-message-line {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-family: 'SF Mono', 'Cascadia Code', monospace;
		color: var(--surface-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.observe-error-meta {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
	}

	.observe-error-meta-sep {
		opacity: 0.5;
	}

	.observe-error-sample {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.observe-stack-wrapper {
		position: relative;
	}

	.observe-error-stack {
		font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
		font-size: var(--text-micro);
		line-height: 1.6;
		background: #1a1a1e;
		color: #c8c8cc;
		border-radius: var(--radius-sm);
		padding: 12px 16px;
		padding-right: 40px;
		margin: 0;
		overflow-x: auto;
		white-space: pre;
	}

	:global(:root:not(.dark)) .observe-error-stack {
		background: #1e1e22;
	}

	.observe-stack-copy {
		position: absolute;
		top: 8px;
		right: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--border-default);
		background-color: var(--fill-quiet);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background var(--dur-fast) ease;
	}

	.observe-stack-copy:hover {
		color: var(--text-default);
		background-color: var(--fill-soft);
	}

	.observe-error-sample-ts {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-variant-numeric: tabular-nums;
		color: var(--surface-muted);
		cursor: help;
	}

	.observe-error-samples-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
		margin: 4px 0 4px;
	}

	@media (max-width: 720px) {
		.observe-chart-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 640px) {
		.ov-viewbar-controls {
			margin-left: 0;
			width: 100%;
			flex-wrap: wrap;
		}

		.observe-log-search {
			width: 100%;
		}

		.observe-chart-grid {
			grid-template-columns: 1fr;
		}

		.observe-error-card {
			border-radius: var(--radius-md);
		}
	}

	:global(.ov-range-select) {
		width: auto;
		flex: none;
	}
	:global(.ov-range-select .ui-select) {
		height: 2.4375rem;
		padding: 0 2rem 0 0.75rem;
		border-radius: var(--radius-md);
		border-color: var(--border-default);
		background-color: var(--bg-sunken);
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 550;
	}
	:global(.ov-range-select .ui-select:hover) {
		color: var(--text-default);
		border-color: var(--rule-strong, var(--border-default));
	}
	:global(.ov-range-select .ui-select-chevron) {
		color: var(--text-muted);
	}

	.lg-filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-4);
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background-color: var(--fill-quiet);
	}
	.lg-filter-group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.lg-filter-label,
	.lg-filter-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		margin: 0;
	}
	.lg-chip {
		border: 1px solid var(--border-default);
		background: none;
		color: var(--text-muted);
		border-radius: var(--radius-pill);
		padding: 0.125rem var(--space-2);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		font-family: var(--font-mono, ui-monospace, monospace);
		cursor: pointer;
		min-height: 1.5rem;
	}
	.lg-chip--on {
		border-color: transparent;
	}
	.lg-filter-clear {
		border: none;
		background: none;
		padding: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--accent);
		cursor: pointer;
	}
	.lg-head,
	.lg-row {
		display: grid;
		grid-template-columns: 7rem 4.75rem minmax(0, 1fr);
		gap: var(--space-3);
		align-items: baseline;
	}
	.lg-head {
		position: sticky;
		top: 0;
		z-index: 1;
		background-color: var(--bg-raised);
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--rule);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-faint);
	}
	.lg-row {
		padding: 0.1875rem var(--space-3);
		border-bottom: 1px solid color-mix(in srgb, var(--rule) 55%, transparent);
	}
	.lg-row--alt {
		background-color: color-mix(in srgb, var(--fill-quiet) 55%, transparent);
	}
	.lg-row--open {
		background-color: var(--fill-quiet);
	}
	.lg-time {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.lg-level {
		justify-self: start;
		border-radius: var(--radius-xs);
		padding: 0 0.375rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-micro);
		line-height: 1.4;
		font-weight: 700;
		letter-spacing: 0.02em;
	}
	.lg-msg-cell {
		min-width: 0;
	}
	.lg-msg-btn {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1);
		width: 100%;
		border: none;
		background: none;
		padding: 0;
		text-align: left;
		color: inherit;
		cursor: default;
	}
	.lg-msg-btn--expandable {
		cursor: pointer;
	}
	.lg-msg {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-micro);
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		min-width: 0;
	}
	.lg-more {
		flex-shrink: 0;
		align-self: center;
		border-radius: var(--radius-pill);
		background-color: var(--fill-soft);
		color: var(--text-muted);
		padding: 0 0.375rem;
		font-size: var(--text-micro);
		line-height: 1.5;
	}

	.lg-chip--time {
		border-color: transparent;
		background-color: var(--fill-soft);
		color: var(--text-default);
	}

	.eg-card--done {
		opacity: 0.62;
	}
	.eg-status {
		border-radius: var(--radius-pill);
		padding: 0 0.4375rem;
		font-size: var(--text-micro);
		line-height: 1.5;
		font-weight: 600;
		text-transform: capitalize;
	}
	.eg-status--resolved {
		background-color: var(--status-success-bg);
		color: var(--status-success);
	}
	.eg-status--ignored {
		background-color: var(--fill-soft);
		color: var(--text-muted);
	}
	.eg-chip {
		border-radius: var(--radius-pill);
		background-color: var(--fill-quiet);
		color: var(--text-muted);
		padding: 0 0.375rem;
		font-size: var(--text-micro);
		line-height: 1.5;
	}
	.eg-chip--mono {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.eg-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: 0 var(--space-4) var(--space-3) 2.25rem;
	}

	.eg-headline {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.eg-origin {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		margin-top: var(--space-1);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		min-width: 0;
	}
	.eg-origin-label {
		color: var(--text-faint);
	}
	.eg-sha {
		font-family: var(--font-mono, ui-monospace, monospace);
		color: var(--accent);
		text-decoration: none;
		flex-shrink: 0;
	}
	.eg-sha:hover {
		text-decoration: underline;
	}
	.eg-origin-msg {
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		max-width: 22rem;
	}
	.eg-origin-by {
		color: var(--text-faint);
	}
	.eg-deploy-msg {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}

	.observe-error-detail {
		border-top: 1px solid var(--rule);
		padding: var(--space-4);
		background-color: var(--fill-quiet);
	}
	.eg-facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-6);
		margin: 0 0 var(--space-4);
	}
	.eg-fact {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.eg-fact dt {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.eg-fact dd {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.eg-section {
		margin: 0 0 var(--space-2);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
	}
	.eg-table {
		display: flex;
		flex-direction: column;
		margin-bottom: var(--space-4);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		background-color: var(--bg-raised);
		overflow: hidden;
	}
	.eg-trow {
		display: grid;
		grid-template-columns: 5rem minmax(0, 1fr) 4rem 6rem;
		gap: var(--space-3);
		align-items: baseline;
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.eg-trow + .eg-trow {
		border-top: 1px solid color-mix(in srgb, var(--rule) 60%, transparent);
	}
	.eg-trow--head {
		background-color: var(--fill-quiet);
		color: var(--text-faint);
		font-weight: 600;
	}
	.eg-num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.eg-muted {
		color: var(--text-faint);
	}
	.eg-deploy-msg {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}

	.eg-assign {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 1.75rem;
		padding: 0 var(--space-2) 0 var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background-color: var(--bg-raised);
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.eg-assign:hover {
		background-color: var(--fill-quiet);
		color: var(--text-default);
	}
	.eg-assign:focus-visible {
		outline: 2px solid var(--focus-ring, var(--accent));
		outline-offset: 1px;
	}
	.eg-assign-caret {
		opacity: 0.5;
	}
	.eg-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		border-radius: var(--radius-pill);
		overflow: hidden;
		background-color: var(--fill-soft);
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: 1;
		font-weight: 600;
	}
	.eg-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.eg-menu-row {
		white-space: nowrap;
	}
	.eg-issue-link {
		display: inline-flex;
		align-items: center;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
	}
	.eg-issue-link:hover {
		text-decoration: underline;
	}

	.kc-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.kc-reason {
		border-radius: var(--radius-pill);
		padding: 0 0.4375rem;
		font-size: var(--text-micro);
		line-height: 1.5;
		font-weight: 600;
	}
	.kc-reason--critical {
		background-color: var(--status-error-bg);
		color: var(--status-error);
	}
	.kc-reason--error {
		background-color: var(--status-warning-bg);
		color: var(--status-warning);
	}
	.kc-reason--warning {
		background-color: var(--status-warning-bg);
		color: var(--status-warning);
	}
	.kc-reason--info {
		background-color: var(--fill-soft);
		color: var(--text-muted);
	}
	.kc-pod {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
</style>
