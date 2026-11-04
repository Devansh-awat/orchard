<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceChecklist, toasts } from '$lib/stores';
	import DnsStatusCard from '$lib/components/admin/DnsStatusCard.svelte';
	import TunnelCard from '$lib/components/admin/TunnelCard.svelte';
	import AddressesCard from '$lib/components/admin/AddressesCard.svelte';
	import type { SetupOverview } from '$lib/components/setup/setup-overview';
	import type { DnsReport } from '$lib/components/admin/DnsStatusCard.svelte';
	import type { TunnelSection, TunnelState } from '$lib/components/admin/TunnelCard.svelte';

	let report = $state<DnsReport | null>(null);
	let dnsError = $state<string | null>(null);
	let tunnel = $state<TunnelState | null>(null);
	let section = $state<TunnelSection | null>(null);
	let overview = $state<SetupOverview | null>(null);
	let draft = $state<Record<string, string>>({});

	let loading = $state(true);
	let refreshing = $state(false);
	let saving = $state(false);
	let routing = $state<string | null>(null);

	function seed(next: TunnelSection) {
		section = next;
		draft = Object.fromEntries(
			Object.entries(next.values).map(([name, value]) => [name, value ?? ''])
		);
	}

	async function loadOverview() {
		const response = await apiFetch('/apiv1/setup/overview');
		if (response.ok) overview = await response.json();
	}

	async function loadDns(refresh = false) {
		try {
			const response = await apiFetch(
				`/apiv1/admin/networking/dns${refresh ? '?refresh=true' : ''}`
			);
			if (!response.ok) throw new Error(`The server answered ${response.status}.`);
			report = await response.json();
			dnsError = null;
		} catch (e) {
			dnsError = e instanceof Error ? e.message : "Couldn't check DNS";
		}
	}

	async function loadTunnel() {
		const [state, sections] = await Promise.all([
			apiFetch('/apiv1/admin/networking/tunnel'),
			apiFetch('/apiv1/admin/instance-config/tunnel')
		]);
		if (state.ok) tunnel = await state.json();
		if (sections.ok) seed(await sections.json());
	}

	async function refresh() {
		refreshing = true;
		try {
			await loadDns(true);
			await instanceChecklist.load(true);
		} finally {
			refreshing = false;
		}
	}

	async function save() {
		saving = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/tunnel', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(draft)
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || "Couldn't save");
			}
			seed(await response.json());
			await loadTunnel();
			toasts.add({ title: 'Cloudflare credentials saved', color: 'success' });
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't save",
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function route(hostname: string) {
		routing = hostname;
		try {
			const response = await apiFetch('/apiv1/admin/networking/tunnel/routes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hostname })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || "Couldn't add the route");
			}
			tunnel = await response.json();
			await loadDns(true);
			await instanceChecklist.load(true);
			toasts.add({ title: `${hostname} routed through the tunnel`, color: 'success' });
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't add the route",
				color: 'error'
			});
		} finally {
			routing = null;
		}
	}

	onMount(async () => {
		await Promise.allSettled([loadDns(), loadTunnel(), loadOverview()]);
		loading = false;
	});
</script>

<DnsStatusCard {report} error={dnsError} {loading} {refreshing} onRefresh={refresh} />

<AddressesCard {overview} />

<TunnelCard state={tunnel} {section} bind:draft {saving} {routing} onSave={save} onRoute={route} />
