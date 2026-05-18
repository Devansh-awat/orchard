<script lang="ts">
	import { Loader2, Globe, Lock } from 'lucide-svelte';
	import { ShieldCheck } from '@jis3r/icons';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';

	let {
		organization,
		isOwner,
		baseDomain,
		ssoLoading,
		ssoSaving,
		ssoTab = $bindable<'config' | 'branding'>('config'),
		ssoConfig,
		ssoSubdomain = $bindable(''),
		ssoSubdomainSaving,
		ssoProvider = $bindable<'oidc' | 'saml'>('oidc'),
		ssoOidcIssuerUrl = $bindable(''),
		ssoOidcClientId = $bindable(''),
		ssoOidcClientSecret = $bindable(''),
		ssoOidcScopes = $bindable('openid email profile'),
		ssoSamlEntryPoint = $bindable(''),
		ssoSamlIssuer = $bindable(''),
		ssoSamlCertificate = $bindable(''),
		ssoSamlMetadataUrl = $bindable(''),
		ssoEnabled = $bindable(false),
		ssoEnforced = $bindable(false),
		ssoLoginLogoUrl = $bindable(''),
		ssoLoginPrimaryColor = $bindable('#6366f1'),
		ssoLoginBgColor = $bindable('#0a0a0f'),
		ssoLoginWelcomeText = $bindable(''),
		ssoTestResult,
		ssoTesting,
		onSaveSubdomain,
		onSaveSsoConfig,
		onTestSsoConnection,
		onDeleteSsoConfig,
		index = 0,
	}: {
		organization: { id: string; name: string } | null;
		isOwner: boolean;
		baseDomain: string;
		ssoLoading: boolean;
		ssoSaving: boolean;
		ssoTab: 'config' | 'branding';
		ssoConfig: any;
		ssoSubdomain: string;
		ssoSubdomainSaving: boolean;
		ssoProvider: 'oidc' | 'saml';
		ssoOidcIssuerUrl: string;
		ssoOidcClientId: string;
		ssoOidcClientSecret: string;
		ssoOidcScopes: string;
		ssoSamlEntryPoint: string;
		ssoSamlIssuer: string;
		ssoSamlCertificate: string;
		ssoSamlMetadataUrl: string;
		ssoEnabled: boolean;
		ssoEnforced: boolean;
		ssoLoginLogoUrl: string;
		ssoLoginPrimaryColor: string;
		ssoLoginBgColor: string;
		ssoLoginWelcomeText: string;
		ssoTestResult: { success: boolean; testLoginUrl?: string; error?: string } | null;
		ssoTesting: boolean;
		onSaveSubdomain: () => void;
		onSaveSsoConfig: () => void;
		onTestSsoConnection: () => void;
		onDeleteSsoConfig: () => void;
		index?: number;
	} = $props();
</script>

