export type SandboxStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'deleting'
  | 'error';

export type SandboxRunnerId = 'kubernetes' | 'vercel';

export type SandboxDesiredState = 'running' | 'stopped' | 'deleted';

export type SandboxRole = 'owner' | 'collaborator' | 'viewer' | 'admin';

export interface SandboxRunnerCapabilities {
  statusSource: 'watch' | 'poll';
  persistence: 'volume' | 'snapshot';
  homeMode: 'block' | 'filesystem' | 'none';
  tcpTunnel: 'native' | 'bridge' | 'none';
  pty: 'native' | 'none';
  execStdin?: boolean;
  maxRunMs: number | null;
  diskSizeConfigurable?: boolean;
  fork?: boolean;
  previews?: 'proxy' | 'public' | 'none';
}

export interface SandboxRunnerInfo {
  id: SandboxRunnerId;
  label: string;
  capabilities: SandboxRunnerCapabilities;
  available: boolean;
  reason: string | null;
}

export interface SandboxSshIdentityRef {
  id: string;
  name: string;
}

export interface Sandbox {
  id: string;
  name: string;
  status: SandboxStatus;
  statusMessage: string | null;
  runner?: SandboxRunnerId;
  desiredState?: SandboxDesiredState;
  applying?: boolean;
  applyError?: string | null;
  diskObserved?: string | null;
  myRole?: SandboxRole;
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
  runners?: SandboxRunnerInfo[];
  defaultRunner?: SandboxRunnerId | null;
}

export interface SandboxCredentials {
  claude: boolean;
  openai: boolean;
  aiGateway?: boolean;
}

export interface SandboxOwnerRef {
  id: string;
  username: string | null;
  email: string | null;
}

export interface SandboxCreateInput {
  organizationId?: string;
  runner?: SandboxRunnerId;
  size?: string;
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
  github?: { owner: string; name: string } | null;
  icon?: string | null;
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
