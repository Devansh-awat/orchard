export type PermissionReply = 'once' | 'always' | 'reject';

export type PermissionRequest = {
	kind: 'permission';
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	always: string[];
	metadata: Record<string, unknown>;
	title: string | null;
	messageID: string | null;
	callID: string | null;
	legacy: boolean;
};

export type QuestionOption = { label: string; description: string };

export type QuestionInfo = {
	question: string;
	header: string;
	options: QuestionOption[];
	multiple: boolean;
	custom: boolean;
};

export type QuestionRequest = {
	kind: 'question';
	id: string;
	sessionID: string;
	questions: QuestionInfo[];
	messageID: string | null;
	callID: string | null;
};

export type AgentRequest = PermissionRequest | QuestionRequest;

export type RequestOutcome =
	| { kind: 'permission'; id: string; sessionID: string | null; reply: PermissionReply }
	| { kind: 'question'; id: string; sessionID: string | null; answers: string[][] | null };

export type PermissionIcon = 'command' | 'edit' | 'fetch' | 'folder' | 'read' | 'search' | 'tool';

export type DiffLine = { sign: '+' | '−' | ' '; text: string };

export type PermissionView = {
	icon: PermissionIcon;
	title: string;
	detail: string | null;
	diff: DiffLine[] | null;
	covers: string | null;
	subject: { lead: string; target: string | null; mono: boolean };
};

export type NoteTone = 'allowed' | 'denied' | 'answered';

export type NoteText = { tone: NoteTone; lead: string; target: string | null; mono: boolean };

const DIFF_CAP = 200;
const LIST_CAP = 6;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
	if (typeof value === 'string') return value ? [value] : [];
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function toolRef(raw: Record<string, unknown>): {
	messageID: string | null;
	callID: string | null;
} {
	const tool = record(raw.tool);
	return {
		messageID: str(tool?.messageID) ?? str(raw.messageID),
		callID: str(tool?.callID) ?? str(raw.callID)
	};
}

export function parsePermission(value: unknown): PermissionRequest | null {
	const raw = record(value);
	if (!raw) return null;
	const id = str(raw.id);
	const sessionID = str(raw.sessionID);
	const current = str(raw.permission);
	const old = str(raw.type);
	const permission = current ?? old;
	if (!id || !sessionID || !permission) return null;
	const legacy = !current;
	const patterns = strings(legacy ? raw.pattern : raw.patterns);
	const always = legacy ? patterns : strings(raw.always);
	return {
		kind: 'permission',
		id,
		sessionID,
		permission,
		patterns,
		always,
		metadata: record(raw.metadata) ?? {},
		title: str(raw.title),
		...toolRef(raw),
		legacy
	};
}

function parseInfo(value: unknown): QuestionInfo | null {
	const raw = record(value);
	if (!raw) return null;
	const question = str(raw.question);
	if (!question) return null;
	const options: QuestionOption[] = [];
	if (Array.isArray(raw.options)) {
		for (const item of raw.options) {
			const option = record(item);
			const label = str(option?.label);
			if (!label || options.some((o) => o.label === label)) continue;
			options.push({ label, description: str(option?.description) ?? '' });
		}
	}
	return {
		question,
		header: str(raw.header) ?? '',
		options,
		multiple: raw.multiple === true,
		custom: raw.custom !== false || options.length === 0
	};
}

export function parseQuestion(value: unknown): QuestionRequest | null {
	const raw = record(value);
	if (!raw) return null;
	const id = str(raw.id);
	const sessionID = str(raw.sessionID);
	if (!id || !sessionID || !Array.isArray(raw.questions)) return null;
	const questions = raw.questions.map(parseInfo).filter((q): q is QuestionInfo => !!q);
	if (questions.length === 0) return null;
	return { kind: 'question', id, sessionID, questions, ...toolRef(raw) };
}

export function parseRequestList(kind: AgentRequest['kind'], body: unknown): AgentRequest[] {
	if (!Array.isArray(body)) return [];
	const out: AgentRequest[] = [];
	for (const item of body) {
		const request = kind === 'permission' ? parsePermission(item) : parseQuestion(item);
		if (request) out.push(request);
	}
	return out;
}

function replyOf(value: unknown): PermissionReply | null {
	return value === 'once' || value === 'always' || value === 'reject' ? value : null;
}

function answersOf(value: unknown): string[][] | null {
	if (!Array.isArray(value)) return null;
	return value.map((answer) => strings(answer));
}

export function parseOutcome(type: string, value: unknown): RequestOutcome | null {
	const raw = record(value);
	if (!raw) return null;
	const sessionID = str(raw.sessionID);
	if (type === 'permission.replied') {
		const id = str(raw.requestID) ?? str(raw.permissionID);
		const reply = replyOf(raw.reply) ?? replyOf(raw.response);
		return id && reply ? { kind: 'permission', id, sessionID, reply } : null;
	}
	if (type === 'question.replied' || type === 'question.rejected') {
		const id = str(raw.requestID);
		if (!id) return null;
		const answers = type === 'question.replied' ? (answersOf(raw.answers) ?? []) : null;
		return { kind: 'question', id, sessionID, answers };
	}
	return null;
}

