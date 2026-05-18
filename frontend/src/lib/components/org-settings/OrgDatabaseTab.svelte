<script lang="ts">
	import { Loader2 } from 'lucide-svelte';

	let {
		canEditOrg,
		publicIp = $bindable(''),
		publicIpSaving,
		onSavePublicIp,
	}: {
		canEditOrg: boolean;
		publicIp: string;
		publicIpSaving: boolean;
		onSavePublicIp: () => void;
	} = $props();
</script>

<h1 class="os-tab-title">Database</h1>

{#if canEditOrg}
	<div class="os-card">
		<div class="os-card-header">
			<h2 class="os-card-title">Public Database IP</h2>
		</div>

		<div class="os-card-body">
			<p class="os-sso-hint" style="margin-bottom: 1rem;">
				Shared external IP used to expose databases publicly. Databases opted into public
				exposure will share this IP with unique ports per database.
			</p>

			<div class="os-field">
				<label class="os-field-label" for="public-ip">IPv4 / IPv6 Address</label>
				<div style="display: flex; gap: 0.5rem; align-items: center;">
					<input
						id="public-ip"
						type="text"
						class="input"
						placeholder="e.g. 203.0.113.10"
						bind:value={publicIp}
						style="flex: 1;"
					/>
					<button onclick={onSavePublicIp} disabled={publicIpSaving} class="btn btn-primary">
						{#if publicIpSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Save
					</button>
				</div>
			</div>
		</div>
	</div>
{:else}
	<div class="os-card">
		<div class="os-card-body">
			<p class="text-sm" style="color: var(--surface-muted);">Only admins and owners can manage database settings.</p>
		</div>
	</div>
{/if}