{#if isOwner}
	<SettingsSection title="Single Sign-On" description="Configure identity provider for your organization" iconColor="primary" {index}>
		{#snippet icon(hovered)}<ShieldCheck size={18} animate={hovered} />{/snippet}

		{#if ssoLoading}
			<div class="sso-loading">
				<Loader2 class="h-5 w-5 animate-spin" />
			</div>
		{:else}
			<!-- Subdomain -->
			<div class="sso-section">
				<h3 class="sso-section-title">
					<Globe class="h-3.5 w-3.5" />
					Custom Subdomain
				</h3>
				<div class="sso-subdomain-row">
					<input
						type="text"
						bind:value={ssoSubdomain}
						placeholder="yourcompany"
						class="input sso-subdomain-input"
					/>
					<span class="sso-subdomain-suffix">.{baseDomain}</span>
					<button
						onclick={onSaveSubdomain}
						disabled={ssoSubdomainSaving}
						class="btn btn-secondary"
					>
						{#if ssoSubdomainSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Save
					</button>
				</div>
				{#if ssoSubdomain}
					<p class="sso-hint">Your login page will be at <strong>https://{ssoSubdomain}.{baseDomain}</strong></p>
				{/if}
			</div>

			<!-- SSO tabs -->
			<div class="sso-tabs">
				<button
					class="sso-tab"
					class:sso-tab-active={ssoTab === 'config'}
					onclick={() => { ssoTab = 'config'; }}
				>
					Provider Configuration
				</button>
				<button
					class="sso-tab"
					class:sso-tab-active={ssoTab === 'branding'}
					onclick={() => { ssoTab = 'branding'; }}
				>
					Login Page Customization
				</button>
			</div>

			{#if ssoTab === 'config'}
				<!-- Provider selection -->
				<div class="sso-section">
					<h3 class="sso-section-title">Provider Type</h3>
					<div class="sso-provider-toggle">
						<button
							class="sso-provider-btn"
							class:sso-provider-active={ssoProvider === 'oidc'}
							onclick={() => { ssoProvider = 'oidc'; }}
						>
							OpenID Connect (OIDC)
						</button>
						<button
							class="sso-provider-btn"
							class:sso-provider-active={ssoProvider === 'saml'}
							onclick={() => { ssoProvider = 'saml'; }}
						>
							SAML 2.0
						</button>
					</div>
				</div>

				<!-- OIDC config -->
				{#if ssoProvider === 'oidc'}
					<div class="sso-section">
						<div class="sso-field">
							<label class="sso-field-label" for="oidc-issuer">Issuer URL</label>
							<input id="oidc-issuer" type="url" bind:value={ssoOidcIssuerUrl} placeholder="https://accounts.google.com" class="input" />
						</div>
						<div class="sso-field">
							<label class="sso-field-label" for="oidc-client-id">Client ID</label>
							<input id="oidc-client-id" type="text" bind:value={ssoOidcClientId} placeholder="your-client-id" class="input" />
						</div>
						<div class="sso-field">
							<label class="sso-field-label" for="oidc-client-secret">Client Secret</label>
							<input id="oidc-client-secret" type="password" bind:value={ssoOidcClientSecret} placeholder={ssoConfig?.oidcClientSecret === '••••••••' ? '(already set, leave blank to keep)' : 'your-client-secret'} class="input" />
						</div>
						<div class="sso-field">
							<label class="sso-field-label" for="oidc-scopes">Scopes</label>
							<input id="oidc-scopes" type="text" bind:value={ssoOidcScopes} placeholder="openid email profile" class="input" />
						</div>
					</div>
				{/if}

				<!-- SAML config -->
				{#if ssoProvider === 'saml'}
					<div class="sso-section">
						<div class="sso-field">
							<label class="sso-field-label" for="saml-metadata">Metadata URL (optional)</label>
							<input id="saml-metadata" type="url" bind:value={ssoSamlMetadataUrl} placeholder="https://idp.example.com/metadata" class="input" />
						</div>
						<div class="sso-field">
							<label class="sso-field-label" for="saml-entry">SSO Entry Point URL</label>
							<input id="saml-entry" type="url" bind:value={ssoSamlEntryPoint} placeholder="https://idp.example.com/sso" class="input" />
						</div>
						<div class="sso-field">
							<label class="sso-field-label" for="saml-issuer">Issuer</label>
							<input id="saml-issuer" type="text" bind:value={ssoSamlIssuer} placeholder="urn:idp:example" class="input" />
						</div>
						<div class="sso-field">
							<label class="sso-field-label" for="saml-cert">IdP Certificate (PEM)</label>
							<textarea id="saml-cert" bind:value={ssoSamlCertificate} rows="4" placeholder={ssoConfig?.samlCertificate === '(configured)' ? '(already set, leave blank to keep)' : 'Paste the X.509 certificate here...'} class="input"></textarea>
						</div>
					</div>
				{/if}

				<!-- Toggles -->
				<div class="sso-section">
					<div class="sso-toggle-row">
						<div>
							<p class="sso-toggle-label">Enable SSO</p>
							<p class="sso-toggle-desc">Allow members to sign in via your identity provider</p>
						</div>
						<label class="sso-switch">
							<input type="checkbox" bind:checked={ssoEnabled} />
							<span class="sso-slider"></span>
						</label>
					</div>
					<div class="sso-toggle-row">
						<div>
							<p class="sso-toggle-label">Enforce SSO</p>
							<p class="sso-toggle-desc">Require SSO for all members (disables email/passkey login on subdomain)</p>
						</div>
						<label class="sso-switch">
							<input type="checkbox" bind:checked={ssoEnforced} />
							<span class="sso-slider"></span>
						</label>
					</div>
				</div>

				<!-- Actions -->
				<div class="sso-actions">
					<button onclick={onSaveSsoConfig} disabled={ssoSaving} class="btn btn-primary">
						{#if ssoSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Save SSO Configuration
					</button>
					<button onclick={onTestSsoConnection} disabled={ssoTesting} class="btn btn-secondary">
						{#if ssoTesting}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Test Connection
					</button>
					{#if ssoConfig}
						<button onclick={onDeleteSsoConfig} class="btn btn-secondary" style="color: var(--error-color, #ef4444);">
							Delete SSO Config
						</button>
					{/if}
				</div>

				{#if ssoTestResult}
					<div class="sso-test-result" class:sso-test-success={ssoTestResult.success} class:sso-test-error={!ssoTestResult.success}>
						{#if ssoTestResult.success}
							<p>Connection successful. <a href={ssoTestResult.testLoginUrl} target="_blank" rel="noopener">Test login</a></p>
						{:else}
							<p>Connection failed: {ssoTestResult.error}</p>
						{/if}
					</div>
				{/if}
			{/if}

			{#if ssoTab === 'branding'}
				<div class="sso-section">
					<div class="sso-field">
						<label class="sso-field-label" for="sso-logo">Logo URL</label>
						<input id="sso-logo" type="url" bind:value={ssoLoginLogoUrl} placeholder="https://example.com/logo.png" class="input" />
					</div>
					<div class="sso-field">
						<label class="sso-field-label" for="sso-welcome">Welcome Text</label>
						<input id="sso-welcome" type="text" bind:value={ssoLoginWelcomeText} placeholder="Sign in to Your Company" class="input" />
					</div>
					<div class="sso-color-row">
						<div class="sso-field" style="flex: 1;">
							<label class="sso-field-label" for="sso-primary-color">Primary Color</label>
							<div class="sso-color-input">
								<input id="sso-primary-color" type="color" bind:value={ssoLoginPrimaryColor} />
								<input type="text" bind:value={ssoLoginPrimaryColor} placeholder="#6366f1" class="input" style="flex: 1;" />
							</div>
						</div>
						<div class="sso-field" style="flex: 1;">
							<label class="sso-field-label" for="sso-bg-color">Background Color</label>
							<div class="sso-color-input">
								<input id="sso-bg-color" type="color" bind:value={ssoLoginBgColor} />
								<input type="text" bind:value={ssoLoginBgColor} placeholder="#0a0a0f" class="input" style="flex: 1;" />
							</div>
						</div>
					</div>

					<!-- Preview -->
					<div class="sso-preview" style="background: {ssoLoginBgColor};">
						<div class="sso-preview-card">
							{#if ssoLoginLogoUrl}
								<img src={ssoLoginLogoUrl} alt="Logo" class="sso-preview-logo" />
							{:else}
								<div class="sso-preview-icon" style="background: {ssoLoginPrimaryColor}20; color: {ssoLoginPrimaryColor};">
									<Lock class="h-5 w-5" />
								</div>
							{/if}
							<p class="sso-preview-text">{ssoLoginWelcomeText || `Sign in to ${organization?.name || 'Organization'}`}</p>
							<div class="sso-preview-btn" style="background: {ssoLoginPrimaryColor};">Sign in with SSO</div>
						</div>
					</div>

					<button onclick={onSaveSsoConfig} disabled={ssoSaving} class="btn btn-primary">
						{#if ssoSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Save Branding
					</button>
				</div>
			{/if}
		{/if}
	</SettingsSection>
{:else}
	<SettingsSection title="Single Sign-On" description="Configure identity provider for your organization" iconColor="primary" {index}>
		{#snippet icon(hovered)}<ShieldCheck size={18} animate={hovered} />{/snippet}

		<p class="sso-no-access">
			Only the organization owner can manage SSO settings.
		</p>
	</SettingsSection>
{/if}

<style>
	.sso-loading {
		display: flex;
		justify-content: center;
		padding: 2rem;
		color: var(--surface-muted);
	}

	.sso-section {
		padding: 1rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-top: 1px solid var(--surface-border);
	}

	.sso-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.sso-subdomain-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sso-subdomain-input {
		max-width: 200px;
	}

	.sso-subdomain-suffix {
		font-size: 0.875rem;
		color: var(--surface-muted);
		white-space: nowrap;
	}

	.sso-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.sso-hint :global(strong) {
		color: var(--center-channel-color);
	}

	.sso-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--surface-border);
	}

	.sso-tab {
		padding: 0.625rem 1rem;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		transition: color 120ms ease, border-color 120ms ease;
		background: transparent;
		border-top: none;
		border-left: none;
		border-right: none;
	}

	.sso-tab:hover {
		color: var(--center-channel-color);
	}

	.sso-tab-active {
		color: var(--center-channel-color);
		border-bottom-color: var(--button-bg);
	}

	.sso-provider-toggle {
		display: flex;
		gap: 0.5rem;
	}

	.sso-provider-btn {
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
		font-weight: 500;
		border-radius: 0.375rem;
		cursor: pointer;
		transition: all 120ms ease;
		background: transparent;
		border: 1px solid var(--surface-border);
		color: var(--surface-muted);
	}

	.sso-provider-active {
		background: var(--button-bg);
		color: var(--button-color);
		border-color: var(--button-bg);
	}

	.sso-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.sso-field-label {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}

	.sso-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.sso-toggle-label {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--center-channel-color);
		margin: 0;
	}

	.sso-toggle-desc {
		font-size: 0.7rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.sso-switch {
		position: relative;
		display: inline-block;
		width: 36px;
		height: 20px;
		flex-shrink: 0;
	}

	.sso-switch input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.sso-slider {
		position: absolute;
		cursor: pointer;
		inset: 0;
		background-color: var(--surface-border);
		transition: background-color 200ms;
		border-radius: 20px;
	}

	.sso-slider::before {
		content: '';
		position: absolute;
		height: 14px;
		width: 14px;
		left: 3px;
		bottom: 3px;
		background-color: white;
		transition: transform 200ms;
		border-radius: 50%;
	}

	.sso-switch input:checked + .sso-slider {
		background-color: var(--button-bg);
	}

	.sso-switch input:checked + .sso-slider::before {
		transform: translateX(16px);
	}

	.sso-actions {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 0;
		border-top: 1px solid var(--surface-border);
		flex-wrap: wrap;
	}

	.sso-test-result {
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8rem;
	}

	.sso-test-success {
		background: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}

	.sso-test-success :global(a) {
		color: inherit;
		text-decoration: underline;
	}

	.sso-test-error {
		background: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
	}

	.sso-color-row {
		display: flex;
		gap: 1rem;
	}

	.sso-color-input {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sso-color-input input[type='color'] {
		width: 32px;
		height: 32px;
		border: 1px solid var(--surface-border);
		border-radius: 0.375rem;
		cursor: pointer;
		padding: 2px;
		background: transparent;
	}

	.sso-preview {
		border-radius: 0.75rem;
		padding: 2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--surface-border);
	}

	.sso-preview-card {
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.75rem;
		padding: 1.5rem;
		width: 260px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	.sso-preview-logo {
		width: 40px;
		height: 40px;
		border-radius: 0.5rem;
		object-fit: cover;
	}

	.sso-preview-icon {
		width: 40px;
		height: 40px;
		border-radius: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sso-preview-text {
		font-size: 0.8rem;
		color: rgba(255, 255, 255, 0.9);
		text-align: center;
		margin: 0;
	}

	.sso-preview-btn {
		width: 100%;
		padding: 0.5rem;
		border-radius: 0.375rem;
		text-align: center;
		font-size: 0.75rem;
		font-weight: 500;
		color: white;
	}

	.sso-no-access {
		font-size: 0.8rem;
		color: var(--surface-muted);
		margin: 0;
	}
</style>
