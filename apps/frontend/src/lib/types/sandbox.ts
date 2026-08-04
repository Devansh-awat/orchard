export type SandboxStatus =
	| 'creating'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'deleting'
	| 'error';

export interface SandboxSshIdentityRef {
	id: string;
	name: string;
}

export interface Sandbox {
	id: string;
	name: string;
	status: SandboxStatus;
	statusMessage: string | null;
	repoUrl: string | null;
	sshIdentity: SandboxSshIdentityRef | null;
	setupScript: string | null;
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
	sshIdentityId?: string;
	setupScript?: string;
}

export interface SandboxPatchInput {
	name?: string;
	sshIdentityId?: string;
	setupScript?: string | null;
}

export interface SshIdentity {
	id: string;
	name: string;
	publicKey: string;
	createdAt: string;
}

export interface SshIdentitiesResponse {
	identities: SshIdentity[];
}

const TRANSITIONAL = new Set<SandboxStatus>(['creating', 'starting', 'stopping', 'deleting']);

export function isSandboxTransitional(status: SandboxStatus): boolean {
	return TRANSITIONAL.has(status);
}
