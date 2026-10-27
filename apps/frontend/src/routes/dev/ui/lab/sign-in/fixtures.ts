import type { LoginProvider } from '$lib/components/login';

const provider = (id: string, preset: string, label: string): LoginProvider => ({
	id,
	slug: id,
	name: label,
	preset,
	protocol: 'oidc',
	label,
	startUrl: `/apiv1/sso/start/${id}`
});

export const VARIANTS = {
	instance: {
		label: 'Instance',
		title: 'Sign in to Orchard',
		providers: [provider('hackclub', 'hackclub', 'Continue with Hack Club')],
		emailAccess: 'open',
		brand: null
	},
	several: {
		label: 'Several providers',
		title: 'Sign in to Orchard',
		providers: [
			provider('github', 'github', 'Continue with GitHub'),
			provider('google', 'google', 'Continue with Google')
		],
		emailAccess: 'open',
		brand: null
	},
	enforced: {
		label: 'SSO required',
		title: 'Sign in to Orchard',
		providers: [provider('okta', 'saml', 'Continue with Okta')],
		emailAccess: 'tucked',
		brand: null
	},
	email: {
		label: 'Email only',
		title: 'Sign in to Orchard',
		providers: [],
		emailAccess: 'open',
		brand: null
	},
	org: {
		label: 'Org branded',
		title: 'Sign in to Northwind',
		providers: [provider('northwind', 'microsoft', 'Continue with Microsoft')],
		emailAccess: 'tucked',
		brand: '#2f6bd8'
	}
} as const;

export type VariantKey = keyof typeof VARIANTS;
