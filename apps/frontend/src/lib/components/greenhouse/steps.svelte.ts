export class StepStack<T extends string> {
	stack = $state<T[]>([]);
	dir = $state<1 | -1>(1);
	moves = $state(0);
	readonly root: T;

	constructor(root: T) {
		this.root = root;
		this.stack = [root];
	}

	get current(): T {
		return this.stack[this.stack.length - 1];
	}

	get depth(): number {
		return this.stack.length - 1;
	}

	push(step: T) {
		this.dir = 1;
		this.moves += 1;
		this.stack = [...this.stack, step];
	}

	replace(step: T) {
		this.dir = 1;
		this.moves += 1;
		this.stack = [...this.stack.slice(0, -1), step];
	}

	finish(step: T) {
		this.dir = 1;
		this.moves += 1;
		this.stack = [this.root, step];
	}

	back(): boolean {
		if (this.stack.length <= 1) return false;
		this.dir = -1;
		this.moves += 1;
		this.stack = this.stack.slice(0, -1);
		return true;
	}

	reset() {
		this.dir = 1;
		this.moves = 0;
		this.stack = [this.root];
	}
}
