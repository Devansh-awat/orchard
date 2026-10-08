const SHEET_ID = 'orchard-monaco-styles';
const TOKEN = /^--[a-z0-9-]+$/i;
const FALLBACK = '--hue-blue';

const BASE_RULES = [
	`.orchard-rc-caret { position: relative; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--rc); pointer-events: none; z-index: 2; }`,
	`.orchard-rc-label { position: absolute; left: -1px; bottom: 100%; padding: 0 6px; border-radius: 5px 5px 5px 1px; font: 600 10px/16px var(--font-sans); letter-spacing: 0.01em; white-space: nowrap; color: var(--bg-app); background: color-mix(in oklab, var(--rc) 82%, var(--ink)); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }`,
	`.orchard-rc-caret--below .orchard-rc-label { bottom: auto; top: 100%; border-radius: 1px 5px 5px 5px; }`,
	`.orchard-diff-plus { display: flex !important; align-items: center; justify-content: center; cursor: pointer; }`,
	`.orchard-diff-plus::before { content: '+'; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 5px; font: 600 13px/1 var(--font-sans); color: var(--text-on-accent); background: var(--accent); box-shadow: 0 1px 2px rgb(0 0 0 / 0.16); }`,
	`.orchard-diff-commented { background: color-mix(in srgb, var(--accent) 7%, transparent); }`,
	`.orchard-diff-commented-glyph { display: flex !important; align-items: center; justify-content: center; }`,
	`.orchard-diff-commented-glyph::before { content: ''; width: 6px; height: 6px; border-radius: 999px; background: var(--accent); }`,
	`.orchard-diff-thread { position: absolute; z-index: 3; box-sizing: border-box; padding: 6px 16px 8px 0; }`,
	`.monaco-diff-editor .cdr.char-insert[style*="width:100%"], .monaco-diff-editor .cdr.char-delete[style*="width:100%"] { background-color: transparent !important; }`,
	`.monaco-editor .monaco-hover, .monaco-editor .suggest-widget { border-radius: var(--radius-sm); overflow: hidden; box-shadow: var(--elev-3); }`,
	`.monaco-editor .find-widget { border-radius: 0 0 var(--radius-sm) var(--radius-sm); box-shadow: var(--elev-3); }`
];

const colorRules = new Set<string>();

function sheet(): CSSStyleSheet | null {
	if (typeof document === 'undefined') return null;
	let el = document.getElementById(SHEET_ID) as HTMLStyleElement | null;
	if (!el) {
		el = document.createElement('style');
		el.id = SHEET_ID;
		document.head.appendChild(el);
		for (const rule of BASE_RULES) el.sheet?.insertRule(rule, el.sheet.cssRules.length);
	}
	return el.sheet;
}

export function ensureEditorStyles() {
	sheet();
}

export function safeColorVar(colorVar: string | undefined): string {
	return colorVar && TOKEN.test(colorVar) ? colorVar : FALLBACK;
}

export function colorClass(colorVar: string | undefined): string {
	const token = safeColorVar(colorVar);
	const name = `orchard-rc${token}`;
	if (!colorRules.has(name)) {
		const target = sheet();
		if (target) {
			target.insertRule(`.${name} { --rc: var(${token}); }`, target.cssRules.length);
			target.insertRule(
				`.orchard-rc-sel.${name} { background: color-mix(in srgb, var(${token}) 24%, transparent); border-radius: 2px; }`,
				target.cssRules.length
			);
			colorRules.add(name);
		}
	}
	return name;
}
