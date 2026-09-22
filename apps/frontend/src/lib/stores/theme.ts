import { writable, derived, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import {
	DEFAULT_PRESET_ID,
	matchPresetId,
	presetById,
	sanitizeSpec,
	type ThemeMode,
	type ThemeSpec,
	type Scheme
} from '$lib/theme/spec';
import {
	deriveSimpleColors,
	generateChrome,
	generateThemeColors,
	type SimpleThemeColors,
	type ThemeColors
} from '$lib/theme/generate';
import { hexToOklch } from '$lib/theme/color';
import { DEFAULT_FONT, fontById, type FontId } from '$lib/theme/fonts';
import { legacyById, LEGACY_THEMES } from '$lib/theme/legacy';

export type { SimpleThemeColors, ThemeColors };
export { generateThemeColors };

export type SavedTheme = {
	id: string;
	name: string;
	spec: ThemeSpec;
	overrides: Partial<SimpleThemeColors>;
};

export type ThemeState = {
	mode: ThemeMode;
	spec: ThemeSpec;
	overrides: Partial<SimpleThemeColors>;
	presetId: string | null;
	font: FontId;
};

const MODE_KEY = 'theme';
const SPEC_KEY = 'orchard-theme';
const SAVED_KEY = 'orchard-saved-themes';
const BOOT_KEY = 'orchard-theme-boot';
const LEGACY_THEMES_KEY = 'custom-themes';
const LEGACY_ACTIVE_KEY = 'active-theme-id';

const OVERRIDE_KEYS: (keyof SimpleThemeColors)[] = [
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

// Pinned colours win over the generated palette, so a pin from the other scheme
// makes Light/Dark look broken: the mode flips but the page does not. These two
// groups are the ones that carry the scheme, and they get dropped when they
// contradict it. Accent and status colours read fine either way, so they stay.
const SURFACE_OVERRIDES: (keyof SimpleThemeColors)[] = [
	'background',
	'card',
	'border',
	'sidebarBackground'
];

const INK_OVERRIDES: (keyof SimpleThemeColors)[] = ['foreground', 'muted', 'sidebarForeground'];

export const themeColorCategories = [
	{
		name: 'Brand',
		description: 'Accent and the text that sits on it',
		colors: [
			{ key: 'accent', label: 'Accent', description: 'Buttons, links and highlights' },
			{ key: 'accentForeground', label: 'Accent text', description: 'Text on accent fills' }
		]
	},
	{
		name: 'Base',
		description: 'Backgrounds and type',
		colors: [
			{ key: 'background', label: 'Background', description: 'Main content background' },
			{ key: 'card', label: 'Card', description: 'Cards and raised surfaces' },
			{ key: 'foreground', label: 'Text', description: 'Primary text' },
			{ key: 'muted', label: 'Muted text', description: 'Secondary text' },
			{ key: 'border', label: 'Border', description: 'Borders and dividers' }
		]
	},
	{
		name: 'Sidebar',
		description: 'Navigation rail',
		colors: [
			{ key: 'sidebarBackground', label: 'Background', description: 'Sidebar background' },
			{ key: 'sidebarForeground', label: 'Text', description: 'Sidebar text' }
		]
	},
	{
		name: 'Status',
		description: 'Success, warning and error states',
		colors: [
			{ key: 'success', label: 'Success', description: 'Healthy and online' },
			{ key: 'warning', label: 'Warning', description: 'Degraded and pending' },
			{ key: 'error', label: 'Error', description: 'Failures and destructive actions' }
		]
	}
] as const;

function readJson<T>(key: string): T | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown) {
	if (!browser) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* storage unavailable */
	}
}

function sanitizeOverrides(input: unknown): Partial<SimpleThemeColors> {
	if (!input || typeof input !== 'object') return {};
	const source = input as Record<string, unknown>;
	const out: Partial<SimpleThemeColors> = {};
	for (const key of OVERRIDE_KEYS) {
		const value = source[key];
		if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) {
			out[key] = value.trim().toLowerCase();
		}
	}
	return out;
}

function pruneOverrides(
	overrides: Partial<SimpleThemeColors>,
	scheme: Scheme
): Partial<SimpleThemeColors> {
	const wantsLight = scheme === 'light';
	const next = { ...overrides };
	for (const key of SURFACE_OVERRIDES) {
		const hex = next[key];
		if (hex && hexToOklch(hex).l > 0.5 !== wantsLight) delete next[key];
	}
	for (const key of INK_OVERRIDES) {
		const hex = next[key];
		if (hex && hexToOklch(hex).l > 0.5 === wantsLight) delete next[key];
	}
	return next;
}

