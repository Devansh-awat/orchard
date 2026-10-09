<script lang="ts">
	import { onMount } from 'svelte';
	import { SegmentedControl, Select } from '$lib/components/ui';
	import { isMac } from '../format';
	import { greenhousePrefs, type FollowUp, type SendWith } from '../prefs.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';

	const prefs = $derived(greenhousePrefs.values);
	const mac = isMac();
	const modEnter = mac ? '⌘↵' : 'Ctrl+↵';

	const followUps: { value: FollowUp; label: string }[] = [
		{ value: 'queue', label: 'Queue' },
		{ value: 'steer', label: 'Steer' }
	];

	let permission = $state<NotificationPermission | 'unsupported'>('default');

	onMount(() => {
		permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
	});

	const notifyHint = $derived(
		permission === 'denied'
			? 'Blocked by the browser'
			: permission === 'unsupported'
				? 'Not available in this browser'
				: 'When an agent finishes or needs your input'
	);

	const sendHint = $derived(
		prefs.sendWith === 'enter' ? 'Use ⇧↵ for new lines' : '↵ adds a new line'
	);

	const alternate = $derived(prefs.sendWith === 'enter' ? modEnter : `${mac ? '⌘⇧' : 'Ctrl+⇧+'}↵`);
	const followHint = $derived(
		prefs.followUp === 'queue'
			? `Waits for the agent to finish, ${alternate} steers`
			: `Interrupts the agent mid turn, ${alternate} queues`
	);

	async function setNotify(next: boolean) {
		greenhousePrefs.set('notifyAgent', next);
		if (!next) return;
		if (typeof Notification === 'undefined') {
			permission = 'unsupported';
			greenhousePrefs.set('notifyAgent', false);
			return;
		}
		const result =
			Notification.permission === 'default'
				? await Notification.requestPermission().catch(() => Notification.permission)
				: Notification.permission;
		permission = result;
		if (result !== 'granted') greenhousePrefs.set('notifyAgent', false);
	}
</script>

<Card title="Chat">
	<Row title="Send messages with" description={sendHint}>
		{#snippet control()}
			<div class="pick">
				<Select
					value={prefs.sendWith}
					aria-label="Send messages with"
					onchange={(e: Event) =>
						greenhousePrefs.set(
							'sendWith',
							(e.currentTarget as HTMLSelectElement).value as SendWith
						)}
				>
					<option value="enter">Enter</option>
					<option value="mod-enter">{mac ? '⌘ Enter' : 'Ctrl Enter'}</option>
				</Select>
			</div>
		{/snippet}
	</Row>
	<Row title="Follow-up behavior" description={followHint}>
		{#snippet control()}
			<SegmentedControl
				label="Follow-up behavior"
				options={followUps}
				value={prefs.followUp}
				onchange={(v) => greenhousePrefs.set('followUp', v as FollowUp)}
			/>
		{/snippet}
	</Row>
	<Row
		title="Auto-accept permissions"
		description="Allow every permission request automatically"
		checked={prefs.autoAcceptPermissions}
		ontoggle={(v) => greenhousePrefs.set('autoAcceptPermissions', v)}
	/>
</Card>

<Card title="Notifications">
	<Row
		title="Agent notifications"
		description={notifyHint}
		checked={prefs.notifyAgent}
		disabled={permission === 'unsupported'}
		ontoggle={(v) => void setNotify(v)}
	/>
</Card>

<Card title="Transcript">
	<Row
		title="Hold the applause"
		description="Cut the flattery from agent replies"
		checked={prefs.notAbsolutelyRight}
		ontoggle={(v) => greenhousePrefs.set('notAbsolutelyRight', v)}
	/>
	<Row
		title="Always show context usage"
		description="Otherwise it appears past 70%"
		checked={prefs.alwaysShowContext}
		ontoggle={(v) => greenhousePrefs.set('alwaysShowContext', v)}
	/>
	<Row
		title="Show MCP status in the composer"
		description="Connected servers next to the model picker"
		checked={prefs.showMcpStatus}
		ontoggle={(v) => greenhousePrefs.set('showMcpStatus', v)}
	/>
	<Row
		title="Don't collapse tool calls"
		description="Expand them by default, toggle with ⌃O"
		checked={prefs.expandTools}
		ontoggle={(v) => greenhousePrefs.set('expandTools', v)}
	/>
	<Row
		title="Show reasoning"
		description="Model reasoning summaries in the transcript"
		checked={prefs.showReasoning}
		ontoggle={(v) => greenhousePrefs.set('showReasoning', v)}
	/>
</Card>

<style>
	.pick {
		width: 9rem;
	}
</style>
