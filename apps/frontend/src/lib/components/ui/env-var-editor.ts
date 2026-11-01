export interface EnvVarEditorRow {
	key: string;
	value: string;
	secret?: boolean;
	sealed?: boolean;
}

export interface EnvVarIssue {
	tone: 'error' | 'warning';
	text: string;
}
