export type ConsentScope = 'read' | 'deploy' | 'exec';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function requestedConsentScope(raw: string | null): ConsentScope {
	const scope = (raw ?? '').trim().toLowerCase();
	if (scope === 'mcp:read') return 'read';
	if (scope === 'mcp:deploy') return 'deploy';
	return 'exec';
}

export function consentScope(requested: ConsentScope, allowExec: boolean): string {
	if (requested === 'read') return 'mcp:read';
	return requested === 'exec' && allowExec ? 'mcp:exec' : 'mcp:deploy';
}

export function consentDestination(redirectUri: string): { host: string; local: boolean } | null {
	if (!redirectUri) return null;
	let url: URL;
	try {
		url = new URL(redirectUri);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	return { host: url.host, local: LOOPBACK_HOSTNAMES.has(url.hostname) };
}
