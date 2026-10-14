<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ChevronDown,
		ExternalLink,
		Loader2,
		Puzzle,
		ShieldAlert,
		ShieldCheck,
		ShieldX
	} from 'lucide-svelte';
	import { Alert, Badge, EmptyState, StatusBadge, statusMeta } from '$lib/components/ui';
	import { apiFetch } from '$lib/stores';
	import { springCollapse, springRotate, motionStagger } from '$lib/utils/motion.svelte';

	type Claim = {
		kind: string;
		value: string;
		state: 'own' | 'alias' | 'shadowed';
		shadowedBy?: string;
	};
	type Route = {
		method: string;
		path: string;
		classification: 'public' | 'authenticated' | 'superadmin';
	};
	type Graft = {
		id: string;
		status: 'loaded' | 'failed';
		phase: string | null;
		reason: string | null;
		warnings: string[];
		name: string;
		version: string | null;
		publisher: string | null;
		description: string | null;
		capabilities: string[];
		permissions: Record<string, { label: string; defaultGrants: string[] }>;
		coreReads: Record<string, string[]>;
		adopts: string[];
		signature: Signature | null;
		claims: Claim[];
		routes: Route[];
		migrationsApplied: string[];
		dbRole: string | null;
		dbPool: { total: number; idle: number; waiting: number; max: number } | null;
		dbPoolSize: { size: number; source: 'values' | 'graft' | 'default' } | null;
		settings: { id: string; title: string }[];
	};
	type Tier = 'official' | 'community' | 'tap' | 'publisher';
	type Signature = {
		tier?: Tier | null;
		keyId: string | null;
		publisher?: string;
		repo?: string;
		tap?: string;
		signedBy: 'official' | 'publisher' | null;
	};
	type Tap = { name: string; url: string; keyId: string };
	type Trust = 'official' | 'listed' | 'taps' | 'any';
	type DbBudget = {
		usable: number;
		inUse: number;
		perPod: number;
		steadyPeak: number;
		rolloutPeak: number;
		level: 'ok' | 'tight' | 'over';
		summary: string;
	};
	type Overview = {
		platform: string;
		sdk: string;
		trust: Trust | 'signed';
		taps?: Tap[];
		database: DbBudget | null;
		grafts: Graft[];
	};

	const POOL_SOURCE = {
		values: 'set in your values',
		graft: 'what the graft asks for',
		default: 'the default'
	} as const;

	const budgetShare = (b: DbBudget) =>
		b.usable > 0 ? Math.min(100, Math.round((b.rolloutPeak / b.usable) * 100)) : 100;

	let overview = $state<Overview | null>(null);
	let loadError = $state<string | null>(null);
	let open = $state<Record<string, boolean>>({});

	onMount(async () => {
		try {
			const res = await apiFetch('/apiv1/admin/grafts');
			if (!res.ok) throw new Error(`Could not load grafts (${res.status})`);
			overview = await res.json();
		} catch (err) {
			loadError = (err as Error).message;
		}
	});

	const TRUST_BADGE: Record<Trust, string> = {
		official: 'Official grafts only',
		listed: 'Official and listed grafts',
		taps: 'Taps allowed',
		any: 'Unsigned grafts allowed'
	};

	const TRUST_COPY: Record<Trust, string> = {
		official: 'Only grafts signed by Orchard can load.',
		listed:
			'Official grafts, community grafts listed in the Extension Marketplace and grafts signed by a publisher key you added can load.',
		taps: 'Official, listed and publisher-key grafts can load, plus grafts from the taps you added.',
		any: 'Unsigned grafts can load. Anything placed in the grafts directory runs.'
	};

	const trust = $derived<Trust>(
		!overview || overview.trust === 'signed' ? 'listed' : overview.trust
	);

	function statusOf(g: Graft) {
		if (g.status === 'failed') return statusMeta('error', `Failed during ${g.phase ?? 'load'}`);
		if (g.warnings.length) return statusMeta('warning', 'Running with warnings');
		return statusMeta('success', 'Running');
	}

	function tierOf(sig: Signature | null): Tier | null {
		if (!sig) return null;
		if (sig.tier !== undefined) return sig.tier;
		return sig.signedBy;
	}

	function tierLabel(g: Graft): {
		tone: 'success' | 'info' | 'warning' | 'error' | 'neutral';
		text: string;
	} {
		const sig = g.signature;
		switch (tierOf(sig)) {
			case 'official':
				return { tone: 'success', text: 'Official' };
			case 'community':
				return { tone: 'info', text: `Community · by ${sig?.publisher ?? 'unknown'}` };
			case 'tap':
				return { tone: 'warning', text: `Tap: ${sig?.tap ?? 'unknown'}` };
			case 'publisher':
				return { tone: 'neutral', text: `Publisher key ${sig?.keyId ?? ''}`.trim() };
			default:
				return { tone: 'error', text: 'Unsigned' };
		}
	}

	const tapUrl = (name: string | undefined) =>
		overview?.taps?.find((t) => t.name === name)?.url ?? null;

	const publicRoutes = (g: Graft) => g.routes.filter((r) => r.classification === 'public');
	const aliasClaims = (g: Graft) => g.claims.filter((c) => c.state !== 'own');
