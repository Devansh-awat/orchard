import { catalog, graftCatalog } from '$lib/server/registry';
import { absolute } from '$lib/site';
import type { RequestHandler } from './$types';

const PAGES = ['/', '/templates', '/extensions', '/credits'];

function entry(path: string, modified?: string) {
	const time = modified ? new Date(modified) : null;
	const lastmod =
		time && !Number.isNaN(time.getTime()) ? `<lastmod>${time.toISOString()}</lastmod>` : '';
	return `<url><loc>${absolute(path)}</loc>${lastmod}</url>`;
}

export const GET: RequestHandler = async ({ fetch }) => {
	const [templates, extensions] = await Promise.all([catalog(fetch), graftCatalog(fetch)]);
	const urls = [
		...PAGES.map((path) => entry(path)),
		...templates.templates.map((t) =>
			entry(`/templates/${encodeURIComponent(t.name)}`, t.publishedAt)
		),
		...extensions.grafts.map((g) =>
			entry(
				`/extensions/${encodeURIComponent(g.id)}`,
				g.versions.find((v) => v.version === g.latest)?.publishedAt
			)
		)
	];
	const failed = templates.error || extensions.error;
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
		{
			headers: {
				'content-type': 'application/xml; charset=utf-8',
				'cache-control': `public, max-age=${failed ? 120 : 3600}`
			}
		}
	);
};