export function relativePath(path: string, directory: string | null): string {
	if (!directory) return path;
	const root = directory.endsWith('/') ? directory : `${directory}/`;
	return path.startsWith(root) ? path.slice(root.length) : path;
}

export function parseDiff(diff: unknown): DiffLine[] | null {
	if (typeof diff !== 'string' || !diff.trim()) return null;
	const lines: DiffLine[] = [];
	let body = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('@@')) {
			body = true;
			continue;
		}
		if (!body || line.startsWith('\\')) continue;
		if (line.startsWith('+')) lines.push({ sign: '+', text: line.slice(1) });
		else if (line.startsWith('-')) lines.push({ sign: '−', text: line.slice(1) });
		else lines.push({ sign: ' ', text: line.startsWith(' ') ? line.slice(1) : line });
		if (lines.length >= DIFF_CAP) break;
	}
	while (lines.length > 0 && lines[lines.length - 1].sign === ' ' && !lines.at(-1)?.text) {
		lines.pop();
	}
	return lines.some((l) => l.sign !== ' ') ? lines : null;
}

function listed(items: string[]): string {
	const shown = items.slice(0, LIST_CAP);
	const more = items.length - shown.length;
	return more > 0 ? `${shown.join('\n')}\n+${more} more` : shown.join('\n');
}

function shortList(items: string[]): string {
	return items.length > 2
		? `${items.slice(0, 2).join(', ')} +${items.length - 2}`
		: items.join(', ');
}

function coversText(always: string[]): string | null {
	if (always.length === 0) return null;
	if (always.includes('*')) return 'Allow this kind of request without asking again';
	return `Allow ${shortList(always)} without asking again`;
}

export function describePermission(
	request: PermissionRequest,
	directory: string | null = null
): PermissionView {
	const meta = request.metadata;
	const covers = coversText(request.always);
	const patterns = request.patterns.filter((p) => p !== '*');
	const fallback = request.title;
	switch (request.permission) {
		case 'bash': {
			const command = str(meta.command) ?? (patterns.length > 0 ? patterns.join('\n') : null);
			return {
				icon: 'command',
				title: fallback && !command ? fallback : 'Run a command',
				detail: command,
				diff: null,
				covers,
				subject: command
					? { lead: '', target: command, mono: true }
					: { lead: 'a command', target: null, mono: false }
			};
		}
		case 'edit':
		case 'write': {
			const files = Array.isArray(meta.files) ? strings(meta.files) : [];
			const file = str(meta.filepath);
			const paths = (patterns.length > 0 ? patterns : file ? [file] : files).map((p) =>
				relativePath(p, directory)
			);
			const target = paths.length > 0 ? shortList(paths) : null;
			return {
				icon: 'edit',
				title: target ? `Edit ${target}` : (fallback ?? 'Edit files'),
				detail: paths.length > 1 ? listed(paths) : null,
				diff: parseDiff(meta.diff),
				covers,
				subject: { lead: 'edit to', target: target ?? 'files', mono: !!target }
			};
		}
		case 'webfetch': {
			const url = str(meta.url) ?? patterns[0] ?? null;
			return {
				icon: 'fetch',
				title: url ? `Fetch ${url}` : 'Fetch a web page',
				detail: null,
				diff: null,
				covers,
				subject: { lead: 'fetching', target: url, mono: !!url }
			};
		}
		case 'websearch': {
			const query = str(meta.query) ?? patterns[0] ?? null;
			return {
				icon: 'search',
				title: 'Search the web',
				detail: query,
				diff: null,
				covers,
				subject: { lead: 'a web search for', target: query, mono: !!query }
			};
		}
		case 'external_directory': {
			const where = str(meta.parentDir) ?? str(meta.filepath) ?? null;
			const paths = patterns.length > 0 ? patterns : where ? [where] : [];
			const command = str(meta.command);
			return {
				icon: 'folder',
				title: 'Work outside the worktree',
				detail: command ? `${command}\n${listed(paths)}` : paths.length > 0 ? listed(paths) : null,
				diff: null,
				covers,
				subject: {
					lead: 'access to',
					target: paths.length > 0 ? shortList(paths) : 'files outside the worktree',
					mono: paths.length > 0
				}
			};
		}
		case 'read': {
			const path = patterns[0] ? relativePath(patterns[0], directory) : null;
			return {
				icon: 'read',
				title: path ? `Read ${path}` : 'Read a file',
				detail: null,
				diff: null,
				covers,
				subject: { lead: 'reading', target: path, mono: !!path }
			};
		}
		case 'doom_loop': {
			const tool = str(meta.tool) ?? patterns[0] ?? 'a tool';
			return {
				icon: 'tool',
				title: `Keep calling ${tool} with the same input`,
				detail: null,
				diff: null,
				covers,
				subject: { lead: 'repeating', target: tool, mono: true }
			};
		}
		case 'task': {
			const agent = str(meta.subagent_type) ?? patterns[0] ?? null;
			return {
				icon: 'tool',
				title: agent ? `Start the ${agent} agent` : 'Start a sub-agent',
				detail: str(meta.description),
				diff: null,
				covers,
				subject: { lead: 'the', target: agent ? `${agent} agent` : 'sub-agent', mono: false }
			};
		}
		default: {
			const detail = patterns.length > 0 ? listed(patterns) : null;
			return {
				icon: request.permission === 'glob' || request.permission === 'grep' ? 'search' : 'tool',
				title: fallback ?? `Use ${request.permission}`,
				detail,
				diff: null,
				covers,
				subject: { lead: '', target: request.permission, mono: true }
			};
		}
	}
}