function defaultState(): ThemeState {
	const preset = presetById(DEFAULT_PRESET_ID);
	return {
		mode: 'auto',
		spec: preset ? preset.spec : sanitizeSpec(null),
		overrides: {},
		presetId: DEFAULT_PRESET_ID,
		font: DEFAULT_FONT
	};
}

function migrateLegacy(): ThemeState | null {
	if (!browser) return null;
	const activeId = localStorage.getItem(LEGACY_ACTIVE_KEY);
	const legacyMode = localStorage.getItem(MODE_KEY);
	if (!activeId && !legacyMode) return null;

	const state = defaultState();
	if (legacyMode === 'dark' || legacyMode === 'light') state.mode = legacyMode;

	const known = legacyById(activeId);
	if (known) {
		state.spec = known.spec;
		state.presetId = null;
		state.overrides = { ...known.colours };
		state.mode = known.mode;
		return state;
	}

	const custom =
		readJson<{ id: string; isDark?: boolean; simpleColors?: unknown }[]>(LEGACY_THEMES_KEY);
	const match = custom?.find((t) => t.id === activeId);
	if (match) {
		state.mode = match.isDark ? 'dark' : 'light';
		state.overrides = sanitizeOverrides(match.simpleColors);
		state.presetId = null;
	}
	return state;
}

function loadState(): ThemeState {
	if (!browser) return defaultState();
	const stored = readJson<Partial<ThemeState>>(SPEC_KEY);
	if (!stored) return migrateLegacy() ?? defaultState();

	const spec = sanitizeSpec(stored.spec);
	const mode: ThemeMode =
		stored.mode === 'light' || stored.mode === 'dark' || stored.mode === 'auto'
			? stored.mode
			: 'auto';
	return {
		mode,
		spec,
		overrides: pruneOverrides(
			sanitizeOverrides(stored.overrides),
			resolveScheme(mode, prefersDark())
		),
		presetId: matchPresetId(spec),
		font: fontById(stored.font).id
	};
}

function loadSaved(): SavedTheme[] {
	const raw = readJson<SavedTheme[]>(SAVED_KEY);
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string')
		.map((t) => ({
			id: t.id,
			name: t.name,
			spec: sanitizeSpec(t.spec),
			overrides: sanitizeOverrides(t.overrides)
		}));
}

