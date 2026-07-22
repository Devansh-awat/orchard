import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';

// Simplified editable theme colors - consolidated for easy editing
export interface SimpleThemeColors {
	// Core colors (user edits these)
	accent: string; // Primary brand color
	accentForeground: string; // Text on accent backgrounds
	background: string; // Main background
	foreground: string; // Main text color
	muted: string; // Secondary/muted text
	border: string; // Borders and dividers
	card: string; // Card/elevated surface background
	sidebarBackground: string; // Sidebar background
	sidebarForeground: string; // Sidebar text
	error: string; // Error states
	success: string; // Success/online indicator
	warning: string; // Warning/away indicator
}

// Full theme colors (generated from simple colors)
export interface ThemeColors {
	// Primary color palette (generated from accent)
	primary50: string;
	primary100: string;
	primary200: string;
	primary300: string;
	primary400: string;
	primary500: string;
	primary600: string;
	primary700: string;
	primary800: string;
	primary900: string;
	primary950: string;

	// Sidebar
	sidebarBg: string;
	sidebarText: string;
	sidebarUnreadText: string;
	sidebarTextHoverBg: string;
	sidebarTextActiveBorder: string;
	sidebarTextActiveColor: string;
	sidebarTextActiveBg: string;
	sidebarHeaderBg: string;
	sidebarHeaderText: string;
	sidebarTeamBarBg: string;

	// Status indicators
	onlineIndicator: string;
	awayIndicator: string;
	dndIndicator: string;

	// Mentions
	mentionBg: string;
	mentionColor: string;
	mentionHighlightBg: string;
	mentionHighlightLink: string;

	// Main content
	centerChannelBg: string;
	centerChannelColor: string;
	newMessageSeparator: string;
	linkColor: string;

	// Buttons
	buttonBg: string;
	buttonColor: string;

	// States
	errorTextColor: string;

	// Surfaces
	surfaceBg: string;
	surfaceBorder: string;
	surfaceMuted: string;
	cardBg: string;

	// Controls
	controlBg: string;
	controlHoverBg: string;
	controlText: string;

	// Dropdowns
	dropdownBg: string;
	dropdownBorder: string;
	dropdownHoverBg: string;

	// Misc
	dividerColor: string;
	orgTriggerBg: string;
	orgTriggerHoverBg: string;
}

export interface Theme {
	id: string;
	name: string;
	isDark: boolean;
	colors: ThemeColors;
	simpleColors: SimpleThemeColors;
	isBuiltIn?: boolean;
}

// Color utility functions
function hexToHsl(hex: string): { h: number; s: number; l: number } {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;

	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
				break;
			case g:
				h = ((b - r) / d + 2) / 6;
				break;
			case b:
				h = ((r - g) / d + 4) / 6;
				break;
			default:
				break;
		}
	}

	return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
	const hn = h / 360;
	const sn = s / 100;
	const ln = l / 100;

	const hue2rgb = (p: number, q: number, t: number) => {
		let tv = t;
		if (tv < 0) tv += 1;
		if (tv > 1) tv -= 1;
		if (tv < 1 / 6) return p + (q - p) * 6 * tv;
		if (tv < 1 / 2) return q;
		if (tv < 2 / 3) return p + (q - p) * (2 / 3 - tv) * 6;
		return p;
	};

	let r;
	let g;
	let b;
	if (sn === 0) {
		r = ln;
		g = ln;
		b = ln;
	} else {
		const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
		const p = 2 * ln - q;
		r = hue2rgb(p, q, hn + 1 / 3);
		g = hue2rgb(p, q, hn);
		b = hue2rgb(p, q, hn - 1 / 3);
	}

	const toHex = (x: number) => {
		const hex = Math.round(x * 255).toString(16);
		return hex.length === 1 ? `0${hex}` : hex;
	};

	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function adjustLightness(hex: string, amount: number): string {
	const hsl = hexToHsl(hex);
	return hslToHex(hsl.h, hsl.s, Math.max(0, Math.min(100, hsl.l + amount)));
}

