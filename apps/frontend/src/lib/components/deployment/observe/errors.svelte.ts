import { apiFetch, toasts } from '$lib/stores';
import { demoErrors } from '$lib/utils/observe-demo';

export type ErrorStatus = 'unresolved' | 'resolved' | 'ignored';
export type ErrorAssignee = { id: string; username: string; imageUrl?: string | null };
export type ErrorDeploy = {
	commitSha: string | null;
	commitMessage: string | null;
	branch: string | null;
	triggerType: string | null;
	triggeredBy: string | null;
	at: string;
	count?: number;
};
export type ErrorGroup = {
	fingerprint: string;
	type: string;
	message: string;
	count: number;
	status?: ErrorStatus;
	firstSeen: string;
	lastSeen: string;
	assignee?: ErrorAssignee | null;
	githubIssueUrl?: string | null;
	stackTrace?: string | null;
	firstDeploy?: ErrorDeploy | null;
	deployCount?: number;
	deploys?: ErrorDeploy[];
};

export const ERROR_WINDOWS = [
	{ value: '15', label: 'Last 15m', long: 'the last 15 minutes' },
	{ value: '60', label: 'Last 1h', long: 'the last hour' },
	{ value: '360', label: 'Last 6h', long: 'the last 6 hours' },
	{ value: '1440', label: 'Last 24h', long: 'the last 24 hours' }
];

export function deployLabel(d: ErrorDeploy): string {
	if (d.triggerType === 'manual' || d.triggeredBy) {
		return d.triggeredBy ? `Deployed by @${d.triggeredBy}` : 'Deployed manually';
	}
	if (d.branch) return `Pushed to ${d.branch}`;
	return 'Deployed';
}

export class ErrorsState {
	status = $state<ErrorStatus | 'all'>('unresolved');
	window = $state('60');
	groups = $state<ErrorGroup[]>([]);
	members = $state<ErrorAssignee[]>([]);
	repoUrl = $state<string | null>(null);
	loaded = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);
	updating = $state<string | null>(null);

	visible = $derived(
		this.status === 'all'
			? this.groups
			: this.groups.filter((g) => (g.status ?? 'unresolved') === this.status)
	);
	events = $derived(this.visible.reduce((sum, g) => sum + g.count, 0));

	#seq = 0;

	async fetch(id: string, demo: boolean) {
		const minutes = Number(this.window);
		if (demo) {
			this.groups = demoErrors(minutes) as ErrorGroup[];
			this.error = null;
			this.loaded = true;
			return;
		}
		const seq = ++this.#seq;
		this.loading = true;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(id)}/errors?window=${minutes}`
			);
			if (seq !== this.#seq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			if (seq !== this.#seq) return;
			this.groups = body?.errors ?? [];
			this.repoUrl = body?.repoUrl ?? null;
			if (Array.isArray(body?.assignable)) this.members = body.assignable;
			this.error = null;
			this.loaded = true;
		} catch (err) {
			if (seq === this.#seq) this.error = (err as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	async #patch(id: string, g: ErrorGroup, body: Record<string, unknown>) {
		const res = await apiFetch(
			`/apiv1/observe/deployments/${encodeURIComponent(id)}/errors/${encodeURIComponent(g.fingerprint)}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}
		);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	}

	async setStatus(id: string, g: ErrorGroup, status: ErrorStatus) {
		this.updating = g.fingerprint;
		const prev = g.status;
		g.status = status;
		try {
			await this.#patch(id, g, { status });
		} catch (err) {
			g.status = prev;
			toasts.add({
				title: "Couldn't update the error",
				description: (err as Error).message,
				color: 'error'
			});
		} finally {
			this.updating = null;
		}
	}

	async assign(id: string, g: ErrorGroup, assigneeId: string | null) {
		this.updating = g.fingerprint;
		const prev = g.assignee;
		g.assignee = assigneeId ? (this.members.find((m) => m.id === assigneeId) ?? null) : null;
		try {
			await this.#patch(id, g, { assigneeId });
		} catch (err) {
			g.assignee = prev;
			toasts.add({
				title: "Couldn't assign the error",
				description: (err as Error).message,
				color: 'error'
			});
		} finally {
			this.updating = null;
		}
	}
}
