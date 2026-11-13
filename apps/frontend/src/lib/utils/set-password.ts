import { apiFetch } from '$lib/stores';
import { stepUpError } from './step-up';

export async function setOwnPassword(password: string, currentPassword?: string): Promise<void> {
	const response = await apiFetch('/apiv1/auth/password/set', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(currentPassword ? { password, currentPassword } : { password })
	});
	if (!response.ok) throw await stepUpError(response, "Couldn't set the password.");
}
