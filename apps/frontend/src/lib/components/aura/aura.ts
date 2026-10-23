const TEXTURE_SIZE = 256;

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform float u_size;
uniform float u_frame;
out vec4 color;

const float SCALES[4] = float[4](1.7, 1.0, 0.6, 0.32);
const float SPINS[4] = float[4](0.0011, -0.0014, 0.0018, -0.0023);
const float ORBITS[4] = float[4](0.0, 0.0, 0.16, 0.22);
const float ORBIT_SPEEDS[4] = float[4](0.0, 0.0, 0.011, -0.009);
const float TWIST_RADIUS = 0.62;
const float TWIST_ANGLE = 3.2;

vec3 composite(vec2 p) {
	vec3 c = vec3(0.0);
	for (int i = 0; i < 4; i++) {
		float phase = float(i) / 4.0 * 6.2831853;
		float rot = phase + SPINS[i] * u_frame;
		float orbitAngle = u_frame * ORBIT_SPEEDS[i] + phase;
		vec2 center = vec2(0.5) + ORBITS[i] * vec2(cos(orbitAngle), sin(orbitAngle));
		vec2 d = p - center;
		float cs = cos(-rot);
		float sn = sin(-rot);
		vec2 local = vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs) / SCALES[i] + 0.5;
		if (local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0) {
			c = textureLod(u_image, local, 1.5).rgb;
		}
	}
	return c;
}

vec2 twist(vec2 p) {
	vec2 d = p - 0.5;
	float dist = length(d);
	if (dist >= TWIST_RADIUS) return p;
	float percent = (TWIST_RADIUS - dist) / TWIST_RADIUS;
	float theta = percent * percent * TWIST_ANGLE;
	float s = sin(theta);
	float c = cos(theta);
	return vec2(d.x * c - d.y * s, d.x * s + d.y * c) + 0.5;
}

