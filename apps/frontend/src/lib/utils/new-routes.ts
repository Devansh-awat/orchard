import { preloadCode } from '$app/navigation';
import { queryClient } from '$lib/query';
import { projectDetailQueryOptions } from '$lib/stores/project-context';

export type NewKind = 'github' | 'deployment' | 'database' | 'job' | 'project';

export const NEW_KINDS: NewKind[] = ['github', 'deployment', 'database', 'job', 'project'];

interface ProjectLike {
	slug: string;
	canEdit?: boolean;
}

export function defaultProjectSlug(projects: ProjectLike[] | undefined | null): string | null {
	const list = projects ?? [];
	return (list.find((p) => p.canEdit !== false) ?? list[0])?.slug ?? null;
}

export function newHref(kind: NewKind, orgSlug: string, projectSlug: string | null): string {
	const base = projectSlug ? `/${orgSlug}/projects/${projectSlug}` : null;
	switch (kind) {
		case 'github':
			return base ? `${base}/deployments/new?source=github` : `/${orgSlug}/new?source=github`;
		case 'deployment':
			return `/${orgSlug}/new`;
		case 'database':
			return base ? `${base}/databases/new` : `/${orgSlug}/new?source=database`;
		case 'job':
			return `/${orgSlug}/jobs/new`;
		case 'project':
			return `/${orgSlug}/projects/new`;
	}
}

export function preloadNew(orgSlug: string, projectSlug: string | null) {
	for (const kind of NEW_KINDS) {
		void preloadCode(newHref(kind, orgSlug, projectSlug).split('?')[0]).catch(() => {});
	}
	if (projectSlug) void queryClient.prefetchQuery(projectDetailQueryOptions(orgSlug, projectSlug));
}
