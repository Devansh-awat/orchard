<script lang="ts">
	import { tick } from 'svelte';
	import { Globe, Shuffle } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Disclosure,
		Dropdown,
		Field,
		FieldGrid,
		Input,
		Modal,
		ModalIntro,
		SegmentedControl,
		Swap,
		ToggleRow
	} from '$lib/components/ui';
	import DnsSetup from './DnsSetup.svelte';
	import { REDIRECT_STATUS_OPTIONS } from './network';

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
		appDomain,
		cname,
		creating,
		error,
		serviceOptions,
		normalizedHost,
		normalizedPath,
		conflict,
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
		appDomain: string;
		cname: string;
		creating: boolean;
		error: string | null;
		serviceOptions: Array<{ key: string; label: string; serviceName: string; port: number }>;
		normalizedHost: string;
		normalizedPath: string;
		conflict: { otherDeployment: boolean; pathCollision: boolean } | null;
		onCreate: () => void;
		onReset: () => void;
		onGenerate: () => void;
		onCheckDns?: (domain: string) => Promise<{ valid: boolean; message: string }>;
	} = $props();

	const uid = $props.id();

	let mode = $state<'orchard' | 'custom'>('custom');
	let customStash = '';
	let wasOpen = false;

	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) {
			mode = appDomain ? 'orchard' : 'custom';
			customStash = '';
			if (appDomain && !host) onGenerate();
		}
		wasOpen = isOpen;
	});

	const prefix = $derived(
		appDomain && host.endsWith(`.${appDomain}`) ? host.slice(0, -(appDomain.length + 1)) : host
	);

	const portOptions = $derived(serviceOptions.map((o) => ({ value: o.key, label: o.label })));
	const needsPort = $derived(routing === 'service' && serviceOptions.length === 0);
	const advancedNote = $derived(
		[routing === 'service' && normalizedPath !== '/' ? normalizedPath : '', tls ? '' : 'HTTP only']
			.filter(Boolean)
			.join(' · ') || undefined
	);
	const canCreate = $derived(
		!creating &&
			!!normalizedHost &&
			(routing === 'service' ? !!serviceKey : !!redirectTarget.trim()) &&
			!conflict?.pathCollision
	);

	function setMode(next: string) {
		if (next !== 'orchard' && next !== 'custom') return;
		if (next === mode) return;
		if (mode === 'custom') customStash = host;
		mode = next;
		if (next === 'orchard') {
			tls = true;
			if (!host.endsWith(`.${appDomain}`)) onGenerate();
		} else {
			host = customStash;
		}
	}

	function setPrefix(value: string) {
		const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
		host = clean ? `${clean}.${appDomain}` : '';
	}

	function close() {
		open = false;
		onReset();
	}

	function submit() {
		if (canCreate) onCreate();
	}

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => el.focus());
	}
</script>

<Modal bind:open size="md" closable={false} dismissable labelledby="{uid}-title" onclose={onReset}>
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<ModalIntro id="{uid}-title" icon={Globe} title="Add a domain" />

		{#if appDomain}
			<SegmentedControl
				label="Domain type"
				grow
				value={mode}
				onchange={setMode}
				options={[
					{ value: 'orchard', label: `On ${appDomain}` },
					{ value: 'custom', label: 'Your own domain' }
				]}
			/>
		{/if}

		<Swap key={mode}>
			{#if mode === 'orchard'}
				<div class="sub">
					<Input
						id="{uid}-host"
						aria-label="Subdomain"
						placeholder="my-app"
						value={prefix}
						suffix=".{appDomain}"
						oninput={(e: Event) => setPrefix((e.currentTarget as HTMLInputElement).value)}
					/>
					<Button variant="secondary" icon={Shuffle} label="Suggest a name" onclick={onGenerate} />
				</div>
			{:else}
				<div class="stack">
					<Input
						id="{uid}-host"
						aria-label="Domain"
						placeholder="app.example.com"
						mono
						autocomplete="off"
						spellcheck={false}
						bind:value={host}
						{@attach focusOnOpen}
					/>
					<DnsSetup host={normalizedHost} {cname} {onCheckDns} />
				</div>
			{/if}
		</Swap>

		{#if serviceOptions.length > 1 && routing === 'service'}
			<Field label="Port">
				<Dropdown bind:value={serviceKey} options={portOptions} ariaLabel="Port" />
			</Field>
		{/if}

		<Disclosure title="Advanced" note={advancedNote} bind:open={advanced}>
			<div class="stack">
				<ToggleRow
					label="Redirect somewhere else"
					bind:checked={
						() => routing === 'redirect', (on) => (routing = on ? 'redirect' : 'service')
					}
				/>
				<Swap key={routing}>
					{#if routing === 'redirect'}
						<FieldGrid>
							<Field label="Redirect to" for="{uid}-target" hint="Keeps the path and query.">
								<Input
									id="{uid}-target"
									placeholder="example.com"
									mono
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
					{:else}
						<Field label="Path" for="{uid}-path" hint="Only requests under it reach this app.">
							<Input
								id="{uid}-path"
								placeholder="/"
								mono
								width="short"
								autocomplete="off"
								spellcheck={false}
								bind:value={path}
							/>
						</Field>
					{/if}
				</Swap>
				<ToggleRow label="HTTPS" bind:checked={tls} disabled={mode === 'orchard'} />
			</div>
		</Disclosure>

		{#if needsPort}
			<Alert tone="info">Add a port first so the domain has somewhere to send traffic.</Alert>
		{:else if conflict?.pathCollision && routing === 'redirect'}
			<Alert tone="error" title="Domain in use">
				{normalizedHost} already routes traffic. Remove it before adding a redirect.
			</Alert>
		{:else if conflict?.pathCollision}
			<Alert tone="error" title="Path in use">
				<code>{normalizedHost}{normalizedPath}</code> is already routed. Pick another path.
			</Alert>
		{:else if conflict?.otherDeployment}
			<Alert tone="warning" title="Shared domain">
				{normalizedHost} also serves another app. This adds <code>{normalizedPath}</code> to it.
			</Alert>
		{:else if conflict}
			<Alert tone="info">This adds <code>{normalizedPath}</code> to {normalizedHost}.</Alert>
		{/if}

		{#if error}
			<Alert tone="error">{error}</Alert>
		{/if}
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={creating} onclick={close}>Cancel</Button>
		<Button variant="primary" loading={creating} disabled={!canCreate} onclick={submit}
			>Add domain</Button
		>
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
	.sub {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.sub > :global(.wrap) {
		flex: 1;
	}
	.form :global(code) {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}
</style>
