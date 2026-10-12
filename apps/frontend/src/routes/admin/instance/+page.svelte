<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceChecklist, toasts } from '$lib/stores';
	import {
		Alert,
		Button,
		Field,
		Input,
		SectionCard,
		Skeleton,
		ToggleRow
	} from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import McpToggle from '$lib/components/admin/McpToggle.svelte';
	import SandboxesToggle from '$lib/components/admin/SandboxesToggle.svelte';
	import TelemetryToggle from '$lib/components/admin/TelemetryToggle.svelte';

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

	function hintFor(section: Section, name: string) {
		return HINTS[name] ?? section.graft?.fields[name]?.help;
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
				'Where database backups, uploads and cached favicons are written. Until this is set, managed databases have no base backup and a deleted database cannot be recovered.',
			fields: {
				accountId: 'Account ID',
				accessKeyId: 'Access key ID',
				secretAccessKey: 'Secret access key',
				bucketName: 'Bucket',
				endpoint: 'Endpoint',
				publicUrl: 'Public base URL',
				buildContextBucket: 'Build context bucket',
				backupBucket: 'Backup bucket'
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
				'A Cloudflare Turnstile challenge on the sign-in pages and on password-protected deployments. Off until both keys are set. Once set, a sign-in that cannot solve the challenge is refused, so set TURNSTILE_DISABLED=true on the server to get back in if the keys are wrong.',
			fields: {
				siteKey: 'Site key',
				secretKey: 'Secret key',
				enabled: 'Challenge the sign-in pages',
				strict: 'Refuse sign-in when Cloudflare is unreachable'
			}
		},
		'sandbox-runners': {
			title: 'Greenhouse runners',
			description:
				'Where Greenhouse machines run. Kubernetes uses this cluster; Vercel runs them as Vercel Sandboxes on your team. People pick one when they create a machine, and the default is used when they do not.',
			fields: {
				defaultRunner: 'Default runner',
				vercelToken: 'Vercel token',
				vercelTeamId: 'Vercel team ID',
				vercelProjectId: 'Vercel project ID',
				vercelImage: 'Vercel base image',
				vercelVcpus: 'Vercel vCPUs',
				vercelTimeoutMinutes: 'Vercel timeout (minutes)',
				vercelDriveGiB: 'Vercel drive size (GiB)',
				bridgeBinaryUrl: 'Bridge binary URL',
				bridgeBinarySha256: 'Bridge binary SHA-256',
				previewDomain: 'Preview domain',
				kubernetesEnabled: 'Kubernetes runner',
				vercelEnabled: 'Vercel runner'
			}
		},
		'slack-app': {
			title: 'Slack app',
			description:
				'Lets people start Greenhouse sessions with /greenhouse and app mentions, with status posted back to the thread. Point the slash command at <origin>/apiv1/integrations/slack/commands and events at <origin>/apiv1/integrations/slack/events.',
			fields: {
				signingSecret: 'Signing secret',
				botToken: 'Bot token',
				appId: 'App ID'
			}
		},
		linear: {
			title: 'Linear',
			description:
				'A Linear webhook so a comment starting with /greenhouse on an issue starts a session. Point it at <origin>/apiv1/integrations/linear/webhook. Issue pickers work without it; people connect their own API key in their settings.',
			fields: { webhookSecret: 'Webhook signing secret' }
		}
	};

	const HINTS: Record<string, string> = {
		domains: 'Suffix and secret name, for example .apps.example.com=wildcard-tls',
		secure: 'true for port 465, otherwise leave blank',
		endpoint: 'Derived from the account ID when left blank',
		publicUrl: 'Derived from the account ID when left blank',
		publicIp:
			'The routable address of this box, for example 203.0.113.10. Leave blank to require one per organization.',
		siteKey: 'From the Turnstile widget in your Cloudflare dashboard',
		secretKey: 'Never leaves the server. Leave blank to keep the stored one.',
		enabled: 'Ignored until both keys are set. Turning this off keeps the keys.',
		strict: 'Off lets sign-in through unchallenged if the check cannot be reached, and logs it.',
		baseUrl: 'Leave blank for gitlab.com. Callback URL: <origin>/apiv1/git/oauth/gitlab/callback',
		clientId: 'Scopes: read_api, read_repository, read_user',
		key: 'Callback URL: <origin>/apiv1/git/oauth/bitbucket/callback',
		defaultRunner: 'kubernetes or vercel. Leave blank to use the first enabled runner.',
		vercelToken: 'A Vercel access token scoped to the team. Leave blank to keep the stored one.',
		vercelTeamId: 'team_..., from the team settings page',
		vercelProjectId: 'prj_..., the project sandboxes are billed to',
		vercelImage: 'Leave blank for the default Greenhouse image',
		vercelVcpus: 'Whole number from 1 to 8',
		vercelTimeoutMinutes: 'How long a Vercel machine may run before it is stopped, up to 1440',
		vercelDriveGiB:
			"Disk for each machine's home, 1 to 16384 (default 50). New machines only; 0 keeps homes in snapshots",
		bridgeBinaryUrl: 'https:// address of the orchard bridge tarball used for SSH on Vercel',
		bridgeBinarySha256: 'The 64 character hex checksum of that tarball',
		previewDomain:
			'Bare domain whose wildcard points at Orchard, for example preview.example.com. Must not share the Orchard cookie domain.',
		kubernetesEnabled: 'Machines run as Kata VMs in this cluster.',
		vercelEnabled: 'Needs a token, team and project.',
		signingSecret: 'From Basic Information in the Slack app. Never leaves the server.',
		botToken: 'xoxb-..., from OAuth and Permissions',
		appId: 'A0123456789. Optional, used to ignore the app talking to itself.',
		webhookSecret: 'Shown once when you create the webhook in Linear'
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

	onMount(async () => {
		await load();
		loading = false;
	});
</script>

{#if loading}
	<Skeleton class="h-96 w-full" />
{:else}
	{#each sections as section, i (section.id)}
		{@const meta = metaFor(section)}
		{@const allLocked = section.lockedFields.length === Object.keys(meta.fields).length}
		{#if section.id === 'sandbox-runners'}
			<div {@attach motionStagger({ index: i })}>
				<SandboxesToggle />
			</div>
		{/if}
		<div {@attach motionStagger({ index: i })}>
			<SectionCard title={meta.title} description={meta.description}>
				{#if allLocked}
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
								hint={locked ? 'Set by the environment' : hintFor(section, name)}
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

				{#if !allLocked}
					<div class="actions">
						<Button variant="primary" loading={saving === section.id} onclick={() => save(section)}>
							Save
						</Button>
					</div>
				{/if}
			</SectionCard>
		</div>
	{/each}

	<div {@attach motionStagger({ index: sections.length })}>
		<McpToggle />
	</div>

	<div {@attach motionStagger({ index: sections.length + 1 })}>
		<TelemetryToggle />
	</div>
{/if}

<style>
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.85rem;
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
		margin-top: 1.25rem;
	}
</style>
