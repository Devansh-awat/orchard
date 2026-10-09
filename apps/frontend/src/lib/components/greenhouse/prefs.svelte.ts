export type ChatSize = 'sm' | 'md' | 'lg';

export const ZOOM_STEPS = [0.9, 1, 1.1, 1.25] as const;
export const CHAT_SIZES: readonly ChatSize[] = ['sm', 'md', 'lg'];
export const CODE_MIN = 11;
export const CODE_MAX = 16;

const KEY = 'greenhouse.prefs.v1';
const DEFAULT_ZOOM = 1;
const DEFAULT_CHAT: ChatSize = 'md';
const DEFAULT_CODE = 13;

const READING: Record<ChatSize, { size: number; leading: number }> = {
	sm: { size: 13, leading: 20 },
	md: { size: 14, leading: 24 },
	lg: { size: 15, leading: 24 }
};

function cleanZoom(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return DEFAULT_ZOOM;
	return ZOOM_STEPS.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best));
}

function cleanChat(value: unknown): ChatSize {
	return CHAT_SIZES.includes(value as ChatSize) ? (value as ChatSize) : DEFAULT_CHAT;
}

function cleanCode(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return DEFAULT_CODE;
	return Math.max(CODE_MIN, Math.min(CODE_MAX, Math.round(n)));
}

function rem(px: number): string {
	return `${px / 16}rem`;
}

class GreenhousePrefs {
	#zoom = $state(DEFAULT_ZOOM);
	#chatSize = $state<ChatSize>(DEFAULT_CHAT);
	#codeSize = $state(DEFAULT_CODE);

	constructor() {
		if (typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(KEY);
			if (!raw) return;
			const saved = JSON.parse(raw) as Record<string, unknown> | null;
			if (!saved || typeof saved !== 'object') return;
			this.#zoom = cleanZoom(saved.zoom);
			this.#chatSize = cleanChat(saved.chatSize);
			this.#codeSize = cleanCode(saved.codeSize);
		} catch {
			return;
		}
	}

	get zoom() {
		return this.#zoom;
	}

	set zoom(value: number) {
		this.#zoom = cleanZoom(value);
		this.#save();
	}

	get chatSize() {
		return this.#chatSize;
	}

	set chatSize(value: ChatSize) {
		this.#chatSize = cleanChat(value);
		this.#save();
	}

	get codeSize() {
		return this.#codeSize;
	}

	set codeSize(value: number) {
		this.#codeSize = cleanCode(value);
		this.#save();
	}

	get isDefault() {
		return (
			this.#zoom === DEFAULT_ZOOM &&
			this.#chatSize === DEFAULT_CHAT &&
			this.#codeSize === DEFAULT_CODE
		);
	}

	get style() {
		const reading = READING[this.#chatSize];
		return [
			`--gh-reading:${rem(reading.size)}`,
			`--gh-lh-reading:${rem(reading.leading)}`,
			`--gh-code-size:${this.#codeSize}px`
		].join('; ');
	}

	stepCode(step: 1 | -1 | 0) {
		this.codeSize = step === 0 ? DEFAULT_CODE : this.#codeSize + step;
	}

	reset() {
		this.#zoom = DEFAULT_ZOOM;
		this.#chatSize = DEFAULT_CHAT;
		this.#codeSize = DEFAULT_CODE;
		this.#save();
	}

	#save() {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(
				KEY,
				JSON.stringify({ zoom: this.#zoom, chatSize: this.#chatSize, codeSize: this.#codeSize })
			);
		} catch {
			return;
		}
	}
}

export const greenhousePrefs = new GreenhousePrefs();
