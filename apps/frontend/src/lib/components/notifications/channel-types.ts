import { Mail, MessageSquare, Slack, Webhook } from 'lucide-svelte';
import type { ChannelType } from './types';

export const CHANNEL_TYPE_META: Record<
	ChannelType,
	{ label: string; icon: typeof Webhook; placeholder: string; hue: string; hint: string }
> = {
	discord: {
		label: 'Discord',
		icon: MessageSquare,
		placeholder: 'https://discord.com/api/webhooks/…',
		hue: 'var(--hue-violet)',
		hint: 'Channel settings → Integrations → Webhooks'
	},
	slack: {
		label: 'Slack',
		icon: Slack,
		placeholder: 'https://hooks.slack.com/services/…',
		hue: 'var(--hue-green)',
		hint: 'Slack app → Incoming Webhooks'
	},
	webhook: {
		label: 'Webhook',
		icon: Webhook,
		placeholder: 'https://example.com/orchard-hook',
		hue: 'var(--hue-slate)',
		hint: 'Signed JSON POST to any HTTPS endpoint'
	},
	email: {
		label: 'Email',
		icon: Mail,
		placeholder: 'alerts@example.com, oncall@example.com',
		hue: 'var(--hue-amber)',
		hint: 'Sent to organization members only'
	}
};
