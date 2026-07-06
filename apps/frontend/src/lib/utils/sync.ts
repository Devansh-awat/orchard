export function shallowEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!shallowEq(a[i], b[i])) return false;
		return true;
	}
	if (typeof a === 'object' && typeof b === 'object') {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		if (ka.length !== kb.length) return false;
		for (const k of ka)
			if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
		return true;
	}
	return false;
}

export function syncListBy<T extends Record<string, any>>(list: T[], next: T[], key: string) {
	const curByKey = new Map<unknown, T>();
	for (const x of list) curByKey.set(x[key], x);
	const out: T[] = [];
	for (const n of next) {
		const cur = curByKey.get(n[key]);
		if (cur) {
			for (const k of Object.keys(n)) {
				if (!shallowEq(cur[k], n[k])) (cur as Record<string, any>)[k] = n[k];
			}
			out.push(cur);
		} else {
			out.push(n);
		}
	}
	let changed = out.length !== list.length;
	if (!changed) {
		for (let i = 0; i < out.length; i++) {
			if (out[i] !== list[i]) {
				changed = true;
				break;
			}
		}
	}
	if (changed) {
		list.length = 0;
		list.push(...out);
	}
}

const listKeyOf = (item: unknown): string | null => {
	if (item == null || typeof item !== 'object') return null;
	if ('id' in item) return 'id';
	if ('name' in item) return 'name';
	return null;
};

export function mergeInto(target: Record<string, any>, next: Record<string, any>) {
	for (const k of Object.keys(next)) {
		const nv = next[k];
		const cv = target[k];
		if (Array.isArray(nv) && Array.isArray(cv)) {
			const key = listKeyOf(nv[0] ?? cv[0]);
			if (key) {
				syncListBy(cv, nv, key);
				continue;
			}
		}
		if (!shallowEq(cv, nv)) target[k] = nv;
	}
}
