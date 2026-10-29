import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

const KEY = Symbol('chart-axis');

export class ChartAxis {
	#widths = new SvelteMap<string, number>();

	gutter = $derived(Math.max(0, ...this.#widths.values()));

	report(id: string, width: number) {
		if (this.#widths.get(id) !== width) this.#widths.set(id, width);
	}

	drop(id: string) {
		this.#widths.delete(id);
	}
}

export function provideChartAxis(): ChartAxis {
	return setContext(KEY, new ChartAxis());
}

export function chartAxis(): ChartAxis | undefined {
	return getContext<ChartAxis | undefined>(KEY);
}
