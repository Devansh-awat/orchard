<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceChecklist, toasts } from '$lib/stores';
	import { Alert, Button, Field, Input, SectionCard, Skeleton } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import McpToggle from '$lib/components/admin/McpToggle.svelte';

	type Section = {
		id: string;
		configured: boolean;
		values: Record<string, string | null>;
		lockedFields: string[];
		secretFields: string[];
	};

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
				buildContextBucket: 'Build context bucket'
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
		}
	};

	const HINTS: Record<string, string> = {
		domains: 'Suffix and secret name, for example .apps.example.com=wildcard-tls',
		secure: 'true for port 465, otherwise leave blank',
		endpoint: 'Derived from the account ID when left blank',
		publicUrl: 'Derived from the account ID when left blank',
		publicIp:
			'The routable address of this box, for example 203.0.113.10. Leave blank to require one per organization.'
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
		sections = all.filter((s) => s.id in META);
		seed(sections);
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
			toasts.add({ title: `${META[section.id].title} saved`, color: 'success' });
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
		{@const meta = META[section.id]}
		{@const allLocked = section.lockedFields.length === Object.keys(meta.fields).length}
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
						{@const locked = section.lockedFields.includes(name)}
						{@const secret = section.secretFields.includes(name)}
						<Field
							{label}
							for="{section.id}-{name}"
							hint={locked ? 'Set by the environment' : HINTS[name]}
						>
							<Input
								id="{section.id}-{name}"
								type={secret ? 'password' : 'text'}
								disabled={locked}
								placeholder={secret && section.configured ? 'Unchanged' : ''}
								bind:value={drafts[section.id][name]}
							/>
						</Field>
					{/each}
				</div>

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
{/if}

<style>
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.85rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1.25rem;
	}
</style>
