import { SsoProtocol } from '@prisma/client';

/**
 * The catalogue an admin picks from when adding a connection. A preset is only
 * a set of defaults plus the list of fields worth asking for — every preset
 * ends up in the same IdentityProvider row and runs the same flow, so adding
 * one here is data, not code.
 *
 * `template` fields carry a {placeholder} the admin fills in (Entra needs a
 * tenant id, Okta and Keycloak need their own hostname). We substitute rather
 * than making the admin assemble the URL, because getting the issuer subtly
 * wrong is the single most common way an OIDC setup fails.
 */
export type PresetField =
  | 'clientId'
  | 'clientSecret'
  | 'issuerUrl'
  | 'scopes'
  | 'tenant'
  | 'domain'
  | 'samlMetadataUrl'
  | 'samlEntryPoint'
  | 'samlIssuer'
  | 'samlIdpEntityId'
  | 'samlCertificate';

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: SsoProtocol;
  category: 'social' | 'enterprise' | 'custom';
  buttonLabel: string;
  scopes: string;
  fields: PresetField[];
  issuerUrl?: string;
  issuerTemplate?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  docsUrl?: string;
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'google',
    name: 'Google Workspace',
    protocol: SsoProtocol.oidc,
    category: 'social',
    buttonLabel: 'Continue with Google',
    issuerUrl: 'https://accounts.google.com',
    scopes: 'openid email profile',
    fields: ['clientId', 'clientSecret'],
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    hint: 'Create an OAuth 2.0 Web application credential and paste the client id and secret.',
  },
  {
    id: 'microsoft',
    name: 'Microsoft Entra ID',
    protocol: SsoProtocol.oidc,
    category: 'social',
    buttonLabel: 'Continue with Microsoft',
    issuerTemplate: 'https://login.microsoftonline.com/{tenant}/v2.0',
    scopes: 'openid email profile',
    fields: ['tenant', 'clientId', 'clientSecret'],
    docsUrl: 'https://entra.microsoft.com',
    hint: 'Use your directory (tenant) ID, or "organizations" to accept any work account.',
  },
  {
    id: 'github',
    name: 'GitHub',
    protocol: SsoProtocol.oauth2,
    category: 'social',
    buttonLabel: 'Continue with GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scopes: 'read:user user:email',
    fields: ['clientId', 'clientSecret'],
    docsUrl: 'https://github.com/settings/developers',
    hint: 'GitHub has no OIDC discovery, so we read the primary verified email from its API.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    protocol: SsoProtocol.oidc,
    category: 'social',
    buttonLabel: 'Continue with GitLab',
    issuerUrl: 'https://gitlab.com',
    scopes: 'openid email profile',
    fields: ['clientId', 'clientSecret', 'issuerUrl'],
    docsUrl: 'https://docs.gitlab.com/ee/integration/openid_connect_provider.html',
    hint: 'Self-managed GitLab works too, point the issuer at your own instance.',
  },
  {
    id: 'okta',
    name: 'Okta',
    protocol: SsoProtocol.oidc,
    category: 'enterprise',
    buttonLabel: 'Continue with Okta',
    issuerTemplate: 'https://{domain}/oauth2/default',
    scopes: 'openid email profile',
    fields: ['domain', 'clientId', 'clientSecret'],
    docsUrl: 'https://developer.okta.com/docs/guides/find-your-domain/',
    hint: 'Your Okta domain looks like acme.okta.com.',
  },
  {
    id: 'auth0',
    name: 'Auth0',
    protocol: SsoProtocol.oidc,
    category: 'enterprise',
    buttonLabel: 'Continue with Auth0',
    issuerTemplate: 'https://{domain}/',
    scopes: 'openid email profile',
    fields: ['domain', 'clientId', 'clientSecret'],
    docsUrl: 'https://auth0.com/docs/get-started/applications',
  },
  {
    id: 'keycloak',
    name: 'Keycloak',
    protocol: SsoProtocol.oidc,
    category: 'enterprise',
    buttonLabel: 'Continue with Keycloak',
    issuerTemplate: 'https://{domain}/realms/{tenant}',
    scopes: 'openid email profile',
    fields: ['domain', 'tenant', 'clientId', 'clientSecret'],
    docsUrl: 'https://www.keycloak.org/docs/latest/server_admin/',
    hint: 'Domain is the Keycloak host, tenant is the realm name.',
  },
  {
    id: 'authentik',
    name: 'Authentik',
    protocol: SsoProtocol.oidc,
    category: 'enterprise',
    buttonLabel: 'Continue with Authentik',
    issuerTemplate: 'https://{domain}/application/o/{tenant}/',
    scopes: 'openid email profile',
    fields: ['domain', 'tenant', 'clientId', 'clientSecret'],
    hint: 'Tenant is the application slug you gave the provider in Authentik.',
  },
  {
    id: 'onelogin',
    name: 'OneLogin',
    protocol: SsoProtocol.oidc,
    category: 'enterprise',
    buttonLabel: 'Continue with OneLogin',
    issuerTemplate: 'https://{domain}/oidc/2',
    scopes: 'openid email profile',
    fields: ['domain', 'clientId', 'clientSecret'],
  },
  {
    id: 'jumpcloud',
    name: 'JumpCloud',
    protocol: SsoProtocol.oidc,
    category: 'enterprise',
    buttonLabel: 'Continue with JumpCloud',
    issuerUrl: 'https://oauth.id.jumpcloud.com/',
    scopes: 'openid email profile',
    fields: ['clientId', 'clientSecret'],
  },
  {
    id: 'generic',
    name: 'OpenID Connect',
    protocol: SsoProtocol.oidc,
    category: 'custom',
    buttonLabel: 'Continue with SSO',
    scopes: 'openid email profile',
    fields: ['issuerUrl', 'clientId', 'clientSecret', 'scopes'],
    hint: 'Any spec-compliant IdP that publishes /.well-known/openid-configuration.',
  },
  {
    id: 'saml',
    name: 'SAML 2.0',
    protocol: SsoProtocol.saml,
    category: 'custom',
    buttonLabel: 'Continue with SSO',
    scopes: '',
    fields: ['samlMetadataUrl', 'samlEntryPoint', 'samlIdpEntityId', 'samlCertificate'],
    hint: 'Upload the IdP metadata URL, or paste the sign-in URL and signing certificate.',
  },
];

