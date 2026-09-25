import { apiFetch } from '$lib/stores/api';
import type { Binding, BindingOption } from './bindings';

async function readError(res: Response, fallback: string): Promise<never> {
	const data = await res.json().catch(() => ({}));
	throw new Error((data as { message?: string }).message || fallback);
}

export async function fetchBindings(deploymentId: string): Promise<Binding[]> {
	const res = await apiFetch(`/apiv1/deployments/${deploymentId}/bindings`);
	if (!res.ok) return readError(res, 'Could not load bindings');
	return res.json();
}

export async function fetchBindingOptions(deploymentId: string): Promise<BindingOption[]> {
	const res = await apiFetch(`/apiv1/deployments/${deploymentId}/bindings/options`);
	if (!res.ok) return readError(res, 'Could not load databases');
	return res.json();
}

export async function createBinding(
	deploymentId: string,
	input: { resourceType: 'database'; resourceId: string; name: string; envKey: string | null }
): Promise<Binding & { addedEnvKey: string | null }> {
	const res = await apiFetch(`/apiv1/deployments/${deploymentId}/bindings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input)
	});
	if (!res.ok) return readError(res, 'Could not bind the database');
	return res.json();
}

export async function deleteBinding(deploymentId: string, bindingId: string): Promise<void> {
	const res = await apiFetch(`/apiv1/deployments/${deploymentId}/bindings/${bindingId}`, {
		method: 'DELETE'
	});
	if (!res.ok) return readError(res, 'Could not remove the binding');
}
