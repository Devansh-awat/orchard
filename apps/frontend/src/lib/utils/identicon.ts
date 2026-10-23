const HUES = [352, 335, 24, 38, 88, 130, 288, 220];
const cache = new Map<string, string>();

export function identicon(seed: string): string {
	const hit = cache.get(seed);
	if (hit) return hit;
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	const hue = HUES[hash % HUES.length];
	let bits = hash || 1;
	const next = () => {
		bits = (bits * 1103515245 + 12345) >>> 0;
		return bits;
	};
	const ripe = `hsl(${hue} 62% 50%)`;
	const shade = `hsl(${hue} 58% 37%)`;
	let rects = '';
	let count = 0;
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 7; row++) {
			const edge = row === 0 || row === 6;
			if (next() % 100 >= (edge ? 30 : 52)) continue;
			const fill = next() % 100 < 30 ? shade : ripe;
			count++;
			rects += `<rect x='${col}' y='${row}' width='1' height='1' fill='${fill}'/>`;
			if (col < 3) rects += `<rect x='${6 - col}' y='${row}' width='1' height='1' fill='${fill}'/>`;
		}
	}
	if (count < 3) {
		rects += `<rect x='3' y='2' width='1' height='1' fill='${shade}'/><rect x='2' y='3' width='1' height='1' fill='${ripe}'/><rect x='4' y='3' width='1' height='1' fill='${ripe}'/><rect x='3' y='4' width='1' height='1' fill='${ripe}'/>`;
	}
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 7 7' shape-rendering='crispEdges'><rect width='7' height='7' fill='hsl(${hue} 48% 93%)'/>${rects}</svg>`;
	const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
	cache.set(seed, url);
	return url;
}
