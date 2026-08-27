export interface BreakdownItem {
	kind: string;
	id: string;
	name: string;
	projectName: string;
	replicas: number;
	cpuMilli: number;
	memoryBytes: number;
}
