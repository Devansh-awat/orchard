import { createHash, randomUUID } from 'node:crypto';

export function uid(seed: string) {
	const h = createHash('sha1').update(`orchard-mock:${seed}`).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function freshId() {
	return randomUUID();
}

export function sha(seed: string) {
	return createHash('sha1').update(seed).digest('hex');
}

export function ago(minutes: number) {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function slugify(name: string) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
