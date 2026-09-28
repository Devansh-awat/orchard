import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const allowedHosts = new Set(
	(env.ASSET_PROXY_HOSTS || 'assets.orchard.my')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
);

const nosniff = { 'x-content-type-options': 'nosniff' };

const reject = (message: string, status: number) =>
	new Response(message, { status, headers: nosniff });

export const GET: RequestHandler = async ({ url, fetch, setHeaders }) => {
	const target = url.searchParams.get('u');
	if (!target) return reject('missing u', 400);

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return reject('bad url', 400);
	}
	if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) {
		return reject('forbidden host', 403);
	}

	const upstream = await fetch(parsed.toString());
	if (!upstream.ok || !upstream.body) {
		return reject('upstream error', 502);
	}

	const contentType = upstream.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('image/')) {
		return reject('unsupported media type', 415);
	}

	setHeaders({
		'content-type': contentType,
		'cache-control': 'public, max-age=86400, immutable',
		'access-control-allow-origin': '*',
		...nosniff
	});
	return new Response(upstream.body, { status: 200 });
};
