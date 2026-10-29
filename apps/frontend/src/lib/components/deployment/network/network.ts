import type { DropdownOption } from '$lib/components/ui';
import { statusMeta, type StatusMeta } from '$lib/components/ui/status';

export const REDIRECT_STATUS_OPTIONS: DropdownOption[] = [
	{ value: '307', label: '307 Temporary', description: 'Keeps the request method' },
	{ value: '302', label: '302 Found', description: 'Temporary' },
	{ value: '308', label: '308 Permanent', description: 'Keeps the request method' },
	{ value: '301', label: '301 Moved Permanently', description: 'Permanent' }
];

export type ProtectionMode = 'none' | 'password' | 'basic' | 'orchard';

export type ServicePort = {
	id?: string;
	name?: string;
	port?: number;
	targetPort: number;
	protocol?: string;
	nodePort?: number | null;
	publicEnabled?: boolean;
	publicPort?: number | null;
	publicAddress?: string | null;
	internalUrl?: string;
};

export type PortEntry = {
	key: string;
	service: any;
	port: ServicePort;
	internalUrl: string | null;
};

export function servicePorts(service: any): ServicePort[] {
	if (service.ports?.length) return service.ports;
	return [
		{
			name: service.name,
			port: service.port,
			targetPort: service.targetPort,
			protocol: service.protocol,
			nodePort: service.nodePort ?? null
		}
	];
}

export function portEntries(services: any[] | undefined): PortEntry[] {
	return (services ?? []).flatMap((service) =>
		servicePorts(service).map((port) => ({
			key: `${service.id}:${port.id ?? `${port.targetPort}/${port.protocol ?? 'TCP'}`}`,
			service,
			port,
			internalUrl:
				port.internalUrl ??
				(service.internalHost
					? `${service.internalHost}:${port.port ?? port.targetPort}`
					: (service.internalUrl ?? null))
		}))
	);
}

export function protectionOf(ingress: any): ProtectionMode | 'legacy' {
	const mode = ingress.protectionMode;
	if (mode === 'password' || mode === 'basic' || mode === 'orchard') return mode;
	const middlewares = ingress.annotations?.['traefik.ingress.kubernetes.io/router.middlewares'];
	if (typeof middlewares === 'string' && middlewares.includes('auth@kubernetescrd'))
		return 'legacy';
	if (ingress.annotations?.['orchard.my/basic-auth'] === 'true') return 'basic';
	return 'none';
}

export const PROTECTION_LABELS: Record<ProtectionMode | 'legacy', string> = {
	none: '',
	password: 'Password',
	basic: 'Username and password',
	orchard: 'Orchard sign-in',
	legacy: 'Sign-in'
};

export function certificateMeta(ingress: any): StatusMeta | null {
	if (ingress.tlsEnabled === false) return null;
	switch (ingress.certificateStatus?.state) {
		case 'issuing':
			return statusMeta('progress', 'Securing', true);
		case 'failed':
			return statusMeta('error', 'Certificate failed');
		case 'rateLimited':
			return statusMeta('warning', 'Certificate delayed');
		default:
			return null;
	}
}

export function displayHost(ingress: any): string {
	const path = ingress.path && ingress.path !== '/' ? ingress.path : '';
	return `${ingress.host}${path}`;
}

export function redirectLabel(ingress: any): string {
	return String(ingress.redirectTarget ?? '').replace(/^https?:\/\//, '');
}

export function dnsRecordName(host: string): string {
	const parts = host.split('.').filter(Boolean);
	return parts.length > 2 ? parts.slice(0, -2).join('.') : '@';
}

export function portKeyOf(ingress: any, entries: PortEntry[]): string | null {
	if (ingress.redirectTarget) return null;
	const route = ingress.routes?.[0];
	const name = route?.serviceName ?? ingress.service?.name;
	const port = Number(route?.servicePort ?? ingress.service?.port);
	const match =
		entries.find(
			(e) => e.service.name === name && Number(e.port.port ?? e.service.port) === port
		) ?? entries.find((e) => e.service.name === name);
	return (match ?? entries[0])?.key ?? null;
}

export function domainsByPort(ingresses: any[], entries: PortEntry[]) {
	const byPort = new Map<string, any[]>();
	const redirects: any[] = [];
	for (const ingress of ingresses) {
		const key = portKeyOf(ingress, entries);
		if (!key) {
			redirects.push(ingress);
			continue;
		}
		byPort.set(key, [...(byPort.get(key) ?? []), ingress]);
	}
	return { byPort, redirects };
}

export function domainKeyOf(entry: PortEntry): string | null {
	if ((entry.port.protocol ?? 'TCP').toUpperCase() === 'UDP') return null;
	return `${entry.service.id}::${entry.port.port ?? entry.service.port}`;
}
