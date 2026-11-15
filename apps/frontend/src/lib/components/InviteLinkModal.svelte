<script lang="ts">
	import { Button, Modal } from '$lib/components/ui';
	import Snippet from '$lib/components/ui/Snippet.svelte';

	let {
		links = $bindable([]),
		reissued = false,
		emailFailed = false
	}: {
		links?: { email: string; link: string }[];
		reissued?: boolean;
		emailFailed?: boolean;
	} = $props();
</script>

<Modal
	bind:open={() => links.length > 0, (open) => (links = open ? links : [])}
	dismissable={false}
	title={links.length === 1 ? 'Copy the invite link' : 'Copy the invite links'}
>
	<div class="body">
		<p>
			{#if emailFailed}The invitation email didn't send{:else}This instance can't send email{/if},
			so send the link yourself. It works once and expires in 7 days. You won't see it again.
			{#if reissued}The old link no longer works.{/if}
		</p>
		{#each links as { email, link } (email)}
			<div class="link">
				<strong>{email}</strong>
				<Snippet command={link} prompt="" label="Copy the link for {email}" />
			</div>
		{/each}
	</div>
	{#snippet footer()}
		<Button variant="primary" onclick={() => (links = [])}>Done</Button>
	{/snippet}
</Modal>

<style>
	.body {
		display: grid;
		gap: 1rem;
	}
	.link {
		display: grid;
		gap: 0.375rem;
		min-width: 0;
	}
</style>