void main() {
	vec2 uv = gl_FragCoord.xy / u_size;
	uv.y = 1.0 - uv.y;
	color = vec4(composite(twist(uv)), 1.0);
}`;

const PRESENT = `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform vec2 u_res;
uniform float u_saturation;
out vec4 color;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
	vec2 uv = gl_FragCoord.xy / u_res;
	float aspect = u_res.x / u_res.y;
	float fit = 1.6;
	if (aspect > fit) {
		float range = fit / aspect;
		uv.y = 1.0 - (0.04 + (1.0 - uv.y) * range);
	} else {
		uv.x = 0.5 + (uv.x - 0.5) * aspect / fit;
	}
	vec3 sum = vec3(0.0);
	float weight = 0.0;
	for (int y = -3; y <= 3; y++) {
		for (int x = -3; x <= 3; x++) {
			vec2 o = vec2(float(x), float(y)) * 0.026;
			float w = exp(-float(x * x + y * y) / 8.0);
			sum += textureLod(u_field, uv + o, 2.5).rgb * w;
			weight += w;
		}
	}
	vec3 c = sum / weight;
	float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
	c = mix(vec3(l), c, u_saturation);
	c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
	color = vec4(c, 1.0);
}`;

export function proxied(raw: string): string {
	try {
		const u = new URL(raw, window.location.href);
		if (u.origin === window.location.origin || u.protocol === 'data:') return u.href;
		return `/asset-proxy?u=${encodeURIComponent(u.href)}`;
	} catch {
		return raw;
	}
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.decoding = 'async';
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = proxied(src);
	});
}

export function colorsImage(colors: string[]): string | null {
	if (colors.length === 0) return null;
	const size = 96;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = colors[0];
	ctx.fillRect(0, 0, size, size);
	const spots = [
		[0.22, 0.2, 0.55],
		[0.82, 0.28, 0.5],
		[0.5, 0.86, 0.6],
		[0.12, 0.78, 0.45],
		[0.88, 0.82, 0.45]
	];
	spots.forEach(([x, y, r], i) => {
		const g = ctx.createRadialGradient(x * size, y * size, 0, x * size, y * size, r * size);
		g.addColorStop(0, colors[(i + 1) % colors.length]);
		g.addColorStop(1, 'transparent');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
	});
	return canvas.toDataURL('image/png');
}

const baked = new Map<string, Promise<string | null>>();

export function bakeBlur(url: string): Promise<string | null> {
	let p = baked.get(url);
	if (p) return p;
	p = loadImage(url).then((img) => {
		if (!img) return null;
		try {
			const w = 640;
			const h = Math.max(1, Math.round((img.naturalHeight / Math.max(img.naturalWidth, 1)) * w));
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			ctx.filter = 'blur(80px) saturate(1.6)';
			ctx.drawImage(img, 0, 0, w, h);
			return canvas.toDataURL('image/jpeg', 0.85);
		} catch {
			return null;
		}
	});
	baked.set(url, p);
	return p;
}

export type AuraRenderer = {
	setImage: (img: HTMLImageElement) => void;
	render: (frame: number) => void;
	resize: (w: number, h: number) => void;
	destroy: () => void;
};

export function loadTexture(src: string) {
	return loadImage(src);
}

const FIELD_SIZE = 256;

export function createRenderer(canvas: HTMLCanvasElement, saturation = 1.27): AuraRenderer | null {
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false,
		depth: false,
		powerPreference: 'low-power'
	});
	if (!gl) return null;

	const link = (fragment: string) => {
		const compile = (type: number, source: string) => {
			const shader = gl.createShader(type)!;
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			return shader;
		};
		const program = gl.createProgram()!;
		gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
		gl.linkProgram(program);
		return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
	};
	const compositeProgram = link(COMPOSITE);
	const presentProgram = link(PRESENT);
	if (!compositeProgram || !presentProgram) return null;

	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	for (const program of [compositeProgram, presentProgram]) {
		const loc = gl.getAttribLocation(program, 'p');
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
	}

	const makeTexture = () => {
		const t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return t;
	};
	const image = makeTexture();
	const field = makeTexture();
	gl.texImage2D(
		gl.TEXTURE_2D,
		0,
		gl.RGBA,
		FIELD_SIZE,
		FIELD_SIZE,
		0,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		null
	);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, field, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	const u = {
		image: gl.getUniformLocation(compositeProgram, 'u_image'),
		size: gl.getUniformLocation(compositeProgram, 'u_size'),
		frame: gl.getUniformLocation(compositeProgram, 'u_frame'),
		field: gl.getUniformLocation(presentProgram, 'u_field'),
		res: gl.getUniformLocation(presentProgram, 'u_res'),
		saturation: gl.getUniformLocation(presentProgram, 'u_saturation')
	};

	const scratch = document.createElement('canvas');
	scratch.width = TEXTURE_SIZE;
	scratch.height = TEXTURE_SIZE;
	const sctx = scratch.getContext('2d');

	return {
		setImage(img) {
			if (!sctx) return;
			sctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
			sctx.drawImage(img, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, image);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
			gl.generateMipmap(gl.TEXTURE_2D);
		},
		resize(w, h) {
			canvas.width = w;
			canvas.height = h;
		},
		render(frame) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.viewport(0, 0, FIELD_SIZE, FIELD_SIZE);
			gl.useProgram(compositeProgram);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, image);
			gl.uniform1i(u.image, 0);
			gl.uniform1f(u.size, FIELD_SIZE);
			gl.uniform1f(u.frame, frame);
			gl.drawArrays(gl.TRIANGLES, 0, 3);

			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, canvas.width, canvas.height);
			gl.useProgram(presentProgram);
			gl.bindTexture(gl.TEXTURE_2D, field);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.uniform1i(u.field, 0);
			gl.uniform2f(u.res, canvas.width, canvas.height);
			gl.uniform1f(u.saturation, saturation);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		},
		destroy() {
			gl.deleteTexture(image);
			gl.deleteTexture(field);
			gl.deleteFramebuffer(fbo);
			gl.deleteBuffer(buffer);
			gl.deleteProgram(compositeProgram);
			gl.deleteProgram(presentProgram);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		}
	};
}
