<script lang="ts">
	import {
		GreenhouseShell,
		liveWithTransport,
		realEnv,
		type GreenhouseEnv,
		type GreenhouseNav,
		type NavTarget
	} from '$lib/components/greenhouse';
	import { fixtureStore } from '$lib/components/greenhouse/demo/chat-fixtures';
	import { SEB } from '$lib/components/greenhouse/demo/data';
	import { fakeLive, installFetch, json } from '$lib/components/greenhouse/demo/mock';
	import TourOverlay from '$lib/components/greenhouse/tour/TourOverlay.svelte';

	const data = installFetch('owner');
	const demoFetch = window.fetch;
	window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (new URL(raw, location.origin).pathname.endsWith('/connect')) {
			return Promise.resolve(json({ sshHost: 'orchard-leaf-box', user: 'dev', sshReady: false }));
		}
		return demoFetch(input, init);
	};

	const env: GreenhouseEnv = {
		...realEnv,
		harness: true,
		terminalEndpoint: () => 'ws://127.0.0.1:9/tour',
		createChatStore() {
			const store = fixtureStore();
			for (const thread of store.threads.values()) {
				thread.entries = thread.entries.map((entry) =>
					entry.kind === 'text'
						? {
								...entry,
								text: entry.text
									.split('\n')
									.filter((line) => !line.includes('<img') && !line.includes('sanitized away'))
									.join('\n')
									.trimEnd()
							}
						: entry
				);
			}
			store.directory = '/persist/home/.worktrees/orchard/fix-login';
			for (const s of store.sessions) s.directory = '/persist/home/.worktrees/orchard/fix-login';
			Object.assign(store, {
				connect: async () => {},
				pause: () => {},
				selectSession: async (id: string) => {
					if (store.threads.has(id)) store.activeId = id;
				}
			});
			return store;
		},
		createLive: (id) => liveWithTransport(id, fakeLive('owner'))
	};

	let machine = $state<string | null>('sbx-leaf');
	let session = $state<string | null>(null);
	let tab = $state<string | null>(null);

	const nav: GreenhouseNav = {
		machineId: () => machine,
		sessionId: () => session,
		tab: () => tab,
		go(target: NavTarget) {
			if (target.machine !== undefined) machine = target.machine;
			if (target.session !== undefined) session = target.session;
			if (target.tab !== undefined) tab = target.tab;
			if (!session) tab = null;
		}
	};

	function finish(completed: boolean) {
		window.parent.postMessage({ type: 'greenhouse-tour', completed }, location.origin);
	}
</script>

<svelte:head>
	<title>Greenhouse tour</title>
</svelte:head>

<div class="stage">
	<GreenhouseShell {env} {nav} list={data} listState="ready" self={SEB} organizationId="org-1" />
</div>
<TourOverlay onsession={(id) => nav.go({ session: id })} onfinish={finish} />

<style>
	.stage {
		position: fixed;
		inset: 0;
	}
</style>
