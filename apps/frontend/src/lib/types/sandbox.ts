export type SandboxStatus =
	| 'creating'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'deleting'
	| 'error';

export interface Sandbox {
	id: string;
	name: string;
	status: SandboxStatus;
	statusMessage: string | null;
	repoUrl: string | null;
	sshPublicKeys: string[];
	image: string;
	createdAt: string;
	updatedAt: string;
	lastActiveAt: string | null;
}

export interface SandboxListResponse {
	sandboxes: Sandbox[];
	maxSandboxes: number;
}

export interface SandboxCredentials {
	claude: boolean;
	openai: boolean;
}

export interface SandboxCreateInput {
	name?: string;
	repoUrl?: string;
	sshPublicKeys?: string[];
	importGithubKeys?: boolean;
}

const TRANSITIONAL = new Set<SandboxStatus>(['creating', 'starting', 'stopping', 'deleting']);

export function isSandboxTransitional(status: SandboxStatus): boolean {
	return TRANSITIONAL.has(status);
}
