import { apiFetch } from './api';

export interface ProjectContext {
	id: string;
	name: string;
	slug: string;
	deployments?: {
		id: string;
		name: string;
		services?: {
			id: string;
			name: string;
			port: number;
			targetPort: number;
			protocol: string;
		}[];
	}[];
	[key: string]: unknown;
}

/**
 * Resolve a project from URL params. Works for both org-level and workspace-level routes.
 * - Org route: uses orgSlug + projectSlug to find the project
 * - Workspace route: uses wsSlug to find the workspace, then matches projectSlug within it
 */
export async function fetchProjectContext(params: {
	orgSlug: string;
	projectSlug: string;
	wsSlug?: string;
}): Promise<ProjectContext> {
	const { orgSlug, projectSlug, wsSlug } = params;

	let projectId: string;

	if (wsSlug) {
		const wsResponse = await apiFetch(`/apiv1/workspaces/slug/${wsSlug}`);
		if (!wsResponse.ok) throw new Error('Failed to fetch workspace');
		const workspace = await wsResponse.json();

		const matched = workspace.projects?.find((p: { slug: string }) => p.slug === projectSlug);
		if (!matched) throw new Error('Project not found in workspace');
		projectId = matched.id;
	} else {
		const orgRes = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
		if (!orgRes.ok) throw new Error('Organization not found');
		const org = await orgRes.json();

		const slugRes = await apiFetch(`/apiv1/projects/slug/${projectSlug}?orgId=${org.id}`);
		if (!slugRes.ok) throw new Error('Project not found');
		const projData = await slugRes.json();
		projectId = projData.id;
	}

	const projResponse = await apiFetch(`/apiv1/projects/${projectId}`);
	if (!projResponse.ok) throw new Error('Failed to fetch project');
	return await projResponse.json();
}

/**
 * Build the base path for navigation from route params.
 * Returns e.g. "/my-org/projects/my-project" or "/my-org/workspaces/my-ws/projects/my-project"
 */
export function buildBasePath(params: {
	orgSlug: string;
	projectSlug: string;
	wsSlug?: string;
}): string {
	const { orgSlug, projectSlug, wsSlug } = params;
	if (wsSlug) {
		return `/${orgSlug}/workspaces/${wsSlug}/projects/${projectSlug}`;
	}
	return `/${orgSlug}/projects/${projectSlug}`;
}