export function requestDetail(request: AgentRequest, directory: string | null = null): string {
	if (request.kind === 'permission') return describePermission(request, directory).title;
	const first = request.questions[0];
	return first.question || first.header;
}

export type RequestAuthor = { id: string; name: string; avatarUrl?: string | null };

export type PromptRef = {
	local?: boolean;
	messageID?: string;
	author?: RequestAuthor | null;
};

export function waitingOn(
	prompt: PromptRef | null,
	authorOf: (messageId: string) => RequestAuthor | null,
	selfId: string | null
): RequestAuthor | null {
	if (!prompt || prompt.local || !selfId) return null;
	const author = (prompt.messageID ? authorOf(prompt.messageID) : null) ?? prompt.author ?? null;
	if (!author || author.id === selfId) return null;
	return author;
}

export type PlanHandoff = { path: string | null; yes: string; no: string };

export function planHandoff(request: AgentRequest): PlanHandoff | null {
	if (request.kind !== 'question' || request.questions.length !== 1) return null;
	const info = request.questions[0];
	if (info.header !== 'Build Agent' || info.multiple) return null;
	const labels = info.options.map((o) => o.label);
	if (!labels.includes('Yes') || !labels.includes('No')) return null;
	const path = /^Plan at (.+?) is complete\b/.exec(info.question)?.[1] ?? null;
	return { path, yes: 'Yes', no: 'No' };
}

export function collectAnswers(
	questions: QuestionInfo[],
	picks: string[][],
	custom: string[]
): string[][] {
	return questions.map((info, i) => {
		const chosen = (picks[i] ?? []).filter((label) => info.options.some((o) => o.label === label));
		const typed = info.custom ? (custom[i] ?? '').trim() : '';
		const answer = info.multiple ? chosen : chosen.slice(0, 1);
		if (typed) return info.multiple ? [...answer, typed] : [typed];
		return answer;
	});
}

export function answered(
	questions: QuestionInfo[],
	picks: string[][],
	custom: string[]
): boolean[] {
	return collectAnswers(questions, picks, custom).map((answer) => answer.length > 0);
}

export function noteFor(
	request: AgentRequest,
	outcome: RequestOutcome,
	directory: string | null = null
): NoteText {
	if (request.kind === 'permission' && outcome.kind === 'permission') {
		const { subject } = describePermission(request, directory);
		const verb =
			outcome.reply === 'reject'
				? 'Denied'
				: outcome.reply === 'always'
					? 'Always allowed'
					: 'Allowed';
		return {
			tone: outcome.reply === 'reject' ? 'denied' : 'allowed',
			lead: subject.lead ? `${verb} ${subject.lead}` : verb,
			target: subject.target,
			mono: subject.mono
		};
	}
	if (request.kind === 'question' && outcome.kind === 'question') {
		const plan = planHandoff(request);
		if (outcome.answers === null) {
			return {
				tone: 'denied',
				lead: plan ? 'Kept planning' : 'Skipped the question',
				target: null,
				mono: false
			};
		}
		if (plan) {
			const first = outcome.answers[0]?.[0];
			return first === plan.no
				? { tone: 'denied', lead: 'Kept planning', target: null, mono: false }
				: { tone: 'allowed', lead: 'Started building', target: null, mono: false };
		}
		const flat = outcome.answers.flat().filter(Boolean);
		return {
			tone: 'answered',
			lead: 'Answered',
			target: flat.length > 0 ? shortList(flat) : null,
			mono: false
		};
	}
	return { tone: 'answered', lead: 'Answered', target: null, mono: false };
}

export type NotFoundProbe = { status: number; body: unknown };

export function replyGone(probe: NotFoundProbe): boolean | null {
	if (probe.status === 409 || probe.status === 410) return true;
	if (probe.status !== 404) return null;
	const raw = record(probe.body);
	const tag = str(raw?.['_tag']) ?? str(raw?.name) ?? '';
	const message = str(raw?.message) ?? str(record(raw?.data)?.message) ?? '';
	return /NotFound/i.test(tag) || /not found:/i.test(message);
}
