export type SsoProtocol = 'oidc' | 'saml' | 'oauth2';

// What the colour pickers start on before an org picks its own. These live
// here rather than in the component because they are branding data an org
// overwrites, not design tokens.
export const DEFAULT_LOGIN_ACCENT = '#4f46e5';
export const DEFAULT_LOGIN_BG = '#0b0b0f';

export interface SsoProviderPreset {
	id: string;
	name: string;
	protocol: SsoProtocol;
	category: 'social' | 'enterprise' | 'custom';
	buttonLabel: string;
	scopes: string;
	fields: string[];
	issuerUrl: string | null;
	issuerTemplate: string | null;
	docsUrl: string | null;
	hint: string | null;
}

export interface SsoProvider {
	id: string;
	organizationId: string | null;
	slug: string;
	name: string;
	preset: string;
	protocol: SsoProtocol;
	enabled: boolean;
	buttonLabel: string | null;
	iconUrl: string | null;
	sortOrder: number;
	issuerUrl: string | null;
	clientId: string | null;
	clientSecret: string | null;
	scopes: string | null;
	authorizationUrl: string | null;
	tokenUrl: string | null;
	userinfoUrl: string | null;
	samlEntryPoint: string | null;
	samlIssuer: string | null;
	samlIdpEntityId: string | null;
	samlCertificate: string | null;
	samlMetadataUrl: string | null;
	jitProvisioning: boolean;
	defaultRole: 'owner' | 'admin' | 'member' | 'guest';
	allowedDomains: string[];
	requireVerifiedEmail: boolean;
	trustEmail?: boolean;
	usable: boolean;
	lastUsedAt: string | null;
	callbackUrl: string;
	entityId: string;
	metadataUrl: string | null;
}

export interface SsoSettings {
	organizationId: string;
	platformEnabled: boolean;
	enabled: boolean;
	enforced: boolean;
	loginLogoUrl: string | null;
	loginPrimaryColor: string | null;
	loginBgColor: string | null;
	loginWelcomeText: string | null;
	loginTagline: string | null;
}

export interface SsoDomain {
	id: string;
	domain: string;
	verified: boolean;
	verifiedAt: string | null;
	lastCheckedAt: string | null;
	lastError: string | null;
	recordName: string;
	recordType: 'TXT';
	recordValue: string;
}

export interface SsoOverview {
	settings: SsoSettings;
	providers: SsoProvider[];
	domains: SsoDomain[];
	presets: SsoProviderPreset[];
	loginUrl: string | null;
}

export type MappableRole = 'admin' | 'member' | 'guest';

export interface GroupRule {
	id?: string;
	organizationId: string;
	value: string;
	role: MappableRole;
}

export interface GroupRulesState {
	groupClaim: string;
	rules: GroupRule[];
}

export interface RulePreviewMatch {
	organizationId: string;
	role: MappableRole;
	ruleIds: string[];
}

export interface RulePreview {
	hasRules: boolean;
	allowed: boolean;
	matches: RulePreviewMatch[];
}

export interface IdentityPolicy {
	autoCreateOrgs: { enabled: boolean; dbValue: boolean; envOverride: boolean | null };
	superadminRule: { providerId: string; value: string } | null;
}

export interface AutoCreateRule {
	id?: string;
	value: string;
	role: MappableRole;
	organizationId?: string | null;
}

export interface ProviderDraft {
	preset: string;
	name: string;
	protocol: SsoProtocol;
	enabled: boolean;
	issuerUrl: string;
	tenant: string;
	domain: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	samlMetadataUrl: string;
	samlEntryPoint: string;
	samlIdpEntityId: string;
	samlCertificate: string;
	jitProvisioning: boolean;
	defaultRole: 'admin' | 'member' | 'guest';
	allowedDomains: string;
	requireVerifiedEmail: boolean;
	trustEmail: boolean;
	iconUrl: string | null;
	pendingIcon?: File | null;
}

export const PROVIDER_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const PROVIDER_ICON_MAX_BYTES = 1024 * 1024;

export function emptyDraft(preset: SsoProviderPreset): ProviderDraft {
	return {
		preset: preset.id,
		name: preset.name,
		protocol: preset.protocol,
		enabled: true,
		issuerUrl: preset.issuerUrl ?? '',
		tenant: '',
		domain: '',
		clientId: '',
		clientSecret: '',
		scopes: preset.scopes,
		samlMetadataUrl: '',
		samlEntryPoint: '',
		samlIdpEntityId: '',
		samlCertificate: '',
		jitProvisioning: true,
		defaultRole: 'member',
		allowedDomains: '',
		requireVerifiedEmail: true,
		trustEmail: false,
		iconUrl: null,
		pendingIcon: null
	};
}

export function draftFromProvider(provider: SsoProvider): ProviderDraft {
	return {
		preset: provider.preset,
		name: provider.name,
		protocol: provider.protocol,
		enabled: provider.enabled,
		issuerUrl: provider.issuerUrl ?? '',
		tenant: '',
		domain: '',
		clientId: provider.clientId ?? '',
		clientSecret: '',
		scopes: provider.scopes ?? '',
		samlMetadataUrl: provider.samlMetadataUrl ?? '',
		samlEntryPoint: provider.samlEntryPoint ?? '',
		samlIdpEntityId: provider.samlIdpEntityId ?? '',
		samlCertificate: '',
		jitProvisioning: provider.jitProvisioning,
		defaultRole: provider.defaultRole === 'owner' ? 'admin' : provider.defaultRole,
		allowedDomains: provider.allowedDomains.join(', '),
		requireVerifiedEmail: provider.requireVerifiedEmail,
		trustEmail: provider.trustEmail ?? false,
		iconUrl: provider.iconUrl,
		pendingIcon: null
	};
}

/** Only send what the form actually collected; blank secrets keep the stored one. */
export function draftToPayload(draft: ProviderDraft) {
	const payload: Record<string, unknown> = {
		preset: draft.preset,
		name: draft.name.trim(),
		protocol: draft.protocol,
		enabled: draft.enabled,
		jitProvisioning: draft.jitProvisioning,
		defaultRole: draft.defaultRole,
		requireVerifiedEmail: draft.requireVerifiedEmail,
		trustEmail: draft.trustEmail,
		iconUrl: draft.iconUrl,
		allowedDomains: draft.allowedDomains
			.split(/[\s,]+/)
			.map((d) => d.trim().replace(/^@/, ''))
			.filter(Boolean)
	};

	if (draft.protocol === 'saml') {
		payload.samlMetadataUrl = draft.samlMetadataUrl.trim() || null;
		payload.samlEntryPoint = draft.samlEntryPoint.trim() || null;
		payload.samlIdpEntityId = draft.samlIdpEntityId.trim() || null;
		if (draft.samlCertificate.trim()) payload.samlCertificate = draft.samlCertificate.trim();
		return payload;
	}

	if (draft.issuerUrl.trim()) payload.issuerUrl = draft.issuerUrl.trim();
	if (draft.tenant.trim()) payload.tenant = draft.tenant.trim();
	if (draft.domain.trim()) payload.domain = draft.domain.trim();
	payload.clientId = draft.clientId.trim();
	if (draft.clientSecret.trim()) payload.clientSecret = draft.clientSecret.trim();
	payload.scopes = draft.scopes.trim();
	return payload;
}
