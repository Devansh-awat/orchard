import { apiFetch } from '$lib/stores';

export const OC_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5-20250929' };

export type OcSession = {
	id: string;
	title: string;
	directory: string;
	parentID?: string;
	revert?: { messageID: string; partID?: string };
	time: { created: number; updated: number; archived?: number };
};

export type OcToolState = {
	status: 'pending' | 'running' | 'completed' | 'error';
	input?: Record<string, unknown>;
	title?: string;
	error?: string;
	metadata?: Record<string, unknown>;
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
	mime?: string;
	url?: string;
	filename?: string;
	time?: { start: number; end?: number };
};

export type OcAttachment = {
	id: string;
	name: string;
	mime: string;
	size: number;
	dataUrl: string;
	isImage: boolean;
};

export type OcFilePart = {
	type: 'file';
	mime: string;
	filename: string;
	url: string;
};

export type OcTokens = {
	total?: number;
	input: number;
	output: number;
	reasoning: number;
	cache: { read: number; write: number };
};

export type OcMessageInfo = {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	cost?: number;
	providerID?: string;
	modelID?: string;
	variant?: string | null;
	agent?: string;
	tokens?: OcTokens | null;
	time: { created: number; completed?: number };
};

export type OcModel = {
	providerID: string;
	providerName: string;
	modelID: string;
	name: string;
	context: number | null;
	variants: string[];
};

export type OcMcpState =
	| 'connected'
	| 'disabled'
	| 'failed'
	| 'needs_auth'
	| 'needs_client_registration';

export type OcMcpServer = { name: string; status: OcMcpState; error?: string };

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

export async function ocModels(sandboxId: string): Promise<OcModel[]> {
	const res = await apiFetch(`${ocBase(sandboxId)}/config/providers`);
	if (!res.ok) return [];
	const data = (await res.json()) as {
		providers?: {
			id: string;
			name: string;
			models?: Record<
				string,
				{
					name?: string;
					limit?: { context?: number };
					variants?: Record<string, unknown> | null;
				}
			>;
		}[];
	};
	const models: OcModel[] = [];
	for (const provider of data.providers ?? []) {
		for (const [modelID, model] of Object.entries(provider.models ?? {})) {
			models.push({
				providerID: provider.id,
				providerName: provider.name,
				modelID,
				name: model.name ?? modelID,
				context: model.limit?.context ?? null,
				variants: model.variants ? Object.keys(model.variants) : []
			});
		}
	}
	return models;
}

export function ocShortModelName(name: string): string {
	return name.replace(/^Claude\s+/i, '').replace(/\s*\(latest\)$/i, '');
}

export function ocMcpServers(map: Record<string, { status: string; error?: string }>): OcMcpServer[] {
	return Object.entries(map)
		.map(([name, s]) => ({ name, status: s.status as OcMcpState, error: s.error }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function ocFmtTokens(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
	}
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return `${n}`;
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

export const OC_ATTACH_MAX_BYTES = 5 * 1024 * 1024;
export const OC_ATTACH_MAX_COUNT = 10;

export function ocIsImageMime(mime: string): boolean {
	return mime.startsWith('image/');
}

export function ocFmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ocReadAttachment(file: File): Promise<OcAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('Could not read file'));
		reader.onload = () => {
			const mime = file.type || 'application/octet-stream';
			resolve({
				id: crypto.randomUUID(),
				name: file.name || 'attachment',
				mime,
				size: file.size,
				dataUrl: typeof reader.result === 'string' ? reader.result : '',
				isImage: ocIsImageMime(mime)
			});
		};
		reader.readAsDataURL(file);
	});
}

export function ocFilePart(attachment: OcAttachment): OcFilePart {
	return {
		type: 'file',
		mime: attachment.mime,
		filename: attachment.name,
		url: attachment.dataUrl
	};
}

export function ocPartAttachment(part: OcPart): OcAttachment | null {
	if (part.type !== 'file' || !part.url) return null;
	const mime = part.mime || 'application/octet-stream';
	return {
		id: part.id,
		name: part.filename || 'attachment',
		mime,
		size: 0,
		dataUrl: part.url,
		isImage: ocIsImageMime(mime)
	};
}

export function ocErrorMessage(error: unknown): string {
	if (error && typeof error === 'object') {
		const e = error as { name?: string; data?: { message?: string } };
		if (e.data?.message) return e.data.message;
		if (e.name) return e.name;
	}
	return 'The agent hit an error';
}
