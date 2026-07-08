export interface NotificationChannelConfig {
	recipients?: string[];
	urlConfigured?: boolean;
	urlPreview?: string | null;
	secretConfigured?: boolean;
}

export interface NotificationChannel {
	id: string;
	name: string;
	type: 'discord' | 'slack' | 'webhook' | 'email';
	config: NotificationChannelConfig;
	events: string[];
	projectIds: string[] | null;
	enabled: boolean;
	lastDelivery: { status: string; error: string | null; event: string; createdAt: string } | null;
}

export interface ChannelPayload {
	name: string;
	type: string;
	config: { url?: string; recipients?: string[] };
	events: string[];
	projectIds: string[] | null;
}
