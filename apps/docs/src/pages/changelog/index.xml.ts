import type { APIRoute } from 'astro';
import { changeHref, getChanges } from '../../lib/changelog';
import { SITE_URL } from '../../lib/nav';

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const GET: APIRoute = () => {
  const changes = getChanges().slice(0, 50);
  const updated = changes[0] ? new Date(`${changes[0].date}T00:00:00Z`).toUTCString() : new Date(0).toUTCString();
  const items = changes.map((change) => {
    const link = `${SITE_URL}${changeHref(change)}`;
    const summary = [change.detail, `${change.type} in ${change.version ?? change.component}.`]
      .filter(Boolean)
      .join(' ');
    return [
      '    <item>',
      `      <title>${xml(change.text)}</title>`,
      `      <link>${xml(link)}</link>`,
      `      <guid isPermaLink="false">${xml(change.id)}</guid>`,
      `      <pubDate>${new Date(`${change.date}T00:00:00Z`).toUTCString()}</pubDate>`,
      `      <category>${xml(change.component)}</category>`,
      `      <description>${xml(summary)}</description>`,
      '    </item>'
    ].join('\n');
  });

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Orchard changelog</title>',
    `    <link>${SITE_URL}/changelog/</link>`,
    `    <atom:link href="${SITE_URL}/changelog/index.xml" rel="self" type="application/rss+xml" />`,
    '    <description>New features and fixes in Orchard.</description>',
    '    <language>en</language>',
    `    <lastBuildDate>${updated}</lastBuildDate>`,
    ...items,
    '  </channel>',
    '</rss>',
    ''
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' }
  });
};
