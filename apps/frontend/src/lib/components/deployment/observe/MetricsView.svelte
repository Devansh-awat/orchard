<script lang="ts">
	import { untrack } from 'svelte';
	import { Boxes, Clock, Code, GitCommitHorizontal, Info, TriangleAlert } from 'lucide-svelte';
	import { Button, Disclosure, EmptyState, LogViewer, Modal, Table } from '$lib/components/ui';
	import MetaList from '$lib/components/ui/MetaList.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import TopList from '$lib/components/ui/TopList.svelte';
	import Widget from '$lib/components/ui/Widget.svelte';
	import MetricPanel from '$lib/components/patterns/MetricPanel.svelte';
	import {
		SERIES_COLORS,
		type ChartBand,
		type ChartFinding,
		type ChartPoint,
		type ChartSeries,
		type ChartThreshold
	} from '$lib/components/ui/time-chart';
	import { selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import { podLabel } from '$lib/utils/format';
	import { anomalies } from './findings';
	import { entryLine, type LogEntry } from './logs.svelte';
	import { runtimeName, uptime, type DetectedRuntime } from './runtime';
	import { bucketSize, clock, runsAbove, stackByKey } from './signals';
	import type { ChartId, MetricsState, ResourceId } from './metrics.svelte';

	let {
		metrics,
		deployment,
		active,
		demo,
		hasIngress,
		runtime,
		upSince,
		sharedHttp
	}: {
		metrics: MetricsState;
		deployment: any;
		active: boolean;
		demo: boolean;
		hasIngress: boolean;
		runtime: DetectedRuntime | null;
		upSince: string | null;
		sharedHttp: boolean;
	} = $props();

	const MIB = 1024 * 1024;
	const cpu = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} cores` : `${Math.round(v)}m`);
	const mem = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${Math.round(v)} MB`);
	const net = (v: number) =>
		v >= 1024 ? `${(v / 1024).toFixed(2)} MB/s` : `${Math.round(v)} KB/s`;
	const rate = (v: number) =>
		v >= 1000 ? `${(v / 1000).toFixed(1)}k/s` : `${v.toFixed(v >= 10 ? 0 : 1)}/s`;
	const percent = (v: number) => `${v.toFixed(2)}%`;
	const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
	const count = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
	const minutes = (v: number) =>
		v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${Math.round(v)}s`;

	const REASON_COLORS: Record<string, string> = {
		OOMKilled: 'var(--status-error-solid)',
		Error: 'var(--red-9)',
		BackOff: 'var(--red-9)',
		CrashLoopBackOff: 'var(--red-9)',
		Unhealthy: 'var(--status-warning-solid)',
		Failed: 'var(--amber-9)',
		FailedScheduling: 'var(--amber-9)',
		error: 'var(--status-error-solid)',
		warn: 'var(--status-warning-solid)',
		failed: 'var(--status-error-solid)',
		succeeded: 'var(--status-success-solid)'
	};

	let open = $state({ red: true, use: true, pods: true, logs: true, deploys: true });
	let picked = $state<LogEntry | null>(null);
	let reading = $state(false);

	const step = $derived(metrics.step);
	const pods = $derived(Math.max(1, (deployment?.pods ?? []).length));
	const split = $derived(metrics.byPod && (metrics.pods.cpu?.length ?? 0) > 0);
	const bucket = $derived(bucketSize(metrics.from, metrics.to));

	function latest(points: ChartPoint[]) {
		return points.length ? points[points.length - 1].y : null;
	}

	function byPod(id: ResourceId, suffix = '', dashed = false): ChartSeries[] {
		return (metrics.pods[id] ?? []).map((g, i) => ({
			id: `${g.key}${suffix}`,
			label: `${podLabel(g.key)}${suffix ? ` ${suffix.trim()}` : ''}`,
			points: g.points,
			color: SERIES_COLORS[i % SERIES_COLORS.length],
			dashed
		}));
	}

	function limitZones(limit: number | null, format: (v: number) => string): ChartThreshold[] {
		if (!limit) return [];
		return [
			{ value: limit * 0.8, tone: 'warning', label: `80% of the ${format(limit)} limit` },
			{ value: limit, tone: 'error', label: `${format(limit)} limit` }
		];
	}

	function usage(points: ChartPoint[], limit: number | null, format: (v: number) => string) {
		const v = latest(points);
		if (v == null) return undefined;
		if (!limit) return { value: format(v) };
		const ratio = v / limit;
		return {
			value: `${format(v)} · ${Math.round(ratio * 100)}% of limit`,
			tone:
				ratio >= 1 ? ('error' as const) : ratio >= 0.8 ? ('warning' as const) : ('neutral' as const)
		};
	}

	const cpuPod = $derived(deployment?.cpuRequestMilli || null);
	const memPod = $derived(
		deployment?.memoryRequestBytes ? Number(deployment.memoryRequestBytes) / MIB : null
	);
	const cpuTotal = $derived(cpuPod ? cpuPod * pods : null);
	const memTotal = $derived(memPod ? memPod * pods : null);

	const series = $derived({
		req: [{ id: 'req', label: 'Per second', points: metrics.http.req, tone: 'neutral' }],
		err: [{ id: 'err', label: '5xx share', points: metrics.http.err, tone: 'error' }],
		lat: [
			{ id: 'avg', label: 'Average', points: metrics.http.lat, tone: 'neutral' },
			{ id: 'max', label: 'Slowest', points: metrics.http.latmax, tone: 'faint', dashed: true }
		],
		cpu: split
			? byPod('cpu')
			: [{ id: 'cpu', label: 'All pods', points: metrics.resources.cpu, tone: 'neutral' }],
		mem: split
			? byPod('mem')
			: [{ id: 'mem', label: 'All pods', points: metrics.resources.mem, tone: 'neutral' }],
		net: split
			? [...byPod('rx', ' in'), ...byPod('tx', ' out', true)]
			: [
					{ id: 'rx', label: 'In', points: metrics.resources.rx, tone: 'neutral' },
					{ id: 'tx', label: 'Out', points: metrics.resources.tx, tone: 'faint', dashed: true }
				]
	} as Record<ChartId, ChartSeries[]>);

	function findingsFor(list: ChartSeries[], format: (v: number) => string): ChartFinding[] {
		return list.flatMap((s) =>
			anomalies(s.points, { format, events: metrics.events }).map((a) => ({
				t: a.t,
				seriesId: s.id,
				label: a.label
			}))
		);
	}

	const findings = $derived({
		req: findingsFor(series.req, rate),
		err: findingsFor(series.err, percent),
		lat: findingsFor(series.lat, ms),
		cpu: findingsFor(series.cpu, cpu),
		mem: findingsFor(series.mem, mem),
		net: findingsFor(series.net, net)
	} as Record<ChartId, ChartFinding[]>);

	const incidents = $derived.by<ChartBand[]>(() => {
		const out: ChartBand[] = [];
		for (const k of metrics.killed) {
			if (!k.finishedAt) continue;
			const t = new Date(k.finishedAt).getTime();
			out.push({
				from: t - step,
				to: t + step,
				label: `${podLabel(k.pod)} / ${k.container}: ${k.reason}${k.exitCode != null ? ` (exit ${k.exitCode})` : ''} at ${clock(t)}`,
				tone: 'error'
			});
		}
		for (const w of metrics.warnings) {
			if (!/backoff|crashloop/i.test(`${w.reason} ${w.message}`)) continue;
			const a = w.firstTimestamp ? new Date(w.firstTimestamp).getTime() : null;
			const b = w.lastTimestamp ? new Date(w.lastTimestamp).getTime() : a;
			if (!a || !b) continue;
			out.push({
				from: a,
				to: Math.max(b, a + step),
				label: `${podLabel(w.pod)} kept crashing (${w.count ?? 1} restarts) from ${clock(a)} to ${clock(b)}`,
				tone: 'error'
			});
		}
		for (const r of metrics.releases) {
			if (r.status !== 'failed' || !r.startedAt) continue;
			out.push({
				from: r.startedAt,
				to: r.completedAt ?? r.at,
				label: `Deploy ${r.tag} failed${r.title ? `: ${r.title}` : ''}`,
				tone: 'warning'
			});
		}
		out.push(
			...runsAbove(
				metrics.http.err,
				5,
				(peak, a, b) =>
					`Error rate above 5% (up to ${percent(peak)}) from ${clock(a)} to ${clock(b)}`
			)
		);
		return out;
	});

	const restarts = $derived(
		stackByKey(
			metrics.killed.flatMap((k) =>
				k.finishedAt ? [{ t: new Date(k.finishedAt).getTime(), key: k.reason }] : []
			),
			metrics.from,
			metrics.to,
			{ size: bucket, colors: REASON_COLORS }
		)
	);

	const warnings = $derived(
		stackByKey(
			metrics.warnings.flatMap((w) => {
				const t = w.lastTimestamp ?? w.firstTimestamp;
				return t ? [{ t: new Date(t).getTime(), key: w.reason ?? 'Warning', n: w.count ?? 1 }] : [];
			}),
			metrics.from,
			metrics.to,
			{ size: bucket, colors: REASON_COLORS }
		)
	);

	const logsSince = $derived(
		metrics.logTail[0]?.timestamp ? new Date(metrics.logTail[0].timestamp).getTime() : null
	);

	const problemLines = $derived(
		metrics.logTail.filter((e) => /^(error|fatal|warn|warning)$/i.test(e.level ?? ''))
	);

	const logLevels = $derived(
		stackByKey(
			problemLines.flatMap((e) =>
				e.timestamp
					? [
							{
								t: new Date(e.timestamp).getTime(),
								key: /^warn/i.test(e.level ?? '') ? 'warn' : 'error'
							}
						]
					: []
			),
			metrics.from,
			metrics.to,
			{
				size: bucket,
				colors: REASON_COLORS,
				label: (k) => (k === 'warn' ? 'Warnings' : 'Errors'),
				since: logsSince ?? undefined
			}
		)
	);

	const latestErrors = $derived(
		problemLines
			.filter((e) => !/^warn/i.test(e.level ?? ''))
			.slice(-50)
			.reverse()
	);

	const deploys = $derived(
		stackByKey(
			metrics.releases.map((r) => ({ t: r.at, key: r.status || 'unknown' })),
			metrics.from,
			metrics.to,
			{
				size: bucket,
				colors: REASON_COLORS,
				label: (k) => k.charAt(0).toUpperCase() + k.slice(1)
			}
		)
	);

	const builds = $derived(
		metrics.releases
			.filter((r) => r.startedAt && r.completedAt)
			.slice(0, 12)
			.map((r) => ({
				id: `${r.tag}-${r.at}`,
				label: `${r.tag}${r.title ? ` ${r.title}` : ''}`,
				value: ((r.completedAt ?? 0) - (r.startedAt ?? 0)) / 1000,
				color: r.status === 'failed' ? 'var(--status-error-solid)' : undefined
			}))
	);

	const podsByMemory = $derived(
		(metrics.pods.mem ?? []).map((g, i) => ({
			id: g.key,
			label: podLabel(g.key),
			value: latest(g.points),
			color: SERIES_COLORS[i % SERIES_COLORS.length]
		}))
	);

	const errorRank = $derived(
		metrics.errorGroups.map((g) => ({
			id: g.fingerprint,
			label: `${g.type}: ${g.message}`,
			value: g.count,
			color: 'var(--status-error-solid)'
		}))
	);

	function liveDeploy(t: number) {
		return metrics.releases
			.filter((r) => r.status === 'succeeded' && r.at <= t)
			.sort((a, b) => b.at - a.at)[0];
	}

	const context = $derived.by(() => {
		if (!picked) return [];
		const pod = picked.metadata?.pod;
		const same = metrics.logTail.filter((e) => !pod || e.metadata?.pod === pod);
		const at = same.indexOf(picked);
		return same.slice(Math.max(0, at - 25), at + 26).map(entryLine);
	});

	const pickedDeploy = $derived(
		picked?.timestamp ? liveDeploy(new Date(picked.timestamp).getTime()) : undefined
	);

	const facts = $derived(
		[
			runtimeName(runtime) && { label: runtimeName(runtime)!, icon: Code },
			uptime(upSince) && { label: `Up ${uptime(upSince)}`, icon: Clock },
			deployment?.pods && {
				label: `${(deployment.pods ?? []).filter((p: any) => (p.status ?? '').toLowerCase() === 'ready').length} of ${deployment.pods.length} pods ready`,
				icon: Boxes
			}
		].filter(Boolean) as { label: string; icon: typeof Code }[]
	);

	function load() {
		const id = deployment?.id;
		if (id) metrics.load(id, { http: hasIngress, demo });
	}

	function loadContext() {
		const id = deployment?.id;
		if (id) metrics.loadContext(id, { demo, pods: deployment?.pods ?? [] });
	}

	$effect(() => {
		void metrics.from;
		void metrics.to;
		void hasIngress;
		if (!deployment?.id || !active) return;
		untrack(load);
	});

	$effect(() => {
		void metrics.custom;
		void metrics.windowMs;
		if (!deployment?.id || !active) return;
		untrack(loadContext);
	});

	$effect(() => {
		if (!metrics.live || !active) return;
		const timer = setInterval(() => {
			if (metrics.hover === null && !document.hidden) metrics.tick();
		}, 15_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		const orgId = $selectedOrganization?.id;
		const id = deployment?.id;
		if (!metrics.live || !active || !orgId || !id) return;
		return subscribeOrgEvents(orgId, (ev) => {
			if (ev.type === 'deployment.metrics' && ev.id === id && metrics.hover === null)
				metrics.tick();
			if ((ev.type === 'deployment.changed' || ev.type === 'pod.changed') && ev.id === id) {
				loadContext();
			}
		});
	});
</script>

{#snippet shared()}Includes every protected app in this project{/snippet}

{#snippet infoTip(text: string)}
	<Tooltip {text}>
		<span class="info" role="img" aria-label={text}><Info size={14} /></span>
	</Tooltip>
{/snippet}

{#snippet rank(
	title: string,
	info: string,
	items: { id: string; label: string; value: number | null; color?: string }[],
	format: (v: number) => string,
	empty: string
)}
	{#snippet meta()}{@render infoTip(info)}{/snippet}
	<Widget {title} {meta} class="metric-panel">
		<div class="rank">
			{#if items.length}
				<TopList label={title} {items} {format} />
			{:else}
				<p class="empty">{empty}</p>
			{/if}
		</div>
	</Widget>
{/snippet}

{#snippet errorsMeta()}
	{@render infoTip('The newest error lines. Open one to read the lines around it.')}
{/snippet}

{#snippet errorCell(e: LogEntry, col: { id: string })}
	{#if col.id === 'time'}
		<span class="mono">{e.timestamp ? clock(new Date(e.timestamp).getTime()) : ''}</span>
	{:else if col.id === 'pod'}
		<span class="mono">{e.metadata?.pod ? podLabel(e.metadata.pod) : ''}</span>
	{:else}
		<span class="mono message">{e.message ?? e.raw ?? ''}</span>
	{/if}
{/snippet}

<div class="board">
	{#if facts.length}
		<MetaList items={facts} />
	{/if}

	{#if !metrics.loaded && metrics.error}
		<EmptyState title="Metrics aren't available" description={metrics.error}>
			{#snippet icon()}<TriangleAlert size={18} />{/snippet}
			<Button variant="secondary" onclick={load}>Retry</Button>
		</EmptyState>
	{:else if !metrics.loaded}
		<div class="grid">
			{#each [0, 1, 2, 3] as i (i)}
				<Skeleton height="17rem" rounded="calc(var(--radius-widget) * var(--corner-scale))" />
			{/each}
		</div>
	{:else}
		{#if metrics.error}
			<p class="stale" role="status">
				Metrics aren't updating: {metrics.error}
				<Button size="sm" variant="ghost" onclick={load}>Retry</Button>
			</p>
		{/if}

		{#if hasIngress}
			<Disclosure title="Traffic and errors" bind:open={open.red}>
				<div class="grid">
					<MetricPanel
						title="Requests"
						info="Requests per second reaching this app through its domains."
						series={series.req}
						from={metrics.from}
						to={metrics.to}
						format={rate}
						bind:hover={metrics.hover}
						bind:mode={() => metrics.modes.req ?? 'areas', (m) => (metrics.modes.req = m)}
						modes={['areas', 'lines', 'bars']}
						headline={latest(metrics.http.req) != null
							? { value: rate(latest(metrics.http.req)!) }
							: undefined}
						events={metrics.events}
						findings={findings.req}
						bands={incidents}
						empty="No requests reached this app in this range"
						onZoom={(a, b) => metrics.zoom(a, b)}
						note={sharedHttp ? shared : undefined}
					/>
					<MetricPanel
						title="Error rate"
						info="Share of requests that returned a 5xx. Amber from 1%, red from 5%."
						series={series.err}
						from={metrics.from}
						to={metrics.to}
						format={percent}
						bind:hover={metrics.hover}
						bind:mode={() => metrics.modes.err ?? 'lines', (m) => (metrics.modes.err = m)}
						modes={['lines', 'areas', 'bars']}
						headline={latest(metrics.http.err) != null
							? {
									value: percent(latest(metrics.http.err)!),
									tone:
										latest(metrics.http.err)! >= 5
											? 'error'
											: latest(metrics.http.err)! >= 1
												? 'warning'
												: 'neutral'
								}
							: undefined}
						thresholds={[
							{ value: 1, tone: 'warning', label: '1%' },
							{ value: 5, tone: 'error', label: '5%' }
						]}
						events={metrics.events}
						findings={findings.err}
						bands={incidents}
						empty="No requests, so no error rate"
						onZoom={(a, b) => metrics.zoom(a, b)}
					/>
					<MetricPanel
						title="Response time"
						info="Average and slowest response per interval. Percentiles (p50, p95, p99) are not measured yet."
						series={series.lat}
						from={metrics.from}
						to={metrics.to}
						format={ms}
						bind:hover={metrics.hover}
						bind:mode={() => metrics.modes.lat ?? 'lines', (m) => (metrics.modes.lat = m)}
						modes={['lines', 'areas']}
						headline={latest(metrics.http.lat) != null
							? { value: `${ms(latest(metrics.http.lat)!)} average` }
							: undefined}
						peaks={2}
						events={metrics.events}
						findings={findings.lat}
						bands={incidents}
						empty="No requests to time in this range"
						onZoom={(a, b) => metrics.zoom(a, b)}
					/>
					{@render rank(
						'Most frequent errors',
						'Exceptions grouped by fingerprint, ranked by how often they happened in this range.',
						errorRank,
						count,
						'No errors in this range'
					)}
				</div>
			</Disclosure>
		{/if}

		<Disclosure title="Resources" bind:open={open.use}>
			<div class="grid">
				<MetricPanel
					title="CPU"
					info="CPU used against the limit. Amber from 80% of the limit, red at the limit, where the app gets throttled."
					series={series.cpu}
					from={metrics.from}
					to={metrics.to}
					format={cpu}
					bind:hover={metrics.hover}
					bind:mode={() => metrics.modes.cpu ?? 'lines', (m) => (metrics.modes.cpu = m)}
					headline={usage(metrics.resources.cpu, cpuTotal, cpu)}
					thresholds={limitZones(split ? cpuPod : cpuTotal, cpu)}
					events={metrics.events}
					findings={findings.cpu}
					bands={incidents}
					empty="No CPU samples in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
				<MetricPanel
					title="Memory"
					info="Memory used against the limit. At the limit the container is killed (OOMKilled)."
					series={series.mem}
					from={metrics.from}
					to={metrics.to}
					format={mem}
					bind:hover={metrics.hover}
					bind:mode={() => metrics.modes.mem ?? 'lines', (m) => (metrics.modes.mem = m)}
					headline={usage(metrics.resources.mem, memTotal, mem)}
					thresholds={limitZones(split ? memPod : memTotal, mem)}
					events={metrics.events}
					findings={findings.mem}
					bands={incidents}
					empty="No memory samples in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
				<MetricPanel
					title="Network"
					info="Bytes per second received (in) and sent (out) by the app's pods."
					series={series.net}
					from={metrics.from}
					to={metrics.to}
					format={net}
					bind:hover={metrics.hover}
					bind:mode={() => metrics.modes.net ?? 'areas', (m) => (metrics.modes.net = m)}
					modes={['areas', 'lines', 'top']}
					events={metrics.events}
					findings={findings.net}
					bands={incidents}
					empty="No network samples in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
				<MetricPanel
					title="Restarts and out-of-memory kills"
					info="Containers that stopped, per interval, by the reason Kubernetes gave."
					series={restarts}
					from={metrics.from}
					to={metrics.to}
					format={count}
					bind:hover={metrics.hover}
					mode="stacked"
					modes={['stacked']}
					sum
					events={metrics.events}
					bands={incidents}
					empty="No container stopped in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
				{@render rank(
					'Pods by memory',
					'Memory each pod is using right now, largest first.',
					podsByMemory,
					mem,
					'No per-pod memory samples yet'
				)}
			</div>
		</Disclosure>

		<Disclosure title="Pods" bind:open={open.pods}>
			<div class="grid">
				<MetricPanel
					title="Kubernetes warnings"
					info="Warnings Kubernetes recorded for this app's pods (failed probes, back-off, scheduling), by reason."
					series={warnings}
					from={metrics.from}
					to={metrics.to}
					format={count}
					bind:hover={metrics.hover}
					mode="stacked"
					modes={['stacked']}
					sum
					events={metrics.events}
					bands={incidents}
					empty="Kubernetes recorded no warnings in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
			</div>
		</Disclosure>

		<Disclosure title="Logs" bind:open={open.logs}>
			<div class="grid">
				<MetricPanel
					title="Error and warning lines"
					info="Log lines at error or warning level per interval, from the latest {metrics.logTail
						.length} lines across all pods."
					series={logLevels}
					from={metrics.from}
					to={metrics.to}
					format={count}
					bind:hover={metrics.hover}
					mode="stacked"
					modes={['stacked']}
					sum
					events={metrics.events}
					bands={incidents}
					empty="No error or warning lines in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
				<Widget title="Latest errors" meta={errorsMeta} class="metric-panel">
					<Table
						label="Latest errors"
						dense
						inset={false}
						maxHeight="16.5rem"
						columns={[
							{ id: 'time', label: 'Time', width: '5rem' },
							{ id: 'pod', label: 'Pod', width: '4.5rem' },
							{ id: 'message', label: 'Message' }
						]}
						rows={latestErrors}
						rowKey={(e, i) => e._key ?? i}
						cell={errorCell}
						onRowClick={(e) => {
							picked = e;
							reading = true;
						}}
						emptyText="No error lines in the latest logs"
					/>
				</Widget>
			</div>
		</Disclosure>

		<Disclosure title="Deploys" bind:open={open.deploys}>
			<div class="grid">
				<MetricPanel
					title="Deploys"
					info="Builds started for this app per interval, by outcome."
					series={deploys}
					from={metrics.from}
					to={metrics.to}
					format={count}
					bind:hover={metrics.hover}
					mode="stacked"
					modes={['stacked']}
					sum
					events={metrics.events}
					bands={incidents}
					empty="Nothing was deployed in this range"
					onZoom={(a, b) => metrics.zoom(a, b)}
				/>
				{@render rank(
					'Build time',
					'How long each recent build took, slowest first. Failed builds are red.',
					builds,
					minutes,
					'No finished builds yet'
				)}
			</div>
		</Disclosure>
	{/if}
</div>

<Modal
	bind:open={reading}
	title={picked?.timestamp
		? `Error at ${new Date(picked.timestamp).toLocaleTimeString()}`
		: 'Error'}
	size="xl"
>
	{#if picked}
		<div class="detail">
			<MetaList
				items={[
					...(picked.metadata?.pod
						? [{ label: picked.metadata.pod, icon: Boxes, mono: true }]
						: []),
					...(pickedDeploy
						? [
								{
									label: `Running ${pickedDeploy.tag}${pickedDeploy.title ? ` ${pickedDeploy.title}` : ''}`,
									icon: GitCommitHorizontal
								}
							]
						: [])
				]}
			/>
			<div class="context">
				<LogViewer lines={context} toolbar filename="error-context" sourceLabel="Pod" />
			</div>
		</div>
	{/if}
</Modal>

<style>
	.board {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.board > :global(.meta) {
		padding-inline: 0.25rem;
		font-size: var(--text-footnote);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		padding-top: 0.5rem;
	}
	.grid > :global(:last-child:nth-child(odd)) {
		grid-column: 1 / -1;
	}
	.rank {
		height: 11rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.empty {
		display: grid;
		place-items: center;
		height: 100%;
		margin: 0;
		color: var(--text-faint);
		font-size: var(--text-callout);
	}
	.info {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--text-faint);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
	}
	.message {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.stale {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		padding-inline: 0.25rem;
		color: var(--status-warning);
		font-size: var(--text-footnote);
	}
	.detail {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.context {
		display: flex;
		height: 24rem;
		padding: 0.75rem 1rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
	}
	@media (max-width: 60rem) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
