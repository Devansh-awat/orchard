const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

export function escapeHtml(value: unknown): string {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function safeHttpUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const u = new URL(value.trim());
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
	} catch {
		return undefined;
	}
}
