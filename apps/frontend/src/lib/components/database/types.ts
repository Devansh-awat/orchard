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
	replicas?: number;
	maxReplicas?: number;
	clusterName?: string | null;
	connectionString: string;
	internalHost: string;
	endpoints?: { rw: string; ro: string; r: string } | null;
	createdAt: string;
	backupsEnabled?: boolean;
	backupScheduleCron?: string | null;
	liveStatus?: {
		exists: boolean;
		size?: string;
		volume?: {
			usedBytes: number;
			capacityBytes: number;
			used?: string;
			capacity?: string;
			percent: number;
		} | null;
		walPendingSegments?: number;
		connections?: number;
		statsAt?: string;
		ready?: boolean;
		phase?: string;
		replicas?: number;
		readyReplicas?: number;
		restartCount?: number;
		message?: string;
		lastTerminationReason?: string;
		lastTerminationExitCode?: number;
		lastTerminationAt?: string;
		archiving?: { ok: boolean; message?: string | null; since?: string | null } | null;
		firstRecoverabilityPoint?: string | null;
		lastSuccessfulBackup?: string | null;
		danglingPVC?: string[];
		unusablePVC?: string[];
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
	autoSized?: boolean;
	help: string;
}

export interface TerminalTab {
	id: string;
	podName: string;
	container: string;
	label: string;
	title?: string;
	bell?: boolean;
	sessionHandle?: string;
}
