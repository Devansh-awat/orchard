import { browser } from '$app/environment';

export const clock = $state({ now: Date.now() });

if (browser) {
	setInterval(() => {
		clock.now = Date.now();
	}, 1_000);
}
