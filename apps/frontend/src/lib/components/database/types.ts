import type { PublicStatus } from '$lib/components/deployment/network/network';

export interface DatabasePod {
	name: string;
	status?: string;
	podIp?: string;
	podIP?: string;
	startTime?: string;
	role?: string;
	labels?: Record<string, string>;
	containers?: { name: string; image?: string; ready?: boolean }[];
	containerStatuses?: { name: string; ready?: boolean; restartCount?: number; image?: string }[];
}

export interface DatabaseDetail {
	id: string;
	name: string;
	dbName: string;
	dbUser: string;
	dbPassword: string | null;
	passwordSet?: boolean;
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
	publicStatus?: PublicStatus | null;
	pods?: DatabasePod[];
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
	keepsLocalBackups?: boolean;
	backupScheduleCron?: string | null;
	environmentId?: string | null;
	deletionProtection?: boolean;
	ddlCheckpoints?: boolean;
	restoreTests?: boolean;
	poolerEnabled?: boolean;
	poolerConfig?: PoolerConfig | null;
	backupMethod?: 'barman' | 'plugin' | null;
	backupServerName?: string | null;
	forkedFromId?: string | null;
	forkedAt?: string | null;
	liveStatus?: {
		verdict?: DatabaseVerdict;
		verdictReasons?: string[];
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
		currentPrimary?: string | null;
		restartCount?: number;
		message?: string;
		lastTerminationReason?: string;
		lastTerminationExitCode?: number;
		lastTerminationAt?: string;
		writeGuard?: boolean;
		resumeWritesAt?: string | null;
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
		organization?: { id?: string; slug: string };
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
	ephemeral?: boolean;
}

export type DatabaseVerdict =
	| 'healthy'
	| 'degraded'
	| 'unprotected'
	| 'down'
	| 'hibernated'
	| 'unknown';

export type OperationKind = 'restore' | 'fork' | 'undelete' | 'drill' | 'upgrade';
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type OperationPhase =
	| 'queued'
	| 'provisioning'
	| 'recovering'
	| 'verifying'
	| 'cleaning_up'
	| 'cutting_over'
	| 'finalizing'
	| 'rehearsal_provisioning'
	| 'rehearsal_cloning'
	| 'rehearsal_upgrading'
	| 'upgrading'
	| 'upgrade_waiting'
	| 'upgrade_finishing'
	| 'done';

export type RecoveryTarget =
	| { type: 'latest' }
	| { type: 'now' }
	| { type: 'time'; time: string }
	| { type: 'checkpoint'; checkpointId: string }
	| { type: 'backup'; backupId: string }
	| { type: 'major'; major: number; image?: string };

export interface DrillVerdict {
	passed: boolean;
	tablesChecked?: number;
	missingTables?: string[];
	rowDrift?: { table: string; expected?: number; actual?: number }[];
	reasons?: string[];
}

export interface RetiredCopy {
	namespace: string;
	clusterName: string;
	retireAfter: string;
	deleted?: boolean;
}

export interface OperationResult {
	recoveredFrom?: unknown;
	recoveredAt?: string;
	progress?: string;
	verdict?: DrillVerdict;
	recoveryMs?: number;
	sizeBytes?: number;
	retired?: RetiredCopy;
	rehearsal?: { passed?: boolean; upgradeMs?: number };
}

export interface DatabaseOperation {
	id: string;
	databaseId: string | null;
	kind: OperationKind;
	mode: 'in_place' | 'fork' | null;
	status: OperationStatus;
	phase: OperationPhase;
	target: RecoveryTarget | null;
	request?: { rehearse?: boolean } | null;
	source: { name?: string; namespace?: string; clusterName?: string; projectId?: string } | null;
	targetNamespace: string | null;
	targetClusterName: string | null;
	targetDatabaseId: string | null;
	result: OperationResult | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export type CheckpointKind = 'manual' | 'pre_deploy' | 'pre_op' | 'ddl';
export type CheckpointStatus = 'pending' | 'durable' | 'failed' | 'expired';

export interface DatabaseCheckpoint {
	id: string;
	databaseId: string;
	groupId: string | null;
	label: string | null;
	kind: CheckpointKind;
	status: CheckpointStatus;
	restorePointName: string;
	lsn: string | null;
	walFile: string | null;
	detail: string | null;
	deploymentId: string | null;
	releaseId: string | null;
	createdAt: string;
	durableAt: string | null;
	expiresAt: string | null;
	error: string | null;
}

export interface RecoveryBackup {
	id: string;
	label: string;
	type: string;
	completedAt: string | null;
	barmanId: string | null;
	startedAt: string | null;
}

export interface DatabaseProtection {
	deletionProtection: boolean;
	ddlCheckpoints: boolean;
	restoreTests: boolean;
}

export interface RecoveryInfo {
	earliest: string | null;
	latest: string | null;
	archiving: { ok: boolean; message?: string | null } | null;
	backups: RecoveryBackup[];
	checkpoints: DatabaseCheckpoint[];
	lastRestoreTest: DatabaseOperation | null;
	restoreTests: DatabaseOperation[];
	activeOperations: DatabaseOperation[];
	protection: DatabaseProtection;
}

export interface PoolerConfig {
	instances: number;
	poolMode: 'transaction' | 'session';
	defaultPoolSize: number;
	maxClientConn: number;
}

export interface PoolerState {
	enabled: boolean;
	config: PoolerConfig;
	host: string | null;
	port: number | null;
	ready: boolean;
	phase: string | null;
}

export interface DeletedDatabase {
	id: string;
	projectId: string;
	organizationId: string;
	environmentId: string | null;
	name: string;
	pgMajor: number | null;
	reason: string | null;
	recoverableUntil: string | null;
	deletedAt: string;
	deletedBy: string | null;
	purgeAfter: string;
}

export interface DatabaseVersion {
	major: number;
	image: string;
	minor: number | null;
	supported: boolean | null;
	current: boolean;
	eolDate: string | null;
}

export interface DatabaseVersions {
	versions: DatabaseVersion[];
	defaultMajor: number;
	source: string;
	catalogDate: string | null;
}

export interface Vulnerability {
	cve: string;
	description: string;
	component: string;
	score: number | null;
	vector: string | null;
	fixedInVersion: string | null;
	url: string;
}

export interface MinorUpdate {
	to: string;
	automatic: boolean;
	blocked: string | null;
}

export interface AutoUpdateState {
	enabled: boolean;
	organization: boolean;
	instance: boolean;
}

export type SecurityAction = 'none' | 'minor_update' | 'major_upgrade' | 'unknown';

export interface DatabaseSecurity {
	running: string | null;
	major: number;
	minor: number | null;
	latestMinor: number | null;
	supported: boolean | null;
	eolDate: string | null;
	endOfLifeSoon: boolean;
	vulnerabilities: Vulnerability[];
	highestScore: number | null;
	action: SecurityAction;
	image: string | null;
	minorUpdate: MinorUpdate | null;
	autoUpdate: AutoUpdateState;
	upgrades: DatabaseVersion[];
	advisoriesFetchedAt: string | null;
}

export interface ProjectDatabaseSecurityRow {
	id: string;
	name: string;
	status: string;
	environmentId: string | null;
	running: string | null;
	major: number;
	action: SecurityAction;
	vulnerabilities: number;
	highestScore: number | null;
	supported: boolean | null;
	eolDate: string | null;
	endOfLifeSoon: boolean;
	minorUpdate: MinorUpdate | null;
	upgrades: DatabaseVersion[];
}

export interface ProjectDatabaseSecurity {
	autoUpdate: AutoUpdateState;
	advisoriesFetchedAt: string | null;
	databases: ProjectDatabaseSecurityRow[];
}
