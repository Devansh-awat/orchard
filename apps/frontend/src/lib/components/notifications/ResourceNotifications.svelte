<script lang="ts">
	import NotificationRules from './NotificationRules.svelte';
	import PersonalNotifications from './PersonalNotifications.svelte';
	import type { NotificationScopeType } from './types';

	let {
		organizationId,
		scopeType,
		scopeId,
		canEdit = true
	}: {
		organizationId: string;
		scopeType: NotificationScopeType;
		scopeId: string;
		canEdit?: boolean;
	} = $props();
</script>

<div class="rn">
	<NotificationRules {organizationId} {scopeType} {scopeId} {canEdit} />
	<div class="rn-divider"></div>
	<PersonalNotifications {organizationId} {scopeType} {scopeId} />
</div>

<style>
	.rn {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.rn-divider {
		height: 1px;
		background: var(--border-default);
		opacity: 0.6;
	}
</style>
