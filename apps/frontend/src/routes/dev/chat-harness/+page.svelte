<script lang="ts">
	import { page } from '$app/state';
	import ChatPanel from '$lib/components/sandbox/chat/ChatPanel.svelte';
	import type { RemoteDraft } from '$lib/components/sandbox/chat/session-store.svelte';
	import {
		fixtureStore,
		longStore,
		seedRequests
	} from '$lib/components/greenhouse/demo/chat-fixtures';

	const view = page.url.searchParams.get('view') ?? 'busy';
	const store = view === 'long' ? longStore() : fixtureStore();

	if (view === 'unreachable') store.connection = 'unreachable';
	if (!['busy', 'unreachable', 'long'].includes(view) && store.active) {
		store.active.busy = false;
		store.active.queue = [];
		store.active.entries = store.active.entries.slice(0, 9);
		store.activity.set('ses_login', 'idle');
	}
	if (view === 'plan') store.plan = true;
	if (view === 'slash') store.draft = '/';
	if (view === 'comment') store.draft = '/chat looks good, merging after CI';
	if (view === 'ask' || view === 'plan-ready' || view === 'ask-viewer') {
		seedRequests(store, view === 'plan-ready' ? 'plan' : 'ask');
	}
	if (view === 'ask-viewer') store.canAnswer = () => false;
	if (view === 'plan-ready') {
		store.readFile = async () =>
			[
				'# Fix the login redirect loop',
				'',
				'The session cookie is scoped to the request host, so `app.orchard.my` never sees it.',
				'',
				'## Steps',
				'',
				'1. Read `COOKIE_DOMAIN` in `auth.controller.ts` and set it on the session cookie.',
				'2. Carry `returnTo` through the OAuth callback.',
				'3. Add `COOKIE_DOMAIN=orchard.my` to `.env.example`.',
				'',
				'## Verify',
				'',
				'- `pnpm --filter server test`',
				'- Log in on staging and land back on the page you started from.'
			].join('\n');
	}

	const remoteDrafts: RemoteDraft[] =
		view === 'busy'
			? [{ userId: 'user-alex', name: 'Alex Rivera', text: 'also check the staging cookie domain' }]
			: [];

	function onComment(text: string) {
		store.comments = [
			...store.comments,
			{
				id: crypto.randomUUID(),
				author: { id: 'user-seb', name: 'Seb' },
				body: text,
				createdAt: Date.now(),
				sessionId: store.activeId ?? ''
			}
		];
	}
</script>

<div class="harness" data-testid="chat-pane">
	<ChatPanel {store} tabs {remoteDrafts} {onComment} />
</div>

<style>
	.harness {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--bg-app);
		container: chat-pane / inline-size;
	}
</style>
