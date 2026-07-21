export interface DatabaseDetail {
	id: string;
	name: string;
	dbName: string;
	dbUser: string;
	dbPassword: string;
	host: string;
	port: number;
	status: string;
	mode?: string;
	pgMajor?: number;
	namespace?: string;
	containerName?: string;
	storageSize?: string;
	publicEnabled?: boolean;
	publicIp?: string | null;
	publicPort?: number | null;
	publicHostname?: string | null;
	publicConnectionString?: string | null;
	pods?: {
		name: string;
		status?: string;
		podIp?: string;
		containers?: { name: string; image?: string; ready?: boolean }[];
	}[];
	cpuRequestMilli?: number | null;
	memoryRequestBytes?: number | null;
	clusterName?: string | null;
	connectionString: string;
	internalHost: string;
	createdAt: string;
	backupsEnabled?: boolean;
	liveStatus?: {
		exists: boolean;
		size?: string;
		connections?: number;
		ready?: boolean;
		phase?: string;
		replicas?: number;
		readyReplicas?: number;
		restartCount?: number;
		message?: string;
		lastTerminationReason?: string;
		lastTerminationExitCode?: number;
		lastTerminationAt?: string;
	};
	project?: {
		id: string;
		name: string;
		slug: string;
		workspace?: {
			slug: string;
			organization?: {
				slug: string;
			};
		};
	};
	creator?: {
		username: string;
		email: string;
	};
}

export interface Backup {
	id: string;
	label: string;
	backupName: string;
	type: string;
	status: string;
	sizeBytes: number | null;
	errorMessage: string | null;
	createdAt: string;
	completedAt: string | null;
}

export interface SchedulePreset {
	id: string;
	label: string;
	cron: string;
	description: string;
}

export interface ExtInfo {
	name: string;
	installed: boolean;
	version?: string;
	defaultVersion?: string;
	comment?: string;
}

export interface ParamMeta {
	key: string;
	label: string;
	kind: 'int' | 'memory' | 'string';
	min?: number;
	max?: number;
	enum?: string[];
	defaultValue: string;
	requiresRestart?: boolean;
	help: string;
}

export interface TerminalTab {
	id: string;
	podName: string;
	container: string;
	label: string;
}
