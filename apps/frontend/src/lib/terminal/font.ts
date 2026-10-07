const TERMINAL_MONO =
	"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

export function monoFontFor(el: HTMLElement): string {
	const styles = getComputedStyle(el);
	return (
		styles.getPropertyValue('--font-mono-terminal').trim() ||
		styles.getPropertyValue('--font-mono').trim() ||
		TERMINAL_MONO
	);
}

export async function ensureTerminalFont(el: HTMLElement, sizePx: number): Promise<void> {
	if (typeof document === 'undefined' || !document.fonts?.load) return;
	const family = monoFontFor(el).split(',')[0].trim();
	if (!family.startsWith("'") && !family.startsWith('"')) return;
	try {
		await Promise.all([
			document.fonts.load(`${sizePx}px ${family}`),
			document.fonts.load(`bold ${sizePx}px ${family}`)
		]);
	} catch {}
}
