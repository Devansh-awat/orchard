<script lang="ts" module>
	interface RenderOptions {
		sitekey: string;
		action?: string;
		theme?: 'light' | 'dark' | 'auto';
		size?: 'normal' | 'flexible' | 'compact';
		execution?: 'render' | 'execute';
		appearance?: 'always' | 'execute' | 'interaction-only';
		'response-field'?: boolean;
		callback?: (token: string) => void;
		'error-callback'?: (code?: string) => void;
		'expired-callback'?: () => void;
		'timeout-callback'?: () => void;
	}

	interface TurnstileApi {
		render(el: HTMLElement, options: RenderOptions): string;
		execute(id: string, options?: { action?: string }): void;
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
				reject(new Error("Couldn't load the bot check"));
			};
			document.head.appendChild(script);
		});
		return loader;
	}

	export class ChallengeFailed extends Error {
		constructor(message = 'Bot check failed. Reload the page and try again.') {
			super(message);
			this.name = 'ChallengeFailed';
		}
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	let {
		siteKey,
		action
	}: {
		siteKey: string;
		action: string;
	} = $props();

	let host = $state<HTMLDivElement | null>(null);
	let visible = $state(false);
	let widgetId: string | null = null;
	let api: TurnstileApi | null = null;
	let ready: Promise<TurnstileApi> | null = null;
	let pending: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;

	function settle(token: string | null, error?: Error) {
		const waiter = pending;
		pending = null;
		visible = false;
		if (!waiter) return;
		if (token) waiter.resolve(token);
		else waiter.reject(error ?? new ChallengeFailed());
	}

	onMount(() => {
		if (!browser || !host) return;

		let disposed = false;

		ready = loadTurnstile().then((loaded) => {
			if (disposed || !host) throw new ChallengeFailed();
			api = loaded;
			widgetId = loaded.render(host, {
				sitekey: siteKey,
				action,
				execution: 'execute',
				appearance: 'interaction-only',
				size: 'flexible',
				'response-field': false,
				theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
				callback: (token) => settle(token),
				'error-callback': () => settle(null),
				'expired-callback': () => settle(null),
				'timeout-callback': () => settle(null)
			});
			return loaded;
		});
		ready.catch(() => {});

		return () => {
			disposed = true;
			settle(null);
			if (api && widgetId) api.remove(widgetId);
			widgetId = null;
		};
	});

	export async function execute(): Promise<string> {
		const loaded = await (ready ?? Promise.reject(new ChallengeFailed()));
		if (!widgetId) throw new ChallengeFailed();
		if (pending) settle(null);
		loaded.reset(widgetId);
		visible = true;
		return new Promise<string>((resolve, reject) => {
			pending = { resolve, reject };
			loaded.execute(widgetId!, { action });
		});
	}
</script>

<div class="ts-wrap" class:ts-wrap--visible={visible}>
	<div class="ts-host" bind:this={host}></div>
</div>

<style>
	.ts-wrap {
		display: contents;
	}

	.ts-wrap--visible {
		display: block;
		width: 100%;
		margin: 0.875rem 0;
	}

	.ts-host {
		display: flex;
		justify-content: center;
		width: 100%;
	}

	.ts-host :global(iframe) {
		width: 100% !important;
		max-width: 100%;
		border-radius: var(--radius-lg);
	}
</style>
