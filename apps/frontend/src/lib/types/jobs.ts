export type JobStepType = 'app' | 'image' | 'script';
export type ScriptRuntime = 'bash' | 'python' | 'node';
export type RunStatus =
	| 'pending'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'canceled'
	| 'skipped'
	| 'timed_out';
export type RunTrigger = 'cron' | 'manual' | 'api';

export interface JobStep {
	id: string;
	stepOrder: number;
	name: string;
	type: JobStepType;
	deploymentId: string | null;
	image: string | null;
	command: string | null;
	script: string | null;
	scriptRuntime: ScriptRuntime | null;
	envVars: { key: string; value: string }[];
	cpuRequestMilli: number | null;
	memoryRequestBytes: string | null;
	timeoutSeconds: number;
	retries: number;
}

export interface JobStepDraft {
	name: string;
	type: JobStepType;
	deploymentId: string;
	image: string;
	command: string;
	script: string;
	scriptRuntime: ScriptRuntime;
	envVars: { key: string; value: string }[];
	cpuRequestMilli: number | null;
	memoryRequestBytes: string | null;
	timeoutSeconds: number;
	retries: number;
}

export interface JobRunSummary {
	id: string;
	number: number;
	status: RunStatus;
	trigger: RunTrigger;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
}

export interface Job {
	id: string;
	name: string;
	description: string | null;
	projectId: string;
	projectName?: string;
	projectSlug?: string;
	organizationId?: string;
	scheduleCron: string | null;
	timeZone: string | null;
	enabled: boolean;
	concurrencyPolicy: 'allow' | 'forbid';
	runTimeoutSeconds: number;
	stepCount?: number;
	stepSummaries?: { name: string; type: JobStepType }[];
	lastRun: JobRunSummary | null;
	recentRuns?: {
		id: string;
		number: number;
		status: RunStatus;
		startedAt: string | null;
		finishedAt: string | null;
	}[];
	nextRunAt: string | null;
	steps?: JobStep[];
	createdAt: string;
	updatedAt: string;
}

export interface JobRunStep {
	id: string;
	stepOrder: number;
	name: string;
	type: JobStepType;
	resolvedImage: string | null;
	command: string | null;
	status: RunStatus;
	exitCode: number | null;
	reason: string | null;
	logsTruncated: boolean;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface JobRun extends JobRunSummary {
	jobId: string;
	jobName?: string;
	currentStepOrder: number | null;
	errorMessage: string | null;
	scheduledFor: string | null;
	triggeredBy: { id: string; username: string; name: string } | null;
	steps?: JobRunStep[];
}

export interface JobRunsPage {
	runs: JobRun[];
	nextCursor: string | null;
}

export interface JobStepLogs {
	logs: string;
	truncated: boolean;
	live: boolean;
}
