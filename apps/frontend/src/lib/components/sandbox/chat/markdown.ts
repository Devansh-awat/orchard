import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { browser } from '$app/environment';

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function renderMarkdown(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return '';
	const html = marked.parse(trimmed, { async: false }) as string;
	if (!browser) return escapeHtml(trimmed);
	return DOMPurify.sanitize(html);
}