function mixColors(color1: string, color2: string, weight: number): string {
	const r1 = parseInt(color1.slice(1, 3), 16);
	const g1 = parseInt(color1.slice(3, 5), 16);
	const b1 = parseInt(color1.slice(5, 7), 16);
	const r2 = parseInt(color2.slice(1, 3), 16);
	const g2 = parseInt(color2.slice(3, 5), 16);
	const b2 = parseInt(color2.slice(5, 7), 16);

	const r = Math.round(r1 * weight + r2 * (1 - weight));
	const g = Math.round(g1 * weight + g2 * (1 - weight));
	const b = Math.round(b1 * weight + b2 * (1 - weight));

	const toHex = (x: number) => x.toString(16).padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Generate a full primary color palette from a single accent color
function generatePrimaryPalette(
	accent: string,
	isDark: boolean
): {
	primary50: string;
	primary100: string;
	primary200: string;
	primary300: string;
	primary400: string;
	primary500: string;
	primary600: string;
	primary700: string;
	primary800: string;
	primary900: string;
	primary950: string;
} {
	const hsl = hexToHsl(accent);

	if (isDark) {
		return {
			primary50: hslToHex(hsl.h, Math.max(hsl.s - 30, 20), 95),
			primary100: hslToHex(hsl.h, Math.max(hsl.s - 20, 30), 90),
			primary200: hslToHex(hsl.h, Math.max(hsl.s - 10, 40), 80),
			primary300: hslToHex(hsl.h, hsl.s, 70),
			primary400: hslToHex(hsl.h, hsl.s, 60),
			primary500: accent,
			primary600: hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 10, 30)),
			primary700: hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 20, 25)),
			primary800: hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 30, 20)),
			primary900: hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 40, 15)),
			primary950: hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 45, 10))
		};
	}

	return {
		primary50: hslToHex(hsl.h, Math.max(hsl.s - 30, 20), 97),
		primary100: hslToHex(hsl.h, Math.max(hsl.s - 20, 30), 92),
		primary200: hslToHex(hsl.h, Math.max(hsl.s - 10, 40), 85),
		primary300: hslToHex(hsl.h, hsl.s, 75),
		primary400: hslToHex(hsl.h, hsl.s, 60),
		primary500: accent,
		primary600: hslToHex(hsl.h, hsl.s + 5, Math.max(hsl.l - 10, 35)),
		primary700: hslToHex(hsl.h, hsl.s + 5, Math.max(hsl.l - 18, 28)),
		primary800: hslToHex(hsl.h, hsl.s + 5, Math.max(hsl.l - 25, 22)),
		primary900: hslToHex(hsl.h, hsl.s + 5, Math.max(hsl.l - 32, 16)),
		primary950: hslToHex(hsl.h, hsl.s + 5, Math.max(hsl.l - 38, 10))
	};
}

// Generate full theme colors from simple colors
export function generateThemeColors(simple: SimpleThemeColors, isDark: boolean): ThemeColors {
	const palette = generatePrimaryPalette(simple.accent, isDark);

	// Generate derived colors
	const hoverBg = isDark
		? adjustLightness(simple.sidebarBackground, -5)
		: adjustLightness(simple.sidebarBackground, -3);
	const activeBg = isDark
		? adjustLightness(simple.sidebarBackground, 10)
		: mixColors(simple.accent, simple.background, 0.15);
	const controlBg = isDark ? simple.background : adjustLightness(simple.background, -2);
	const controlHoverBg = isDark
		? adjustLightness(simple.sidebarBackground, 10)
		: adjustLightness(simple.background, -5);

	return {
		...palette,

		sidebarBg: simple.sidebarBackground,
		sidebarText: simple.sidebarForeground,
		sidebarUnreadText: isDark ? '#ffffff' : adjustLightness(simple.sidebarForeground, -20),
		sidebarTextHoverBg: hoverBg,
		sidebarTextActiveBorder: simple.accent,
		sidebarTextActiveColor: isDark ? '#ffffff' : palette.primary700,
		sidebarTextActiveBg: activeBg,
		sidebarHeaderBg: isDark ? adjustLightness(simple.sidebarBackground, -5) : simple.background,
		sidebarHeaderText: simple.sidebarForeground,
		sidebarTeamBarBg: isDark ? adjustLightness(simple.sidebarBackground, -5) : simple.background,

		onlineIndicator: simple.success,
		awayIndicator: simple.warning,
		dndIndicator: simple.error,

		mentionBg: simple.accent,
		mentionColor: simple.accentForeground,
		mentionHighlightBg: activeBg,
		mentionHighlightLink: isDark ? palette.primary300 : palette.primary700,

		centerChannelBg: simple.background,
		centerChannelColor: simple.foreground,
		newMessageSeparator: palette.primary400,
		linkColor: isDark ? palette.primary300 : palette.primary700,

		buttonBg: palette.primary600,
		buttonColor: simple.accentForeground,

		errorTextColor: simple.error,

		surfaceBg: simple.background,
		surfaceBorder: simple.border,
		surfaceMuted: simple.muted,
		cardBg: simple.card,

		controlBg,
		controlHoverBg,
		controlText: simple.foreground,

		dropdownBg: isDark ? simple.sidebarBackground : simple.background,
		dropdownBorder: simple.border,
		dropdownHoverBg: hoverBg,

		dividerColor: simple.border,
		orgTriggerBg: controlBg,
		orgTriggerHoverBg: controlHoverBg
	};
}

