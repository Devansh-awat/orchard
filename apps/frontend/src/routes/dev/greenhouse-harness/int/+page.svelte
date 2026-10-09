<script lang="ts">
	import { page } from '$app/state';
	import ShareViewer from '$lib/components/greenhouse/ShareViewer.svelte';
	import SlackLink from '$lib/components/greenhouse/SlackLink.svelte';
	import { UserGreenhouseAccounts } from '$lib/components/user-settings';
	import AdminInstance from '../../../admin/instance/+page.svelte';
	import * as data from '$lib/components/greenhouse/demo/data';
	import {
		installRoutes,
		integrationRoutes,
		json,
		type Route
	} from '$lib/components/greenhouse/demo/mock';

	const view = page.url.searchParams.get('view') ?? 'share';
	const share = page.url.searchParams.get('share') ?? 'ok';

	const shareRoutes: Route[] = [
		[
			/^\/apiv1\/share\/sandbox$/,
			'GET',
			() =>
				share === 'revoked'
					? json({ message: 'This share link is invalid, expired or revoked' }, 404)
					: share === 'org'
						? json(
								{ message: "Share links only open for members of the machine's organization" },
								403
							)
						: data.shareView
		],
		[/\/share\/sandbox\/sessions\/[^/]+\/transcript$/, 'GET', () => data.shareTranscript],
		[/\/share\/sandbox\/sessions\/[^/]+\/changes$/, 'GET', () => data.changes],
		[
			/\/share\/sandbox\/sessions\/[^/]+\/diff$/,
			'GET',
			() => ({ diff: data.shareDiff, truncated: false })
		]
	];

	const adminRoutes: Route[] = [
		[
			/^\/apiv1\/admin\/instance-config$/,
			'GET',
			() => [
				{
					id: 'sandbox-runners',
					configured: true,
					values: {
						kubernetesEnabled: 'true',
						vercelEnabled: 'true',
						defaultRunner: 'kubernetes',
						vercelToken: null,
						vercelTeamId: 'team_hackclub',
						vercelProjectId: 'prj_greenhouse',
						vercelImage: '',
						vercelVcpus: '4',
						vercelTimeoutMinutes: '300',
						bridgeBinaryUrl: 'https://assets.orchard.my/bridge/orchard-bridge-linux-amd64.tar.gz',
						bridgeBinarySha256: '',
						previewDomain: 'preview.orchard.my'
					},
					lockedFields: [],
					secretFields: ['vercelToken'],
					boolFields: ['kubernetesEnabled', 'vercelEnabled']
				},
				{
					id: 'slack-app',
					configured: false,
					values: { signingSecret: null, botToken: null, appId: '' },
					lockedFields: [],
					secretFields: ['signingSecret', 'botToken'],
					boolFields: []
				},
				{
					id: 'linear',
					configured: true,
					values: { webhookSecret: null },
					lockedFields: [],
					secretFields: ['webhookSecret'],
					boolFields: []
				}
			]
		],
		[
			/^\/apiv1\/admin\/instance-settings\/sandboxes$/,
			'GET',
			() => ({ enabled: true, dbValue: true, envOverride: null })
		],
		[
			/^\/apiv1\/admin\/instance-settings\/sandboxes$/,
			'PATCH',
			(_u, init) => {
				const enabled = JSON.parse(String(init.body ?? '{}')).enabled === true;
				return { enabled, dbValue: enabled, envOverride: null };
			}
		],
		[
			/^\/apiv1\/admin\/instance-settings\/mcp$/,
			'GET',
			() => ({ enabled: true, dbValue: true, envOverride: null })
		],
		[
			/^\/apiv1\/sandboxes$/,
			'GET',
			() => {
				const list = data.list();
				list.runners = (list.runners ?? []).map((r) =>
					r.id === 'vercel'
						? { ...r, available: false, reason: 'SANDBOX_VERCEL_TOKEN is not set' }
						: r
				);
				return list;
			}
		]
	];

	installRoutes([...integrationRoutes(), ...shareRoutes, ...adminRoutes]);
	if (view === 'share' && share !== 'missing' && !location.hash) {
		history.replaceState(
			history.state,
			'',
			`${location.pathname}${location.search}#hX2_kq9-Zt4mW8rB1nVc7yLp0sDf3gJa5eUo6iQ_w-E`
		);
	}
	const token = view === 'share' && share !== 'missing' ? location.hash.slice(1) || null : null;
</script>

{#if view === 'share'}
	<ShareViewer {token} selfId={data.SEB.id} />
{:else if view === 'slack'}
	<SlackLink
		token={page.url.searchParams.get('token') ?? 'hX2_kq9-Zt4mW8rB1nVc7yLp0sDf3gJa5eUo6iQ_w-E'}
	/>
{:else if view === 'accounts'}
	<div class="frame"><UserGreenhouseAccounts /></div>
{:else if view === 'admin'}
	<div class="frame frame--wide"><AdminInstance /></div>
{/if}

<style>
	.frame {
		max-width: 46rem;
		margin: 0 auto;
		padding: 3rem 1.5rem;
	}

	.frame--wide {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		max-width: 56rem;
	}
</style>
