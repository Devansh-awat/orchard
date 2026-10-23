import { FONT_OPTIONS } from '$lib/theme/fonts';

export const FONTS = FONT_OPTIONS.filter((f) => f.id === 'default' || f.id === 'hyperlegible').map(
	(f) => ({ id: f.id, label: f.name, stack: f.stack })
);
