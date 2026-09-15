import type { SimpleThemeColors } from './generate';
import { radiusFor, hueToAngle, type ThemeMode, type ThemeSpec } from './spec';

export type LegacyTheme = {
	id: string;
	name: string;
	mode: Exclude<ThemeMode, 'auto'>;
	spec: ThemeSpec;
	colours: SimpleThemeColors;
};

const spec = (hue: number, vividness: number): ThemeSpec => ({
	angle: hueToAngle(hue),
	radius: radiusFor(vividness),
	count: 1,
	blend: 0,
	grain: 0
});

export const LEGACY_THEMES: LegacyTheme[] = [
	{
		id: 'light',
		name: 'Light',
		mode: 'light',
		spec: spec(20, 0.864),
		colours: {
			accent: '#d53044',
			accentForeground: '#ffffff',
			background: '#f6f5f6',
			foreground: '#241d1e',
			muted: '#7a6f70',
			border: '#e6e2e3',
			card: '#ffffff',
			sidebarBackground: '#f6f5f6',
			sidebarForeground: '#241d1e',
			error: '#d53044',
			success: '#12b886',
			warning: '#e8820c'
		}
	},
	{
		id: 'cream',
		name: 'Cream',
		mode: 'light',
		spec: spec(70, 0.5),
		colours: {
			accent: '#d53044',
			accentForeground: '#ffffff',
			background: '#f8f3e9',
			foreground: '#372e22',
			muted: '#8a7c68',
			border: '#e9deca',
			card: '#fffcf5',
			sidebarBackground: '#f2ecdd',
			sidebarForeground: '#372e22',
			error: '#d53044',
			success: '#33d6a6',
			warning: '#ff8c37'
		}
	},
	{
		id: 'dark',
		name: 'Dark',
		mode: 'dark',
		spec: spec(20, 0.864),
		colours: {
			accent: '#e5455a',
			accentForeground: '#ffffff',
			background: '#0a0a0b',
			foreground: '#ededef',
			muted: '#8f8f96',
			border: '#242427',
			card: '#121214',
			sidebarBackground: '#0a0a0b',
			sidebarForeground: '#ededef',
			error: '#ff6b7d',
			success: '#33d6a6',
			warning: '#f5b544'
		}
	},
	{
		id: 'midnight',
		name: 'Midnight',
		mode: 'dark',
		spec: spec(262, 0.8),
		colours: {
			accent: '#3d7bfd',
			accentForeground: '#ffffff',
			background: '#06070a',
			foreground: '#e8eaf0',
			muted: '#8b90a0',
			border: '#1c1f28',
			card: '#0d0f14',
			sidebarBackground: '#06070a',
			sidebarForeground: '#e8eaf0',
			error: '#ff6b7d',
			success: '#33d6a6',
			warning: '#f5b544'
		}
	},
	{
		id: 'electric',
		name: 'Electric',
		mode: 'dark',
		spec: spec(185, 1),
		colours: {
			accent: '#00d4c8',
			accentForeground: '#031312',
			background: '#0a0101',
			foreground: '#e7f5f2',
			muted: '#8fa5a1',
			border: '#22292b',
			card: '#140d0e',
			sidebarBackground: '#070101',
			sidebarForeground: '#e7f5f2',
			error: '#ff5e6c',
			success: '#33d6a6',
			warning: '#ffb454'
		}
	}
];

export function legacyById(id: string | null | undefined): LegacyTheme | null {
	if (!id) return null;
	return LEGACY_THEMES.find((t) => t.id === id) ?? null;
}
