import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const PROJECT_GRADIENT_KEY = 'project-gradient-enabled';

function loadBool(key: string, fallback: boolean): boolean {
	if (!browser) return fallback;
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === 'true';
	} catch {
		return fallback;
	}
}

function saveBool(key: string, value: boolean) {
	if (!browser) return;
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// ignore
	}
}

const gradientStore = writable<boolean>(loadBool(PROJECT_GRADIENT_KEY, true));

export const projectGradientEnabled = {
	subscribe: gradientStore.subscribe,
	set(value: boolean) {
		gradientStore.set(value);
		saveBool(PROJECT_GRADIENT_KEY, value);
	},
	toggle() {
		gradientStore.update((v) => {
			const next = !v;
			saveBool(PROJECT_GRADIENT_KEY, next);
			return next;
		});
	}
};

export type DashboardDensity = 'compact' | 'normal';

const DENSITY_KEY = 'dashboard-density';

function loadDensity(): DashboardDensity {
	if (!browser) return 'normal';
	try {
		const v = localStorage.getItem(DENSITY_KEY);
		return v === 'compact' ? v : 'normal';
	} catch {
		return 'normal';
	}
}

const densityStore = writable<DashboardDensity>(loadDensity());

export const dashboardDensity = {
	subscribe: densityStore.subscribe,
	set(value: DashboardDensity) {
		densityStore.set(value);
		if (!browser) return;
		try {
			localStorage.setItem(DENSITY_KEY, value);
		} catch {
			// ignore
		}
	}
};

export type AnimationLevel = 'system' | 'full' | 'reduced' | 'off';
export type EffectiveAnimationLevel = 'full' | 'reduced' | 'off';

const ANIMATION_KEY = 'animation-level';

function loadAnimationLevel(): AnimationLevel {
	if (!browser) return 'system';
	try {
		const v = localStorage.getItem(ANIMATION_KEY);
		return v === 'full' || v === 'reduced' || v === 'off' || v === 'system' ? v : 'system';
	} catch {
		return 'system';
	}
}

const animationStore = writable<AnimationLevel>(loadAnimationLevel());

let currentEffective: EffectiveAnimationLevel = 'full';

export function effectiveAnimationLevel(): EffectiveAnimationLevel {
	return currentEffective;
}

export const animationLevel = {
	subscribe: animationStore.subscribe,
	set(value: AnimationLevel) {
		animationStore.set(value);
		if (!browser) return;
		try {
			localStorage.setItem(ANIMATION_KEY, value);
		} catch {
			// ignore
		}
	}
};

if (browser) {
	const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
	let level = loadAnimationLevel();
	let systemReduced = mq.matches;
	const apply = () => {
		currentEffective = level === 'system' ? (systemReduced ? 'reduced' : 'full') : level;
		document.documentElement.classList.toggle('motion-reduce', currentEffective !== 'full');
		document.documentElement.classList.toggle('motion-off', currentEffective === 'off');
	};
	animationStore.subscribe((l) => {
		level = l;
		apply();
	});
	mq.addEventListener('change', (e) => {
		systemReduced = e.matches;
		apply();
	});
}

export type ContrastLevel = 'default' | 'high';

const CONTRAST_KEY = 'contrast-level';

function loadContrast(): ContrastLevel {
	if (!browser) return 'default';
	try {
		return localStorage.getItem(CONTRAST_KEY) === 'high' ? 'high' : 'default';
	} catch {
		return 'default';
	}
}

const contrastStore = writable<ContrastLevel>(loadContrast());

export const contrastLevel = {
	subscribe: contrastStore.subscribe,
	set(value: ContrastLevel) {
		contrastStore.set(value);
		if (!browser) return;
		try {
			localStorage.setItem(CONTRAST_KEY, value);
		} catch {
			// ignore
		}
	}
};

export type TextScale = 'sm' | 'md' | 'lg' | 'xl';

const TEXT_SCALE_KEY = 'text-scale';
const TEXT_SCALE_SIZES: Record<TextScale, string> = {
	sm: '93.75%',
	md: '',
	lg: '106.25%',
	xl: '112.5%'
};

function loadTextScale(): TextScale {
	if (!browser) return 'md';
	try {
		const v = localStorage.getItem(TEXT_SCALE_KEY);
		return v === 'sm' || v === 'lg' || v === 'xl' ? v : 'md';
	} catch {
		return 'md';
	}
}

const textScaleStore = writable<TextScale>(loadTextScale());

export const textScale = {
	subscribe: textScaleStore.subscribe,
	set(value: TextScale) {
		textScaleStore.set(value);
		if (!browser) return;
		try {
			localStorage.setItem(TEXT_SCALE_KEY, value);
		} catch {
			// ignore
		}
	}
};

const TRANSPARENCY_KEY = 'reduce-transparency';

const transparencyStore = writable<boolean>(loadBool(TRANSPARENCY_KEY, false));

export const reduceTransparency = {
	subscribe: transparencyStore.subscribe,
	set(value: boolean) {
		transparencyStore.set(value);
		saveBool(TRANSPARENCY_KEY, value);
	}
};

if (browser) {
	contrastStore.subscribe((v) => {
		document.documentElement.classList.toggle('contrast-high', v === 'high');
	});
	textScaleStore.subscribe((v) => {
		document.documentElement.style.fontSize = TEXT_SCALE_SIZES[v];
	});
	transparencyStore.subscribe((v) => {
		document.documentElement.classList.toggle('reduce-transparency', v);
	});
}
