import type { MonacoApi } from './load';

const BY_EXTENSION: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	jsonc: 'json',
	json5: 'json',
	md: 'markdown',
	mdx: 'markdown',
	markdown: 'markdown',
	py: 'python',
	pyi: 'python',
	go: 'go',
	rs: 'rust',
	rb: 'ruby',
	java: 'java',
	kt: 'kotlin',
	swift: 'swift',
	c: 'c',
	h: 'c',
	cc: 'cpp',
	cpp: 'cpp',
	hpp: 'cpp',
	cs: 'csharp',
	php: 'php',
	css: 'css',
	scss: 'scss',
	less: 'less',
	html: 'html',
	htm: 'html',
	svelte: 'html',
	vue: 'html',
	xml: 'xml',
	svg: 'xml',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'ini',
	ini: 'ini',
	env: 'ini',
	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
	sql: 'sql',
	prisma: 'graphql',
	graphql: 'graphql',
	gql: 'graphql',
	tf: 'hcl',
	hcl: 'hcl',
	lua: 'lua',
	dart: 'dart',
	ex: 'elixir',
	exs: 'elixir',
	r: 'r',
	proto: 'proto'
};

const BY_NAME: Record<string, string> = {
	dockerfile: 'dockerfile',
	containerfile: 'dockerfile',
	makefile: 'shell',
	'.gitignore': 'ini',
	'.dockerignore': 'ini',
	'.editorconfig': 'ini',
	'.env': 'ini'
};

export function languageForPath(path: string, monaco?: MonacoApi | null): string {
	const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	if (BY_NAME[name]) return BY_NAME[name];
	if (name.startsWith('dockerfile')) return 'dockerfile';
	if (name.startsWith('.env')) return 'ini';
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot + 1) : '';
	if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
	if (monaco && ext) {
		const match = monaco.languages
			.getLanguages()
			.find((lang) => lang.extensions?.includes(`.${ext}`) || lang.filenames?.includes(name));
		if (match) return match.id;
	}
	return 'plaintext';
}

const LABELS: Record<string, string> = {
	typescript: 'TypeScript',
	javascript: 'JavaScript',
	json: 'JSON',
	markdown: 'Markdown',
	python: 'Python',
	go: 'Go',
	rust: 'Rust',
	ruby: 'Ruby',
	css: 'CSS',
	scss: 'SCSS',
	html: 'HTML',
	yaml: 'YAML',
	shell: 'Shell',
	sql: 'SQL',
	dockerfile: 'Dockerfile',
	plaintext: 'Plain text'
};

export function languageLabel(id: string): string {
	return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
