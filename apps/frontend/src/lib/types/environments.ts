export interface Environment {
	id: string;
	projectId: string;
	name: string;
	slug: string;
	namespace: string;
	isDefault: boolean;
	isProduction: boolean;
	cpuLimitMilli: number | null;
	memoryLimitBytes: string | null;
	maxPods: number | null;
	maxServices: number | null;
	createdAt: string;
	updatedAt: string;
	_count?: { deployments: number; databases: number; ingresses: number };
}

export interface SharedVar {
	key: string;
	value: string | null;
	secret: boolean;
}

export interface SharedVarWarning {
	key: string;
	missingRef: string;
}
