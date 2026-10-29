<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { ChevronRight, Globe, Link, MonitorSmartphone, Plug, Shuffle } from 'lucide-svelte';
	import {
		Alert,
		Badge,
		Button,
		Disclosure,
		Dropdown,
		Field,
		FieldGrid,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SegmentedControl,
		Swap,
		ToggleRow,
		ToneTile
	} from '$lib/components/ui';
	import DnsSetup from './DnsSetup.svelte';
	import { REDIRECT_STATUS_OPTIONS } from './network';

	type ProjectRoute = {
		host: string;
		path?: string;
		deploymentId?: string | null;
		deploymentName?: string;
	};

	let {
		open = $bindable(false),
		host = $bindable(),
		path = $bindable(),
		tls = $bindable(),
		serviceKey = $bindable(),
		routing = $bindable(),
		redirectTarget = $bindable(),
		redirectStatus = $bindable(),
		advanced = $bindable(),
		portLocked = false,
		target = null,
		kinds = { web: true, raw: false, tailnet: false, tailnetLinked: false },
		onOpenRaw = () => {},
		onJoinTailnet = () => {},
		deploymentId,
		projectRoutes,
		appDomain,
		cname,
		creating,
		error,
		serviceOptions,
		normalizedHost,
		normalizedPath,
		onCreate,
		onReset,
		onGenerate,
		onCheckDns = undefined
	}: {
		open: boolean;
		host: string;
		path: string;
		tls: boolean;
		serviceKey: string;
		routing: 'service' | 'redirect';
		redirectTarget: string;
		redirectStatus: string;
		advanced: boolean;
		portLocked?: boolean;
		target?: { port: number; protocol: string; public: boolean } | null;
		kinds?: { web: boolean; raw: boolean; tailnet: boolean; tailnetLinked: boolean };
		onOpenRaw?: () => void;
		onJoinTailnet?: () => void;
		deploymentId: string;
		projectRoutes: ProjectRoute[];
		appDomain: string;
		cname: string;
		creating: boolean;
		error: string | null;
		serviceOptions: Array<{ key: string; label: string; serviceName: string; port: number }>;
		normalizedHost: string;
		normalizedPath: string;
		onCreate: () => Promise<boolean>;
		onReset: () => void;
		onGenerate: () => void;
		onCheckDns?: (domain: string) => Promise<{ valid: boolean; message: string }>;
	} = $props();

	const uid = $props.id();

	type Step = 'choose' | 'address' | 'raw' | 'dns';

	let step = $state<Step>('address');
	let chose = $state(false);
	let created = $state('');
	let wasOpen = false;

	const choiceCount = $derived([kinds.web, kinds.raw, kinds.tailnet].filter(Boolean).length);

	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) {
			chose = choiceCount > 1;
			step = chose ? 'choose' : kinds.raw && !kinds.web ? 'raw' : 'address';
			created = '';
			if (appDomain && !host) onGenerate();
		}
		wasOpen = isOpen;
	});

	function pick(next: Step) {
		step = next;
	}

	function joinTailnet() {
		onJoinTailnet();
		close();
	}

	function openRaw() {
		onOpenRaw();
		close();
	}

	const onAppDomain = $derived(!!appDomain && normalizedHost.endsWith(`.${appDomain}`));
	const address = $derived(host + (path && path !== '/' ? path : ''));
	const portLabel = $derived(serviceOptions.find((o) => o.key === serviceKey)?.label ?? '');
	const portOptions = $derived(serviceOptions.map((o) => ({ value: o.key, label: o.label })));
	const choosePort = $derived(!portLocked && routing === 'service' && serviceOptions.length > 1);
	const needsPort = $derived(routing === 'service' && serviceOptions.length === 0);

	const sharedRoutes = $derived(
		normalizedHost
			? projectRoutes
					.filter((r) => r.host === normalizedHost)
					.map((r) => ({
						path: r.path || '/',
						name: r.deploymentId === deploymentId ? 'This app' : (r.deploymentName ?? 'Another app')
					}))
					.sort((a, b) => a.path.localeCompare(b.path))
			: []
	);
	const taken = $derived(
		routing === 'redirect'
			? sharedRoutes.length > 0
			: sharedRoutes.some((r) => r.path === normalizedPath)
	);
	const routeMap = $derived(
		sharedRoutes.length > 0 && routing === 'service' && !taken
			? [...sharedRoutes, { path: normalizedPath, name: 'This app', fresh: true }].sort((a, b) =>
					a.path.localeCompare(b.path)
				)
			: sharedRoutes.map((r) => ({ ...r, fresh: false }))
	);
	const advancedNote = $derived([tls ? '' : 'HTTP only'].filter(Boolean).join(' · ') || undefined);
	const canCreate = $derived(
		!creating &&
			!!normalizedHost &&
			(routing === 'service' ? !!serviceKey : !!redirectTarget.trim()) &&
			!taken
	);

	let draft = $state('');

	function parse(value: string) {
		const clean = value.trim().replace(/^[a-z]+:\/\//i, '');
		const slash = clean.indexOf('/');
		return {
			host: (slash === -1 ? clean : clean.slice(0, slash)).toLowerCase(),
			path: slash === -1 ? '/' : clean.slice(slash) || '/'
		};
	}

	$effect(() => {
		const next = { host, path: path || '/' };
		untrack(() => {
			const current = parse(draft);
			if (current.host !== next.host || current.path !== next.path) draft = address;
		});
	});

	function setAddress(value: string) {
		draft = value;
		const next = parse(value);
		host = next.host;
		path = next.path;
		if (appDomain && next.host.endsWith(`.${appDomain}`)) tls = true;
	}

	function routeLabel(route: { name: string; fresh: boolean; path: string }) {
		if (route.fresh) return 'This app';
		if (taken && route.path === normalizedPath)
			return `Taken by ${route.name === 'This app' ? 'this app' : route.name}`;
		return route.name;
	}

	function close() {
		open = false;
		onReset();
	}

	async function submit() {
		if (!canCreate) return;
		const target = normalizedHost;
		const custom = !onAppDomain && routing === 'service';
		const ok = await onCreate();
		if (!ok) return;
		if (custom) {
			created = target;
			step = 'dns';
		} else {
			close();
		}
	}

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => {
			el.focus();
			el.select();
		});
	}
