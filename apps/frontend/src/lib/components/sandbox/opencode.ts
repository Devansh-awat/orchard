import { apiFetch } from '$lib/stores';

export const OC_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5-20250929' };

export type OcSession = {
	id: string;
	title: string;
	directory: string;
	parentID?: string;
	time: { created: number; updated: number; archived?: number };
};

export type OcToolState = {
	status: 'pending' | 'running' | 'completed' | 'error';
	input?: Record<string, unknown>;
	title?: string;
	error?: string;
};

export type OcPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	text?: string;
	synthetic?: boolean;
	ignored?: boolean;
	tool?: string;
	callID?: string;
	state?: OcToolState;
};

export type OcMessageInfo = {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	cost?: number;
	time: { created: number; completed?: number };
};

export type OcMessage = { info: OcMessageInfo; parts: OcPart[] };

export type OcEvent = { type: string; properties?: Record<string, unknown> };

const OC_HOME = '/persist/home';

const OC_TOOL_NAMES: Record<string, string> = {
	bash: 'Bash',
	edit: 'Edit',
	multiedit: 'MultiEdit',
	write: 'Write',
	read: 'Read',
	grep: 'Grep',
	glob: 'Glob',
	list: 'List',
	patch: 'Patch',
	task: 'Task',
	webfetch: 'WebFetch',
	websearch: 'WebSearch',
	todowrite: 'TodoWrite',
	todoread: 'TodoRead'
};

const OC_INPUT_KEYS: Record<string, string> = {
	filePath: 'file_path',
	oldString: 'old_string',
	newString: 'new_string'
};

export function ocBase(sandboxId: string): string {
	return `/apiv1/sandboxes/${sandboxId}/opencode`;
}

export function ocDirectory(repo: string | null): string | null {
	return repo ? `${OC_HOME}/${repo}` : null;
}

export function ocRepo(directory: string): string | null {
	if (!directory || directory === OC_HOME) return null;
	return directory.split('/').pop() || null;
}

export async function ocProbe(sandboxId: string): Promise<boolean> {
	try {
		const res = await apiFetch(`${ocBase(sandboxId)}/doc`, {
			signal: AbortSignal.timeout(8000)
		});
		res.body?.cancel();
		return res.ok;
	} catch {
		return false;
	}
}

export function ocNormalizeTool(
	tool: string,
	input: unknown
): { name: string; input: unknown } {
	const name = OC_TOOL_NAMES[tool] ?? tool;
	if (!input || typeof input !== 'object') return { name, input };
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		out[OC_INPUT_KEYS[key] ?? key] = value;
	}
	return { name, input: out };
}

export function ocErrorMessage(error: unknown): string {
	if (error && typeof error === 'object') {
		const e = error as { name?: string; data?: { message?: string } };
		if (e.data?.message) return e.data.message;
		if (e.name) return e.name;
	}
	return 'The agent hit an error';
}
