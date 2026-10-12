export interface Readable<T> {
	subscribe(run: (value: T) => void): () => void;
}

export interface HostUser {
	id: string;
	email: string;
	username: string;
	name: string;
	imageUrl: string | null;
	isSuperAdmin: boolean;
}

export interface HostOrg {
	id: string;
	slug: string;
	name: string;
}

export interface HostRoute {
	path: string;
	search: string;
	params: Record<string, string>;
}

export interface HostOrgEvent {
	organizationId: string;
	type: string;
	id?: string;
	projectId?: string;
	payload?: unknown;
	ts: number;
}

export interface ConfirmOptions {
	title: string;
	body?: string;
	confirmLabel?: string;
	danger?: boolean;
}

export interface ApiInit extends Omit<RequestInit, 'body'> {
	body?: BodyInit | null;
	json?: unknown;
}

export interface HostApi {
	readonly graft: { id: string; version: string; apiBase: string; assetBase: string };
	readonly stores: {
		user: Readable<HostUser | null>;
		org: Readable<HostOrg | null>;
		theme: Readable<{ mode: 'light' | 'dark' }>;
		route: Readable<HostRoute>;
	};
	api<T = unknown>(path: string, init?: ApiInit): Promise<T>;
	fetch(path: string, init?: ApiInit): Promise<Response>;
	navigate(href: string, options?: { replace?: boolean }): void;
	toast(message: string, tone?: 'info' | 'success' | 'error'): void;
	confirm(options: ConfirmOptions): Promise<boolean>;
	onOrgEvent(handler: (event: HostOrgEvent) => void): () => void;
}

export type MountHandle = { update?(props: unknown): void; destroy(): void };
export type MountResult = MountHandle | (() => void) | void;
export type Mount<P> = (target: HTMLElement, props: P, host: HostApi) => MountResult;

export interface NavItem {
	id: string;
	label: string;
	href: string;
	icon?: string;
	order?: number;
	visible?: (host: HostApi) => boolean;
}

export interface TabContribution<P> {
	id: string;
	label: string;
	order?: number;
	mount: Mount<P>;
	visible?: (host: HostApi, props: P) => boolean;
}

export interface CardContribution<P> {
	id: string;
	order?: number;
	mount: Mount<P>;
	visible?: (host: HostApi, props: P) => boolean;
}

export type OrgProps = { orgId: string; orgSlug: string };
export type ProjectProps = OrgProps & { projectId: string; projectSlug: string };
export type DeploymentProps = ProjectProps & { deploymentId: string };

export interface SlotMap {
	'nav.primary': NavItem[];
	'admin.nav': NavItem[];
	'user.settings.tabs': TabContribution<Record<string, never>>[];
	'org.settings.tabs': TabContribution<OrgProps>[];
	'org.usage.tabs': TabContribution<OrgProps>[];
	'deployment.tabs': TabContribution<DeploymentProps>[];
	'deployment.overview.cards': CardContribution<DeploymentProps>[];
	'project.overview.cards': CardContribution<ProjectProps>[];
}

export type SlotName = keyof SlotMap;

export interface ScreenProps {
	path: string;
	params: Record<string, string>;
	search: string;
}

export interface GraftClient {
	slots?: Partial<SlotMap>;
	screens?: Record<string, Mount<ScreenProps>>;
}
