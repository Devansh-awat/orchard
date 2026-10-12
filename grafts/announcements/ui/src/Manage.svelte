<script lang="ts">
	import type { HostApi } from '@orchard/graft-sdk/client';
	import { Alert, Button, EmptyState, Field, Input, SegmentedControl } from '@orchard/graft-ui';
	import {
		createAnnouncement,
		listAnnouncements,
		removeAnnouncement,
		type Announcement
	} from './api';

	let { host, user }: { host: HostApi; user: HostApi['stores']['user'] } = $props();

	let items = $state<Announcement[]>([]);
	let body = $state('');
	let tone = $state<Announcement['tone']>('info');
	let hours = $state('0');
	let posting = $state(false);
	let error = $state<string | null>(null);

	async function refresh() {
		items = await listAnnouncements(host);
	}

	$effect(() => {
		void refresh();
	});

	async function post() {
		posting = true;
		error = null;
		try {
			await createAnnouncement(host, { body, tone, expiresInHours: Number(hours) || 0 });
			body = '';
			host.toast('Announcement posted', 'success');
			await refresh();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			posting = false;
		}
	}

	async function remove(item: Announcement) {
		const ok = await host.confirm({
			title: 'Take this announcement down?',
			body: item.body,
			confirmLabel: 'Take down',
			danger: true
		});
		if (!ok) return;
		await removeAnnouncement(host, item.id);
		await refresh();
	}
</script>

<div class="manage">
	<header>
		<h1>Announcements</h1>
		<p>Notices posted here show on every project and app overview for everyone on this instance.</p>
	</header>

	{#if $user?.isSuperAdmin}
		<section class="compose">
			<Field label="Message">
				<Input bind:value={body} placeholder="Maintenance tonight at 22:00 UTC" maxlength={500} />
			</Field>
			<div class="row">
				<SegmentedControl
					options={[
						{ value: 'info', label: 'Info' },
						{ value: 'success', label: 'Good news' },
						{ value: 'warning', label: 'Warning' }
					]}
					bind:value={tone}
					label="Tone"
				/>
				<Field label="Hide after (hours, 0 keeps it up)">
					<Input bind:value={hours} type="number" min="0" />
				</Field>
				<Button variant="primary" loading={posting} disabled={!body.trim()} onclick={post}>
					Post announcement
				</Button>
			</div>
			{#if error}<Alert tone="error">{error}</Alert>{/if}
		</section>
	{/if}

	{#if items.length === 0}
		<EmptyState title="Nothing announced" description="Active announcements will show up here." />
	{:else}
		<ul>
			{#each items as item (item.id)}
				<li>
					<Alert tone={item.tone} title={item.author ? `From ${item.author}` : 'Announcement'}>
						<p>{item.body}</p>
						{#if $user?.isSuperAdmin}
							<Button size="sm" variant="ghost" onclick={() => remove(item)}>Take down</Button>
						{/if}
					</Alert>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.manage {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.75rem;
		max-width: 52rem;
	}

	h1 {
		margin: 0;
		font-size: var(--text-title-2, 1.375rem);
		color: var(--text-default);
	}

	header p {
		margin: 0.25rem 0 0;
		color: var(--text-muted);
		font-size: var(--text-footnote, 0.8125rem);
	}

	.compose {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 0.5rem);
		background: var(--bg-surface);
	}

	.row {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	li p {
		margin: 0 0 0.5rem;
	}
</style>
