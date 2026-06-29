<script lang="ts">
	import { onDestroy, untrack, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatRelativeTime } from '$lib/utils/format';
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

	let { deployment }: { deployment: any } = $props();

	type SubTab = 'logs' | 'http' | 'traces' | 'errors';
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

	function chooseStep(ms: number): number {
		if (ms <= 30 * 60 * 1000) return 15_000;
		return 30_000;
	}

	let activeTab = $state<SubTab>('logs');
	let timeRange = $state<TimeRange>('1h');
	let logSearch = $state('');
	let logLevel = $state<LogLevel>('all');
	let liveTail = $state(false);
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
			entries = entries.filter((e: any) => (e.message ?? '').toLowerCase().includes(q));
		}
		return entries;
	});

	const visibleTabs = $derived(
		(['logs', 'http', 'traces', 'errors'] as SubTab[]).filter((t) => t !== 'http' || hasIngress)
	);
	const activeTabIndex = $derived(visibleTabs.indexOf(activeTab));

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

	async function fetchLogs() {
		if (!deployment?.id) return;
		const seq = ++logsFetchSeq;
		if (!logEntries.length) logsLoading = true;
		logsError = null;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deployment.id)}/logs/structured?tailLines=200`
			);
			if (seq !== logsFetchSeq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			logEntries = body?.entries ?? body?.logs ?? body ?? [];
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

	function trendIcon(trend: 'rising' | 'stable' | 'falling'): string {
		if (trend === 'rising') return '↑';
		if (trend === 'falling') return '↓';
		return '→';
	}

	function trendColor(trend: 'rising' | 'stable' | 'falling'): string {
		if (trend === 'rising') return '#d04a4a';
		if (trend === 'falling') return '#22c0a8';
		return 'var(--surface-muted)';
	}

	$effect(() => {
		const id = deployment?.id;
		if (!id) return;
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

	$effect(() => {
		if (!liveTail) return;
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

	function formatTimestamp(ts: string | number | undefined): string {
		if (!ts) return '';
		const d = new Date(ts);
		if (isNaN(d.getTime())) return '';
		const h = String(d.getHours()).padStart(2, '0');
		const m = String(d.getMinutes()).padStart(2, '0');
		const s = String(d.getSeconds()).padStart(2, '0');
		const ms = String(d.getMilliseconds()).padStart(3, '0');
		return `${h}:${m}:${s}.${ms}`;
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

		return { running, total, cpuReq, memReq, cpuPct, memPct, uptime, reqRate, errorRate, avgLatency };
	});

	function highlightStack(stack: string): string {
		return stack
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(
				/^(\w+(?:Error|Exception|Fault|Failure)[^\n]*)/m,
				'<span style="color: #d04a4a; font-weight: 600;">$1</span>'
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
		{#each [{ icon: Clock, label: 'Uptime', value: formatUptime(overviewStats.uptime), show: true }, { icon: Boxes, label: 'Pods', value: `${overviewStats.running}/${overviewStats.total}`, show: true }, { icon: Cpu, label: 'CPU', value: overviewStats.cpuPct != null ? `${overviewStats.cpuPct.toFixed(1)}%` : '--', show: true }, { icon: MemoryStick, label: 'Memory', value: overviewStats.memPct != null ? `${overviewStats.memPct.toFixed(1)}%` : '--', show: true }, { icon: Activity, label: 'Req/s', value: overviewStats.reqRate != null ? fmtReqRate(overviewStats.reqRate) : '--', show: hasIngress }, { icon: AlertTriangle, label: 'Error rate', value: overviewStats.errorRate != null ? fmtPercent(overviewStats.errorRate) : '--', show: hasIngress }, { icon: Clock, label: 'Avg latency', value: overviewStats.avgLatency != null ? fmtLatency(overviewStats.avgLatency) : '--', show: hasIngress }].filter((s) => s.show) as stat, i}
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
			{#each visibleTabs as tab}
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
								: 'Errors'}
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

				<div class="observe-log-level">
					<select bind:value={logLevel} class="observe-select">
						<option value="all">All levels</option>
						<option value="debug">Debug</option>
						<option value="info">Info</option>
						<option value="warn">Warn</option>
						<option value="error">Error</option>
					</select>
				</div>

				<div class="observe-rangepick">
					{#each TIME_RANGES as r}
						<button
							class="observe-rangebtn"
							class:active={timeRange === r.id}
							onclick={() => (timeRange = r.id)}
							type="button">{r.label}</button
						>
					{/each}
				</div>

				<button
					class="observe-tail-btn"
					class:observe-tail-btn--active={liveTail}
					onclick={() => (liveTail = !liveTail)}
					type="button"
				>
					{#if liveTail}
						<span class="observe-tail-dot"></span>
					{/if}
					Live
				</button>
			</div>

			<div class="observe-log-viewer" bind:this={logViewerEl} onscroll={handleLogScroll}>
				{#if logsLoading && !logEntries.length}
					<div class="observe-log-skeleton">
						{#each Array(12) as _, i}
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
						<AlertTriangle class="h-5 w-5" style="color: #d04a4a;" />
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
					{#each filteredLogs as entry, i}
						<div class="observe-log-entry" class:observe-log-entry--alt={i % 2 === 1}>
							<span class="observe-log-num">{i + 1}</span>
							{#if entry.timestamp}
								<span class="observe-log-ts">{formatTimestamp(entry.timestamp)}</span>
							{/if}
							<span
								class="observe-log-level-badge"
								style="color: {levelColor(entry.level)}; background: {levelBg(entry.level)};"
							>
								{(entry.level ?? 'log').toUpperCase()}
							</span>
							<span class="observe-log-msg">{entry.message ?? ''}</span>
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
						{#each TIME_RANGES as r}
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
						<AlertTriangle class="h-5 w-5" style="color: #d04a4a;" />
						<span>Failed to load HTTP metrics: {httpError}</span>
					</div>
				{:else if httpLoading && !httpMetrics}
					<div class="observe-chart-grid">
						{#each Array(4) as _, i}
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
						{#each [{ label: 'Request Rate', series: httpMetrics?.requestRate ?? [], color: '#7c5cff', formatter: fmtReqRate }, { label: 'Error Rate', series: httpMetrics?.errorRate ?? [], color: '#d04a4a', formatter: fmtPercent }, { label: 'Avg Latency', series: httpMetrics?.latencyAvg ?? [], color: '#22c0a8', formatter: fmtLatency }, { label: 'Max Latency', series: httpMetrics?.latencyMax ?? [], color: '#ff7e6b', formatter: fmtLatency }] as chart, i}
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
							<button
								class="observe-copy-btn"
								onclick={() => copyToClipboard(runtimeGuide.install, 'guide-install')}
								type="button"
							>
								{#if copiedId === 'guide-install'}<Check class="h-3 w-3" />{:else}<Copy
										class="h-3 w-3"
									/>{/if}
							</button>
						</div>
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
								{#each otherSdks as sdk, i}
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
											<button
												class="observe-copy-btn"
												onclick={() => copyToClipboard(sdk.cmd, `sdk-${sdk.name}`)}
												type="button"
											>
												{#if copiedId === `sdk-${sdk.name}`}<Check class="h-3 w-3" />{:else}<Copy
														class="h-3 w-3"
													/>{/if}
											</button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
				{:else}
					<div class="observe-sdk-grid">
						{#each SDK_LIST as sdk, i}
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
									<button
										class="observe-copy-btn"
										onclick={() => copyToClipboard(sdk.cmd, `sdk-${sdk.name}`)}
										type="button"
									>
										{#if copiedId === `sdk-${sdk.name}`}<Check class="h-3 w-3" />{:else}<Copy
												class="h-3 w-3"
											/>{/if}
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{:else if activeTab === 'errors'}
			<div class="observe-errors-toolbar">
				<div class="observe-rangepick">
					{#each ERROR_WINDOWS as w}
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
					<AlertTriangle class="h-5 w-5" style="color: #d04a4a;" />
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
						<PartyPopper class="h-10 w-10" style="color: #22c0a8;" />
					</div>
					<p class="observe-empty-title">All clear!</p>
					<p class="observe-empty-desc">
						No errors in the selected time window &mdash; your app is running clean
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
					{#each errorGroups as group, i}
						{@const isExpanded = expandedErrors.has(group.fingerprint)}
						<div
							class="observe-error-card"
							{@attach springHover()}
							{@attach motionStagger({
								index: i,
								stride: 0.04,
								from: { y: 8, opacity: 0, scale: 0.98 }
							})}
						>
							<button
								class="observe-error-header"
								onclick={() => toggleError(group.fingerprint)}
								type="button"
							>
								<div class="observe-error-top">
									<ChevronRight
										class="h-3.5 w-3.5 observe-error-chevron"
										style="transform: rotate({isExpanded
											? 90
											: 0}deg); transition: transform 150ms ease; flex-shrink: 0;"
									/>
									<span class="observe-error-type">{group.type}</span>
									<span class="observe-error-trend" style="color: {trendColor(group.trend)};">
										<span class="observe-trend-arrow">{trendIcon(group.trend)}</span>
										<span class="observe-trend-label">{group.trend}</span>
									</span>
									<span class="observe-error-count">{group.count.toLocaleString()}</span>
								</div>
								<div class="observe-error-message-line">{group.message}</div>
								<div class="observe-error-meta">
									First {formatRelativeTime(new Date(group.firstSeen))} &middot; Last {formatRelativeTime(
										new Date(group.lastSeen)
									)}
								</div>
							</button>

							{#if isExpanded}
								<div class="observe-error-detail">
									<p class="observe-error-full-msg">{group.message}</p>

									{#if group.samples.length > 0}
										{#each group.samples as sample, si}
											{#if sample.stackTrace}
												<div class="observe-stack-wrapper">
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
											{#if sample.timestamp}
												<span class="observe-error-sample-ts"
													>{formatRelativeTime(new Date(sample.timestamp))}</span
												>
											{/if}
										{/each}
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

	.observe-log-level {
		position: relative;
	}

	.observe-select {
		padding: 6px 28px 6px 10px;
		border-radius: 8px;
		border: 1px solid var(--surface-border);
		background: var(--surface-bg);
		color: var(--center-channel-color);
		font-size: 0.8rem;
		font-family: inherit;
		cursor: pointer;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 8px center;
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

	.observe-tail-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 5px 12px;
		font-size: 0.78rem;
		font-weight: 500;
		border: 1px solid var(--surface-border);
		background: var(--surface-bg);
		color: var(--surface-muted);
		border-radius: 8px;
		cursor: pointer;
		transition:
			background 80ms ease,
			color 80ms ease,
			border-color 80ms ease;
	}

	.observe-tail-btn:hover {
		color: var(--center-channel-color);
	}

	.observe-tail-btn--active {
		border-color: var(--online-indicator);
		color: var(--online-indicator);
		background: rgba(34, 192, 168, 0.06);
	}

	.observe-tail-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--online-indicator);
		animation: observe-pulse 1.6s ease-out infinite;
	}

	@keyframes observe-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(34, 192, 168, 0.55);
		}
		70% {
			box-shadow: 0 0 0 6px rgba(34, 192, 168, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(34, 192, 168, 0);
		}
	}

	.observe-log-viewer {
		position: relative;
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
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

	.observe-log-entry--alt {
		background: rgba(120, 120, 128, 0.02);
	}

	.observe-log-entry:hover {
		background: rgba(120, 120, 128, 0.05);
	}

	.observe-log-num {
		color: rgba(120, 120, 128, 0.35);
		font-size: 0.65rem;
		font-variant-numeric: tabular-nums;
		min-width: 28px;
		text-align: right;
		flex-shrink: 0;
		user-select: none;
	}

	.observe-log-ts {
		color: var(--surface-muted);
		font-size: 0.7rem;
		white-space: nowrap;
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
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
		color: var(--center-channel-color);
		white-space: pre-wrap;
		word-break: break-all;
		min-width: 0;
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
		border-color: rgba(34, 192, 168, 0.25);
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

	.observe-copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 6px;
		border: 1px solid var(--surface-border);
		background: var(--surface-bg);
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			color 80ms ease,
			background 80ms ease;
	}

	.observe-copy-btn:hover {
		color: var(--center-channel-color);
		background: rgba(120, 120, 128, 0.06);
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
		display: flex;
		flex-direction: column;
		gap: 4px;
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

	.observe-error-top {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.observe-error-type {
		font-size: 0.82rem;
		font-weight: 600;
		color: #d04a4a;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.observe-error-trend {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-weight: 600;
		flex-shrink: 0;
	}

	.observe-trend-arrow {
		font-size: 1rem;
		line-height: 1;
	}

	.observe-trend-label {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.observe-error-count {
		margin-left: auto;
		padding: 1px 8px;
		border-radius: 6px;
		background: rgba(208, 74, 74, 0.1);
		color: #d04a4a;
		font-size: 0.72rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	.observe-error-message-line {
		font-size: 0.78rem;
		color: var(--center-channel-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-left: 22px;
	}

	.observe-error-meta {
		font-size: 0.7rem;
		color: var(--surface-muted);
		padding-left: 22px;
	}

	.observe-error-detail {
		padding: 0 14px 14px 36px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid rgba(120, 120, 128, 0.08);
	}

	.observe-error-full-msg {
		font-size: 0.78rem;
		color: var(--center-channel-color);
		margin: 10px 0 0;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
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
		font-size: 0.68rem;
		color: var(--surface-muted);
	}

	.observe-error-chevron {
		flex-shrink: 0;
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