// Default simple colors for light theme
const defaultLightSimple: SimpleThemeColors = {
	accent: '#d53044',
	accentForeground: '#ffffff',
	background: '#ffffff',
	foreground: '#302627',
	muted: '#80696b',
	border: '#efdddf',
	card: '#ffffff',
	sidebarBackground: '#ffffff',
	sidebarForeground: '#302627',
	error: '#d53044',
	success: '#33d6a6',
	warning: '#ff8c37'
};

// Default simple colors for dark theme
const defaultDarkSimple: SimpleThemeColors = {
	accent: '#d53044',
	accentForeground: '#efdddf',
	background: '#161314',
	foreground: '#efdddf',
	muted: '#ba9da0',
	border: '#302627',
	card: '#251e1f',
	sidebarBackground: '#251e1f',
	sidebarForeground: '#efdddf',
	error: '#fb5e71',
	success: '#33d6a6',
	warning: '#f1c40f'
};

// Hand-tuned Orchard primary ramp; overrides the HSL-generated approximations
// so the applied built-in themes match the static palette in app.css exactly
const orchardPrimaryPalette = {
	primary50: '#ffffff',
	primary100: '#efdddf',
	primary200: '#ba9da0',
	primary300: '#fb5e71',
	primary400: '#ea485c',
	primary500: '#d53044',
	primary600: '#ae2a3a',
	primary700: '#8a2c37',
	primary800: '#8a2c37',
	primary900: '#8a2c37',
	primary950: '#161314'
};

// Default light theme
export const defaultLightTheme: Theme = {
	id: 'light',
	name: 'Light',
	isDark: false,
	isBuiltIn: true,
	simpleColors: defaultLightSimple,
	colors: {
		...generateThemeColors(defaultLightSimple, false),
		...orchardPrimaryPalette,
		sidebarUnreadText: '#161314',
		sidebarTextHoverBg: '#efdddf',
		sidebarTextActiveColor: '#8a2c37',
		sidebarTextActiveBg: '#efdddf',
		mentionHighlightBg: '#efdddf',
		mentionHighlightLink: '#8a2c37',
		newMessageSeparator: '#ea485c',
		linkColor: '#8a2c37',
		buttonBg: '#ae2a3a',
		controlBg: '#ffffff',
		controlHoverBg: '#efdddf',
		dropdownHoverBg: '#efdddf',
		orgTriggerBg: '#ffffff',
		orgTriggerHoverBg: '#efdddf'
	}
};

