export type SetupCertificate = {
	state:
		| 'ready'
		| 'issuing'
		| 'failed'
		| 'rateLimited'
		| 'unknown'
		| 'unconfigured'
		| 'perHost'
		| 'external';
	host: string | null;
	message: string | null;
};

export type SetupOverviewItem = {
	id: string;
	title: string;
	value: string;
	state: 'configured' | 'skipped' | 'pending' | 'off';
	detail: string | null;
	href: string;
};

export type SetupOverview = {
	installer: boolean;
	mode: string | null;
	dashboardUrl: string | null;
	appDomain: string | null;
	publicIp: string | null;
	cname: string | null;
	certIssuer: string | null;
	locked: {
		publicIp: boolean;
		cname: boolean;
		appDomain: boolean;
		email: boolean;
		limits: boolean;
	};
	mcp: { deployed: boolean; enabled: boolean; url: string | null; locked: boolean };
	emailConfigured: boolean;
	certificate: SetupCertificate;
	skipped: string[];
	items: SetupOverviewItem[];
};

export function dashboardHost(overview: SetupOverview | null): string {
	if (!overview?.dashboardUrl) return '';
	try {
		return new URL(overview.dashboardUrl).hostname;
	} catch {
		return '';
	}
}

export function parentDomain(host: string): string {
	const labels = host.split('.');
	return labels.length > 2 ? labels.slice(1).join('.') : host;
}
