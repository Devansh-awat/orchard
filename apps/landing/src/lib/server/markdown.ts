import { marked, type Tokens } from 'marked';

function escape(text: string) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function safeHref(href: string) {
	try {
		const url = new URL(href, 'https://orchard.my');
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return escape(url.href);
	} catch {
		return null;
	}
}

marked.use({
	gfm: true,
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return escape(token.text);
		},
		link(token: Tokens.Link) {
			const text = this.parser.parseInline(token.tokens);
			const href = safeHref(token.href);
			if (!href) return text;
			return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
		},
		image(token: Tokens.Image) {
			const src = safeHref(token.href);
			if (!src) return '';
			return `<img src="${src}" alt="${escape(token.text)}" loading="lazy" decoding="async">`;
		}
	}
});

export function renderMarkdown(source: string) {
	return marked.parse(source, { async: false });
}
