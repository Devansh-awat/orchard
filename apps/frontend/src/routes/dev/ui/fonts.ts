const SYSTEM =
	'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const FONTS = [
	{ id: 'jakarta', label: 'Plus Jakarta', stack: `'Plus Jakarta Sans', ${SYSTEM}` },
	{ id: 'inter', label: 'Inter', stack: `'Inter', ${SYSTEM}` },
	{ id: 'geist', label: 'Geist', stack: `'Geist', ${SYSTEM}` },
	{ id: 'figtree', label: 'Figtree', stack: `'Figtree', ${SYSTEM}` },
	{ id: 'system', label: 'System (SF)', stack: SYSTEM }
] as const;

export const MONOS = [
	{ id: 'jetbrains', label: 'JetBrains Mono', stack: `'JetBrains Mono', ui-monospace, monospace` },
	{ id: 'geist-mono', label: 'Geist Mono', stack: `'Geist Mono', ui-monospace, monospace` },
	{ id: 'space', label: 'Space Mono', stack: `'Space Mono', ui-monospace, monospace` }
] as const;

export const GOOGLE_FONTS =
	'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=Geist:wght@400..700&family=Figtree:wght@400..700&family=Geist+Mono:wght@400..600&display=swap';
