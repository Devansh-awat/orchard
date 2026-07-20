import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const allowedHosts = (env.ASSET_PROXY_HOSTS || 'assets.orchard.my')
	.split(',')
	.map((h) => h.trim())
	.filter(Boolean);

const hostAllowed = (host: string) => host.endsWith('.r2.dev') || allowedHosts.includes(host);

export const GET: RequestHandler = async ({ url, fetch, setHeaders }) => {
	const target = url.searchParams.get('u');
	if (!target) return new Response('missing u', { status: 400 });

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return new Response('bad url', { status: 400 });
	}
	if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname)) {
		return new Response('forbidden host', { status: 403 });
	}

	const upstream = await fetch(parsed.toString());
	if (!upstream.ok || !upstream.body) {
		return new Response('upstream error', { status: 502 });
	}

	setHeaders({
		'content-type': upstream.headers.get('content-type') ?? 'image/png',
		'cache-control': 'public, max-age=86400, immutable',
		'access-control-allow-origin': '*'
	});
	return new Response(upstream.body, { status: 200 });
};
