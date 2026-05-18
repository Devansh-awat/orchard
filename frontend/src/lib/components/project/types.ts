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
	status: string;
	buildStatus?: string;
	replicas: number;
	image?: string;
	githubRepo?: string;
	githubBranch?: string;
	ingresses?: Array<{ id: string; host: string }>;
	creator?: DeploymentUser;
	imageHistory?: Array<{
		buildStartedAt?: string;
		buildCompletedAt?: string;
		commitAuthorName?: string;
		commitAuthorUsername?: string;
		triggeredBy?: DeploymentUser;
	}>;
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

export interface Project {
	id: string;
	name: string;
	slug: string;
	description?: string;
	namespace?: string;
	repositoryUrl?: string;
	icon?: string | null;
	backgroundImage?: string | null;
	deployments?: Deployment[];
	members?: ProjectMember[];
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

export const ROLE_OPTIONS: { value: 'admin' | 'member' | 'viewer'; label: string; desc: string }[] = [
	{ value: 'admin', label: 'Admin', desc: 'Full access — manage members & resources' },
	{ value: 'member', label: 'Member', desc: 'Create & edit project resources' },
	{ value: 'viewer', label: 'Viewer', desc: 'Read-only access' }
];
