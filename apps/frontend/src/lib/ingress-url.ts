import { env } from '$env/dynamic/public';
import { formatAppUrl } from '$lib/utils/app-url';

type IngressLike = {
	url?: string | null;
	host?: string | null;
	path?: string | null;
	tlsEnabled?: boolean | null;
};

export function ingressUrl(ingress: IngressLike | null | undefined): string {
	if (!ingress) return '';
	if (ingress.url) return ingress.url;
	return formatAppUrl(ingress.host, ingress.path ?? '', ingress.tlsEnabled !== false, {
		http: env.PUBLIC_HTTP_PORT,
		https: env.PUBLIC_HTTPS_PORT
	});
}
