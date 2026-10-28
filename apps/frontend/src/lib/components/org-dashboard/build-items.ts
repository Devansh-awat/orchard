import { buildStatusMeta } from '$lib/components/ui/status';
import type { BuildItem } from '$lib/components/patterns/builds';
import { buildPhases } from '$lib/components/deployment/build-phases';
import { humanizeStep } from '$lib/components/deployment/timeline-rows';
import { buildIcon } from './helpers.svelte';
import type { ActiveBuild, RecentBuild } from './types';

function duration(from?: string | null, to?: string | null) {
	if (!from || !to) return undefined;
	const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function toBuildItems(
	active: ActiveBuild[],
	recent: RecentBuild[],
	opts: {
		orgSlug: string;
		failedFav: Set<string>;
		projectIcon?: (name?: string) => string | null;
		only?: (deploymentId: string) => boolean;
	}
): BuildItem[] {
	const keep = opts.only ?? (() => true);
	const projectIcon = opts.projectIcon ?? (() => null);
	return [
		...active
			.filter((b) => keep(b.id))
			.map((b): BuildItem => ({
				id: b.id,
				app: b.displayName || b.name,
				project: b.project?.name,
				projectIcon: projectIcon(b.project?.name),
				icon: buildIcon(b.image, b.ingresses, b.id, opts.failedFav, b.faviconUrl),
				message: b.buildStep ? humanizeStep(b.buildStep) : 'Queued',
				status: buildStatusMeta('building'),
				at: b.buildStartedAt ?? b.updatedAt,
				startedAt: b.buildStartedAt ?? undefined,
				href: `/${opts.orgSlug}/deployments/${b.id}`,
				branch: b.githubBranch,
				phases: buildPhases(b.buildStepTimestamps, Date.now(), true)
			})),
		...recent
			.filter((b) => keep(b.deployment.id))
			.map((b): BuildItem => ({
				id: b.id,
				app: b.deployment.displayName || b.deployment.name,
				project: b.deployment.project?.name,
				projectIcon: projectIcon(b.deployment.project?.name),
				icon: buildIcon(
					b.deployment.image,
					b.deployment.ingresses,
					b.deployment.id,
					opts.failedFav,
					b.deployment.faviconUrl
				),
				message:
					b.commitMessage ??
					(b.commitSha
						? b.commitSha.slice(0, 7)
						: b.triggerType === 'manual'
							? 'Manual deploy'
							: 'Deploy'),
				status: buildStatusMeta(b.status ?? b.deployment.buildStatus),
				at: b.buildCompletedAt ?? b.createdAt,
				href: `/${opts.orgSlug}/deployments/${b.deployment.id}`,
				branch: b.branch ?? undefined,
				duration: duration(b.buildStartedAt, b.buildCompletedAt)
			}))
	];
}
