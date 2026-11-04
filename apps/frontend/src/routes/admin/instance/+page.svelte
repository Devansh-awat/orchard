<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceChecklist, instanceFeatures, toasts } from '$lib/stores';
	import { STORAGE_PROVIDERS, storageProvider } from '$lib/storage-providers';
	import {
		Alert,
		Button,
		Field,
		Input,
		SectionCard,
		Select,
		Skeleton,
		ToggleRow
	} from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import McpToggle from '$lib/components/admin/McpToggle.svelte';
	import ResourceLimitsSetting from '$lib/components/admin/ResourceLimitsSetting.svelte';
	import DatabaseSettings from '$lib/components/admin/DatabaseSettings.svelte';
	import ImageScanning from '$lib/components/admin/ImageScanning.svelte';
	import TelemetryToggle from '$lib/components/admin/TelemetryToggle.svelte';
	import SettingCommand from '$lib/components/setup/SettingCommand.svelte';
	import {
		settingChanges,
		type SettingChange,
		type SettingChanges
	} from '$lib/components/setup/setting-changes';
	import type { SetupOverview } from '$lib/components/setup/setup-overview';

	type Section = {
		id: string;
		configured: boolean;
		values: Record<string, string | null>;
		lockedFields: string[];
		secretFields: string[];
		boolFields: string[];
		graft?: {
			id: string;
			title: string;
			description?: string;
			fields: Record<string, { label: string; help?: string }>;
		};
	};

	function metaFor(section: Section) {
		if (META[section.id]) return META[section.id];
		const g = section.graft!;
		return {
			title: g.title,
			description: `${g.description ? `${g.description} ` : ''}Added by the ${g.id} graft.`,
			fields: Object.fromEntries(Object.entries(g.fields).map(([name, f]) => [name, f.label]))
		};
	}

	const LOCKED_CHANGES: Record<string, keyof SettingChanges> = {
		appDomain: 'apps',
		publicIp: 'public-ip',
		cname: 'custom-domains'
	};

	let overview = $state<SetupOverview | null>(null);
	const changes = $derived(settingChanges(overview));

	function lockedChanges(section: Section): SettingChange[] {
		return section.lockedFields
			.map((name) => changes[LOCKED_CHANGES[name]])
			.filter((change): change is SettingChange => !!change);
	}

	async function loadOverview() {
		const response = await apiFetch('/apiv1/setup/overview');
		if (response.ok) overview = await response.json();
	}

	function hintFor(section: Section, name: string) {
		return section.graft ? section.graft.fields[name]?.help : HINTS[name];
	}

	// A section with no entry here is not rendered. The Cloudflare tunnel is the
	// deliberate case: its credentials only make sense next to the routes they
	// manage, so it lives on the Networking page instead.
	const META: Record<
		string,
		{ title: string; description: string; fields: Record<string, string> }
	> = {
		storage: {
			title: 'Object storage',
			description:
				'Where database backups, uploads and build contexts go. Any S3-compatible provider works. The access key needs to list, read, write and delete in each bucket.',
			fields: {
				endpoint: 'Endpoint',
				region: 'Region',
				accessKeyId: 'Access key ID',
				secretAccessKey: 'Secret access key',
				backupBucket: 'Backup bucket',
				bucketName: 'Uploads bucket',
				pathStyle: 'Path-style addressing',
				publicUrl: 'Public base URL',
				buildContextBucket: 'Build context bucket',
				accountId: 'Account ID'
			}
		},
		email: {
			title: 'Email',
			description:
				'Sends invitations and sign-in codes. Without it invitations still work as copyable links.',
			fields: {
				host: 'Host',
				port: 'Port',
				user: 'Username',
				pass: 'Password',
				secure: 'Implicit TLS',
				from: 'From address',
				fromName: 'From name'
			}
		},
		ingress: {
			title: 'Custom domains',
			description:
				'The hostname people point their own domains at with a CNAME. Without it Orchard cannot check DNS before issuing a certificate.',
			fields: { cname: 'CNAME target' }
		},
		wildcard: {
			title: 'Wildcard certificate',
			description:
				'One certificate for every generated app URL, instead of one each against a limit of 50 per week per domain.',
			fields: {
				appDomain: 'App domain',
				domains: 'Wildcard domains',
				sourceNamespace: 'Certificate namespace'
			}
		},
		network: {
			title: 'Public exposure',
			description:
				'The address raw TCP and UDP ports and public databases are published on. Organizations that set their own override it; the rest inherit this instead of being asked for an IP they do not know.',
			fields: { publicIp: 'Default public IP' }
		},
		'git-gitlab': {
			title: 'GitLab sign-in',
			description:
				'An OAuth application on GitLab so people can connect their account with one click. Register it with the callback URL below. For a self-hosted GitLab, set the base URL.',
			fields: { baseUrl: 'GitLab URL', clientId: 'Application ID', clientSecret: 'Secret' }
		},
		'git-bitbucket': {
			title: 'Bitbucket sign-in',
			description:
				'An OAuth consumer on Bitbucket Cloud so people can connect their account with one click. Grant it repository read and give it the callback URL below.',
			fields: { key: 'Key', secret: 'Secret' }
		},
		turnstile: {
			title: 'Bot protection',
			description:
				'A Cloudflare Turnstile challenge on the sign-in pages and on password-protected deployments. Off until both keys are set. Once set, a sign-in that cannot solve the challenge is refused, so set TURNSTILE_ENABLED=false on the server to get back in if the keys are wrong.',
			fields: {
				siteKey: 'Site key',
				secretKey: 'Secret key',
				enabled: 'Challenge the sign-in pages',
				strict: 'Refuse sign-in when Cloudflare is unreachable'
			}
		}
	};

	const HINTS: Record<string, string> = {
		domains: 'Suffix and secret name, for example .apps.example.com=wildcard-tls',
		secure: 'true for port 465, otherwise leave blank',
		endpoint: 'For example https://s3.eu-west-1.amazonaws.com',
		accountId: 'Cloudflare R2 only. Fills in the endpoint when that is blank.',
		bucketName: 'Holds uploads and cached images. It can be the same bucket.',
		backupBucket: 'Holds database backups.',
		buildContextBucket: 'Optional. Empty uses the bucket above, for orchard up.',
		publicUrl: 'Optional. Empty serves uploads through Orchard, so the bucket stays private.',
		region: 'Empty means auto, which Cloudflare R2 expects.',
		pathStyle: 'true sends requests to <endpoint>/<bucket>, false to <bucket>.<endpoint>.',
		publicIp:
			'The routable address of this box, for example 203.0.113.10. Leave blank to require one per organization.',
		siteKey: 'From the Turnstile widget in your Cloudflare dashboard',
		secretKey: 'Never leaves the server. Leave blank to keep the stored one.',
		enabled: 'Ignored until both keys are set. Turning this off keeps the keys.',
		strict: 'Off lets sign-in through unchallenged if the check cannot be reached, and logs it.',
		baseUrl: 'Leave blank for gitlab.com. Callback URL: <origin>/apiv1/git/oauth/gitlab/callback',
		clientId: 'Scopes: read_api, read_repository, read_user',
		key: 'Callback URL: <origin>/apiv1/git/oauth/bitbucket/callback'
	};

	let sections = $state<Section[]>([]);
	let drafts = $state<Record<string, Record<string, string>>>({});
	let saving = $state<string | null>(null);
	let loading = $state(true);

	function seed(list: Section[]) {
		const next: Record<string, Record<string, string>> = {};
		for (const section of list) {
			next[section.id] = {};
			for (const [name, value] of Object.entries(section.values)) {
				next[section.id][name] = value ?? '';
			}
		}
		drafts = next;
	}

	async function load() {
		const response = await apiFetch('/apiv1/admin/instance-config');
		if (!response.ok) return;
		const all: Section[] = await response.json();
		sections = all.filter((s) => s.id in META || !!s.graft);
		seed(sections);
	}

	function toggleFlag(section: Section, name: string) {
		if (section.lockedFields.includes(name)) return;
		drafts[section.id][name] = drafts[section.id][name] === 'true' ? 'false' : 'true';
	}

	async function save(section: Section) {
		saving = section.id;
		try {
			const response = await apiFetch(`/apiv1/admin/instance-config/${section.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(drafts[section.id] ?? {})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || 'Could not save');
			}
			const updated: Section = await response.json();
			sections = sections.map((s) => (s.id === updated.id ? updated : s));
			seed(sections);
			await instanceChecklist.load(true);
			if (section.id === 'storage') await instanceFeatures.load(true);
			toasts.add({ title: `${metaFor(section).title} saved`, color: 'success' });
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Could not save',
				color: 'error'
			});
		} finally {
			saving = null;
		}
	}

	let storagePreset = $state('');
	let storagePlace = $state('');
	let storageTesting = $state(false);
	let storageResult = $state<{ ok: boolean; message?: string } | null>(null);
	const presetProvider = $derived(storagePreset ? storageProvider(storagePreset) : null);

	function applyStoragePreset() {
		if (!presetProvider || !drafts.storage) return;
		const place = storagePlace.trim() || presetProvider.placeDefault;
		const locked = sections.find((s) => s.id === 'storage')?.lockedFields ?? [];
		const set = (name: string, value: string) => {
			if (!locked.includes(name)) drafts.storage[name] = value;
		};
		if (presetProvider.placeLabel) {
			set('endpoint', presetProvider.endpoint(place));
			set('region', presetProvider.region(place));
		}
		set('pathStyle', String(presetProvider.pathStyle));
		storageResult = null;
	}

	async function testStorage() {
		storageTesting = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/storage/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(drafts.storage ?? {})
			});
			const body = await response.json().catch(() => ({}));
			storageResult =
				response.ok && typeof body.ok === 'boolean'
					? body
					: { ok: false, message: body?.message || 'The connection test failed.' };
		} catch {
			storageResult = { ok: false, message: 'The connection test failed.' };
		} finally {
			storageTesting = false;
		}
	}

	onMount(async () => {
		await Promise.all([load(), loadOverview()]);
		loading = false;
		instanceFeatures.load(true).catch(() => undefined);
		if (window.location.hash === '#storage') {
			document.getElementById('storage')?.scrollIntoView();
		}
	});
</script>

{#if loading}
	<Skeleton class="h-96 w-full" />
{:else}
	{#each sections as section, i (section.id)}
		{@const meta = metaFor(section)}
		{@const allLocked = section.lockedFields.length === Object.keys(meta.fields).length}
		<div id={section.id} {@attach motionStagger({ index: i })}>
			<SectionCard title={meta.title} description={meta.description}>
				{#if section.id === 'storage' && !allLocked}
					{#if $instanceFeatures.storage.backups === 'local'}
						<p class="storage-note">
							Backups are on this server. If the server is lost, the backups are lost.
						</p>
					{/if}
					<div class="preset">
						<Field label="Provider" for="storage-preset">
							<Select id="storage-preset" bind:value={storagePreset} onchange={applyStoragePreset}>
								<option value="">Choose to fill in the fields</option>
								{#each STORAGE_PROVIDERS as provider (provider.id)}
									<option value={provider.id}>{provider.label}</option>
								{/each}
							</Select>
						</Field>
						{#if presetProvider?.placeLabel}
							<Field label={presetProvider.placeLabel} for="storage-place">
								<Input
									id="storage-place"
									placeholder={presetProvider.placeDefault}
									bind:value={storagePlace}
									oninput={applyStoragePreset}
								/>
							</Field>
						{/if}
					</div>
				{/if}
				{#if allLocked && lockedChanges(section).length === 0}
					<Alert tone="info" title="Set by the environment">
						Every field here comes from an environment variable, so it cannot be changed from the
						browser. Edit your values file and restart to change it.
					</Alert>
				{/if}

				<div class="fields">
					{#each Object.entries(meta.fields) as [name, label] (name)}
						{#if !section.boolFields.includes(name)}
							{@const locked = section.lockedFields.includes(name)}
							{@const secret = section.secretFields.includes(name)}
							<Field
								{label}
								for="{section.id}-{name}"
								hint={locked
									? changes[LOCKED_CHANGES[name]]
										? 'Cannot be edited here.'
										: 'Set by the environment'
									: hintFor(section, name)}
							>
								<Input
									id="{section.id}-{name}"
									type={secret ? 'password' : 'text'}
									disabled={locked}
									placeholder={secret && section.configured ? 'Unchanged' : ''}
									bind:value={drafts[section.id][name]}
								/>
							</Field>
						{/if}
					{/each}
				</div>

				{#each lockedChanges(section) as change (change.title)}
					<div class="locked-change">
						<SettingCommand {change} />
					</div>
				{/each}

				{#if section.boolFields.length > 0}
					<div class="switches">
						{#each section.boolFields as name (name)}
							{@const locked = section.lockedFields.includes(name)}
							<ToggleRow
								label={meta.fields[name] ?? name}
								hint={locked ? 'Set by the environment' : hintFor(section, name)}
								disabled={locked}
								checked={drafts[section.id][name] === 'true'}
								onchange={() => toggleFlag(section, name)}
							/>
						{/each}
					</div>
				{/if}

				{#if section.id === 'storage' && !allLocked}
					<p class="storage-note">
						Changing storage applies to new databases. Databases you already have keep backing up to
						where they are now, and their existing backups stay restorable from there.
					</p>
					{#if storageResult}
						<p class="storage-result" role="status">
							{storageResult.ok ? 'Connection works.' : storageResult.message}
						</p>
					{/if}
				{/if}

				{#if !allLocked}
					<div class="actions">
						{#if section.id === 'storage'}
							<Button loading={storageTesting} onclick={testStorage}>Test connection</Button>
						{/if}
						<Button variant="primary" loading={saving === section.id} onclick={() => save(section)}>
							Save
						</Button>
					</div>
				{/if}
			</SectionCard>
		</div>
	{/each}

	<div {@attach motionStagger({ index: sections.length })}>
		<ResourceLimitsSetting change={changes.limits} />
	</div>

	<div {@attach motionStagger({ index: sections.length + 1 })}>
		<McpToggle change={changes.mcp} />
	</div>

	<div {@attach motionStagger({ index: sections.length + 2 })}>
		<ImageScanning />
	</div>

	<div {@attach motionStagger({ index: sections.length + 3 })}>
		<DatabaseSettings />
	</div>

	<div {@attach motionStagger({ index: sections.length + 4 })}>
		<TelemetryToggle />
	</div>
{/if}

<style>
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.85rem;
	}

	.locked-change {
		margin-top: 1rem;
	}

	.switches {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-top: 1rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}

	.preset {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.85rem;
		margin-bottom: 0.85rem;
	}

	.storage-note,
	.storage-result {
		font-size: var(--text-callout);
		color: var(--text-muted);
		margin: 0 0 0.85rem;
	}

	.fields + .storage-note {
		margin-top: 1rem;
	}

	.storage-result {
		color: var(--text-default);
		margin-top: 0.5rem;
	}
</style>
