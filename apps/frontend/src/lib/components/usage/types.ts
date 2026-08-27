export interface BreakdownItem {
	kind: string;
	id: string;
	name: string;
	projectName: string;
	replicas: number;
	cpuMilli: number;
	memoryBytes: number;
}

export interface GridColumn<Row> {
	id: string;
	label: string;
	width?: string;
	align?: 'start' | 'end';
	sort?: (row: Row) => string | number;
}
