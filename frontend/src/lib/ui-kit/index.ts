/**
 * Leaf UI Kit
 *
 * Reusable theme system, component classes, and Svelte components
 * extracted from the Leaf dashboard.
 *
 * ## Quick start
 *
 * 1. Import the CSS in your app's global stylesheet:
 *      @import 'tailwindcss';
 *      @import '$lib/ui-kit/theme.css';
 *
 * 2. Initialize the theme store on mount:
 *      import { themeStore } from '$lib/ui-kit';
 *      themeStore.init();
 *
 * 3. Use components:
 *      import { ToastContainer, ThemeSwitch, ThemeEditor } from '$lib/ui-kit';
 *
 * 4. Use CSS classes in your markup:
 *      .btn .btn-primary .btn-secondary .btn-ghost .btn-danger
 *      .input .input-error
 *      .card .card-header .card-body
 *      .badge .badge-success .badge-warning .badge-error .badge-info .badge-neutral
 *      .alert .alert-error .alert-success .alert-warning
 *      .dropdown .dropdown-item
 *      .skeleton .skeleton-icon .skeleton-title .skeleton-desc .skeleton-badge
 */

// Stores
export {
	themeStore,
	createThemeStore,
	generateThemeColors,
	themeColorCategories,
	defaultLightTheme,
	defaultDarkTheme,
	defaultLightSimple,
	defaultDarkSimple,
	hexToHsl,
	hslToHex,
	adjustLightness,
	mixColors,
	type Theme,
	type ThemeColors,
	type SimpleThemeColors
} from './stores/theme';

export { toasts, type Toast } from './stores/toast';

// Components
export { ToastContainer, ThemeEditor, ThemeSwitch } from './components';
