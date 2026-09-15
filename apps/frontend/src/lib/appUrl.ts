import { env } from '$env/dynamic/public';
import { formatAppUrl } from '$lib/utils/app-url';

export function appUrl(host: string | null | undefined, path = '', tls = true): string {
	return formatAppUrl(host, path, tls, {
		http: env.PUBLIC_HTTP_PORT,
		https: env.PUBLIC_HTTPS_PORT,
	});
}
