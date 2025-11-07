import { writable, get } from 'svelte/store';
import { apiFetch } from './api';
import { selectedOrganization } from './organizations';
import { isSignedIn } from './auth';

export interface Deployment {
	id: string;
	name: string;
	slug?: string;
	status?: string;
}

export interface Project {
	id: string;
	name: string;
	slug: string;
	description?: string;
	deployments?: Deployment[];
}

export interface Workspace {
	id: string;
	name: string;
	slug: string;
	description?: string;
	organizationId: string;
	projects?: Project[];
}

export interface TreeItem {
	id: string;
	name: string;
	type: 'workspace' | 'project' | 'deployment';
	href: string;
	children?: TreeItem[];
}

const treeData = writable<TreeItem[]>([]);
const loading = writable(false);
const error = writable<string | null>(null);

async function fetchWorkspaceDetails(workspace: Workspace): Promise<Workspace> {
	try {
		const response = await apiFetch(`/apiv1/workspaces/slug/${workspace.slug}`);
		if (!response.ok) {
			return workspace;
		}
		const detailedWorkspace = await response.json();
		return detailedWorkspace;
	} catch {
		return workspace;
	}
}

async function fetchProjectDetails(projectId: string): Promise<Project | null> {
	try {
		const response = await apiFetch(`/apiv1/projects/${projectId}`);
		if (!response.ok) {
			return null;
		}
		return await response.json();
	} catch {
		return null;
	}
}

function transformToTreeItems(workspaces: Workspace[]): TreeItem[] {
	return workspaces.map((workspace) => {
		const workspaceItem: TreeItem = {
			id: `workspace-${workspace.id}`,
			name: workspace.name,
			type: 'workspace',
			href: `/workspaces/${workspace.slug}`,
			children: workspace.projects?.map((project) => {
				const projectItem: TreeItem = {
					id: `project-${project.id}`,
					name: project.name,
					type: 'project',
					href: `/workspaces/${workspace.slug}/projects/${project.slug}`,
					children: project.deployments?.map((deployment) => ({
						id: `deployment-${deployment.id}`,
						name: deployment.name || deployment.slug || `Deployment ${deployment.id.slice(0, 8)}`,
						type: 'deployment' as const,
						href: `/deployments/${deployment.id}`
					}))
				};
				return projectItem;
			})
		};
		return workspaceItem;
	});
}

async function fetchTreeData() {
	loading.set(true);
	error.set(null);

	try {
		const response = await apiFetch('/apiv1/workspaces');
		if (!response.ok) {
			throw new Error('Failed to fetch workspaces');
		}

		let workspaces: Workspace[] = await response.json();

		const selectedOrg = get(selectedOrganization);
		if (selectedOrg) {
			workspaces = workspaces.filter((w) => w.organizationId === selectedOrg.id);
		}

		const workspacesWithDetails = await Promise.all(
			workspaces.map(async (workspace) => {
				const detailed = await fetchWorkspaceDetails(workspace);
				if (detailed.projects && detailed.projects.length > 0) {
					const projectsWithDeployments = await Promise.all(
						detailed.projects.map(async (project) => {
							const projectDetails = await fetchProjectDetails(project.id);
							return projectDetails || project;
						})
					);
					detailed.projects = projectsWithDeployments;
				}
				return detailed;
			})
		);

		const treeItems = transformToTreeItems(workspacesWithDetails);
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