</script>

<Modal bind:open size="md" closable={false} dismissable labelledby="{uid}-title" onclose={onReset}>
	<Swap key={step}>
		{#if step === 'choose'}
			<div class="form">
				<ModalIntro
					id="{uid}-title"
					icon={Globe}
					tone="info"
					solid
					title={target?.public
						? `Another way into port ${target.port}`
						: `Make port ${target?.port ?? ''} public`}
				/>
				<List label="Ways to reach it">
					{#if kinds.web}
						<ListRow title="Add a domain" onclick={() => pick('address')}>
							{#snippet leading()}
								<ToneTile tone="info" solid size={32}
									><Globe size={16} strokeWidth={2.25} /></ToneTile
								>
							{/snippet}
							{#snippet trailing()}<ChevronRight size={16} />{/snippet}
						</ListRow>
					{/if}
					{#if kinds.raw}
						<ListRow title="Open a public port" onclick={() => pick('raw')}>
							{#snippet leading()}
								<ToneTile tone="success" solid size={32}
									><Plug size={16} strokeWidth={2.25} /></ToneTile
								>
							{/snippet}
							{#snippet trailing()}<ChevronRight size={16} />{/snippet}
						</ListRow>
					{/if}
					{#if kinds.tailnet}
						<ListRow
							title="Your devices"
							subtitle={kinds.tailnetLinked ? undefined : 'Link Tailscale in your settings first'}
							href={kinds.tailnetLinked ? undefined : '/user/settings'}
							onclick={kinds.tailnetLinked ? joinTailnet : undefined}
						>
							{#snippet leading()}
								<ToneTile tone="neutral" solid size={32}
									><MonitorSmartphone size={16} strokeWidth={2.25} /></ToneTile
								>
							{/snippet}
							{#snippet trailing()}<ChevronRight size={16} />{/snippet}
						</ListRow>
					{/if}
				</List>
			</div>
		{:else if step === 'raw'}
			<div class="form">
				<ModalIntro
					id="{uid}-title"
					icon={Plug}
					tone="success"
					solid
					title={target
						? `Open port ${target.port} to the internet`
						: 'Open a port to the internet'}
				/>
				<Alert tone="warning">This port will be accessible to anyone on the internet.</Alert>
			</div>
		{:else if step === 'dns'}
			<div class="form">
				<ModalIntro
					id="{uid}-title"
					icon={Globe}
					tone="info"
					solid
					title="Point your DNS"
					description={cname ? `Add this record where ${created} is registered.` : created}
				/>
				<DnsSetup host={created} {cname} watch {onCheckDns} />
			</div>
		{:else}
			<form
				class="form"
				onsubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<ModalIntro id="{uid}-title" icon={Globe} tone="info" solid title="Add a domain" />

				<div class="address">
					<Input
						id="{uid}-host"
						aria-label="Domain"
						placeholder="app.example.com"
						size="lg"
						icon={Link}
						autocomplete="off"
						spellcheck={false}
						bind:value={() => draft, setAddress}
						{@attach focusOnOpen}
					/>
					{#if appDomain}
						<Button
							variant="secondary"
							icon={Shuffle}
							label="Suggest a name on {appDomain}"
							onclick={onGenerate}
						/>
					{/if}
				</div>

				{#if routeMap.length > 0}
					<div class="routes" aria-label="Paths on {normalizedHost}">
						{#each routeMap as route (route.path + route.name)}
							<div
								class="route"
								class:route--fresh={route.fresh}
								class:route--taken={taken && route.path === normalizedPath}
							>
								<span class="route-path">{route.path}</span>
								<span class="route-app"
									>{routeLabel(route)}{#if route.fresh}<Badge>New</Badge>{/if}</span
								>
							</div>
						{/each}
					</div>
				{/if}

				<SegmentedControl
					label="What the domain does"
					grow
					value={routing}
					onchange={(next) => (routing = next === 'redirect' ? 'redirect' : 'service')}
					options={[
						{ value: 'service', label: 'Point to this app' },
						{ value: 'redirect', label: 'Redirect' }
					]}
				/>

				{#if choosePort}
					<Field label="Port">
						<Dropdown bind:value={serviceKey} options={portOptions} ariaLabel="Port" />
					</Field>
				{/if}

				{#if routing === 'redirect'}
					<FieldGrid>
						<Field label="Redirect to" for="{uid}-target">
							<Input
								id="{uid}-target"
								placeholder="example.com"
								autocomplete="off"
								spellcheck={false}
								bind:value={redirectTarget}
							/>
						</Field>
						<Field label="Status">
							<Dropdown
								bind:value={redirectStatus}
								options={REDIRECT_STATUS_OPTIONS}
								ariaLabel="Redirect status"
							/>
						</Field>
					</FieldGrid>
				{/if}

				<Disclosure title="Advanced" note={advancedNote} bind:open={advanced}>
					<ToggleRow label="HTTPS" bind:checked={tls} disabled={onAppDomain} />
				</Disclosure>

				{#if needsPort}
					<Alert tone="info">Add a port first so the domain has somewhere to send traffic.</Alert>
				{:else if taken && routing === 'redirect'}
					<Alert tone="error"
						>{normalizedHost} already serves apps. Remove them to redirect it.</Alert
					>
				{/if}

				{#if error}
					<Alert tone="error">{error}</Alert>
				{/if}
			</form>
		{/if}
	</Swap>
	{#snippet footer()}
		{#if step === 'dns'}
			<Button variant="primary" onclick={close}>Done</Button>
		{:else if step === 'choose'}
			<Button variant="ghost" onclick={close}>Cancel</Button>
		{:else}
			{#if chose}
				<Button variant="ghost" disabled={creating} onclick={() => pick('choose')}>Back</Button>
			{:else}
				<Button variant="ghost" disabled={creating} onclick={close}>Cancel</Button>
			{/if}
			{#if step === 'raw'}
				<Button variant="primary" onclick={openRaw}>Open port</Button>
			{:else}
				<Button variant="primary" loading={creating} disabled={!canCreate} onclick={submit}
					>Add domain</Button
				>
			{/if}
		{/if}
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.address {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.address > :global(.wrap) {
		flex: 1;
	}
	.routes {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		column-gap: 1.5rem;
		margin-top: -0.75rem;
		padding: 0.25rem 0;
	}
	.route {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: baseline;
		padding-block: 0.3125rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.route:not(:first-child) {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.route-path {
		color: var(--text-default);
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
	}
	.route-app {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.route-app {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.route--fresh .route-path,
	.route--fresh .route-app {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.route--taken .route-path,
	.route--taken .route-app {
		color: var(--status-error);
	}
</style>
