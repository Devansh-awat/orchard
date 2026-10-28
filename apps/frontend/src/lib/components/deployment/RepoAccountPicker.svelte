<script lang="ts">
	import { Plus, Link2 } from 'lucide-svelte';
	import { Avatar, Menu, MenuItem, SelectTrigger } from '$lib/components/ui';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';

	let {
		accounts = [],
		selected = null,
		onSelect,
		installUrl = null,
		directLink = false,
		onDirectLink,
		size = 'md',
		block = true
	}: {
		accounts?: { login: string; count: number }[];
		selected?: string | null;
		onSelect: (login: string) => void;
		installUrl?: string | null;
		directLink?: boolean;
		onDirectLink?: () => void;
		size?: 'sm' | 'md' | 'lg';
		block?: boolean;
	} = $props();

	const picture = (login: string) => ({
		username: login,
		imageUrl: `https://github.com/${login}.png?size=40`
	});
</script>

{#snippet who()}
	{#if directLink}
		<Link2 size={14} class="text-muted" />
	{:else if selected}
		<Avatar user={picture(selected)} size={size === 'lg' ? 22 : 18} />
	{/if}
{/snippet}

<Menu placement="bottom-start" size="lg" sameWidth={block}>
	{#snippet trigger(attrs, open)}
		<SelectTrigger
			{...attrs}
			{open}
			value={directLink ? 'Direct link' : selected}
			placeholder="Account"
			aria-label="GitHub account"
			{block}
			{size}
			leading={directLink || selected ? who : undefined}
		/>
	{/snippet}
	{#each accounts as account (account.login)}
		<MenuItem
			onclick={() => onSelect(account.login)}
			shortcut={String(account.count)}
			aria-current={!directLink && account.login === selected ? 'true' : undefined}
		>
			{#snippet leading()}<Avatar user={picture(account.login)} />{/snippet}
			{account.login}
		</MenuItem>
	{:else}
		<MenuItem disabled>No connected accounts yet</MenuItem>
	{/each}
	{#if onDirectLink || installUrl}
		<MenuSeparator />
	{/if}
	{#if onDirectLink}
		<MenuItem
			icon={Link2}
			onclick={() => onDirectLink()}
			aria-current={directLink ? 'true' : undefined}
		>
			Direct link
		</MenuItem>
	{/if}
	{#if installUrl}
		<MenuItem icon={Plus} href={installUrl} target="_blank" rel="noopener noreferrer">
			Add GitHub account
		</MenuItem>
	{/if}
</Menu>
