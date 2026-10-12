import type { ConfirmOptions } from './types';

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

class GraftConfirms {
	current = $state<Pending | null>(null);
	private queue: Pending[] = [];

	ask(options: ConfirmOptions): Promise<boolean> {
		return new Promise((resolve) => {
			this.queue.push({ ...options, resolve });
			if (!this.current) this.next();
		});
	}

	answer(ok: boolean) {
		this.current?.resolve(ok);
		this.next();
	}

	private next() {
		this.current = this.queue.shift() ?? null;
	}
}

export const graftConfirms = new GraftConfirms();
