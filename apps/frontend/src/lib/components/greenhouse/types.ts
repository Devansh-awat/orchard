import type { Component } from 'svelte';

export type SessionActivityState = 'idle' | 'working' | 'needs_input' | 'done';

export type PersonRef = { id: string; name: string; avatarUrl?: string | null };

export interface GhSession {
	id: string;
	sandboxId: string;
	title: string;
	slug: string;
	repo: string;
	branch: string;
	baseBranch: string | null;
	baseCommit: string | null;
	worktreePath: string;
	agent: 'opencode';
	opencodeSessionId: string | null;
	status: 'active' | 'archived';
	activity: SessionActivityState;
	diffstat: { files: number; additions: number; deletions: number } | null;
	aheadBehind: { ahead: number; behind: number } | null;
	prUrl: string | null;
	prNumber: number | null;
	prState: 'open' | 'merged' | 'closed' | null;
	previewDeploymentId: string | null;
	previewUrl: string | null;
	createdBy: PersonRef | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

export interface GhChat {
	id: string;
	title: string;
	createdAt: string | number;
}

export interface GhRepo {
	name: string;
	branch: string;
	dirtyFiles: number;
}

export interface GhMember {
	user: { id: string; name: string; email: string | null; avatarUrl?: string | null };
	role: 'viewer' | 'collaborator';
	invitedBy?: PersonRef | null;
	createdAt: string;
}

export interface GhMembers {
	owner: { id: string; name: string; email: string | null; avatarUrl?: string | null } | null;
	members: GhMember[];
	myRole: 'owner' | 'collaborator' | 'viewer' | 'admin';
}

export interface GhPort {
	port: number;
	process: string | null;
	previewUrl: string | null;
	public: boolean;
}

export interface GhCheck {
	name: string;
	status: 'queued' | 'in_progress' | 'completed' | string;
	conclusion:
		| 'success'
		| 'failure'
		| 'neutral'
		| 'cancelled'
		| 'skipped'
		| 'timed_out'
		| 'action_required'
		| null
		| string;
	url: string | null;
	logExcerpt?: string | null;
}

export interface GhChecks {
	pr: {
		number: number;
		title?: string;
		url: string;
		state: 'open' | 'merged' | 'closed';
		draft?: boolean;
		mergeable?: boolean | null;
	} | null;
	checks: GhCheck[];
}

export interface GhConnect {
	sshHost: string;
	user: string;
	sshReady: boolean;
}

export interface GhFileNode {
	name: string;
	path: string;
	absolute: string;
	type: 'file' | 'directory';
	ignored: boolean;
}

export interface GhChangedFile {
	path: string;
	status: string;
	staged?: boolean;
	additions: number | null;
	deletions: number | null;
}

export interface GhChanges {
	isRepo: boolean;
	branch: string | null;
	files: GhChangedFile[];
	ahead?: number;
	behind?: number;
}

export type CenterTab =
	| { kind: 'chat'; id: string; chatId: string; title: string }
	| { kind: 'file'; id: string; path: string; title: string }
	| { kind: 'diff'; id: string; path: string; title: string }
	| { kind: 'preview'; id: string; port: number; title: string; url: string | null };

export type RightTab = 'files' | 'changes' | 'checks' | 'review';

export type DockTab = 'setup' | 'run' | 'ports' | `term:${string}`;

export interface RosterUser {
	id: string;
	name: string;
	avatarUrl?: string | null;
	color: string;
	role: 'owner' | 'collaborator' | 'viewer' | 'admin';
	view?: LiveView | null;
}

export interface LiveView {
	tab?: string;
	file?: string;
	line?: number;
	col?: number;
	selection?: { startLine: number; startCol: number; endLine: number; endCol: number } | null;
	scrollTop?: number;
}

export interface LiveComment {
	id: string;
	chatId: string;
	author: PersonRef;
	body: string;
	createdAt: string | number;
}

export interface RunnerChoice {
	id: string;
	label: string;
	caption: string;
	icon?: Component;
}

export type EditorTarget = 'vscode' | 'cursor' | 'zed' | 'terminal';