// Default dark theme
export const defaultDarkTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	isDark: true,
	isBuiltIn: true,
	simpleColors: defaultDarkSimple,
	colors: {
		...generateThemeColors(defaultDarkSimple, true),
		...orchardPrimaryPalette,
		sidebarTextHoverBg: '#161314',
		sidebarTextActiveBg: '#302627',
		sidebarHeaderBg: '#161314',
		sidebarTeamBarBg: '#161314',
		mentionHighlightBg: '#302627',
		mentionHighlightLink: '#fb5e71',
		newMessageSeparator: '#ea485c',
		linkColor: '#fb5e71',
		buttonBg: '#ae2a3a',
		controlHoverBg: '#302627',
		dropdownHoverBg: '#161314',
		orgTriggerHoverBg: '#302627'
	}
};

// Theme color categories for the editor UI - simplified!
export const themeColorCategories = [
	{
		name: 'Brand',
		description: 'Your primary brand color',
		colors: [
			{
				key: 'accent',
				label: 'Accent Color',
				description: 'Main brand color used for buttons, links, and highlights'
			},
			{
				key: 'accentForeground',
				label: 'Accent Text',
				description: 'Text color on accent-colored backgrounds'
			}
		]
	},
	{
		name: 'Base',
		description: 'Core background and text colors',
		colors: [
			{ key: 'background', label: 'Background', description: 'Main content area background' },
			{ key: 'card', label: 'Card', description: 'Cards and elevated surfaces' },
			{ key: 'foreground', label: 'Text', description: 'Main text color' },
			{ key: 'muted', label: 'Muted Text', description: 'Secondary/subtle text' },
			{ key: 'border', label: 'Border', description: 'Borders and dividers' }
		]
	},
	{
		name: 'Sidebar',
		description: 'Navigation sidebar colors',
		colors: [
			{ key: 'sidebarBackground', label: 'Background', description: 'Sidebar background color' },
			{ key: 'sidebarForeground', label: 'Text', description: 'Sidebar text color' }
		]
	},
	{
		name: 'Status',
		description: 'Status indicator colors',
		colors: [
			{
				key: 'success',
				label: 'Success/Online',
				description: 'Success states and online indicator'
			},
			{ key: 'warning', label: 'Warning/Away', description: 'Warning states and away indicator' },
			{ key: 'error', label: 'Error/DND', description: 'Error states and do not disturb indicator' }
		]
	}
] as const;

