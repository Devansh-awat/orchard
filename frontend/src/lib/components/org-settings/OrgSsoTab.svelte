<script lang="ts">
	import { Loader2, Globe, Lock } from 'lucide-svelte';

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
	} = $props();
</script>

<h1 class="os-tab-title">Single Sign-On</h1>

{#if isOwner}
	<div class="os-card">
		<div class="os-card-header">
			<h2 class="os-card-title">SSO Configuration</h2>
		</div>

		{#if ssoLoading}
			<div class="os-sso-loading">
				<Loader2 class="h-5 w-5 animate-spin" />
			</div>
		{:else}
			<!-- Subdomain -->
			<div class="os-sso-section">
				<h3 class="os-sso-section-title">
					<Globe class="h-3.5 w-3.5" />
					Custom Subdomain
				</h3>
				<div class="os-sso-subdomain-row">
					<input
						type="text"
						bind:value={ssoSubdomain}
						placeholder="yourcompany"
						class="input os-sso-subdomain-input"
					/>
					<span class="os-sso-subdomain-suffix">.{baseDomain}</span>
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
					<p class="os-sso-hint">Your login page will be at <strong>https://{ssoSubdomain}.{baseDomain}</strong></p>
				{/if}
			</div>

			<!-- SSO tabs -->
			<div class="os-sso-tabs">
				<button
					class="os-sso-tab"
					class:os-sso-tab-active={ssoTab === 'config'}
					onclick={() => { ssoTab = 'config'; }}
				>
					Provider Configuration
				</button>
				<button
					class="os-sso-tab"
					class:os-sso-tab-active={ssoTab === 'branding'}
					onclick={() => { ssoTab = 'branding'; }}
				>
					Login Page Customization
				</button>
			</div>

			{#if ssoTab === 'config'}
				<!-- Provider selection -->
				<div class="os-sso-section">
					<h3 class="os-sso-section-title">Provider Type</h3>
					<div class="os-sso-provider-toggle">
						<button
							class="os-sso-provider-btn"
							class:os-sso-provider-active={ssoProvider === 'oidc'}
							onclick={() => { ssoProvider = 'oidc'; }}
						>
							OpenID Connect (OIDC)
						</button>
						<button
							class="os-sso-provider-btn"
							class:os-sso-provider-active={ssoProvider === 'saml'}
							onclick={() => { ssoProvider = 'saml'; }}
						>
							SAML 2.0
						</button>
					</div>
				</div>

				<!-- OIDC config -->
				{#if ssoProvider === 'oidc'}
					<div class="os-sso-section">
						<div class="os-sso-field">
							<label class="os-field-label" for="oidc-issuer">Issuer URL</label>
							<input id="oidc-issuer" type="url" bind:value={ssoOidcIssuerUrl} placeholder="https://accounts.google.com" class="input" />
						</div>
						<div class="os-sso-field">
							<label class="os-field-label" for="oidc-client-id">Client ID</label>
							<input id="oidc-client-id" type="text" bind:value={ssoOidcClientId} placeholder="your-client-id" class="input" />
						</div>
						<div class="os-sso-field">
							<label class="os-field-label" for="oidc-client-secret">Client Secret</label>
							<input id="oidc-client-secret" type="password" bind:value={ssoOidcClientSecret} placeholder={ssoConfig?.oidcClientSecret === '••••••••' ? '(already set, leave blank to keep)' : 'your-client-secret'} class="input" />
						</div>
						<div class="os-sso-field">
							<label class="os-field-label" for="oidc-scopes">Scopes</label>
							<input id="oidc-scopes" type="text" bind:value={ssoOidcScopes} placeholder="openid email profile" class="input" />
						</div>
					</div>
				{/if}

				<!-- SAML config -->
				{#if ssoProvider === 'saml'}
					<div class="os-sso-section">
						<div class="os-sso-field">
							<label class="os-field-label" for="saml-metadata">Metadata URL (optional)</label>
							<input id="saml-metadata" type="url" bind:value={ssoSamlMetadataUrl} placeholder="https://idp.example.com/metadata" class="input" />
						</div>
						<div class="os-sso-field">
							<label class="os-field-label" for="saml-entry">SSO Entry Point URL</label>
							<input id="saml-entry" type="url" bind:value={ssoSamlEntryPoint} placeholder="https://idp.example.com/sso" class="input" />
						</div>
						<div class="os-sso-field">
							<label class="os-field-label" for="saml-issuer">Issuer</label>
							<input id="saml-issuer" type="text" bind:value={ssoSamlIssuer} placeholder="urn:idp:example" class="input" />
						</div>
						<div class="os-sso-field">
							<label class="os-field-label" for="saml-cert">IdP Certificate (PEM)</label>
							<textarea id="saml-cert" bind:value={ssoSamlCertificate} rows="4" placeholder={ssoConfig?.samlCertificate === '(configured)' ? '(already set, leave blank to keep)' : 'Paste the X.509 certificate here...'} class="input"></textarea>
						</div>
					</div>
				{/if}

				<!-- Toggles -->
				<div class="os-sso-section">
					<div class="os-sso-toggle-row">
						<div>
							<p class="os-sso-toggle-label">Enable SSO</p>
							<p class="os-sso-toggle-desc">Allow members to sign in via your identity provider</p>
						</div>
						<label class="os-sso-switch">
							<input type="checkbox" bind:checked={ssoEnabled} />
							<span class="os-sso-slider"></span>
						</label>
					</div>
					<div class="os-sso-toggle-row">
						<div>
							<p class="os-sso-toggle-label">Enforce SSO</p>
							<p class="os-sso-toggle-desc">Require SSO for all members (disables email/passkey login on subdomain)</p>
						</div>
						<label class="os-sso-switch">
							<input type="checkbox" bind:checked={ssoEnforced} />
							<span class="os-sso-slider"></span>
						</label>
					</div>
				</div>

				<!-- Actions -->
				<div class="os-sso-actions">
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
					<div class="os-sso-test-result" class:os-sso-test-success={ssoTestResult.success} class:os-sso-test-error={!ssoTestResult.success}>
						{#if ssoTestResult.success}
							<p>Connection successful. <a href={ssoTestResult.testLoginUrl} target="_blank" rel="noopener">Test login</a></p>
						{:else}
							<p>Connection failed: {ssoTestResult.error}</p>
						{/if}
					</div>
				{/if}
			{/if}

			{#if ssoTab === 'branding'}
				<div class="os-sso-section">
					<div class="os-sso-field">
						<label class="os-field-label" for="sso-logo">Logo URL</label>
						<input id="sso-logo" type="url" bind:value={ssoLoginLogoUrl} placeholder="https://example.com/logo.png" class="input" />
					</div>
					<div class="os-sso-field">
						<label class="os-field-label" for="sso-welcome">Welcome Text</label>
						<input id="sso-welcome" type="text" bind:value={ssoLoginWelcomeText} placeholder="Sign in to Your Company" class="input" />
					</div>
					<div class="os-sso-color-row">
						<div class="os-sso-field" style="flex: 1;">
							<label class="os-field-label" for="sso-primary-color">Primary Color</label>
							<div class="os-sso-color-input">
								<input id="sso-primary-color" type="color" bind:value={ssoLoginPrimaryColor} />
								<input type="text" bind:value={ssoLoginPrimaryColor} placeholder="#6366f1" class="input" style="flex: 1;" />
							</div>
						</div>
						<div class="os-sso-field" style="flex: 1;">
							<label class="os-field-label" for="sso-bg-color">Background Color</label>
							<div class="os-sso-color-input">
								<input id="sso-bg-color" type="color" bind:value={ssoLoginBgColor} />
								<input type="text" bind:value={ssoLoginBgColor} placeholder="#0a0a0f" class="input" style="flex: 1;" />
							</div>
						</div>
					</div>

					<!-- Preview -->
					<div class="os-sso-preview" style="background: {ssoLoginBgColor};">
						<div class="os-sso-preview-card">
							{#if ssoLoginLogoUrl}
								<img src={ssoLoginLogoUrl} alt="Logo" class="os-sso-preview-logo" />
							{:else}
								<div class="os-sso-preview-icon" style="background: {ssoLoginPrimaryColor}20; color: {ssoLoginPrimaryColor};">
									<Lock class="h-5 w-5" />
								</div>
							{/if}
							<p class="os-sso-preview-text">{ssoLoginWelcomeText || `Sign in to ${organization?.name || 'Organization'}`}</p>
							<div class="os-sso-preview-btn" style="background: {ssoLoginPrimaryColor};">Sign in with SSO</div>
						</div>
					</div>

					<button onclick={onSaveSsoConfig} disabled={ssoSaving} class="btn btn-primary">
						{#if ssoSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Save Branding
					</button>
				</div>
			{/if}
		{/if}
	</div>
{:else}
	<div class="os-card">
		<div class="os-card-body">
			<p class="text-sm" style="color: var(--surface-muted);">
				Only the organization owner can manage SSO settings.
			</p>
		</div>
	</div>
{/if}
