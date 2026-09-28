import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MARK_CENTER, MARK_INNER, MARK_OUTLINE, PETAL_RADIUS, PETALS } from './mark';

export type Vec3 = [number, number, number];

export type MarkSceneOptions = {
	depth?: number;
	fov?: number;
	distance?: number;
	onFrame?: (time: number) => void;
};

export type MarkScene = {
	assembly: number;
	turn: number;
	tilt: [number, number];
	offset: [number, number];
	scale: number;
	pointer(x: number, y: number): void;
	project(point: Vec3): { x: number; y: number; scale: number };
	resize(): void;
	start(): void;
	stop(): void;
	renderOnce(): void;
	dispose(): void;
};

const flip = (points: THREE.Vector2[]) =>
	points.map((v) => new THREE.Vector2(v.x - MARK_CENTER, MARK_CENTER - v.y));

function extrude(shapes: THREE.Shape[], depth: number) {
	const geometry = new THREE.ExtrudeGeometry(shapes, {
		depth,
		bevelEnabled: true,
		bevelThickness: depth * 0.24,
		bevelSize: 0.52,
		bevelSegments: 6,
		curveSegments: 48
	});
	geometry.translate(0, 0, -depth / 2);
	return toCreasedNormals(geometry, Math.PI / 5);
}