// Store for custom themes
function createThemeStore() {
	const STORAGE_KEY = 'custom-themes';
	const ACTIVE_THEME_KEY = 'active-theme-id';
	const THEME_MODE_KEY = 'theme';

	function loadCustomThemes(): Theme[] {
		if (!browser) return [];
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return [];
			const themes = JSON.parse(stored);
			// Regenerate full colors from simple colors for each theme
			return themes.map((t: Theme) => ({
				...t,
				colors: generateThemeColors(t.simpleColors, t.isDark)
			}));
		} catch {
			return [];
		}
	}

	function loadActiveThemeId(): string | null {
		if (!browser) return null;
		return localStorage.getItem(ACTIVE_THEME_KEY);
	}

	const customThemes = writable<Theme[]>(loadCustomThemes());
	const activeThemeId = writable<string | null>(loadActiveThemeId());

	const allThemes = derived(customThemes, ($customThemes) => [
		defaultLightTheme,
		defaultDarkTheme,
		...$customThemes
	]);

	const activeTheme = derived([allThemes, activeThemeId], ([$allThemes, $activeThemeId]) => {
		if ($activeThemeId) {
			const found = $allThemes.find((t) => t.id === $activeThemeId);
			if (found) return found;
		}
		if (browser) {
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			return prefersDark ? defaultDarkTheme : defaultLightTheme;
		}
		return defaultLightTheme;
	});

	function saveCustomThemes(themes: Theme[]) {
		if (browser) {
			// Only save simple colors and metadata, not generated colors
			const toSave = themes.map((t) => ({
				id: t.id,
				name: t.name,
				isDark: t.isDark,
				simpleColors: t.simpleColors,
				isBuiltIn: false
			}));
			localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
		}
	}

	function applyTheme(theme: Theme) {
		if (!browser) return;

		const root = document.documentElement;
		const colors = theme.colors;

		root.style.setProperty('color-scheme', theme.isDark ? 'dark' : 'light');

		// Apply primary colors
		root.style.setProperty('--color-primary-50', colors.primary50);
		root.style.setProperty('--color-primary-100', colors.primary100);
		root.style.setProperty('--color-primary-200', colors.primary200);
		root.style.setProperty('--color-primary-300', colors.primary300);
		root.style.setProperty('--color-primary-400', colors.primary400);
		root.style.setProperty('--color-primary-500', colors.primary500);
		root.style.setProperty('--color-primary-600', colors.primary600);
		root.style.setProperty('--color-primary-700', colors.primary700);
		root.style.setProperty('--color-primary-800', colors.primary800);
		root.style.setProperty('--color-primary-900', colors.primary900);
		root.style.setProperty('--color-primary-950', colors.primary950);

		// Apply all CSS custom properties
		root.style.setProperty('--sidebar-bg', colors.sidebarBg);
		root.style.setProperty('--sidebar-text', colors.sidebarText);
		root.style.setProperty('--sidebar-unread-text', colors.sidebarUnreadText);
		root.style.setProperty('--sidebar-text-hover-bg', colors.sidebarTextHoverBg);
		root.style.setProperty('--sidebar-text-active-border', colors.sidebarTextActiveBorder);
		root.style.setProperty('--sidebar-text-active-color', colors.sidebarTextActiveColor);
		root.style.setProperty('--sidebar-text-active-bg', colors.sidebarTextActiveBg);
		root.style.setProperty('--sidebar-header-bg', colors.sidebarHeaderBg);
		root.style.setProperty('--sidebar-header-text', colors.sidebarHeaderText);
		root.style.setProperty('--sidebar-team-bar-bg', colors.sidebarTeamBarBg);

		root.style.setProperty('--online-indicator', colors.onlineIndicator);
		root.style.setProperty('--away-indicator', colors.awayIndicator);
		root.style.setProperty('--dnd-indicator', colors.dndIndicator);

		root.style.setProperty('--mention-bg', colors.mentionBg);
		root.style.setProperty('--mention-color', colors.mentionColor);
		root.style.setProperty('--mention-highlight-bg', colors.mentionHighlightBg);
		root.style.setProperty('--mention-highlight-link', colors.mentionHighlightLink);

		root.style.setProperty('--center-channel-bg', colors.centerChannelBg);
		root.style.setProperty('--center-channel-color', colors.centerChannelColor);
		root.style.setProperty('--new-message-separator', colors.newMessageSeparator);
		root.style.setProperty('--link-color', colors.linkColor);

		root.style.setProperty('--button-bg', colors.buttonBg);
		root.style.setProperty('--button-color', colors.buttonColor);

		root.style.setProperty('--error-text-color', colors.errorTextColor);

		root.style.setProperty('--surface-bg', colors.surfaceBg);
		root.style.setProperty('--surface-border', colors.surfaceBorder);
		root.style.setProperty('--surface-muted', colors.surfaceMuted);
		root.style.setProperty('--card-bg', colors.cardBg);

		root.style.setProperty('--control-bg', colors.controlBg);
		root.style.setProperty('--control-hover-bg', colors.controlHoverBg);
		root.style.setProperty('--control-text', colors.controlText);

		root.style.setProperty('--dropdown-bg', colors.dropdownBg);
		root.style.setProperty('--dropdown-border', colors.dropdownBorder);
		root.style.setProperty('--dropdown-hover-bg', colors.dropdownHoverBg);

		root.style.setProperty('--divider-color', colors.dividerColor);
		root.style.setProperty('--org-trigger-bg', colors.orgTriggerBg);
		root.style.setProperty('--org-trigger-hover-bg', colors.orgTriggerHoverBg);

		root.classList.toggle('dark', theme.isDark);

		localStorage.setItem(ACTIVE_THEME_KEY, theme.id);
		localStorage.setItem(THEME_MODE_KEY, theme.isDark ? 'dark' : 'light');
	}

	return {
		customThemes,
		allThemes,
		activeTheme,
		activeThemeId,

		setActiveTheme(themeId: string) {
			const themes = get(allThemes);
			const theme = themes.find((t) => t.id === themeId);
			if (theme) {
				activeThemeId.set(themeId);
				applyTheme(theme);
			}
		},

		setSystemTheme() {
			if (!browser) return;
			activeThemeId.set(null);
			localStorage.removeItem(ACTIVE_THEME_KEY);
			localStorage.setItem(THEME_MODE_KEY, 'system');
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			applyTheme(prefersDark ? defaultDarkTheme : defaultLightTheme);
		},

		addTheme(theme: Omit<Theme, 'id' | 'colors'> & { simpleColors: SimpleThemeColors }) {
			const id = `custom-${Date.now()}`;
			const colors = generateThemeColors(theme.simpleColors, theme.isDark);
			const newTheme: Theme = { ...theme, id, colors, isBuiltIn: false };
			customThemes.update((themes) => {
				const updated = [...themes, newTheme];
				saveCustomThemes(updated);
				return updated;
			});
			return newTheme;
		},

		updateTheme(
			id: string,
			updates: { name?: string; isDark?: boolean; simpleColors?: SimpleThemeColors }
		) {
			customThemes.update((themes) => {
				const updated = themes.map((t) => {
					if (t.id !== id) return t;
					const isDark = updates.isDark ?? t.isDark;
					const simpleColors = updates.simpleColors ?? t.simpleColors;
					return {
						...t,
						name: updates.name ?? t.name,
						isDark,
						simpleColors,
						colors: generateThemeColors(simpleColors, isDark)
					};
				});
				saveCustomThemes(updated);
				return updated;
			});
			if (get(activeThemeId) === id) {
				const theme = get(allThemes).find((t) => t.id === id);
				if (theme) applyTheme(theme);
			}
		},

		deleteTheme(id: string) {
			customThemes.update((themes) => {
				const updated = themes.filter((t) => t.id !== id);
				saveCustomThemes(updated);
				return updated;
			});
			if (get(activeThemeId) === id) {
				this.setSystemTheme();
			}
		},

		duplicateTheme(id: string, newName: string) {
			const themes = get(allThemes);
			const source = themes.find((t) => t.id === id);
			if (!source) return null;
			return this.addTheme({
				name: newName,
				isDark: source.isDark,
				simpleColors: { ...source.simpleColors }
			});
		},

		exportTheme(id: string): string | null {
			const themes = get(allThemes);
			const theme = themes.find((t) => t.id === id);
			if (!theme) return null;
			return JSON.stringify(
				{
					name: theme.name,
					isDark: theme.isDark,
					simpleColors: theme.simpleColors
				},
				null,
				2
			);
		},

		importTheme(json: string): Theme | null {
			try {
				const data = JSON.parse(json);
				if (!data.name || !data.simpleColors || typeof data.isDark !== 'boolean') {
					throw new Error('Invalid theme format');
				}
				// Validate simple color keys
				const requiredKeys: (keyof SimpleThemeColors)[] = [
					'accent',
					'accentForeground',
					'background',
					'foreground',
					'muted',
					'border',
					'card',
					'sidebarBackground',
					'sidebarForeground',
					'error',
					'success',
					'warning'
				];
				for (const key of requiredKeys) {
					if (!data.simpleColors[key]) {
						throw new Error(`Missing color: ${key}`);
					}
				}
				return this.addTheme({
					name: data.name,
					isDark: data.isDark,
					simpleColors: data.simpleColors
				});
			} catch (e) {
				console.error('Failed to import theme:', e);
				return null;
			}
		},

		init() {
			if (!browser) return;

			const savedThemeId = loadActiveThemeId();
			const savedMode = localStorage.getItem(THEME_MODE_KEY);

			if (savedThemeId) {
				const themes = get(allThemes);
				const theme = themes.find((t) => t.id === savedThemeId);
				if (theme) {
					applyTheme(theme);
					return;
				}
			}

			if (savedMode === 'dark') {
				applyTheme(defaultDarkTheme);
				activeThemeId.set('dark');
			} else if (savedMode === 'light') {
				applyTheme(defaultLightTheme);
				activeThemeId.set('light');
			} else {
				const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				applyTheme(prefersDark ? defaultDarkTheme : defaultLightTheme);
			}
		},

		applyTheme,
		generateThemeColors
	};
}

export const themeStore = createThemeStore();
