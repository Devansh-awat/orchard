const PALETTE_SIZE = 24;

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_palette;
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
out vec4 color;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
	vec2 uv = gl_FragCoord.xy / u_res;
	float aspect = u_res.x / u_res.y;
	vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
	float t = u_time * 0.05 + u_seed * 7.0;

	vec2 q = vec2(sin(p.y * 1.5 + t * 1.3), cos(p.x * 1.3 - t * 1.1));
	vec2 r = vec2(sin(p.y * 2.2 + q.x * 1.4 - t * 0.9), cos(p.x * 1.9 + q.y * 1.2 + t * 0.7));
	vec2 w = p + 0.26 * q + 0.12 * r;

	float d = length(w);
	float a = 1.6 * exp(-d * d * 2.2) * sin(t * 0.6 + u_seed * 3.0);
	w = mat2(cos(a), -sin(a), sin(a), cos(a)) * w;

	vec2 s = vec2(w.x / aspect, w.y) * 0.62 + 0.5;
	vec3 c = texture(u_palette, clamp(s, 0.02, 0.98)).rgb;

	float l = dot(c, vec3(0.299, 0.587, 0.114));
	c = mix(vec3(l), c, 1.25);
	c += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) / 128.0;
	color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function proxied(raw: string): string {
	try {
		const u = new URL(raw, window.location.href);
		if (u.origin === window.location.origin || u.protocol === 'data:') return u.href;
		return `/asset-proxy?u=${encodeURIComponent(u.href)}`;
	} catch {
		return raw;
	}
}

export type AuraSource = { src?: string | null; colors?: string[]; seed?: number };

const palettes = new Map<string, Promise<HTMLCanvasElement | null>>();

function keyOf(source: AuraSource) {
	return source.src ? `src:${source.src}` : `colors:${(source.colors ?? []).join(',')}`;
}

function blank(): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
	const canvas = document.createElement('canvas');
	canvas.width = PALETTE_SIZE;
	canvas.height = PALETTE_SIZE;
	const ctx = canvas.getContext('2d');
	return ctx ? [canvas, ctx] : null;
}

function fromColors(colors: string[]): HTMLCanvasElement | null {
	const made = blank();
	if (!made || colors.length === 0) return null;
	const [canvas, ctx] = made;
	ctx.fillStyle = colors[0];
	ctx.fillRect(0, 0, PALETTE_SIZE, PALETTE_SIZE);
	const spots = [
		[0.2, 0.25],
		[0.8, 0.3],
		[0.5, 0.85],
		[0.15, 0.8],
		[0.85, 0.8]
	];
	spots.forEach(([x, y], i) => {
		const g = ctx.createRadialGradient(
			x * PALETTE_SIZE,
			y * PALETTE_SIZE,
			0,
			x * PALETTE_SIZE,
			y * PALETTE_SIZE,
			PALETTE_SIZE * 0.6
		);
		const c = colors[(i + 1) % colors.length];
		g.addColorStop(0, c);
		g.addColorStop(1, 'transparent');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, PALETTE_SIZE, PALETTE_SIZE);
	});
	ctx.filter = 'blur(3px)';
	ctx.drawImage(canvas, 0, 0);
	return canvas;
}

function fromImage(src: string): Promise<HTMLCanvasElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.decoding = 'async';
		img.onload = () => {
			const made = blank();
			if (!made) return resolve(null);
			const [canvas, ctx] = made;
			ctx.filter = 'blur(5px) saturate(1.35)';
			ctx.drawImage(img, -6, -6, PALETTE_SIZE + 12, PALETTE_SIZE + 12);
			resolve(canvas);
		};
		img.onerror = () => resolve(null);
		img.src = proxied(src);
	});
}

export function loadPalette(source: AuraSource): Promise<HTMLCanvasElement | null> {
	const key = keyOf(source);
	let p = palettes.get(key);
	if (!p) {
		p = source.src
			? fromImage(source.src).then((c) => c ?? fromColors(source.colors ?? []))
			: Promise.resolve(fromColors(source.colors ?? []));
		palettes.set(key, p);
	}
	return p;
}

export type AuraRenderer = {
	setPalette: (palette: HTMLCanvasElement) => void;
	render: (time: number, seed: number) => void;
	resize: (w: number, h: number) => void;
	destroy: () => void;
};

export function createRenderer(canvas: HTMLCanvasElement): AuraRenderer | null {
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false,
		depth: false,
		premultipliedAlpha: false,
		preserveDrawingBuffer: true,
		powerPreference: 'low-power'
	});
	if (!gl) return null;

	const compile = (type: number, source: string) => {
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		return shader;
	};
	const program = gl.createProgram()!;
	gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
	gl.useProgram(program);

	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(program, 'p');
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

	const uRes = gl.getUniformLocation(program, 'u_res');
	const uTime = gl.getUniformLocation(program, 'u_time');
	const uSeed = gl.getUniformLocation(program, 'u_seed');

	return {
		setPalette(palette) {
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, palette);
		},
		resize(w, h) {
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		},
		render(time, seed) {
			gl.uniform2f(uRes, canvas.width, canvas.height);
			gl.uniform1f(uTime, time);
			gl.uniform1f(uSeed, seed);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		},
		destroy() {
			gl.deleteTexture(texture);
			gl.deleteBuffer(buffer);
			gl.deleteProgram(program);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		}
	};
}

let shared: { canvas: HTMLCanvasElement; renderer: AuraRenderer } | null | undefined;
const stills = new Map<string, Promise<string | null>>();

export function renderStill(
	source: AuraSource,
	width: number,
	height: number
): Promise<string | null> {
	const key = `${keyOf(source)}:${source.seed ?? 0}:${width}x${height}`;
	let p = stills.get(key);
	if (p) return p;
	p = loadPalette(source).then((palette) => {
		if (!palette) return null;
		if (shared === undefined) {
			const canvas = document.createElement('canvas');
			const renderer = createRenderer(canvas);
			shared = renderer ? { canvas, renderer } : null;
		}
		if (!shared) return null;
		shared.renderer.resize(width, height);
		shared.renderer.setPalette(palette);
		shared.renderer.render(0, source.seed ?? 0);
		return shared.canvas.toDataURL('image/webp', 0.9);
	});
	stills.set(key, p);
	return p;
}
