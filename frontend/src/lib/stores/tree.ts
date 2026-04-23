import { writable, get } from 'svelte/store';
import { apiFetch } from './api';
import { selectedOrganization } from './organizations';
import { isSignedIn } from './auth';

export interface Deployment {
	id: string;
	name: string;
	slug?: string;
	status?: string;
	ingresses?: IngressSummary[];
}

export interface IngressSummary {
	id: string;
	name: string;
	host: string;
}

export interface DatabaseSummary {
	id: string;
	name: string;
	status: string;
}

export interface TemplateInstanceSummary {
	id: string;
	name: string;
	status: string;
	template?: {
		displayName: string;
	};
}

export interface Project {
	id: string;
	name: string;
	slug: string;
	description?: string;
	organizationId: string;
	deployments?: Deployment[];
	ingresses?: IngressSummary[];
	databases?: DatabaseSummary[];
	templateInstances?: TemplateInstanceSummary[];
	organization?: {
		id: string;
		name: string;
		slug: string;
	};
}

export interface TreeItem {
	id: string;
	name: string;
	type: 'project' | 'deployment' | 'ingress' | 'database' | 'templateInstance';
	href: string;
	children?: TreeItem[];
}

const treeData = writable<TreeItem[]>([]);
const loading = writable(false);
const error = writable<string | null>(null);

function transformToTreeItems(projects: Project[], orgSlug: string): TreeItem[] {
	return projects.map((project) => {
		const deploymentItems: TreeItem[] = project.deployments?.map((deployment) => ({
			id: `deployment-${deployment.id}`,
			name: deployment.name || deployment.slug || `Deployment ${deployment.id.slice(0, 8)}`,
			type: 'deployment' as const,
			href: `/${orgSlug}/deployments/${deployment.id}`
		})) ?? [];

		const seenIngressIds = new Set<string>();
		const ingressItems: TreeItem[] = [];

		for (const ing of project.ingresses ?? []) {
			if (!seenIngressIds.has(ing.id)) {
				seenIngressIds.add(ing.id);
				ingressItems.push({
					id: `ingress-${ing.id}`,
					name: ing.host || ing.name,
					type: 'ingress' as const,
					href: `/${orgSlug}/ingresses/${ing.id}`
				});
			}
		}

		for (const deployment of project.deployments ?? []) {
			for (const ing of deployment.ingresses ?? []) {
				if (!seenIngressIds.has(ing.id)) {
					seenIngressIds.add(ing.id);
					ingressItems.push({
						id: `ingress-${ing.id}`,
						name: ing.host || ing.name,
						type: 'ingress' as const,
						href: `/${orgSlug}/ingresses/${ing.id}`
					});
				}
			}
		}

		const databaseItems: TreeItem[] = (project.databases ?? []).map((db) => ({
			id: `database-${db.id}`,
			name: db.name,
			type: 'database' as const,
			href: `/${orgSlug}/databases/${db.id}`
		}));

		return {
			id: `project-${project.id}`,
			name: project.name,
			type: 'project' as const,
			href: `/${orgSlug}/projects/${project.slug}`,
			children: [...deploymentItems, ...ingressItems, ...databaseItems, ...(project.templateInstances ?? []).map((ti) => ({
				id: `template-instance-${ti.id}`,
				name: ti.name,
				type: 'templateInstance' as const,
				href: `/${orgSlug}/template-instances/${ti.id}`
			}))]
		};
	});
}

async function fetchTreeData() {
	loading.set(true);
	error.set(null);

	try {
		const selectedOrg = get(selectedOrganization);
		const orgId = selectedOrg?.id;
		const url = orgId ? `/apiv1/projects?orgId=${orgId}` : '/apiv1/projects';

		const response = await apiFetch(url);
		if (!response.ok) {
			throw new Error('Failed to fetch projects');
		}

		const projects: Project[] = await response.json();

		const orgSlug = selectedOrg?.slug ?? '';
		const treeItems = transformToTreeItems(projects, orgSlug);
		treeData.set(treeItems);
	} catch (e) {
		error.set(e instanceof Error ? e.message : 'Failed to fetch tree data');
		treeData.set([]);
	} finally {
		loading.set(false);
	}
}

export const tree = treeData;
export const treeLoading = loading;
export const treeError = error;
export const refreshTree = fetchTreeData;

if (typeof window !== 'undefined') {
	isSignedIn.subscribe((signedIn) => {
		if (signedIn) {
			fetchTreeData();
		}
	});

	selectedOrganization.subscribe(() => {
		if (get(isSignedIn)) {
			fetchTreeData();
		}
	});
}
