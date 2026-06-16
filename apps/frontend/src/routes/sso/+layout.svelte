<script lang="ts">
	let { children } = $props();
</script>

<!-- Standalone layout for SSO pages - no sidebar or navigation -->
<div class="sso-layout">
	{@render children()}
</div>

<style>
	.sso-layout {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>