function bandShapes() {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><path d="${MARK_OUTLINE} ${MARK_INNER}" fill-rule="evenodd"/></svg>`;
	const data = new SVGLoader().parse(svg);
	return data.paths
		.flatMap((path) => SVGLoader.createShapes(path))
		.map((source) => {
			const shape = new THREE.Shape(flip(source.getPoints(28)));
			shape.holes = source.holes.map((hole) => new THREE.Path(flip(hole.getPoints(28))));
			return shape;
		});
}

function smoothstep(a: number, b: number, v: number) {
	const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

const EXPLODE = PETALS.map((petal, i) => {
	const x = petal.cx - MARK_CENTER;
	const y = MARK_CENTER - petal.cy;
	const length = Math.hypot(x, y) || 1;
	return {
		home: new THREE.Vector3(x, y, 0),
		push: new THREE.Vector3((x / length) * 15, (y / length) * 15, 16 + i * 7),
		spin: new THREE.Euler((i % 2 ? 1 : -1) * 0.7, (i < 2 ? 1 : -1) * 0.85, (i - 1.5) * 0.6)
	};
});

export function createMarkScene(canvas: HTMLCanvasElement, opts: MarkSceneOptions = {}): MarkScene {
	const depth = opts.depth ?? 4.2;
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		powerPreference: 'high-performance'
	});
	renderer.setClearColor(0x000000, 0);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.NeutralToneMapping;
	renderer.toneMappingExposure = 1.05;

	const scene = new THREE.Scene();
	const pmrem = new THREE.PMREMGenerator(renderer);
	const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	scene.environment = envTexture;
	scene.environmentIntensity = 0.75;

	const camera = new THREE.PerspectiveCamera(opts.fov ?? 28, 1, 1, 1000);
	camera.position.set(0, 0, opts.distance ?? 190);

	scene.add(new THREE.HemisphereLight(0xffffff, 0xf9445a, 1.1));
	const key = new THREE.DirectionalLight(0xffffff, 1.6);
	key.position.set(-70, 90, 120);
	scene.add(key);
	const rim = new THREE.DirectionalLight(0xffc4cf, 1.2);
	rim.position.set(90, -50, -70);
	scene.add(rim);

	const face = new THREE.MeshPhysicalMaterial({
		color: 0xfff1f3,
		roughness: 0.34,
		clearcoat: 1,
		clearcoatRoughness: 0.16,
		sheen: 0.6,
		sheenColor: new THREE.Color(0xffadbd),
		sheenRoughness: 0.45
	});
	const side = new THREE.MeshPhysicalMaterial({
		color: 0xff9aae,
		roughness: 0.3,
		clearcoat: 1,
		clearcoatRoughness: 0.2,
		iridescence: 0.25,
		iridescenceIOR: 1.3
	});
	const materials = [face, side];

	const root = new THREE.Group();
	const mark = new THREE.Group();
	root.add(mark);
	scene.add(root);

	const bandGeometry = extrude(bandShapes(), depth);
	const band = new THREE.Mesh(bandGeometry, materials);
	mark.add(band);

	const petalGeometry = extrude(
		[new THREE.Shape().absarc(0, 0, PETAL_RADIUS, 0, Math.PI * 2, false)],
		depth
	);
	const petals = EXPLODE.map((part) => {
		const mesh = new THREE.Mesh(petalGeometry, materials);
		mesh.position.copy(part.home);
		mark.add(mesh);
		return mesh;
	});

	let raf = 0;
	let snapAt = -1;
	let lastAssembly = 0;
	let pointerX = 0;
	let pointerY = 0;
	let easedX = 0;
	let easedY = 0;
	const born = performance.now();
	const scratch = new THREE.Vector3();

	const state: MarkScene = {
		assembly: 1,
		turn: 0,
		tilt: [-0.2, 0.32],
		offset: [0, 0],
		scale: 1,
		pointer(x, y) {
			pointerX = x;
			pointerY = y;
		},
		project(point) {
			scratch.set(point[0], point[1], point[2]).project(camera);
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			const distance = camera.position.z - point[2];
			return {
				x: (scratch.x * 0.5 + 0.5) * w,
				y: (-scratch.y * 0.5 + 0.5) * h,
				scale: (opts.distance ?? 190) / Math.max(20, distance)
			};
		},
		resize,
		start() {
			if (raf) return;
			raf = requestAnimationFrame(frame);
		},
		stop() {
			cancelAnimationFrame(raf);
			raf = 0;
		},
		renderOnce() {
			update(performance.now());
			renderer.render(scene, camera);
		},
		dispose() {
			state.stop();
			bandGeometry.dispose();
			petalGeometry.dispose();
			face.dispose();
			side.dispose();
			envTexture.dispose();
			pmrem.dispose();
			renderer.dispose();
		}
	};

	function resize() {
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (!w || !h) return;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	function update(now: number) {
		const t = (now - born) / 1000;
		const a = smoothstep(0, 1, state.assembly);

		if (lastAssembly < 0.985 && state.assembly >= 0.985) snapAt = t;
		lastAssembly = state.assembly;
		const since = snapAt < 0 ? 99 : t - snapAt;
		const snap = since < 1.2 ? Math.sin(since * 14) * Math.exp(-since * 5.5) * 0.07 : 0;

		EXPLODE.forEach((part, i) => {
			const mesh = petals[i];
			const loose = 1 - a;
			const drift = Math.sin(t * 0.8 + i * 1.7) * 1.4 * loose;
			mesh.position.set(
				part.home.x + part.push.x * loose,
				part.home.y + part.push.y * loose + drift,
				part.home.z + part.push.z * loose
			);
			mesh.rotation.set(
				part.spin.x * loose + Math.sin(t * 0.6 + i) * 0.12 * loose,
				part.spin.y * loose + Math.cos(t * 0.5 + i) * 0.12 * loose,
				part.spin.z * loose
			);
		});
		band.position.z = -9 * (1 - a);
		band.rotation.z = Math.sin(t * 0.4) * 0.05 * (1 - a);

		easedX += (pointerX - easedX) * 0.06;
		easedY += (pointerY - easedY) * 0.06;
		const idle = Math.sin(t * 0.45) * 0.06;
		root.rotation.set(
			state.tilt[0] - 0.4 * (1 - a) + easedY * 0.28,
			state.tilt[1] + 0.35 * (1 - a) + state.turn + easedX * 0.42 + idle,
			0.12 * (1 - a)
		);
		root.position.set(state.offset[0], state.offset[1], 0);
		root.scale.setScalar(state.scale * (1 + snap));
		opts.onFrame?.(t);
	}

	function frame(now: number) {
		raf = requestAnimationFrame(frame);
		update(now);
		renderer.render(scene, camera);
	}

	resize();
	return state;
}
