export const LEFT = { min: 220, max: 400, initial: 280 } as const;
export const RIGHT = { min: 360, max: 760, initial: 520 } as const;
export const DOCK = { min: 0.2, max: 0.8, initial: 0.55 } as const;
export const CENTER_MIN = 480;

type Saved = {
	left?: number;
	right?: number;
	dock?: number;
	leftOpen?: boolean;
	rightOpen?: boolean;
	dockOpen?: boolean;
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export class PanelLayout {
	left = $state<number>(LEFT.initial);
	right = $state<number>(RIGHT.initial);
	dock = $state<number>(DOCK.initial);
	leftOpen = $state(true);
	rightOpen = $state(true);
	dockOpen = $state(true);
	dragging = $state<'left' | 'right' | 'dock' | null>(null);
	total = $state(0);

	#key = 'greenhouse-layout';

	setUser(userId: string | null | undefined) {
		const key = `greenhouse-layout:${userId ?? 'anon'}`;
		if (key === this.#key) return;
		this.#key = key;
		this.load();
	}

	load() {
		if (typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(this.#key);
			const saved = raw ? (JSON.parse(raw) as Saved) : {};
			this.left = clamp(saved.left ?? LEFT.initial, LEFT.min, LEFT.max);
			this.right = clamp(saved.right ?? RIGHT.initial, RIGHT.min, RIGHT.max);
			this.dock = clamp(saved.dock ?? DOCK.initial, DOCK.min, DOCK.max);
			this.leftOpen = saved.leftOpen ?? true;
			this.rightOpen = saved.rightOpen ?? true;
			this.dockOpen = saved.dockOpen ?? true;
		} catch {
			return;
		}
	}

	save() {
		if (typeof localStorage === 'undefined') return;
		try {
			const saved: Saved = {
				left: Math.round(this.left),
				right: Math.round(this.right),
				dock: Math.round(this.dock * 1000) / 1000,
				leftOpen: this.leftOpen,
				rightOpen: this.rightOpen,
				dockOpen: this.dockOpen
			};
			localStorage.setItem(this.#key, JSON.stringify(saved));
		} catch {
			return;
		}
	}

	maxLeft(): number {
		if (!this.total) return LEFT.max;
		const right = this.rightOpen ? this.right : 0;
		return clamp(this.total - right - CENTER_MIN, LEFT.min, LEFT.max);
	}

	maxRight(): number {
		if (!this.total) return RIGHT.max;
		const left = this.leftOpen ? this.left : 0;
		return clamp(this.total - left - CENTER_MIN, RIGHT.min, RIGHT.max);
	}

	setLeft(px: number) {
		this.left = clamp(px, LEFT.min, this.maxLeft());
	}

	setRight(px: number) {
		this.right = clamp(px, RIGHT.min, this.maxRight());
	}

	setDock(ratio: number) {
		this.dock = clamp(ratio, DOCK.min, DOCK.max);
	}

	reset(which: 'left' | 'right' | 'dock') {
		if (which === 'left') this.left = LEFT.initial;
		else if (which === 'right') this.right = RIGHT.initial;
		else this.dock = DOCK.initial;
		this.save();
	}

	toggle(which: 'left' | 'right' | 'dock') {
		if (which === 'left') this.leftOpen = !this.leftOpen;
		else if (which === 'right') this.rightOpen = !this.rightOpen;
		else this.dockOpen = !this.dockOpen;
		this.save();
	}
}