export function findPreset(id: string | null | undefined): ProviderPreset | null {
  if (!id) return null;
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}

const MAX_ISSUER_INPUT_LENGTH = 2048;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function boundedInput(value: string | null | undefined): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > MAX_ISSUER_INPUT_LENGTH ? '' : s;
}

/** Fill a preset's issuer template from the tenant/domain the admin typed. */
export function resolveIssuerUrl(
  preset: ProviderPreset | null,
  input: { issuerUrl?: string | null; tenant?: string | null; domain?: string | null },
): string | null {
  const issuerUrl = boundedInput(input.issuerUrl);
  if (issuerUrl) return stripTrailingSlashes(issuerUrl) || null;
  if (!preset) return null;
  if (preset.issuerTemplate) {
    const tenant = boundedInput(input.tenant);
    const domain = stripTrailingSlashes(boundedInput(input.domain).replace(/^https?:\/\//, ''));
    if (preset.issuerTemplate.includes('{tenant}') && !tenant) return null;
    if (preset.issuerTemplate.includes('{domain}') && !domain) return null;
    return preset.issuerTemplate.replace('{tenant}', tenant).replace('{domain}', domain);
  }
  return preset.issuerUrl ?? null;
}

/**
 * The public catalogue. Secrets never appear here, so it is safe to hand to any
 * admin UI, and the UI renders its form entirely from `fields`.
 */
export function publicPresets() {
  return PROVIDER_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    category: p.category,
    buttonLabel: p.buttonLabel,
    scopes: p.scopes,
    fields: p.fields,
    issuerUrl: p.issuerUrl ?? null,
    issuerTemplate: p.issuerTemplate ?? null,
    docsUrl: p.docsUrl ?? null,
    hint: p.hint ?? null,
  }));
}
