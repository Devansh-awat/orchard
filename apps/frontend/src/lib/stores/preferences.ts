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

export type DashboardDensity = 'compact' | 'normal' | 'expanded';

const DENSITY_KEY = 'dashboard-density';

function loadDensity(): DashboardDensity {
	if (!browser) return 'normal';
	try {
		const v = localStorage.getItem(DENSITY_KEY);
		return v === 'compact' || v === 'expanded' || v === 'normal' ? v : 'normal';
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
