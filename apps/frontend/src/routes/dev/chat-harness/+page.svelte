<script lang="ts">
	import { page } from '$app/state';
	import ChatPanel from '$lib/components/sandbox/chat/ChatPanel.svelte';
	import type { RemoteDraft } from '$lib/components/sandbox/chat/session-store.svelte';
	import { fixtureStore } from './fixtures';

	const view = page.url.searchParams.get('view') ?? 'busy';
	const store = fixtureStore();

	if (view === 'unreachable') store.connection = 'unreachable';
	if (view !== 'busy' && view !== 'unreachable' && store.active) {
		store.active.busy = false;
		store.active.queue = [];
		store.active.entries = store.active.entries.slice(0, 9);
		store.activity.set('ses_login', 'idle');
	}
	if (view === 'plan') store.plan = true;
	if (view === 'slash') store.draft = '/';
	if (view === 'comment') store.draft = '/chat looks good, merging after CI';

	const remoteDrafts: RemoteDraft[] =
		view === 'busy'
			? [{ userId: 'user-alex', name: 'Alex', text: 'also check the staging cookie' }]
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
	}
</style>
