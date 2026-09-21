import { writable, get } from 'svelte/store';
import { apiFetch } from './api';

export interface AuthConfig {
	turnstileSiteKey: string | null;
}

const config = writable<AuthConfig>({ turnstileSiteKey: null });
let inflight: Promise<AuthConfig> | null = null;

export const authConfig = {
	subscribe: config.subscribe,
	load(): Promise<AuthConfig> {
		inflight ??= (async () => {
			try {
				const response = await apiFetch('/apiv1/auth/config');
				if (!response.ok) throw new Error(String(response.status));
				const next = (await response.json()) as AuthConfig;
				config.set(next);
				return next;
			} catch (e) {
				inflight = null;
				throw e;
			}
		})();
		return inflight;
	},
	current(): AuthConfig {
		return get(config);
	}
};
