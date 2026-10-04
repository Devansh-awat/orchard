export const LIVE_LOG_IDLE_MS = 5 * 60_000;

export function watchLiveLogActivity(
	target: EventTarget & { readonly hidden: boolean },
	onPause: (reason: 'idle' | 'hidden') => void
) {
	const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
	let stopped = false;
	let lastActivity = Date.now();
	let timer: ReturnType<typeof setTimeout>;

	function cleanup() {
		stopped = true;
		clearTimeout(timer);
		for (const event of events) target.removeEventListener(event, activity);
		target.removeEventListener('visibilitychange', visibility);
	}

	function pause(reason: 'idle' | 'hidden') {
		cleanup();
		onPause(reason);
	}

	function check() {
		if (target.hidden) return pause('hidden');
		const remaining = LIVE_LOG_IDLE_MS - (Date.now() - lastActivity);
		if (remaining <= 0) return pause('idle');
		timer = setTimeout(check, remaining);
	}

	function activity() {
		if (stopped) return;
		if (target.hidden) return pause('hidden');
		if (Date.now() - lastActivity >= LIVE_LOG_IDLE_MS) return pause('idle');
		lastActivity = Date.now();
	}

	function visibility() {
		if (target.hidden) pause('hidden');
	}

	if (target.hidden) {
		pause('hidden');
		return cleanup;
	}

	for (const event of events) target.addEventListener(event, activity, { passive: true });
	target.addEventListener('visibilitychange', visibility);
	timer = setTimeout(check, LIVE_LOG_IDLE_MS);
	return cleanup;
}