</script>

<div class="grafts">
	<section class="grafts-section">
		<header class="grafts-head">
			<div>
				<h2 class="grafts-title">Grafts</h2>
				<p class="grafts-desc">
					Grafts are Orchard's extensions. They add pages, APIs and integrations to this instance,
					and are installed with <code>orchardctl graft add</code> or your Helm values.
				</p>
			</div>
			{#if overview}
				<Badge tone={trust === 'any' ? 'warning' : trust === 'taps' ? 'info' : 'neutral'}>
					{TRUST_BADGE[trust]}
				</Badge>
			{/if}
		</header>

		<Alert tone="warning" title="Only install grafts you trust">
			A graft runs inside Orchard with the same access Orchard has: your database, your users' data
			and your cluster. The details below show what each graft asked for, but they are not a
			sandbox.
		</Alert>
	</section>

	{#if loadError}
		<Alert tone="error">{loadError}</Alert>
	{:else if !overview}
		<div class="grafts-loading">
			<Loader2 class="h-5 w-5 animate-spin" data-motion="progress" />
		</div>
	{:else if overview.grafts.length === 0}
		<EmptyState
			title="No grafts installed"
			description="Pick one from the Extension Marketplace, then install it from your Orchard host."
		>
			{#snippet icon()}<Puzzle size={20} />{/snippet}
			<pre class="grafts-snippet">orchardctl graft add &lt;id&gt; --apply</pre>
		</EmptyState>
	{:else}
		<p class="grafts-meta">
			{overview.grafts.length}
			{overview.grafts.length === 1 ? 'graft' : 'grafts'} on Orchard {overview.platform}, graft SDK
			{overview.sdk}. {TRUST_COPY[trust]}
		</p>
		{#if overview.database}
			{@const db = overview.database}
			{#if db.level === 'ok'}
				<div class="grafts-budget">
					<p class="grafts-meta">{db.summary} {db.inUse} are open right now.</p>
					<div
						class="grafts-budget-track"
						role="meter"
						aria-label="Database connections at peak"
						aria-valuenow={db.rolloutPeak}
						aria-valuemin={0}
						aria-valuemax={db.usable}
					>
						<div class="grafts-budget-fill" style="width: {budgetShare(db)}%"></div>
					</div>
				</div>
			{:else}
				<Alert
					tone={db.level === 'over' ? 'error' : 'warning'}
					title={db.level === 'over'
						? 'Grafts could run the database out of connections'
						: 'Database connections are getting tight'}
				>
					{db.summary} When the database runs out, new requests fail until connections free up. Lower
					a graft's pool with <code>orchardctl graft pool &lt;id&gt; &lt;n&gt;</code>, or raise
					<code>max_connections</code> on the database.
				</Alert>
			{/if}
		{/if}
		<ul class="grafts-list">
			{#each overview.grafts as g, i (g.id)}
				{@const sig = tierLabel(g)}
				<li class="graft" {@attach motionStagger({ index: i })}>
					<button
						class="graft-row"
						aria-expanded={!!open[g.id]}
						onclick={() => (open = { ...open, [g.id]: !open[g.id] })}
					>
						<span class="graft-icon"><Puzzle size={16} /></span>
						<span class="graft-main">
							<span class="graft-name">
								{g.name}
								{#if g.version}<span class="graft-version">{g.version}</span>{/if}
							</span>
							<span class="graft-sub">
								{g.description ??
									g.id}{#if g.publisher && tierOf(g.signature) !== 'official' && tierOf(g.signature) !== 'community'}&nbsp;·
									says it is by {g.publisher}{/if}
							</span>
						</span>
						<span class="graft-badges">
							<Badge tone={sig.tone}>
								<span class="graft-tier">
									{#if sig.tone === 'error'}<ShieldX
											size={12}
										/>{:else if sig.tone === 'warning'}<ShieldAlert size={12} />{:else}<ShieldCheck
											size={12}
										/>{/if}
									{sig.text}
								</span>
							</Badge>
							<StatusBadge meta={statusOf(g)} />
						</span>
						<span
							class="graft-chevron"
							{@attach springRotate(() => !!open[g.id], { rest: 0, on: 180 })}
						>
							<ChevronDown size={15} />
						</span>
					</button>

					<div class="graft-detail" {@attach springCollapse(() => !open[g.id])}>
						<div class="graft-detail-inner">
							{#if g.status === 'failed'}
								<Alert tone="error" title={`Failed during ${g.phase}`}>{g.reason}</Alert>
							{/if}
							{#each g.warnings as warning (warning)}
								<Alert tone="warning">{warning}</Alert>
							{/each}
							{#if tierOf(g.signature) === 'tap'}
								<Alert tone="warning" title="Third-party graft">
									From the {g.signature?.tap} tap{#if tapUrl(g.signature?.tap)}&nbsp;at
										<code>{tapUrl(g.signature?.tap)}</code>{/if}. Orchard has not checked anything
									in this tap; you are trusting {g.signature?.tap}.
								</Alert>
							{:else if tierOf(g.signature) === 'community'}
								<p class="graft-faint">
									Published by {g.signature?.publisher}{#if g.signature?.repo}&nbsp;(<a
											class="graft-link"
											href="https://github.com/{g.signature.repo}"
											target="_blank"
											rel="noreferrer">github.com/{g.signature.repo}<ExternalLink size={11} /></a
										>){/if}, not by Orchard. Orchard checked it when it was listed, but does not
									review its updates.
								</p>
							{/if}

							<div class="graft-facts">
								<div class="graft-fact">
									<p class="graft-fact-head">Asked for</p>
									{#if g.capabilities.length}
										<div class="graft-chips">
											{#each g.capabilities as cap (cap)}<span class="graft-chip">{cap}</span
												>{/each}
										</div>
									{:else}
										<p class="graft-none">Nothing beyond its own routes</p>
									{/if}
								</div>

								<div class="graft-fact">
									<p class="graft-fact-head">Reads from core tables</p>
									{#if Object.keys(g.coreReads).length}
										{#each Object.entries(g.coreReads) as [table, cols] (table)}
											<p class="graft-mono">{table}({cols.join(', ')})</p>
										{/each}
									{:else}
										<p class="graft-none">None</p>
									{/if}
									{#if g.adopts?.length}
										<p class="graft-faint">
											Took over {g.adopts.join(', ')} from Orchard; the old names still work as views
										</p>
									{/if}
								</div>

								<div class="graft-fact">
									<p class="graft-fact-head">Paths outside /{g.id}</p>
									{#if aliasClaims(g).length}
										{#each aliasClaims(g) as claim (claim.kind + claim.value)}
											<p class="graft-mono" class:graft-shadowed={claim.state === 'shadowed'}>
												{claim.value}
												<span class="graft-faint">
													{claim.state === 'shadowed' ? `taken by ${claim.shadowedBy}` : claim.kind}
												</span>
											</p>
										{/each}
									{:else}
										<p class="graft-none">None</p>
									{/if}
								</div>

								<div class="graft-fact">
									<p class="graft-fact-head">Database</p>
									<p class="graft-mono">schema ext_{g.id.replaceAll('-', '_')}</p>
									<p class="graft-faint">
										{g.dbRole ? `runs as ${g.dbRole}` : 'shares the main database user'} ·
										{#if g.dbPoolSize}
											up to {g.dbPoolSize.size} connections per pod, {POOL_SOURCE[
												g.dbPoolSize.source
											]} ·
										{/if}
										{g.dbPool
											? `${g.dbPool.total - g.dbPool.idle} of ${g.dbPool.max} connections busy on this pod`
											: 'no connections open on this pod'} ·
										{g.migrationsApplied.length} new migrations this boot
									</p>
								</div>
							</div>

							{#if g.routes.length}
								<div class="graft-routes">
									<p class="graft-fact-head">
										{g.routes.length} routes, {publicRoutes(g).length} open to anyone
									</p>
									<ul>
										{#each g.routes as route (route.method + route.path)}
											<li class="graft-route">
												<span class="graft-method">{route.method}</span>
												<span class="graft-mono">{route.path}</span>
												<span
													class="graft-faint graft-route-auth graft-route-auth--{route.classification}"
												>
													{route.classification === 'public'
														? 'no sign-in'
														: route.classification === 'superadmin'
															? 'admins only'
															: 'signed in'}
												</span>
											</li>
										{/each}
									</ul>
								</div>
							{/if}

							{#if g.settings.length}
								<p class="graft-faint">
									Settings live under <a href="/admin/instance">Configuration</a>:
									{g.settings.map((s) => s.title).join(', ')}.
								</p>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if overview?.taps?.length}
		<section class="grafts-section">
			<div>
				<h3 class="grafts-subtitle">Taps</h3>
				<p class="grafts-meta">
					Graft catalogues you added with <code>orchardctl graft tap add</code>. Orchard has not
					checked them; grafts from a tap must be signed with its key{trust === 'taps' ||
					trust === 'any'
						? '.'
						: ', and only load once the trust policy allows taps.'}
				</p>
			</div>
			<ul class="grafts-taps">
				{#each overview.taps as tap (tap.name)}
					<li class="grafts-tap">
						<span class="graft-name">{tap.name}</span>
						<span class="graft-mono">{tap.url}</span>
						<span class="graft-faint">key {tap.keyId}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.grafts {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.grafts-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.grafts-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.grafts-title {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 600;
		margin: 0;
		color: var(--text-default);
	}

	.grafts-desc,
	.grafts-meta {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0.25rem 0 0;
		max-width: 64ch;
	}

	.grafts-desc code,
	.grafts-snippet {
		font-family: var(--font-mono, monospace);
		font-size: 0.85em;
	}

	.grafts-snippet {
		margin: 0.75rem 0 0;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		color: var(--text-default);
	}

	.grafts-loading {
		display: flex;
		justify-content: center;
		padding: 3rem;
		color: var(--text-muted);
	}

	.grafts-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.graft {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
		overflow: hidden;
	}

	.graft-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.7rem 0.85rem;
		background: none;
		border: 0;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.graft-row:hover {
		background: var(--bg-hover);
	}

	.graft-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		background: var(--bg-raised);
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.graft-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.graft-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 500;
		color: var(--text-default);
	}

	.graft-version {
		margin-left: 0.35rem;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		color: var(--text-faint);
		font-weight: 400;
	}

	.graft-sub,
	.graft-faint {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.graft-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.graft-badges {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.graft-tier {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		white-space: nowrap;
	}

	.graft-link {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		color: var(--text-muted);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.graft-link:hover {
		color: var(--text-default);
	}

	.grafts-subtitle {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.grafts-meta code {
		font-family: var(--font-mono, monospace);
		font-size: 0.85em;
	}

	.grafts-taps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
	}

	.grafts-tap {
		display: grid;
		grid-template-columns: minmax(6rem, auto) minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.6rem 0.85rem;
	}

	.grafts-tap + .grafts-tap {
		border-top: 1px solid var(--border-default);
	}

	.graft-chevron {
		display: flex;
		color: var(--text-faint);
	}

	.graft-detail {
		overflow: hidden;
	}

	.graft-detail-inner {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 0.25rem 0.85rem 1rem 3.6rem;
	}

	.graft-facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
		gap: 1rem;
	}

	.graft-fact {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}

	.graft-fact-head {
		margin: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-muted);
	}

	.graft-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.graft-chip {
		padding: 0.1rem 0.45rem;
		border-radius: var(--radius-sm);
		background: var(--bg-raised);
		border: 1px solid var(--border-default);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		color: var(--text-default);
	}

	.graft-mono {
		margin: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.graft-none {
		margin: 0;
		font-size: var(--text-micro);
		color: var(--text-faint);
	}

	.graft-shadowed {
		text-decoration: line-through;
		color: var(--text-faint);
	}

	.graft-routes ul {
		list-style: none;
		margin: 0.4rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		max-height: 16rem;
		overflow: auto;
	}

	.graft-route {
		display: grid;
		grid-template-columns: 4rem minmax(0, 1fr) auto;
		gap: 0.6rem;
		align-items: baseline;
	}

	.graft-method {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		color: var(--text-muted);
	}

	.graft-route-auth--public {
		color: var(--status-warning);
	}
	.grafts-budget {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.grafts-budget-track {
		height: 0.375rem;
		border-radius: 999px;
		background: var(--bg-raised);
		overflow: hidden;
	}
	.grafts-budget-fill {
		height: 100%;
		border-radius: inherit;
		background: color-mix(in oklab, var(--text-default) 35%, transparent);
	}
</style>
