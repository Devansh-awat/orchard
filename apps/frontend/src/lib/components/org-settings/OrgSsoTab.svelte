<script lang="ts">
	import { Loader2, Globe, Lock } from 'lucide-svelte';
	import { ShieldCheck } from '@jis3r/icons';
	import { Button, TabBar, Field, Input } from '$lib/components/ui';
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
		ssoDeleting = false,
		onSaveSubdomain,
		onSaveSsoConfig,
		onTestSsoConnection,
		onDeleteSsoConfig,
		index = 0
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
		ssoDeleting?: boolean;
		onSaveSubdomain: () => void;
		onSaveSsoConfig: () => void;
		onTestSsoConnection: () => void;
		onDeleteSsoConfig: () => void;
		index?: number;
	} = $props();

	const ssoTabs = [
		{ id: 'config', label: 'Provider configuration' },
		{ id: 'branding', label: 'Login page customization' }
	];
</script>

{#if isOwner}
	<SettingsSection
		title="Single Sign-On"
		description="Configure identity provider for your organization"
		iconColor="primary"
		{index}
	>
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
					Custom subdomain
				</h3>
				<div class="sso-subdomain-row">
					<Input bind:value={ssoSubdomain} placeholder="yourcompany" class="sso-subdomain-input" />
					<span class="sso-subdomain-suffix">.{baseDomain}</span>
					<Button variant="secondary" onclick={onSaveSubdomain} loading={ssoSubdomainSaving}>
						Save
					</Button>
				</div>
				{#if ssoSubdomain}
					<p class="sso-hint">
						Your login page will be at <strong>https://{ssoSubdomain}.{baseDomain}</strong>
					</p>
				{/if}
			</div>

			<TabBar
				tabs={ssoTabs}
				bind:value={() => ssoTab, (v) => (ssoTab = v as 'config' | 'branding')}
			/>

			{#if ssoTab === 'config'}
				<!-- Provider selection -->
				<div class="sso-section">
					<h3 class="sso-section-title">Provider type</h3>
					<div class="sso-provider-toggle">
						<Button
							variant={ssoProvider === 'oidc' ? 'primary' : 'secondary'}
							size="sm"
							onclick={() => {
								ssoProvider = 'oidc';
							}}
						>
							OpenID Connect (OIDC)
						</Button>
						<Button
							variant={ssoProvider === 'saml' ? 'primary' : 'secondary'}
							size="sm"
							onclick={() => {
								ssoProvider = 'saml';
							}}
						>
							SAML 2.0
						</Button>
					</div>
				</div>

				<!-- OIDC config -->
				{#if ssoProvider === 'oidc'}
					<div class="sso-section">
						<Field label="Issuer URL" for="oidc-issuer">
							<Input
								id="oidc-issuer"
								type="url"
								bind:value={ssoOidcIssuerUrl}
								placeholder="https://accounts.google.com"
							/>
						</Field>
						<Field label="Client ID" for="oidc-client-id">
							<Input
								id="oidc-client-id"
								bind:value={ssoOidcClientId}
								placeholder="your-client-id"
							/>
						</Field>
						<Field label="Client secret" for="oidc-client-secret">
							<Input
								id="oidc-client-secret"
								type="password"
								bind:value={ssoOidcClientSecret}
								placeholder={ssoConfig?.oidcClientSecret === '••••••••'
									? '(already set, leave blank to keep)'
									: 'your-client-secret'}
							/>
						</Field>
						<Field label="Scopes" for="oidc-scopes">
							<Input
								id="oidc-scopes"
								bind:value={ssoOidcScopes}
								placeholder="openid email profile"
							/>
						</Field>
					</div>
				{/if}

				<!-- SAML config -->
				{#if ssoProvider === 'saml'}
					<div class="sso-section">
						<Field label="Metadata URL (optional)" for="saml-metadata">
							<Input
								id="saml-metadata"
								type="url"
								bind:value={ssoSamlMetadataUrl}
								placeholder="https://idp.example.com/metadata"
							/>
						</Field>
						<Field label="SSO entry point URL" for="saml-entry">
							<Input
								id="saml-entry"
								type="url"
								bind:value={ssoSamlEntryPoint}
								placeholder="https://idp.example.com/sso"
							/>
						</Field>
						<Field label="Issuer" for="saml-issuer">
							<Input id="saml-issuer" bind:value={ssoSamlIssuer} placeholder="urn:idp:example" />
						</Field>
						<Field label="IdP certificate (PEM)" for="saml-cert">
							<textarea
								id="saml-cert"
								bind:value={ssoSamlCertificate}
								rows="4"
								placeholder={ssoConfig?.samlCertificate === '(configured)'
									? '(already set, leave blank to keep)'
									: 'Paste the X.509 certificate here'}
								class="input"
							></textarea>
						</Field>
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
							<p class="sso-toggle-desc">
								Require SSO for all members (disables email/passkey login on subdomain)
							</p>
						</div>
						<label class="sso-switch">
							<input type="checkbox" bind:checked={ssoEnforced} />
							<span class="sso-slider"></span>
						</label>
					</div>
				</div>

				<!-- Actions -->
				<div class="sso-actions">
					<Button variant="primary" onclick={onSaveSsoConfig} loading={ssoSaving}>
						Save SSO configuration
					</Button>
					<Button variant="secondary" onclick={onTestSsoConnection} loading={ssoTesting}>
						Test connection
					</Button>
					{#if ssoConfig}
						<Button variant="danger" onclick={onDeleteSsoConfig} loading={ssoDeleting}>
							Delete SSO config
						</Button>
					{/if}
				</div>

				{#if ssoTestResult}
					<div
						class="sso-test-result"
						class:sso-test-success={ssoTestResult.success}
						class:sso-test-error={!ssoTestResult.success}
					>
						{#if ssoTestResult.success}
							<p>
								Connection successful. <a
									href={ssoTestResult.testLoginUrl}
									target="_blank"
									rel="noopener">Test login</a
								>
							</p>
						{:else}
							<p>Connection failed: {ssoTestResult.error}</p>
						{/if}
					</div>
				{/if}
			{/if}

			{#if ssoTab === 'branding'}
				<div class="sso-section">
					<Field label="Logo URL" for="sso-logo">
						<Input
							id="sso-logo"
							type="url"
							bind:value={ssoLoginLogoUrl}
							placeholder="https://example.com/logo.png"
						/>
					</Field>
					<Field label="Welcome text" for="sso-welcome">
						<Input
							id="sso-welcome"
							bind:value={ssoLoginWelcomeText}
							placeholder="Sign in to Your Company"
						/>
					</Field>
					<div class="sso-color-row">
						<div class="sso-color-col">
							<Field label="Primary color" for="sso-primary-color">
								<div class="sso-color-input">
									<input id="sso-primary-color" type="color" bind:value={ssoLoginPrimaryColor} />
									<Input
										bind:value={ssoLoginPrimaryColor}
										placeholder="#6366f1"
										class="sso-color-text"
									/>
								</div>
							</Field>
						</div>
						<div class="sso-color-col">
							<Field label="Background color" for="sso-bg-color">
								<div class="sso-color-input">
									<input id="sso-bg-color" type="color" bind:value={ssoLoginBgColor} />
									<Input
										bind:value={ssoLoginBgColor}
										placeholder="#0a0a0f"
										class="sso-color-text"
									/>
								</div>
							</Field>
						</div>
					</div>

					<!-- Preview -->
					<div class="sso-preview" style="background: {ssoLoginBgColor};">
						<div class="sso-preview-card">
							{#if ssoLoginLogoUrl}
								<img src={ssoLoginLogoUrl} alt="Logo" class="sso-preview-logo" />
							{:else}
								<div
									class="sso-preview-icon"
									style="background: {ssoLoginPrimaryColor}20; color: {ssoLoginPrimaryColor};"
								>
									<Lock class="h-5 w-5" />
								</div>
							{/if}
							<p class="sso-preview-text">
								{ssoLoginWelcomeText || `Sign in to ${organization?.name || 'Organization'}`}
							</p>
							<div class="sso-preview-btn" style="background: {ssoLoginPrimaryColor};">
								Sign in with SSO
							</div>
						</div>
					</div>

					<Button variant="primary" onclick={onSaveSsoConfig} loading={ssoSaving}>
						Save branding
					</Button>
				</div>
			{/if}
		{/if}
	</SettingsSection>
{:else}
	<SettingsSection
		title="Single Sign-On"
		description="Configure identity provider for your organization"
		iconColor="primary"
		{index}
	>
		{#snippet icon(hovered)}<ShieldCheck size={18} animate={hovered} />{/snippet}

		<p class="sso-no-access">Only the organization owner can manage SSO settings.</p>
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

	.sso-subdomain-row :global(.sso-subdomain-input) {
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

	.sso-provider-toggle {
		display: flex;
		gap: 0.5rem;
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

	.sso-color-col {
		flex: 1;
	}

	.sso-color-input {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sso-color-input :global(.sso-color-text) {
		flex: 1;
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
