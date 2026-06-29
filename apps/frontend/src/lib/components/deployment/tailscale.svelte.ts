import { apiFetch, toasts } from '$lib/stores';

interface TailscaleDeps {
	deploymentId: () => string;
	isExposed: () => boolean;
	refetch: () => void;
}

export class TailscaleController {
	exposing = $state(false);
	unexposing = $state(false);
	linked = $state(false);
	hostname = $state<string | null>(null);
	ip = $state<string | null>(null);
	dns = $state<string | null>(null);

	#deps: TailscaleDeps;

	constructor(deps: TailscaleDeps) {
		this.#deps = deps;
	}

	async checkStatus() {
		try {
			const response = await apiFetch('/apiv1/tailscale/status');
			if (response.ok) {
				const data = await response.json();
				this.linked = data.linked;
			}
		} catch (e) {
			console.error('Failed to check Tailscale status:', e);
		}
	}

	async fetchDeploymentStatus() {
		if (!this.#deps.isExposed()) return;
		try {
			const response = await apiFetch(`/apiv1/tailscale/deployment/${this.#deps.deploymentId()}`);
			if (response.ok) {
				const data = await response.json();
				this.ip = data.ip;
				this.dns = data.dns;
			}
		} catch (e) {
			console.error('Failed to fetch Tailscale deployment status:', e);
		}
	}

	syncFromDeployment(data: { tailscaleHostname?: string | null; tailscaleExposed?: boolean }) {
		this.hostname = data.tailscaleHostname || null;
		if (data.tailscaleExposed && !this.dns) {
			this.fetchDeploymentStatus();
		}
	}

	async expose() {
		this.exposing = true;
		try {
			const response = await apiFetch(`/apiv1/tailscale/expose/${this.#deps.deploymentId()}`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to expose to Tailscale');
			}
			const data = await response.json();
			this.hostname = data.hostname;
			toasts.add({
				title: 'Exposed to Tailscale',
				description: 'Sidecar is starting — address will appear shortly',
				color: 'success'
			});
			this.#deps.refetch();
			setTimeout(() => this.fetchDeploymentStatus(), 5000);
			setTimeout(() => this.fetchDeploymentStatus(), 15000);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to expose to Tailscale',
				color: 'error'
			});
		} finally {
			this.exposing = false;
		}
	}

	async unexpose() {
		this.unexposing = true;
		try {
			const response = await apiFetch(`/apiv1/tailscale/unexpose/${this.#deps.deploymentId()}`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to remove Tailscale exposure');
			}
			this.hostname = null;
			this.ip = null;
			this.dns = null;
			toasts.add({
				title: 'Tailscale removed',
				description: 'App is no longer exposed to Tailscale',
				color: 'success'
			});
			this.#deps.refetch();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove Tailscale exposure',
				color: 'error'
			});
		} finally {
			this.unexposing = false;
		}
	}
}
