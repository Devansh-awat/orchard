export type MetricId = 'cpu' | 'mem' | 'rx' | 'tx' | 'req' | 'err' | 'lat' | 'latmax';

export const METRIC_COLORS_LIGHT: Record<MetricId, string> = {
	cpu: '#7c5cff',
	mem: '#22c0a8',
	rx: '#3aa8ff',
	tx: '#ff7e6b',
	req: '#7c5cff',
	err: '#d04a4a',
	lat: '#22c0a8',
	latmax: '#ff7e6b'
};

export const METRIC_COLORS_DARK: Record<MetricId, string> = {
	cpu: '#8d70ff',
	mem: '#1fa38f',
	rx: '#2f8fd9',
	tx: '#e0654f',
	req: '#8d70ff',
	err: '#e06060',
	lat: '#1fa38f',
	latmax: '#e0654f'
};
