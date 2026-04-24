// Auto-reload when dynamically imported chunks are stale after a new deployment.
// This happens when the browser has cached HTML referencing old chunk hashes
// that no longer exist on the server.
export function handleError({ error }: { error: unknown }) {
	const msg = error instanceof Error ? error.message : String(error);
	if (
		msg.includes('Failed to fetch dynamically imported module') ||
		msg.includes('error loading dynamically imported module')
	) {
		window.location.reload();
		return;
	}
}
