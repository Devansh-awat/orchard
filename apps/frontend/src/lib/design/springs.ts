export type SpringName = 'smooth' | 'snappy' | 'bouncy' | 'interactive' | 'morph' | 'cinematic';

export type SpringSpec = { visualDuration: number; bounce: number };

export const SPRINGS: Record<SpringName, SpringSpec> = {
	smooth: { visualDuration: 0.26, bounce: 0.2 },
	snappy: { visualDuration: 0.19, bounce: 0.25 },
	bouncy: { visualDuration: 0.28, bounce: 0.45 },
	interactive: { visualDuration: 0.1, bounce: 0.2 },
	morph: { visualDuration: 0.34, bounce: 0.25 },
	cinematic: { visualDuration: 0.8, bounce: 0.14 }
};

export const EXIT_SCALE = 0.8;
export const EXIT_BOUNCE = 0.15;

export function physics({ visualDuration, bounce }: SpringSpec) {
	const root = (2 * Math.PI) / (visualDuration * 1.2);
	const stiffness = root * root;
	const damping = 2 * Math.min(1, Math.max(0.05, 1 - bounce)) * Math.sqrt(stiffness);
	return { stiffness, damping, mass: 1 };
}

export function sampleSpring(spec: SpringSpec, stepMs = 1000 / 120) {
	const { stiffness, damping, mass } = physics(spec);
	const dt = stepMs / 1000;
	const points: number[] = [];
	let x = 0;
	let v = 0;
	let t = 0;
	while (t < 4) {
		points.push(x);
		for (let i = 0; i < 8; i++) {
			const a = (-stiffness * (x - 1) - damping * v) / mass;
			v += a * (dt / 8);
			x += v * (dt / 8);
		}
		t += dt;
		if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break;
	}
	points.push(1);
	return { points, durationMs: Math.round((points.length - 1) * stepMs) };
}

export function springEasing(spec: SpringSpec): {
	easing: (t: number) => number;
	duration: number;
} {
	const { points, durationMs } = sampleSpring(spec);
	const last = points.length - 1;
	return {
		duration: durationMs,
		easing: (t: number) => {
			if (t <= 0) return 0;
			if (t >= 1) return 1;
			const x = t * last;
			const i = Math.floor(x);
			return points[i] + (points[i + 1] - points[i]) * (x - i);
		}
	};
}
