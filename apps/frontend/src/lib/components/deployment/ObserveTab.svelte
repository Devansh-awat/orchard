<script lang="ts">
	import { onDestroy, untrack, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatRelativeTime, ansiToHtml } from '$lib/utils/format';
	import { Button, Select } from '$lib/components/ui';
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
		ChevronRight,
		Package,
		CheckCircle2,
		Terminal as TerminalIcon,
		Copy,
		Check,
		ArrowDown,
		PartyPopper
	} from 'lucide-svelte';

	let { deployment, active = true }: { deployment: any; active?: boolean } = $props();

	type SubTab = 'logs' | 'http' | 'traces' | 'errors' | 'killed';

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
	type TimeRange = '5m' | '15m' | '30m' | '1h';
	type ErrorTimeWindow = '15m' | '1h' | '6h' | '24h';

	type DetectedRuntime = {
		language: string;
		framework: string | null;
		version: string | null;
		confidence: 'high' | 'medium' | 'low';
		detectedFrom: string;
	};

	type ErrorGroup = {
		fingerprint: string;
		type: string;
		message: string;
		count: number;
		firstSeen: string;
		lastSeen: string;
		samples: Array<{ timestamp?: string; message: string; stackTrace?: string }>;
		trend: 'rising' | 'stable' | 'falling';
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

	const OTEL_GUIDES: Record<string, { install: string; snippet: string }> = {
		node: {
			install: 'npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node',
			snippet:
				"const { NodeSDK } = require('@opentelemetry/sdk-node');\nconst { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');\n\nconst sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] });\nsdk.start();"
		},
		python: {
			install: 'pip install opentelemetry-distro opentelemetry-exporter-otlp',
			snippet: '# auto-instrument your app:\nopentelemetry-instrument python app.py'
		},
		go: {
			install: 'go get go.opentelemetry.io/otel',
			snippet:
				'provider := sdktrace.NewTracerProvider(\n    sdktrace.WithBatcher(exporter),\n)\notel.SetTracerProvider(provider)'
		},
		ruby: {
			install: 'gem install opentelemetry-sdk opentelemetry-instrumentation-all',
			snippet: "require 'opentelemetry/sdk'\nOpenTelemetry::SDK.configure do |c|\n  c.use_all\nend"
		},
		java: {
			install: "implementation 'io.opentelemetry:opentelemetry-sdk'",
			snippet:
				'SdkTracerProvider tracerProvider = SdkTracerProvider.builder()\n    .addSpanProcessor(BatchSpanProcessor.builder(exporter).build())\n    .build();'
		},
		dotnet: {
			install: 'dotnet add package OpenTelemetry.Extensions.Hosting',
			snippet:
				'builder.Services.AddOpenTelemetry()\n    .WithTracing(b => b.AddAspNetCoreInstrumentation());'
		}
	};

	const ERROR_WINDOWS: { id: ErrorTimeWindow; label: string; minutes: number }[] = [
		{ id: '15m', label: '15m', minutes: 15 },
		{ id: '1h', label: '1h', minutes: 60 },
		{ id: '6h', label: '6h', minutes: 360 },
		{ id: '24h', label: '24h', minutes: 1440 }
	];

	const TIME_RANGES: { id: TimeRange; label: string; ms: number }[] = [
		{ id: '5m', label: '5m', ms: 5 * 60 * 1000 },
		{ id: '15m', label: '15m', ms: 15 * 60 * 1000 },
		{ id: '30m', label: '30m', ms: 30 * 60 * 1000 },
		{ id: '1h', label: '1h', ms: 60 * 60 * 1000 }
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

	let activeTab = $state<SubTab>('logs');
	let timeRange = $state<TimeRange>('1h');
	let logSearch = $state('');
	let logLevel = $state<LogLevel>('all');
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
	let httpMetrics = $state<any>(null);
	let httpLoading = $state(false);
	let httpError = $state<string | null>(null);
	let errorGroups = $state<ErrorGroup[]>([]);
	let errorsLoading = $state(false);
	let errorsError = $state<string | null>(null);
	let errorWindow = $state<ErrorTimeWindow>('1h');
	let expandedErrors = $state(new Set<string>());
	let tracesOtherExpanded = $state(false);
	let Line: any = $state(null);
	let chartReady = $state(false);
	let logsFetchSeq = 0;
	let httpFetchSeq = 0;
	let errorsFetchSeq = 0;
	let liveTailHandle: ReturnType<typeof setInterval> | null = null;
	let logViewerEl = $state<HTMLDivElement | null>(null);
	let userScrolledUp = $state(false);
	let copiedId = $state<string | null>(null);
	let prevLogCount = 0;

	const hasIngress = $derived((deployment?.ingresses?.length ?? 0) > 0);
	const timeRangeMs = $derived(TIME_RANGES.find((r) => r.id === timeRange)?.ms ?? 60 * 60 * 1000);

	const filteredLogs = $derived.by(() => {
		let entries = logEntries;
		if (logLevel !== 'all') {
			entries = entries.filter((e: any) => (e.level ?? '').toLowerCase() === logLevel);
		}
		if (logSearch.trim()) {
			const q = logSearch.toLowerCase();
			entries = entries.filter((e: any) =>
				((e.raw ?? e.message ?? '') as string).toLowerCase().includes(q)
			);
		}
		return entries;
	});

	const RENDER_WINDOW_STEP = 1000;
	let renderWindow = $state(RENDER_WINDOW_STEP);
	const visibleLogs = $derived(
		filteredLogs.length > renderWindow ? filteredLogs.slice(-renderWindow) : filteredLogs
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
		(['logs', 'http', 'traces', 'errors', 'killed'] as SubTab[]).filter(
			(t) => t !== 'http' || hasIngress
		)
	);
	const activeTabIndex = $derived(visibleTabs.indexOf(activeTab));

	let killedList = $state<KilledContainer[]>([]);
	let killedLoading = $state(false);
	let killedError = $state<string | null>(null);
	let killedFetched = $state(false);
	let expandedKilled = $state<string | null>(null);
	let killedLogs = $state<Record<string, string>>({});
	let killedLogsLoading = $state<string | null>(null);

	async function fetchKilled() {
		if (!deployment?.id) return;
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
		userScrolledUp = scrollHeight - scrollTop - clientHeight > 60;

		if (scrollTop > 80) return;
		const now = Date.now();
		if (now - lastLoadMoreAt < 400) return;
		lastLoadMoreAt = now;

		// First reveal already-loaded rows hidden by the render window, then fall
		// back to fetching earlier lines from the server.
		if (hiddenLogCount > 0) {
			const el = logViewerEl;
			const prevHeight = el.scrollHeight;
			const prevTop = el.scrollTop;
			renderWindow += RENDER_WINDOW_STEP;
			tick().then(() => {
				if (!logViewerEl) return;
				logViewerEl.scrollTop = prevTop + (logViewerEl.scrollHeight - prevHeight);
			});
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
		logViewerEl.scrollTo({ top: logViewerEl.scrollHeight, behavior: 'smooth' });
	}

	$effect(() => {
		const count = filteredLogs.length;
		if (count > prevLogCount && liveTail && logViewerEl && !userScrolledUp) {
			tick().then(() => {
				if (logViewerEl) logViewerEl.scrollTop = logViewerEl.scrollHeight;
			});
		}
		prevLogCount = count;
	});

	function latestValue(series: any[]): number | null {
		if (!series?.length) return null;
		for (let i = series.length - 1; i >= 0; i--) {
			if (series[i]?.y != null) return series[i].y;
		}
		return null;
	}

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
		const filtering = q.length > 0 || logLevel !== 'all';
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

	async function fetchHttpMetrics() {
		if (!deployment?.id || !hasIngress) return;
		const seq = ++httpFetchSeq;
		httpLoading = true;
		httpError = null;
		const now = Date.now();
		const start = now - timeRangeMs;
		const step = chooseStep(timeRangeMs);
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/http-metrics?start=${start}&end=${now}&step=${step}`
			);
			if (seq !== httpFetchSeq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			httpMetrics = await res.json();
		} catch (err) {
			if (seq !== httpFetchSeq) return;
			httpError = (err as Error).message;
		} finally {
			if (seq === httpFetchSeq) httpLoading = false;
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

	const runtimeGuide = $derived.by(() => {
		const rt = detectedRuntime;
		if (!rt || rt.language === 'unknown') return null;
		return OTEL_GUIDES[rt.language] ?? null;
	});

	const runtimeGuideLang = $derived(
		detectedRuntime
			? (LANGUAGE_DISPLAY[detectedRuntime.language] ?? detectedRuntime.language)
			: null
	);

	const otherSdks = $derived.by(() => {
		const rt = detectedRuntime;
		if (!rt || rt.language === 'unknown') return SDK_LIST;
		return SDK_LIST.filter((s) => {
			if (rt.language === 'node' && s.name === 'Node.js') return false;
			if (rt.language === 'python' && s.name === 'Python') return false;
			if (rt.language === 'go' && s.name === 'Go') return false;
			if (rt.language === 'java' && s.name === 'Java') return false;
			if (rt.language === 'ruby' && s.name === 'Ruby') return false;
			if (rt.language === 'dotnet' && s.name === '.NET') return false;
			return true;
		});
	});

	const errorWindowMinutes = $derived(
		ERROR_WINDOWS.find((w) => w.id === errorWindow)?.minutes ?? 60
	);

	const totalErrorCount = $derived(errorGroups.reduce((sum, g) => sum + g.count, 0));
	const uniqueErrorTypes = $derived(new Set(errorGroups.map((g) => g.type)).size);

	async function fetchErrors() {
		if (!deployment?.id) return;
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
		const range = timeRange;
		if (tab !== 'http' || !hasIngress) return;
		untrack(() => {
			fetchHttpMetrics();
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
		liveTailHandle = setInterval(() => {
			fetchLogs();
		}, 2000);
		return () => {
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

	function makeChartData(series: any[], color: string) {
		return {
			datasets: [
				{
					data: series ?? [],
					borderColor: color,
					backgroundColor: color + '18',
					borderWidth: 2,
					pointRadius: 0,
					pointHoverRadius: 0,
					fill: true,
					tension: 0.25,
					spanGaps: true,
					borderCapStyle: 'round' as const,
					borderJoinStyle: 'round' as const
				}
			]
		};
	}

	function makeChartOptions(formatter: (v: number) => string) {
		const now = Date.now();
		return {
			responsive: true,
			maintainAspectRatio: false,
			animation: false as const,
			parsing: false as const,
			normalized: true,
			events: [] as any,
			plugins: {
				legend: { display: false },
				tooltip: { enabled: false },
				decimation: { enabled: true, algorithm: 'lttb' as const, samples: 200 }
			},
			scales: {
				x: {
					type: 'linear' as const,
					min: now - timeRangeMs,
					max: now,
					ticks: {
						color: 'rgba(140,140,150,0.85)',
						maxRotation: 0,
						autoSkip: true,
						maxTicksLimit: 6,
						callback: (v: any) => formatTick(v as number)
					},
					grid: { color: 'rgba(120,120,128,0.08)' }
				},
				y: {
					beginAtZero: true,
					ticks: {
						color: 'rgba(140,140,150,0.85)',
						maxTicksLimit: 4,
						callback: (v: any) => formatter(v as number)
					},
					grid: { color: 'rgba(120,120,128,0.08)' }
				}
			}
		};
	}

	const fmtReqRate = (v: number) =>
		v >= 1000 ? `${(v / 1000).toFixed(1)}k/s` : `${v.toFixed(1)}/s`;
	const fmtPercent = (v: number) => `${v.toFixed(2)}%`;
	const fmtLatency = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`);

	const SDK_LIST = [
		{ name: 'Node.js', pkg: '@opentelemetry/sdk-node', cmd: 'npm install @opentelemetry/sdk-node' },
		{
			name: 'Python',
			pkg: 'opentelemetry-sdk',
			cmd: 'pip install opentelemetry-sdk opentelemetry-exporter-otlp'
		},
		{
			name: 'Go',
			pkg: 'go.opentelemetry.io/otel',
			cmd: 'go get go.opentelemetry.io/otel'
		},
		{
			name: 'Java',
			pkg: 'io.opentelemetry:opentelemetry-sdk',
			cmd: 'implementation "io.opentelemetry:opentelemetry-sdk:1.+"'
		},
		{
			name: 'Ruby',
			pkg: 'opentelemetry-sdk',
			cmd: 'gem install opentelemetry-sdk'
		},
		{
			name: '.NET',
			pkg: 'OpenTelemetry',
			cmd: 'dotnet add package OpenTelemetry'
		}
	];

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

	function highlightCode(code: string): string {
		return code
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/(\/\/.+$|#.+$)/gm, '<span style="color: #6a9955;">$1</span>')
			.replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, '<span style="color: #ce9178;">$1</span>')
			.replace(
				/\b(const|let|var|require|import|from|new|function|def|class|module|do|end|package|go|get)\b/g,
				'<span style="color: #c586c0;">$1</span>'
			)
			.replace(/\b(true|false|nil|null|undefined)\b/g, '<span style="color: #569cd6;">$1</span>');
	}

	function formatUptime(seconds: number | null): string {
		if (seconds == null) return '--';
		if (seconds < 60) return `${Math.floor(seconds)}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
		return `${Math.floor(seconds / 86400)}d`;
	}
</script>

<div class="observe-root">
	<div class="observe-strip">
		{#if runtimeDisplay}
			<div
				class="observe-stat observe-stat--runtime"
				{@attach springHover()}
				{@attach motionStagger({ index: 0, stride: 0.04, from: { y: 8, opacity: 0, scale: 0.98 } })}
			>
				<div class="observe-stat-content">
					<span class="observe-stat-label">Runtime</span>
					<span class="observe-stat-value">{runtimeDisplay.name}</span>
					{#if runtimeDisplay.version}
						<span class="observe-stat-sub">{runtimeDisplay.version}</span>
					{/if}
				</div>
			</div>
		{/if}
		{#each [{ icon: Clock, label: 'Uptime', value: formatUptime(overviewStats.uptime), show: true }, { icon: Boxes, label: 'Pods', value: `${overviewStats.running}/${overviewStats.total}`, show: true }, { icon: Cpu, label: 'CPU', value: overviewStats.cpuPct != null ? `${overviewStats.cpuPct.toFixed(1)}%` : '--', show: true }, { icon: MemoryStick, label: 'Memory', value: overviewStats.memPct != null ? `${overviewStats.memPct.toFixed(1)}%` : '--', show: true }, { icon: Activity, label: 'Req/s', value: overviewStats.reqRate != null ? fmtReqRate(overviewStats.reqRate) : '--', show: hasIngress }, { icon: AlertTriangle, label: 'Error rate', value: overviewStats.errorRate != null ? fmtPercent(overviewStats.errorRate) : '--', show: hasIngress }, { icon: Clock, label: 'Avg latency', value: overviewStats.avgLatency != null ? fmtLatency(overviewStats.avgLatency) : '--', show: hasIngress }].filter((s) => s.show) as stat, i (stat.label)}
			{@const Icon = stat.icon}
			<div
				class="observe-stat"
				{@attach springHover()}
				{@attach motionStagger({
					index: i + statOffset,
					stride: 0.04,
					from: { y: 8, opacity: 0, scale: 0.98 }
				})}
			>
				<div class="observe-stat-icon">
					<Icon class="h-3.5 w-3.5" />
				</div>
				<div class="observe-stat-content">
					<span class="observe-stat-label">{stat.label}</span>
					<span class="observe-stat-value">{stat.value}</span>
				</div>
			</div>
		{/each}
	</div>

	<div class="observe-tabs">
		<div class="observe-tabs-track">
			<div
				class="observe-tab-indicator"
				style="transform: translateX({activeTabIndex *
					100}%); width: calc(100% / {visibleTabs.length});"
			></div>
			{#each visibleTabs as tab (tab)}
				<button
					class="observe-tab"
					class:observe-tab--active={activeTab === tab}
					onclick={() => (activeTab = tab)}
					type="button"
				>
					{tab === 'logs'
						? 'Logs'
						: tab === 'http'
							? 'HTTP'
							: tab === 'traces'
								? 'Traces'
								: tab === 'errors'
									? 'Errors'
									: 'Killed'}
				</button>
			{/each}
		</div>
	</div>

	<div class="observe-body">
		{#if activeTab === 'logs'}
			<div class="observe-log-toolbar">
				<div class="observe-log-search">
					<span class="observe-log-search-icon"><Search class="h-3.5 w-3.5" /></span>
					<input
						type="text"
						class="observe-log-search-input"
						placeholder="Search logs..."
						bind:value={logSearch}
					/>
				</div>

				<Select bind:value={logLevel} aria-label="Log level">
					<option value="all">All levels</option>
					<option value="debug">Debug</option>
					<option value="info">Info</option>
					<option value="warn">Warn</option>
					<option value="error">Error</option>
				</Select>

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
			</div>

			<div class="observe-log-viewer" bind:this={logViewerEl} onscroll={handleLogScroll}>
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
								Scroll up to load earlier logs
							</div>
						{/if}
					{/if}
					{#each visibleLogs as entry, i (entry._key)}
						{@const detail = (entry.lines?.length ?? 0) > 1 ? entry.lines.slice(1) : []}
						{@const key = entry._key}
						{@const open = expandedLogs.has(key)}
						{@const headline = ansiToHtml(entry.lines?.[0] ?? entry.message ?? '')}
						<div
							class="observe-log-entry"
							class:observe-log-entry--alt={i % 2 === 1}
							class:observe-log-entry--group={detail.length > 0}
						>
							<span class="observe-log-num">{hiddenLogCount + i + 1}</span>
							<span
								class="observe-log-level-badge"
								style="color: {levelColor(entry.level)}; background: {levelBg(entry.level)};"
							>
								{(entry.level ?? 'log').toUpperCase()}
							</span>
							<div class="observe-log-body">
								<button
									type="button"
									class="observe-log-headline"
									class:observe-log-headline--btn={detail.length > 0}
									onclick={() => detail.length > 0 && toggleLog(key)}
								>
									{#if detail.length > 0}
										<ChevronRight
											class="observe-log-caret"
											style="transform: rotate({open ? 90 : 0}deg);"
										/>
									{/if}
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									<span class="observe-log-msg">{@html headline}</span>
									{#if detail.length > 0 && !open}
										<span class="observe-log-more">+{detail.length}</span>
									{/if}
								</button>
								{#if detail.length > 0 && open}
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									<pre class="observe-log-detail">{@html ansiToHtml(detail.join('\n'))}</pre>
								{/if}
							</div>
						</div>
					{/each}
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
				<div class="observe-http-toolbar">
					<div class="observe-rangepick">
						{#each TIME_RANGES as r (r.id)}
							<button
								class="observe-rangebtn"
								class:active={timeRange === r.id}
								onclick={() => (timeRange = r.id)}
								type="button">{r.label}</button
							>
						{/each}
					</div>
					{#if httpLoading}
						<Loader2 class="h-3.5 w-3.5 animate-spin" style="color: var(--surface-muted);" />
					{/if}
				</div>

				{#if httpError}
					<div class="observe-empty">
						<AlertTriangle class="h-5 w-5" style="color: var(--error-text-color);" />
						<span>Failed to load HTTP metrics: {httpError}</span>
					</div>
				{:else if httpLoading && !httpMetrics}
					<div class="observe-chart-grid">
						{#each Array(4) as _, i (i)}
							<div
								class="observe-chart-card"
								{@attach motionStagger({
									index: i,
									stride: 0.05,
									from: { y: 10, opacity: 0, scale: 0.98 }
								})}
							>
								<div class="observe-chart-header">
									<div class="observe-skeleton-label"></div>
								</div>
								<div class="observe-chart-area">
									<div class="observe-chart-skeleton"></div>
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="observe-chart-grid">
						{#each [{ label: 'Request rate', series: httpMetrics?.requestRate ?? [], color: '#7c5cff', formatter: fmtReqRate }, { label: 'Error rate', series: httpMetrics?.errorRate ?? [], color: '#d04a4a', formatter: fmtPercent }, { label: 'Avg latency', series: httpMetrics?.latencyAvg ?? [], color: '#22c0a8', formatter: fmtLatency }, { label: 'Max latency', series: httpMetrics?.latencyMax ?? [], color: '#ff7e6b', formatter: fmtLatency }] as chart, i (chart.label)}
							{@const latest = latestValue(chart.series)}
							<div
								class="observe-chart-card"
								{@attach motionStagger({
									index: i,
									stride: 0.05,
									from: { y: 10, opacity: 0, scale: 0.98 }
								})}
							>
								<div class="observe-chart-header">
									<span class="observe-chart-label">{chart.label}</span>
									{#if latest != null}
										<span class="observe-chart-current" style="color: {chart.color};"
											>{chart.formatter(latest)}</span
										>
									{/if}
								</div>
								<div class="observe-chart-area">
									{#if chartReady && Line}
										<svelte:component
											this={Line}
											data={makeChartData(chart.series, chart.color)}
											options={makeChartOptions(chart.formatter)}
										/>
									{:else}
										<div class="observe-chart-skeleton"></div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		{:else if activeTab === 'traces'}
			<div class="observe-traces-cta">
				<div class="observe-traces-header">
					<Package class="h-6 w-6" style="color: var(--button-bg);" />
					<div>
						<p class="observe-traces-title">Traces require OpenTelemetry instrumentation</p>
						<p class="observe-traces-desc">
							Add the OpenTelemetry SDK to your app to collect distributed traces. Traces will
							appear here automatically once instrumented.
						</p>
					</div>
				</div>

				{#if runtimeGuide && runtimeGuideLang}
					<div
						class="observe-guide-card"
						{@attach motionStagger({
							index: 0,
							stride: 0.04,
							from: { y: 6, opacity: 0, scale: 0.98 }
						})}
					>
						<div class="observe-guide-header">
							{#if detectedRuntime}
								<span
									class="observe-guide-dot"
									style="background: {LANGUAGE_COLORS[detectedRuntime.language] ??
										'var(--surface-muted)'};"
								></span>
							{/if}
							<span class="observe-guide-lang">Setup for {runtimeGuideLang}</span>
						</div>
						<div class="observe-cmd-row">
							<code class="observe-sdk-cmd">{runtimeGuide.install}</code>
							<Button
								size="sm"
								variant="secondary"
								aria-label="Copy install command"
								onclick={() => copyToClipboard(runtimeGuide.install, 'guide-install')}
							>
								{#if copiedId === 'guide-install'}<Check class="h-3 w-3" />{:else}<Copy
										class="h-3 w-3"
									/>{/if}
							</Button>
						</div>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<pre class="observe-guide-snippet">{@html highlightCode(runtimeGuide.snippet)}</pre>
					</div>

					{#if otherSdks.length > 0}
						<button
							class="observe-other-toggle"
							onclick={() => (tracesOtherExpanded = !tracesOtherExpanded)}
							type="button"
						>
							<ChevronRight
								class="h-3.5 w-3.5 observe-other-chevron"
								style="transform: rotate({tracesOtherExpanded
									? 90
									: 0}deg); transition: transform 150ms ease;"
							/>
							Other SDKs
						</button>
						{#if tracesOtherExpanded}
							<div class="observe-sdk-grid">
								{#each otherSdks as sdk, i (sdk.name)}
									<div
										class="observe-sdk-card"
										{@attach springHover()}
										{@attach motionStagger({
											index: i,
											stride: 0.04,
											from: { y: 6, opacity: 0, scale: 0.98 }
										})}
									>
										<div class="observe-sdk-top">
											<span class="observe-sdk-name">{sdk.name}</span>
										</div>
										<div class="observe-cmd-row">
											<code class="observe-sdk-cmd">{sdk.cmd}</code>
											<Button
												size="sm"
												variant="secondary"
												aria-label="Copy install command"
												onclick={() => copyToClipboard(sdk.cmd, `sdk-${sdk.name}`)}
											>
												{#if copiedId === `sdk-${sdk.name}`}<Check class="h-3 w-3" />{:else}<Copy
														class="h-3 w-3"
													/>{/if}
											</Button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
				{:else}
					<div class="observe-sdk-grid">
						{#each SDK_LIST as sdk, i (sdk.name)}
							<div
								class="observe-sdk-card"
								{@attach springHover()}
								{@attach motionStagger({
									index: i,
									stride: 0.04,
									from: { y: 6, opacity: 0, scale: 0.98 }
								})}
							>
								<div class="observe-sdk-top">
									<span class="observe-sdk-name">{sdk.name}</span>
								</div>
								<div class="observe-cmd-row">
									<code class="observe-sdk-cmd">{sdk.cmd}</code>
									<Button
										size="sm"
										variant="secondary"
										aria-label="Copy install command"
										onclick={() => copyToClipboard(sdk.cmd, `sdk-${sdk.name}`)}
									>
										{#if copiedId === `sdk-${sdk.name}`}<Check class="h-3 w-3" />{:else}<Copy
												class="h-3 w-3"
											/>{/if}
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{:else if activeTab === 'errors'}
			<div class="observe-errors-toolbar">
				<div class="observe-rangepick">
					{#each ERROR_WINDOWS as w (w.id)}
						<button
							class="observe-rangebtn"
							class:active={errorWindow === w.id}
							onclick={() => (errorWindow = w.id)}
							type="button">{w.label}</button
						>
					{/each}
				</div>
				{#if errorsLoading}
					<Loader2 class="h-3.5 w-3.5 animate-spin" style="color: var(--surface-muted);" />
				{/if}
			</div>

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
					{#each errorGroups as group, i (group.fingerprint)}
						{@const isExpanded = expandedErrors.has(group.fingerprint)}
						<div
							class="observe-error-card"
							{@attach motionStagger({
								index: i,
								stride: 0.03,
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
										: 0}deg); transition: transform 150ms ease; flex-shrink: 0;"
								/>
								<div class="observe-error-main">
									<div class="observe-error-titlerow">
										<span class="observe-error-type">{group.type}</span>
										<span class="observe-error-fp">{group.fingerprint.slice(0, 8)}</span>
									</div>
									<div class="observe-error-message-line">{group.message}</div>
									<div class="observe-error-meta">
										<Clock class="h-3 w-3" />
										{formatRelativeTime(new Date(group.lastSeen))}
										<span class="observe-error-meta-sep">&middot;</span>
										first seen {formatRelativeTime(new Date(group.firstSeen))}
									</div>
								</div>
								<div class="observe-error-stats">
									<span class="observe-error-count-num">{group.count.toLocaleString()}</span>
									<span class="observe-error-count-label"
										>{group.count === 1 ? 'event' : 'events'}</span
									>
								</div>
							</button>

							{#if isExpanded}
								<div class="observe-error-detail">
									<p class="observe-error-full-msg">{group.message}</p>

									{#if group.samples.length > 0}
										<div class="observe-error-samples-label">
											Recent occurrences ({group.samples.length})
										</div>
										{#each group.samples as sample, si (si)}
											<div class="observe-error-sample">
												{#if sample.timestamp}
													<div
														class="observe-error-sample-ts"
														title={fullTimestamp(sample.timestamp)}
													>
														<Clock class="h-3 w-3" />
														{formatRelativeTime(new Date(sample.timestamp))}
													</div>
												{/if}
												{#if sample.stackTrace}
													<div class="observe-stack-wrapper">
														<!-- eslint-disable-next-line svelte/no-at-html-tags -->
														<pre class="observe-error-stack">{@html highlightStack(
																sample.stackTrace
															)}</pre>
														<button
															class="observe-stack-copy"
															onclick={() =>
																copyToClipboard(
																	sample.stackTrace ?? '',
																	`stack-${group.fingerprint}-${si}`
																)}
															type="button"
														>
															{#if copiedId === `stack-${group.fingerprint}-${si}`}<Check
																	class="h-3 w-3"
																/>{:else}<Copy class="h-3 w-3" />{/if}
														</button>
													</div>
												{/if}
											</div>
										{/each}
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{:else if activeTab === 'killed'}
			<div class="observe-errors-toolbar">
				<span class="observe-killed-hint">
					Containers terminated in the last 24h, with the logs they printed before dying
				</span>
				<Button size="sm" loading={killedLoading} onclick={() => fetchKilled()}>Refresh</Button>
			</div>

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
						<div
							class="observe-error-card"
							{@attach motionStagger({
								index: i,
								stride: 0.03,
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
										: 0}deg); transition: transform 150ms ease; flex-shrink: 0;"
								/>
								<div class="observe-error-main">
									<div class="observe-error-titlerow">
										<span class="observe-error-type">{k.reason}</span>
										{#if k.exitCode != null}
											<span class="observe-error-fp">exit {k.exitCode}</span>
										{/if}
									</div>
									<div class="observe-error-message-line">{k.pod} / {k.container}</div>
									{#if k.finishedAt}
										<div class="observe-error-meta">
											<Clock class="h-3 w-3" />
											{formatRelativeTime(new Date(k.finishedAt))}
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
		gap: 16px;
	}

	.observe-strip {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.observe-stat {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-radius: 0.875rem;
		background: var(--surface-bg);
		border: 1px solid var(--surface-border);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		min-width: 120px;
		flex: 1;
		transition: box-shadow 150ms ease;
	}

	.observe-stat:hover {
		box-shadow:
			0 2px 8px rgb(0 0 0 / 0.06),
			0 1px 3px rgb(0 0 0 / 0.04);
	}

	.observe-stat--runtime {
		padding-left: 12px;
	}

	.observe-stat-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		background: rgba(120, 120, 128, 0.08);
		color: var(--surface-muted);
		flex-shrink: 0;
	}

	.observe-stat-content {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.observe-stat-label {
		font-size: 0.68rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
	}

	.observe-stat-value {
		font-size: 1.05rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--center-channel-color);
		letter-spacing: -0.01em;
	}

	.observe-stat-sub {
		font-size: 0.65rem;
		color: var(--surface-muted);
		font-weight: 400;
	}

	.observe-tabs {
		padding: 2px;
		border-radius: 10px;
		background: rgba(120, 120, 128, 0.08);
		width: fit-content;
	}

	.observe-tabs-track {
		position: relative;
		display: flex;
		gap: 2px;
	}

	.observe-tab-indicator {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		border-radius: 8px;
		background: var(--surface-bg);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
		transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
		pointer-events: none;
		z-index: 0;
	}

	:global(:root.dark) .observe-tab-indicator {
		background: rgba(255, 255, 255, 0.08);
	}

	.observe-tab {
		position: relative;
		z-index: 1;
		padding: 6px 16px;
		font-size: 0.8rem;
		font-weight: 500;
		border: 0;
		background: transparent;
		color: var(--surface-muted);
		border-radius: 8px;
		cursor: pointer;
		transition: color 80ms ease;
	}

	.observe-tab:hover {
		color: var(--center-channel-color);
	}

	.observe-tab--active {
		color: var(--center-channel-color);
	}

	.observe-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.observe-log-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		padding-bottom: 10px;
		border-bottom: 1px solid var(--surface-border);
	}

	.observe-log-search {
		position: relative;
		flex: 1;
		min-width: 180px;
		max-width: 320px;
	}

	.observe-log-search-icon {
		position: absolute;
		left: 10px;
		top: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		color: var(--surface-muted);
		pointer-events: none;
	}

	.observe-log-search-input {
		width: 100%;
		padding: 6px 10px 6px 30px;
		border-radius: 8px;
		border: 1px solid var(--surface-border);
		background: var(--surface-bg);
		color: var(--center-channel-color);
		font-size: 0.8rem;
		font-family: inherit;
		outline: none;
		transition: border-color 100ms ease;
	}

	.observe-log-search-input:focus {
		border-color: var(--button-bg);
	}

	.observe-log-search-input::placeholder {
		color: var(--surface-muted);
	}

	.observe-rangepick {
		display: inline-flex;
		padding: 2px;
		gap: 2px;
		border-radius: 8px;
		background: rgba(120, 120, 128, 0.08);
	}

	.observe-rangebtn {
		padding: 4px 10px;
		font-size: 0.78rem;
		font-weight: 500;
		border: 0;
		background: transparent;
		color: var(--surface-muted);
		border-radius: 6px;
		cursor: pointer;
		transition:
			background 80ms ease,
			color 80ms ease;
	}

	.observe-rangebtn:hover {
		color: var(--center-channel-color);
	}

	.observe-rangebtn.active {
		background: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}

	:global(:root.dark) .observe-rangebtn.active {
		background: rgba(255, 255, 255, 0.08);
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
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.875rem;
		background: #0d1117;
		color: #c9d1d9;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.18),
			inset 0 0 0 1px rgba(255, 255, 255, 0.02);
		min-height: 300px;
		max-height: 520px;
		overflow-y: auto;
		font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
		font-size: 0.75rem;
		line-height: 1.65;
	}

	.observe-log-entry {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 3px 14px;
		border-bottom: 1px solid rgba(120, 120, 128, 0.06);
		min-width: 0;
	}

	.observe-log-entry {
		border-bottom: 1px solid rgba(255, 255, 255, 0.04);
	}

	.observe-log-entry--alt {
		background: rgba(255, 255, 255, 0.018);
	}

	.observe-log-entry:hover {
		background: rgba(255, 255, 255, 0.045);
	}

	.observe-log-num {
		color: rgba(255, 255, 255, 0.22);
		font-size: 0.65rem;
		font-variant-numeric: tabular-nums;
		min-width: 28px;
		text-align: right;
		flex-shrink: 0;
		user-select: none;
	}

	.observe-log-level-badge {
		display: inline-block;
		padding: 0px 5px;
		border-radius: 4px;
		font-size: 0.62rem;
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
		gap: 6px;
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
		transition: transform 120ms ease;
	}

	.observe-log-more {
		flex-shrink: 0;
		font-size: 0.62rem;
		font-weight: 600;
		color: #8b949e;
		background: rgba(255, 255, 255, 0.08);
		border-radius: 4px;
		padding: 0 5px;
		align-self: center;
	}

	.observe-log-detail {
		margin: 4px 0 6px 18px;
		padding: 8px 10px;
		background: rgba(255, 255, 255, 0.03);
		border-left: 2px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		color: #c9d1d9;
		font-size: 0.72rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
	}

	.observe-log-loadmore {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 8px 0;
		font-size: 0.7rem;
		color: rgba(255, 255, 255, 0.45);
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.observe-log-loadmore--end {
		font-style: italic;
		color: rgba(255, 255, 255, 0.3);
	}

	.observe-log-loadmore--hint {
		color: rgba(255, 255, 255, 0.3);
	}

	.observe-log-skeleton {
		padding: 6px 0;
	}

	.observe-skeleton-line {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 14px;
	}

	.observe-skeleton-num {
		width: 28px;
		height: 10px;
		border-radius: 3px;
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
		border-radius: 3px;
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
		border-radius: 4px;
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
		border-radius: 3px;
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
		border-radius: 4px;
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
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.1);
		cursor: pointer;
		transition:
			color 80ms ease,
			background 80ms ease;
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
		gap: 10px;
		padding: 48px 24px;
		color: var(--surface-muted);
		font-size: 0.85rem;
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
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.observe-empty-desc {
		font-size: 0.8rem;
		color: var(--surface-muted);
		margin: 0;
		max-width: 360px;
	}

	.observe-http-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.observe-chart-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.observe-chart-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px 16px 12px;
		border-radius: 0.875rem;
		background: var(--surface-bg);
		border: 1px solid var(--surface-border);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		min-width: 0;
	}

	.observe-chart-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.observe-chart-label {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--surface-muted);
	}

	.observe-chart-current {
		font-size: 0.85rem;
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
		border-radius: 6px;
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

	.observe-traces-cta {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.observe-traces-header {
		display: flex;
		align-items: flex-start;
		gap: 14px;
	}

	.observe-traces-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.observe-traces-desc {
		font-size: 0.8rem;
		color: var(--surface-muted);
		margin: 4px 0 0;
		line-height: 1.5;
	}

	.observe-sdk-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 8px;
	}

	.observe-sdk-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		border-radius: 0.875rem;
		border: 1px solid var(--surface-border);
		background: rgba(120, 120, 128, 0.03);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		transition: box-shadow 150ms ease;
	}

	.observe-sdk-card:hover {
		box-shadow:
			0 2px 8px rgb(0 0 0 / 0.06),
			0 1px 3px rgb(0 0 0 / 0.04);
	}

	.observe-sdk-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.observe-sdk-name {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.observe-cmd-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.observe-sdk-cmd {
		font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
		font-size: 0.7rem;
		color: var(--surface-muted);
		padding: 4px 8px;
		border-radius: 6px;
		background: rgba(120, 120, 128, 0.06);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	.observe-guide-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border-radius: 0.875rem;
		border: 1px solid var(--button-bg);
		background: rgba(124, 92, 255, 0.04);
	}

	.observe-guide-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.observe-guide-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.observe-guide-lang {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.observe-guide-snippet {
		font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
		font-size: 0.72rem;
		line-height: 1.6;
		color: var(--center-channel-color);
		background: rgba(120, 120, 128, 0.06);
		border-radius: 8px;
		padding: 10px 14px;
		margin: 0;
		overflow-x: auto;
		white-space: pre;
	}

	:global(:root.dark) .observe-guide-snippet {
		background: rgba(255, 255, 255, 0.04);
	}

	.observe-other-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--surface-muted);
		font-size: 0.78rem;
		font-weight: 500;
		cursor: pointer;
		transition: color 80ms ease;
	}

	.observe-other-toggle:hover {
		color: var(--center-channel-color);
	}

	.observe-errors-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.observe-killed-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		flex: 1;
	}

	.observe-killed-logs {
		max-height: 400px;
		overflow-y: auto;
		white-space: pre-wrap;
	}

	.observe-errors-summary {
		display: flex;
		gap: 20px;
		padding: 12px 16px;
		border-radius: 0.875rem;
		background: var(--surface-bg);
		border: 1px solid var(--surface-border);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.observe-errors-summary-stat {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}

	.observe-errors-summary-value {
		font-size: 1.1rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--center-channel-color);
	}

	.observe-errors-summary-label {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.observe-errors-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.observe-error-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
		transition: box-shadow 150ms ease;
	}

	.observe-error-card:hover {
		box-shadow:
			0 2px 8px rgb(0 0 0 / 0.06),
			0 1px 3px rgb(0 0 0 / 0.04);
	}

	.observe-error-header {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 14px;
		width: 100%;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: var(--center-channel-color);
		font-family: inherit;
		transition: background 80ms ease;
	}

	.observe-error-header:hover {
		background: rgba(120, 120, 128, 0.04);
	}

	:global(.observe-error-chevron) {
		margin-top: 3px;
		color: var(--surface-muted);
		flex-shrink: 0;
	}

	.observe-error-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.observe-error-titlerow {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.observe-error-type {
		font-size: 0.85rem;
		font-weight: 650;
		color: var(--center-channel-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex-shrink: 1;
	}

	.observe-error-fp {
		font-family: 'SF Mono', 'Cascadia Code', monospace;
		font-size: 0.64rem;
		color: var(--surface-muted);
		background: rgba(120, 120, 128, 0.1);
		padding: 1px 6px;
		border-radius: 4px;
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
		font-size: 1.15rem;
		font-weight: 700;
		color: var(--center-channel-color);
		font-variant-numeric: tabular-nums;
	}

	.observe-error-count-label {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
	}

	.observe-error-message-line {
		font-size: 0.76rem;
		font-family: 'SF Mono', 'Cascadia Code', monospace;
		color: var(--surface-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.observe-error-meta {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 0.68rem;
		color: var(--surface-muted);
	}

	.observe-error-meta-sep {
		opacity: 0.5;
	}

	.observe-error-detail {
		padding: 12px 16px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		border-top: 1px solid var(--surface-border);
		background: rgba(120, 120, 128, 0.025);
	}

	.observe-error-full-msg {
		font-size: 0.8rem;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		padding: 10px 12px;
		background: var(--surface-bg);
		border: 1px solid var(--surface-border);
		border-radius: 8px;
	}

	.observe-error-sample {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.observe-stack-wrapper {
		position: relative;
	}

	.observe-error-stack {
		font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
		font-size: 0.7rem;
		line-height: 1.6;
		background: #1a1a1e;
		color: #c8c8cc;
		border-radius: 8px;
		padding: 12px 14px;
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
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(255, 255, 255, 0.06);
		color: rgba(255, 255, 255, 0.5);
		cursor: pointer;
		transition:
			color 80ms ease,
			background 80ms ease;
	}

	.observe-stack-copy:hover {
		color: rgba(255, 255, 255, 0.85);
		background: rgba(255, 255, 255, 0.12);
	}

	.observe-error-sample-ts {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		font-size: 0.66rem;
		font-variant-numeric: tabular-nums;
		color: var(--surface-muted);
		cursor: help;
	}

	.observe-error-samples-label {
		font-size: 0.64rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
		margin: 4px 0 2px;
	}

	@media (max-width: 720px) {
		.observe-chart-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 640px) {
		.observe-strip {
			gap: 8px;
		}

		.observe-stat {
			min-width: 100px;
			padding: 8px 10px;
		}

		.observe-log-toolbar {
			flex-direction: column;
			align-items: stretch;
		}

		.observe-log-search {
			max-width: none;
		}

		.observe-chart-grid {
			grid-template-columns: 1fr;
		}

		.observe-errors-summary {
			flex-direction: column;
			gap: 10px;
		}

		.observe-error-card {
			border-radius: 0.75rem;
		}

		.observe-sdk-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
