export type AppPorts = { http?: string | null; https?: string | null };

export function formatAppUrl(
	host: string | null | undefined,
	path = '',
	tls = true,
	ports: AppPorts = {},
): string {
	if (!host) return '';
	const [name, ...rest] = String(host).split('/');
	if (!name) return '';
	const configured = (tls ? ports.https : ports.http) ?? '';
	const standard = tls ? '443' : '80';
	const port = configured && configured !== standard ? `:${configured}` : '';
	const embedded = rest.length ? `/${rest.join('/')}` : '';
	return `${tls ? 'https' : 'http'}://${name}${port}${embedded}${path ?? ''}`;
}
