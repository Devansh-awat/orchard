export type CurveName =
	| 'snap'
	| 'pop'
	| 'settle'
	| 'glide'
	| 'press'
	| 'bouncy'
	| 'morph'
	| 'cinematic';

export type SpringName = CurveName | 'smooth' | 'snappy' | 'interactive';

export type SpringSpec = { response: number; damping: number };

export const TEMPO = 1;

export const CURVES: Record<CurveName, SpringSpec> = {
	snap: { response: 0.22, damping: 0.88 },
	pop: { response: 0.24, damping: 0.78 },
	settle: { response: 0.17, damping: 1 },
	glide: { response: 0.28, damping: 0.92 },
	press: { response: 0.12, damping: 1 },
	bouncy: { response: 0.32, damping: 0.6 },
	morph: { response: 0.3, damping: 0.8 },
	cinematic: { response: 0.7, damping: 0.86 }
};

export const SPRINGS: Record<SpringName, SpringSpec> = {
	...CURVES,
	smooth: CURVES.glide,
	snappy: CURVES.snap,
	interactive: CURVES.press
};

export const EASE = {
	out: 'cubic-bezier(0.22, 1, 0.36, 1)',
	in: 'cubic-bezier(0.4, 0, 1, 1)',
	inOut: 'cubic-bezier(0.65, 0, 0.35, 1)'
} as const;

export const FADE = { in: 90, out: 110, long: 260 } as const;

export const EXIT_SCALE = 0.8;

let runtimeTempo = TEMPO;

export function tempo() {
	return runtimeTempo;
}

export function setTempo(value: number) {
	runtimeTempo = value;
	if (typeof document !== 'undefined') {
		document.documentElement.style.setProperty('--tempo', String(value));
	}
}

export type PhysicalSpring = { mass: number; stiffness: number; damping: number };

export function fromResponse(response: number, dampingRatio: number): PhysicalSpring {
	return {
		mass: 1,
		stiffness: ((2 * Math.PI) / response) ** 2,
		damping: (4 * Math.PI * dampingRatio) / response
	};
}

export function physics(spec: SpringSpec, scale = tempo()): PhysicalSpring {
	return fromResponse(spec.response * scale, spec.damping);
}

export function exitSpec(spec: SpringSpec): SpringSpec {
	return { response: spec.response * EXIT_SCALE, damping: Math.max(1, spec.damping) };
}

export function samplePhysics({ mass, stiffness, damping }: PhysicalSpring, stepMs = 1000 / 120) {
	const dt = stepMs / 1000;
	const points: number[] = [];
	let x = 0;
	let v = 0;
	let t = 0;
	while (t < 3) {
		points.push(x);
		for (let i = 0; i < 8; i++) {
			const a = (-stiffness * (x - 1) - damping * v) / mass;
			v += a * (dt / 8);
			x += v * (dt / 8);
		}
		t += dt;
		if (Math.abs(x - 1) < 0.0005 && Math.abs(v) < 0.005) break;
	}
	points.push(1);
	return { points, durationMs: Math.round((points.length - 1) * stepMs) };
}

export function sampleSpring(spec: SpringSpec, stepMs = 1000 / 120, scale = tempo()) {
	return samplePhysics(physics(spec, scale), stepMs);
}

function toLinear(points: number[], maxPoints: number) {
	const stride = Math.max(1, Math.ceil(points.length / maxPoints));
	const kept: string[] = [];
	for (let i = 0; i < points.length; i += stride) {
		kept.push(`${Number(points[i].toFixed(4))} ${((i / (points.length - 1)) * 100).toFixed(1)}%`);
	}
	kept[0] = '0';
	kept.push('1');
	return `linear(${kept.join(', ')})`;
}

export function physicsCurve(spring: PhysicalSpring, maxPoints = 48) {
	const { points, durationMs } = samplePhysics(spring);
	return { easing: toLinear(points, maxPoints), durationMs };
}

export function springCurve(spec: SpringSpec, maxPoints = 40, scale = tempo()) {
	return physicsCurve(physics(spec, scale), maxPoints);
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
