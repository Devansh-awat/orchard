export interface DeploymentUser {
	id: string;
	username?: string;
	firstName?: string;
	lastName?: string;
	imageUrl?: string;
}

export interface Deployment {
	id: string;
	name: string;
	displayName?: string | null;
	status: string;
	buildStatus?: string;
	replicas: number;
	image?: string;
	githubRepo?: string;
	githubBranch?: string;
	ingresses?: { id: string; host: string }[];
	creator?: DeploymentUser;
	imageHistory?: {
		buildStartedAt?: string;
		buildCompletedAt?: string;
		commitAuthorName?: string;
		commitAuthorUsername?: string;
		triggeredBy?: DeploymentUser;
	}[];
}

export interface ProjectMember {
	id: string;
	role: { name: string };
	orgRole?: 'owner' | 'admin' | 'member' | 'guest' | null;
	user: {
		id: string;
		firstName?: string;
		lastName?: string;
		email: string;
		imageUrl?: string;
	};
}

export interface TransferParty {
	id: string;
	email: string | null;
	username?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	imageUrl?: string | null;
}

export interface PendingTransfer {
	id: string;
	status: string;
	createdAt: string;
	expiresAt: string;
	project: {
		id: string;
		name: string;
		slug: string;
		organization: { id: string; name: string; slug: string };
	};
	from: TransferParty;
	to: TransferParty;
}

export function transferPartyName(p: TransferParty) {
	const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
	// email is nulled for read-only members, so it can't be the last resort
	return name || p.username || p.email || 'A project member';
}

export interface Project {
	id: string;
	name: string;
	slug: string;
	description?: string;
	namespace?: string;
	repositoryUrl?: string;
	icon?: string | null;
	backgroundImage?: string | null;
	owner?: { username: string | null } | null;
	ownerId?: string | null;
	deployments?: Deployment[];
	members?: ProjectMember[];
	pendingInvitations?: PendingInvitation[];
	pendingTransfer?: PendingTransfer | null;
	organization?: {
		id: string;
		name: string;
		slug: string;
	};
	currentUserRole?: {
		orgRole: 'owner' | 'admin' | 'member' | 'guest' | null;
		projectRole: 'admin' | 'member' | 'viewer' | null;
		source?: 'orgAdmin' | 'projectMember' | 'superadmin';
		canView?: boolean;
		canEdit: boolean;
		canManageMembers?: boolean;
		canDelete?: boolean;
		canTransferOwnership?: boolean;
	};
}

export interface TemplateInstanceSummary {
	id: string;
	name: string;
	status: string;
	createdAt: string;
	template: {
		id: string;
		name: string;
		displayName: string;
		icon?: string;
		category?: string;
	};
	_count?: { deployments: number; databases: number; ingresses: number };
	deployments?: { id: string }[];
	databases?: { id: string }[];
	ingresses?: { id: string }[];
}

export interface DatabaseSummary {
	id: string;
	name: string;
	dbName: string;
	status: string;
	mode?: string;
	createdAt: string;
}

export interface ComposeStackSummary {
	id: string;
	name: string;
	status: string;
	createdAt: string;
	deployments: { id: string; name: string; status: string; composeServiceName?: string }[];
}

export interface PendingInvitation {
	id: string;
	email: string;
	createdAt: string;
	expiresAt: string;
	projectRole?: { name: string } | null;
}

export interface OrgMember {
	id: string;
	role: string;
	user: {
		id: string;
		email: string;
		firstName?: string;
		lastName?: string;
		imageUrl?: string;
	};
}

export const ROLE_OPTIONS: { value: 'admin' | 'member' | 'viewer'; label: string; desc: string }[] =
	[
		{ value: 'admin', label: 'Admin', desc: 'Full access — manage members & resources' },
		{ value: 'member', label: 'Member', desc: 'Create & edit project resources' },
		{ value: 'viewer', label: 'Viewer', desc: 'Read-only access' }
	];
