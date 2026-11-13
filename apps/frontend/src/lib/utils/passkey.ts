import { browser } from '$app/environment';
import { apiFetch } from '$lib/stores';
import { stepUpError } from './step-up';

export function passkeysSupported(): boolean {
	return browser && typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

export function secureContextWarning(): string | null {
	if (!browser || typeof window === 'undefined') return null;
	if (window.isSecureContext) return null;
	return `Passkeys need a secure origin. This instance is served over ${window.location.protocol.replace(':', '')}, so the browser won't create one.`;
}

export function passkeyErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'NotAllowedError') return 'Passkey prompt canceled.';
		return err.message;
	}
	return "Couldn't register passkey.";
}

export async function registerPasskey(
	friendlyName?: string,
	currentPassword?: string
): Promise<void> {
	const proof = currentPassword ? { currentPassword } : {};
	const optionsResponse = await apiFetch('/apiv1/auth/passkey/register/options', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(proof)
	});
	if (!optionsResponse.ok) {
		throw await stepUpError(optionsResponse, "Couldn't create passkey challenge");
	}
	const options = await optionsResponse.json();

	const { startRegistration } = await import('@simplewebauthn/browser');
	const credential = await startRegistration({ optionsJSON: options });

	const verifyResponse = await apiFetch('/apiv1/auth/passkey/register/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			response: credential,
			friendlyName: friendlyName?.trim() || undefined,
			...proof
		})
	});
	if (!verifyResponse.ok) throw await stepUpError(verifyResponse, 'Passkey registration failed');
}
