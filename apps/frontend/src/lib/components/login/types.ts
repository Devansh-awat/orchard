export interface LoginProvider {
	id: string;
	slug: string;
	name: string;
	preset: string;
	protocol: 'oidc' | 'saml' | 'oauth2';
	label: string;
	iconUrl?: string | null;
	startUrl: string;
	source?: 'env' | 'database';
}

export interface OrgLoginContext {
	organizationId: string;
	name: string;
	slug: string;
	avatarUrl?: string | null;
	enforced: boolean;
	branding: {
		logoUrl?: string | null;
		primaryColor?: string | null;
		bgColor?: string | null;
		welcomeText?: string | null;
		tagline?: string | null;
	};
	providers: LoginProvider[];
}

export interface DiscoveredOrg {
	slug: string;
	name: string;
	avatarUrl?: string | null;
	enforced: boolean;
	loginUrl: string;
}
