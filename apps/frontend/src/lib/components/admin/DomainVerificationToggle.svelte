<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Badge, SectionCard, SettingRow, SettingsList, ToggleRow } from '$lib/components/ui';

	interface State {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
	}

	const url = '/apiv1/admin/instance-settings/custom-domain-verification';

	let state = $state<State | null>(null);
	let saving = $state(false);

	async function load() {
		try {
			const res = await apiFetch(url);
			if (!res.ok) return;
			state = await res.json();
		} catch {
			state = null;
		}
	}

	async function toggle() {
		if (!state || state.envOverride !== null) return;
		saving = true;
		const next = !state.dbValue;
		try {
			const res = await apiFetch(url, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			if (!res.ok) throw new Error("Couldn't save");
			state = await res.json();
			toasts.add({
				title: next ? 'Domain proof required' : 'Domain proof not required',
				color: 'success'
			});
		} catch (e) {
			if (state) state = { ...state };
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if state}
	<SectionCard title="Custom domains">
		<SettingsList>
			{#if state.envOverride !== null}
				<SettingRow label="Require proof of domain ownership">
					{#snippet hint()}
						Pinned to <code>{state?.envOverride ? 'on' : 'off'}</code> by the
						<code>CUSTOM_DOMAIN_VERIFICATION</code> environment variable.
					{/snippet}
					<Badge>env override</Badge>
				</SettingRow>
			{:else}
				<ToggleRow
					checked={state.dbValue}
					label="Require proof of domain ownership"
					hint="People add a TXT record before they can add a custom domain. Domains already added keep working."
					disabled={saving}
					onchange={toggle}
				/>
			{/if}
		</SettingsList>
	</SectionCard>
{/if}
