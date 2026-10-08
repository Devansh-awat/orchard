import { getContext, setContext } from 'svelte';
import { ChatSessionStore, type SessionStoreOptions } from '$lib/components/sandbox/chat';
import { LiveClient, type LiveTransport } from './live.svelte';

export interface GreenhouseEnv {
	terminalEndpoint(
		sandboxId: string,
		sid: string,
		n: string,
		mode?: 'rw' | 'ro',
		user?: string | null
	): string;
	createChatStore(sandboxId: string, options: SessionStoreOptions): ChatSessionStore;
	createLive(sandboxId: string): LiveClient;
	harness?: boolean;
}

export const realEnv: GreenhouseEnv = {
	terminalEndpoint(sandboxId, sid, n, mode = 'rw', user = null) {
		const params = new URLSearchParams({ sid, n, mode });
		if (user && mode === 'ro') params.set('user', user);
		return `/apiv1/sandboxes/${encodeURIComponent(sandboxId)}/terminal?${params.toString()}`;
	},
	createChatStore(sandboxId, options) {
		return new ChatSessionStore(sandboxId, options);
	},
	createLive(sandboxId) {
		return new LiveClient(sandboxId);
	}
};

export function liveWithTransport(sandboxId: string, transport: LiveTransport): LiveClient {
	return new LiveClient(sandboxId, transport);
}

const KEY = Symbol('greenhouse-env');

export function setGreenhouseEnv(env: GreenhouseEnv) {
	setContext(KEY, env);
}

export function getGreenhouseEnv(): GreenhouseEnv {
	return getContext<GreenhouseEnv | undefined>(KEY) ?? realEnv;
}
