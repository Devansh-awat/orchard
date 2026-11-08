<script lang="ts">
	import { Field, Select } from '$lib/components/ui';
	import { user } from '$lib/stores';

	let { value = $bindable(''), id }: { value?: string; id: string } = $props();

	const grants = $derived($user?.ssoGrants ?? []);
</script>

{#if grants.length > 0}
	<Field
		label="Reaches"
		for={id}
		hint="An organization that requires single sign-on only accepts a token limited to it."
	>
		<Select {id} bind:value>
			<option value="">All my organizations</option>
			{#each grants as grant (grant.organizationId)}
				<option value={grant.organizationId}>Only {grant.name}</option>
			{/each}
		</Select>
	</Field>
{/if}
