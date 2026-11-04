<script lang="ts">
	import { apiFetch, toasts } from '$lib/stores';
	import { dashboardHost, parentDomain, type SetupOverview } from './setup-overview';

	let {
		overview,
		onDone,
		onSkip
	}: {
		overview: SetupOverview;
		onDone: () => Promise<void> | void;
		onSkip: () => Promise<void> | void;
	} = $props();

	const host = dashboardHost(overview);

	let publicIp = $state(overview.publicIp ?? '');
	let appDomain = $state(overview.appDomain ?? (host ? `apps.${parentDomain(host)}` : ''));
	let cname = $state(overview.cname ?? host);
	let saving = $state(false);

	async function put(section: string, body: Record<string, string>) {
		const response = await apiFetch(`/apiv1/admin/instance-config/${section}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			const failure = await response.json().catch(() => ({}));
			throw new Error(failure?.message || 'Could not save');
		}
	}

	async function save() {
		if (saving) return;
		saving = true;
		try {
			if (!overview.locked.publicIp && publicIp.trim() !== (overview.publicIp ?? '')) {
				await put('network', { publicIp: publicIp.trim() });
			}
			if (!overview.locked.appDomain && appDomain.trim() !== (overview.appDomain ?? '')) {
				await put('wildcard', { appDomain: appDomain.trim() });
			}
			if (!overview.locked.cname && cname.trim() !== (overview.cname ?? '')) {
				await put('ingress', { cname: cname.trim() });
			}
			await onDone();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Could not save', color: 'error' });
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Confirm your network</h2>
	<p>This instance was not installed with the script, so check these before you deploy.</p>

	<div class="setup-body setup-fields">
		<label class="setup-field">
			<span>Public IP</span>
			<input
				bind:value={publicIp}
				disabled={overview.locked.publicIp}
				placeholder="203.0.113.10"
				autocomplete="off"
				spellcheck="false"
			/>
			<small>Public ports and databases use it. Blank keeps them unavailable.</small>
		</label>
		<label class="setup-field">
			<span>Apps domain</span>
			<input
				bind:value={appDomain}
				disabled={overview.locked.appDomain}
				placeholder="apps.example.com"
				autocomplete="off"
				spellcheck="false"
			/>
			<small>
				Needs a wildcard DNS record, *.{appDomain || 'apps.example.com'}. Blank means apps get no
				URL.
			</small>
		</label>
		<label class="setup-field">
			<span>Custom domains target</span>
			<input
				bind:value={cname}
				disabled={overview.locked.cname}
				placeholder="orchard.example.com"
				autocomplete="off"
				spellcheck="false"
			/>
			<small>People point a CNAME here. Blank means Orchard cannot check their domains.</small>
		</label>
	</div>

	<div class="setup-acts">
		<button class="setup-pill" disabled={saving} onclick={save}>
			{saving ? 'Saving' : 'Save and continue'}
		</button>
		<button class="setup-ghost" onclick={onSkip}>Skip for now</button>
	</div>
</section>
