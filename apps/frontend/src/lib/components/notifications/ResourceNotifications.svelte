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

<NotificationRules {organizationId} {scopeType} {scopeId} {canEdit} />
<PersonalNotifications {organizationId} {scopeType} {scopeId} />
