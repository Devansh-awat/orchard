export class Pending {
	active = $state(false);

	run = async (action: () => Promise<void> | void) => {
		if (this.active) return;
		this.active = true;
		try {
			await action();
		} finally {
			this.active = false;
		}
	};
}
