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
	organizationId: string | null;
	owner: SandboxOwnerRef | null;
	createdAt: string;
	updatedAt: string;
	lastActiveAt: string | null;
}

export interface SandboxListResponse {
	sandboxes: Sandbox[];
	maxSandboxes: number | null;
}

export interface SandboxCredentials {
	claude: boolean;
	openai: boolean;
}

export interface SandboxOwnerRef {
	id: string;
	username: string | null;
	email: string | null;
}

export interface SandboxCreateInput {
	organizationId?: string;
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

export interface SandboxRepo {
	name: string;
	branch: string;
	dirtyFiles: number;
}

export interface SandboxReposResponse {
	repos: SandboxRepo[];
}

const TRANSITIONAL = new Set<SandboxStatus>(['creating', 'starting', 'stopping', 'deleting']);

export function isSandboxTransitional(status: SandboxStatus): boolean {
	return TRANSITIONAL.has(status);
}

export type SandboxBootPhase =
	| 'starting'
	| 'packages'
	| 'runtime'
	| 'agents'
	| 'storage'
	| 'account'
	| 'services'
	| 'ready';

export interface SandboxBoot {
	phase: SandboxBootPhase;
	ready: boolean;
	label: string;
}

export const SANDBOX_BOOT_PHASES: { id: SandboxBootPhase; label: string }[] = [
	{ id: 'starting', label: 'Starting the machine' },
	{ id: 'packages', label: 'Installing packages' },
	{ id: 'runtime', label: 'Installing the runtime' },
	{ id: 'agents', label: 'Installing coding agents' },
	{ id: 'storage', label: 'Preparing storage' },
	{ id: 'account', label: 'Setting up your account' },
	{ id: 'services', label: 'Starting services' },
	{ id: 'ready', label: 'Ready' }
];

export function sandboxBootIndex(phase: SandboxBootPhase): number {
	const index = SANDBOX_BOOT_PHASES.findIndex((p) => p.id === phase);
	return index === -1 ? 0 : index;
}
