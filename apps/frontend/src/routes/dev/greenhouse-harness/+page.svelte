<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		GreenhouseShell,
		liveWithTransport,
		realEnv,
		type GreenhouseEnv,
		type GreenhouseNav,
		type NavTarget
	} from '$lib/components/greenhouse';
	import { fixtureStore } from '../chat-harness/fixtures';
	import { SEB } from './data';
	import { fakeLive, installFetch, type HarnessRole } from './mock';

	const params = page.url.searchParams;
	const role = (params.get('role') ?? 'owner') as HarnessRole;
	const pty = params.get('pty') ?? 'ws://localhost:7681/pty';

	const data = installFetch(role);

	const env: GreenhouseEnv = {
		...realEnv,
		harness: true,
		terminalEndpoint: () => pty,
		createChatStore() {
			const store = fixtureStore();
			for (const thread of store.threads.values()) {
				thread.entries = thread.entries.map((entry) =>
					entry.kind === 'text'
						? {
								...entry,
								text: entry.text
									.split('\n')
									.filter((line) => !line.includes('onerror='))
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
		createLive: (id) => liveWithTransport(id, fakeLive(role))
	};

	const nav: GreenhouseNav = {
		machineId: () => page.url.searchParams.get('machine'),
		sessionId: () => page.url.searchParams.get('session'),
		tab: () => page.url.searchParams.get('tab'),
		go(target: NavTarget, opts = {}) {
			const next = new URLSearchParams(page.url.searchParams);
			for (const key of ['machine', 'session', 'tab'] as const) {
				const value = target[key];
				if (value === undefined) continue;
				if (value) next.set(key, value);
				else next.delete(key);
			}
			if (!next.get('session')) next.delete('tab');
			void goto(`?${next.toString()}`, {
				replaceState: opts.replace ?? false,
				keepFocus: true,
				noScroll: true
			});
		}
	};
</script>

<GreenhouseShell {env} {nav} list={data} listState="ready" self={SEB} organizationId="org-1" />
