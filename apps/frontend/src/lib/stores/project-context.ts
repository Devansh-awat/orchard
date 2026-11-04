import { queryClient } from '$lib/query';
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

export function projectDetailQueryOptions(orgSlug: string, projectSlug: string) {
	return {
		queryKey: ['project-detail', orgSlug, projectSlug],
		queryFn: async (): Promise<ProjectContext> => {
			const res = await apiFetch(`/apiv1/projects/by-slugs/${orgSlug}/${projectSlug}`);
			if (!res.ok) {
				if (res.status === 404) throw new Error('Project not found');
				if (res.status === 403) throw new Error('Access denied');
				throw new Error(`Project load failed: ${res.status}`);
			}
			return res.json();
		},
		staleTime: 15_000
	};
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
		if (!wsResponse.ok) throw new Error("Couldn't load workspace");
		const workspace = await wsResponse.json();

		const matched = workspace.projects?.find((p: { slug: string }) => p.slug === projectSlug);
		if (!matched) throw new Error('Project not found in workspace');
		projectId = matched.id;
	} else {
		const project = await queryClient.fetchQuery(projectDetailQueryOptions(orgSlug, projectSlug));
		return structuredClone(project);
	}

	const projResponse = await apiFetch(`/apiv1/projects/${projectId}`);
	if (!projResponse.ok) throw new Error("Couldn't load project");
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
