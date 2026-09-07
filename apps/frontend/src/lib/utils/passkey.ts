import { browser } from '$app/environment';
import { apiFetch } from '$lib/stores';

export function passkeysSupported(): boolean {
	return browser && typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

export function secureContextWarning(): string | null {
	if (!browser || typeof window === 'undefined') return null;
	if (window.isSecureContext) return null;
	return `Passkeys need a secure origin. This instance is served over ${window.location.protocol.replace(':', '')}, so the browser will refuse to create one.`;
}

export function passkeyErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'NotAllowedError') return 'Passkey prompt was cancelled.';
		return err.message;
	}
	return 'Failed to register passkey.';
}

export async function registerPasskey(friendlyName?: string): Promise<void> {
	const optionsResponse = await apiFetch('/apiv1/auth/passkey/register/options', {
		method: 'POST'
	});
	if (!optionsResponse.ok) throw new Error('Could not create passkey challenge');
	const options = await optionsResponse.json();

	const { startRegistration } = await import('@simplewebauthn/browser');
	const credential = await startRegistration({ optionsJSON: options });

	const verifyResponse = await apiFetch('/apiv1/auth/passkey/register/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			response: credential,
			friendlyName: friendlyName?.trim() || undefined
		})
	});
	if (!verifyResponse.ok) {
		const data = await verifyResponse.json().catch(() => ({}));
		throw new Error(data?.message || 'Passkey registration failed');
	}
}
