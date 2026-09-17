export interface DeploymentSummary {
	id: string;
	name: string;
	displayName?: string | null;
	status: string;
	buildStatus: string;
	image?: string;
	githubRepo?: string;
	githubBranch?: string;
	updatedAt: string;
	replicas: number;
	faviconUrl?: string | null;
	ingresses: { id: string; host: string }[];
	project: {
		id: string;
		name: string;
		slug: string;
		organizationId: string;
	};
}

export interface LiveMetricsEntry {
	cpuMilli: number;
	memoryBytes: number;
}

export interface DatabaseSummary {
	id: string;
	name: string;
	dbName: string;
	status: string;
	mode?: string;
	updatedAt: string;
	project: { id: string; name: string; slug: string; organizationId: string };
}

export interface ActiveBuild {
	id: string;
	name: string;
	displayName?: string | null;
	image?: string;
	status: string;
	buildStatus: string;
	buildStep: string | null;
	buildStartedAt?: string | null;
	updatedAt: string;
	githubRepo?: string;
	githubBranch?: string;
	faviconUrl?: string | null;
	ingresses: { host: string }[];
	project?: { name: string };
}

export interface RecentBuild {
	id: string;
	commitSha: string | null;
	branch: string | null;
	triggerType: string | null;
	isActive: boolean;
	createdAt: string;
	deployment: {
		id: string;
		name: string;
		displayName?: string | null;
		image?: string;
		buildStatus: string;
		faviconUrl?: string | null;
		ingresses: { host: string }[];
		project?: { name: string };
	};
}

export interface ProjectMeta {
	id: string;
	name: string;
	slug: string;
	description?: string;
	icon?: string | null;
	backgroundImage?: string | null;
	owner?: { username: string | null } | null;
}

export interface ProjectGroup {
	id: string;
	name: string;
	slug: string;
	deps: DeploymentSummary[];
	dbs: DatabaseSummary[];
}
