export type MetricId = 'cpu' | 'mem' | 'rx' | 'tx';

export const METRIC_COLORS_LIGHT: Record<MetricId, string> = {
	cpu: '#7c5cff',
	mem: '#22c0a8',
	rx: '#3aa8ff',
	tx: '#ff7e6b'
};

export const METRIC_COLORS_DARK: Record<MetricId, string> = {
	cpu: '#8d70ff',
	mem: '#1fa38f',
	rx: '#2f8fd9',
	tx: '#e0654f'
};
