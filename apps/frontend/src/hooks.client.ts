import type { HandleClientError } from '@sveltejs/kit';
import { captureException } from '$lib/posthog';

// Auto-reload when dynamically imported chunks are stale after a new deployment.
// This happens when the browser has cached HTML referencing old chunk hashes
// that no longer exist on the server.
export const handleError: HandleClientError = ({ error, event, status, message }) => {
	const msg = error instanceof Error ? error.message : String(error);
	if (
		msg.includes('Failed to fetch dynamically imported module') ||
		msg.includes('error loading dynamically imported module')
	) {
		window.location.reload();
		return;
	}

	captureException(error, {
		$exception_source: 'sveltekit.client',
		route_id: event.route.id,
		url: event.url.pathname,
		status,
		sveltekit_message: message
	});
};
