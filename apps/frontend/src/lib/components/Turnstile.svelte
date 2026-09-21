<script lang="ts" module>
	interface TurnstileApi {
		render(
			el: HTMLElement,
			options: {
				sitekey: string;
				action?: string;
				theme?: 'light' | 'dark' | 'auto';
				callback?: (token: string) => void;
				'error-callback'?: (code?: string) => void;
				'expired-callback'?: () => void;
				'timeout-callback'?: () => void;
			}
		): string;
		reset(id: string): void;
		remove(id: string): void;
	}

	const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

	let loader: Promise<TurnstileApi> | null = null;

	function loadTurnstile(): Promise<TurnstileApi> {
		if (loader) return loader;
		loader = new Promise<TurnstileApi>((resolve, reject) => {
			const existing = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
			if (existing) {
				resolve(existing);
				return;
			}
			const script = document.createElement('script');
			script.src = SCRIPT_SRC;
			script.async = true;
			script.defer = true;
			script.onload = () => {
				const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
				if (api) resolve(api);
				else reject(new Error('Turnstile loaded without an API'));
			};
			script.onerror = () => {
				loader = null;
				reject(new Error('Could not load the bot check'));
			};
			document.head.appendChild(script);
		});
		return loader;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	let {
		siteKey,
		action,
		token = $bindable<string | null>(null),
		error = $bindable<string | null>(null),
		onsolved
	}: {
		siteKey: string;
		action: string;
		token?: string | null;
		error?: string | null;
		onsolved?: (token: string) => void;
	} = $props();

	let host = $state<HTMLDivElement | null>(null);
	let widgetId: string | null = null;
	let api: TurnstileApi | null = null;

	onMount(() => {
		if (!browser || !host) return;

		let disposed = false;

		loadTurnstile()
			.then((loaded) => {
				if (disposed || !host) return;
				api = loaded;
				widgetId = loaded.render(host, {
					sitekey: siteKey,
					action,
					theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
					callback: (solved) => {
						token = solved;
						error = null;
						onsolved?.(solved);
					},
					'error-callback': () => {
						token = null;
						error = 'Bot check failed to load. Reload the page and try again.';
					},
					'expired-callback': () => {
						token = null;
					},
					'timeout-callback': () => {
						token = null;
					}
				});
			})
			.catch(() => {
				if (!disposed) error = 'Could not load the bot check. Check your network and reload.';
			});

		return () => {
			disposed = true;
			if (api && widgetId) api.remove(widgetId);
			widgetId = null;
		};
	});

	export function reset() {
		token = null;
		if (api && widgetId) api.reset(widgetId);
	}
</script>

<div class="ts-wrap">
	<div bind:this={host}></div>
</div>

<style>
	.ts-wrap {
		display: flex;
		justify-content: center;
		min-height: 65px;
	}
</style>
