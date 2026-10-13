<script lang="ts">
	import SandboxCredentialsPanel from '../components/sandbox/SandboxCredentialsPanel.svelte';
	import UserGreenhouseAccounts from '../components/user-settings/UserGreenhouseAccounts.svelte';
	import UserSshIdentities from '../components/user-settings/UserSshIdentities.svelte';
</script>

<div class="gh-settings-tab">
	<UserGreenhouseAccounts index={0} />
	<UserSshIdentities index={1} />
	<SandboxCredentialsPanel index={2} />
</div>

<style>
	.gh-settings-tab {
		display: flex;
		flex-direction: column;
		gap: var(--space-4, 1rem);
		min-width: 0;
	}
</style>