function prefersDark(): boolean {
	if (!browser) return false;
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveScheme(mode: ThemeMode, systemDark: boolean): Scheme {
	if (mode === 'light') return 'light';
	if (mode === 'dark') return 'dark';
	return systemDark ? 'dark' : 'light';
}

export function composeColors(
	spec: ThemeSpec,
	scheme: Scheme,
	overrides: Partial<SimpleThemeColors>
): { simple: SimpleThemeColors; colors: ThemeColors } {
	const simple = { ...deriveSimpleColors(spec, scheme), ...overrides };
	return { simple, colors: generateThemeColors(simple, scheme === 'dark') };
}

const VAR_MAP: [string, keyof ThemeColors][] = [
	['--color-primary-50', 'primary50'],
	['--color-primary-100', 'primary100'],
	['--color-primary-200', 'primary200'],
	['--color-primary-300', 'primary300'],
	['--color-primary-400', 'primary400'],
	['--color-primary-500', 'primary500'],
	['--color-primary-600', 'primary600'],
	['--color-primary-700', 'primary700'],
	['--color-primary-800', 'primary800'],
	['--color-primary-900', 'primary900'],
	['--color-primary-950', 'primary950'],
	['--sidebar-bg', 'sidebarBg'],
	['--sidebar-text', 'sidebarText'],
	['--sidebar-unread-text', 'sidebarUnreadText'],
	['--sidebar-text-hover-bg', 'sidebarTextHoverBg'],
	['--sidebar-text-active-border', 'sidebarTextActiveBorder'],
	['--sidebar-text-active-color', 'sidebarTextActiveColor'],
	['--sidebar-text-active-bg', 'sidebarTextActiveBg'],
	['--sidebar-header-bg', 'sidebarHeaderBg'],
	['--sidebar-header-text', 'sidebarHeaderText'],
	['--sidebar-team-bar-bg', 'sidebarTeamBarBg'],
	['--online-indicator', 'onlineIndicator'],
	['--away-indicator', 'awayIndicator'],
	['--dnd-indicator', 'dndIndicator'],
	['--mention-bg', 'mentionBg'],
	['--mention-color', 'mentionColor'],
	['--mention-highlight-bg', 'mentionHighlightBg'],
	['--mention-highlight-link', 'mentionHighlightLink'],
	['--center-channel-bg', 'centerChannelBg'],
	['--center-channel-color', 'centerChannelColor'],
	['--new-message-separator', 'newMessageSeparator'],
	['--link-color', 'linkColor'],
	['--button-bg', 'buttonBg'],
	['--button-hover-bg', 'buttonHoverBg'],
	['--button-color', 'buttonColor'],
	['--error-text-color', 'errorTextColor'],
	['--text-on-danger', 'dangerColor'],
	['--surface-bg', 'surfaceBg'],
	['--surface-border', 'surfaceBorder'],
	['--surface-muted', 'surfaceMuted'],
	['--card-bg', 'cardBg'],
	['--control-bg', 'controlBg'],
	['--control-hover-bg', 'controlHoverBg'],
	['--control-text', 'controlText'],
	['--dropdown-bg', 'dropdownBg'],
	['--dropdown-border', 'dropdownBorder'],
	['--dropdown-hover-bg', 'dropdownHoverBg'],
	['--divider-color', 'dividerColor'],
	['--org-trigger-bg', 'orgTriggerBg'],
	['--org-trigger-hover-bg', 'orgTriggerHoverBg']
];

export function buildCssText(state: ThemeState, scheme: Scheme): string {
	const { colors } = composeColors(state.spec, scheme, state.overrides);
	const chrome = generateChrome(state.spec, scheme);
	const parts = VAR_MAP.map(([name, key]) => `${name}:${colors[key]}`);
	parts.push(`--theme-chrome-image:${chrome.image}`);
	parts.push(`--theme-grain:${chrome.grain}`);
	parts.push(`--theme-accent-glow:${chrome.accentGlow}`);
	parts.push(`--font-sans:${fontById(state.font).stack}`);
	parts.push(`color-scheme:${scheme}`);
	return parts.join(';');
}

function createThemeStore() {
	const state = writable<ThemeState>(defaultState());
	const saved = writable<SavedTheme[]>([]);
	const systemDark = writable<boolean>(false);
	let loaded = false;

	const scheme: Readable<Scheme> = derived([state, systemDark], ([$state, $systemDark]) =>
		resolveScheme($state.mode, $systemDark)
	);

	const palette = derived([state, scheme], ([$state, $scheme]) =>
		composeColors($state.spec, $scheme, $state.overrides)
	);

	function paint(next: ThemeState) {
		if (!browser) return;
		document.getElementById('theme-boot')?.remove();
		const active = resolveScheme(next.mode, prefersDark());
		const root = document.documentElement;
		const { colors } = composeColors(next.spec, active, next.overrides);
		for (const [name, key] of VAR_MAP) root.style.setProperty(name, colors[key]);

		const chrome = generateChrome(next.spec, active);
		root.style.setProperty('--theme-chrome-image', chrome.image);
		root.style.setProperty('--theme-grain', chrome.grain);
		root.style.setProperty('--theme-accent-glow', chrome.accentGlow);
		root.style.setProperty('--font-sans', fontById(next.font).stack);
		root.style.setProperty('color-scheme', active);
		root.classList.toggle('dark', active === 'dark');
	}

	function persist(next: ThemeState) {
		if (!browser) return;
		writeJson(SPEC_KEY, {
			mode: next.mode,
			spec: next.spec,
			overrides: next.overrides,
			font: next.font
		});
		localStorage.setItem(MODE_KEY, next.mode === 'auto' ? 'system' : next.mode);
		writeJson(BOOT_KEY, {
			light: buildCssText(next, 'light'),
			dark: buildCssText(next, 'dark')
		});
	}

	function commit(next: ThemeState, options?: { persist?: boolean }) {
		state.set(next);
		paint(next);
		if (options?.persist !== false) persist(next);
	}

	function matchLegacy(overrides: Partial<SimpleThemeColors>): string | null {
		if (Object.keys(overrides).length !== OVERRIDE_KEYS.length) return null;
		return (
			LEGACY_THEMES.find((theme) =>
				OVERRIDE_KEYS.every((key) => overrides[key] === theme.colours[key])
			)?.id ?? null
		);
	}

	function update(patch: Partial<ThemeState>, options?: { persist?: boolean }) {
		const next = { ...get(state), ...patch };
		if (patch.spec && patch.presetId === undefined) next.presetId = matchPresetId(patch.spec);
		if (patch.spec && patch.overrides === undefined && matchLegacy(next.overrides)) {
			next.overrides = {};
		}
		if (patch.mode && patch.overrides === undefined) {
			next.overrides = matchLegacy(next.overrides)
				? {}
				: pruneOverrides(next.overrides, resolveScheme(next.mode, prefersDark()));
		}
		commit(next, options);
	}

	function saveList(list: SavedTheme[]) {
		saved.set(list);
		writeJson(SAVED_KEY, list);
	}

	return {
		subscribe: state.subscribe,
		scheme,
		palette,
		saved: { subscribe: saved.subscribe },
		systemDark: { subscribe: systemDark.subscribe },

		init() {
			if (!browser || loaded) return;
			loaded = true;
			systemDark.set(prefersDark());
			const next = loadState();
			saved.set(loadSaved());
			commit(next);
			window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
				systemDark.set(event.matches);
				const current = get(state);
				if (current.mode !== 'auto') return;
				commit({
					...current,
					overrides: pruneOverrides(current.overrides, event.matches ? 'dark' : 'light')
				});
			});
		},

		setMode(mode: ThemeMode) {
			update({ mode });
		},

		setSpec(spec: ThemeSpec, options?: { persist?: boolean }) {
			update({ spec: sanitizeSpec(spec) }, options);
		},

		applyLegacy(id: string) {
			const theme = legacyById(id);
			if (!theme) return;
			update({
				spec: theme.spec,
				overrides: { ...theme.colours },
				presetId: null,
				mode: theme.mode
			});
		},

		matchLegacyId: matchLegacy,

		applyPreset(presetId: string) {
			const preset = presetById(presetId);
			if (!preset) return;
			update({ spec: preset.spec, presetId: preset.id, overrides: {} });
		},

		setFont(font: FontId) {
			update({ font: fontById(font).id });
		},

		setOverride(key: keyof SimpleThemeColors, value: string | null) {
			const current = get(state);
			const overrides = { ...current.overrides };
			if (value) overrides[key] = value.toLowerCase();
			else delete overrides[key];
			commit({ ...current, overrides });
		},

		clearOverrides() {
			const current = get(state);
			commit({ ...current, overrides: {} });
		},

		saveCurrent(name: string): SavedTheme {
			const current = get(state);
			const entry: SavedTheme = {
				id: `theme-${Date.now().toString(36)}`,
				name: name.trim() || 'Untitled theme',
				spec: current.spec,
				overrides: current.overrides
			};
			saveList([...get(saved), entry]);
			return entry;
		},

		applySaved(id: string) {
			const entry = get(saved).find((t) => t.id === id);
			if (!entry) return;
			update({ spec: entry.spec, overrides: entry.overrides, presetId: matchPresetId(entry.spec) });
		},

		renameSaved(id: string, name: string) {
			saveList(get(saved).map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)));
		},

		deleteSaved(id: string) {
			saveList(get(saved).filter((t) => t.id !== id));
		},

		exportCurrent(name: string): string {
			const current = get(state);
			return JSON.stringify(
				{
					orchardTheme: 2,
					name: name.trim() || 'Orchard theme',
					mode: current.mode,
					spec: current.spec,
					overrides: current.overrides,
					font: current.font
				},
				null,
				2
			);
		},

		importTheme(json: string): SavedTheme | null {
			try {
				const data = JSON.parse(json) as Record<string, unknown>;
				const legacy = data.simpleColors;
				const spec = sanitizeSpec((data.spec as ThemeSpec) ?? null);
				const overrides = sanitizeOverrides(legacy ?? data.overrides);
				if (!data.spec && !Object.keys(overrides).length) return null;
				const entry: SavedTheme = {
					id: `theme-${Date.now().toString(36)}`,
					name: typeof data.name === 'string' ? data.name : 'Imported theme',
					spec,
					overrides
				};
				saveList([...get(saved), entry]);
				if (data.mode === 'light' || data.mode === 'dark' || data.isDark !== undefined) {
					update({
						spec: entry.spec,
						overrides: entry.overrides,
						mode: data.isDark || data.mode === 'dark' ? 'dark' : 'light'
					});
				} else {
					update({ spec: entry.spec, overrides: entry.overrides });
				}
				return entry;
			} catch {
				return null;
			}
		},

		preview(spec: ThemeSpec) {
			update({ spec: sanitizeSpec(spec) }, { persist: false });
		},

		repaint() {
			paint(get(state));
		}
	};
}

export const themeStore = createThemeStore();
