import type { BuildStep, ParsedBuildLogs } from './buildkitParser';

export type BuildPhaseId = 'queue' | 'clone' | 'build' | 'push' | 'deploy';
export type FailureSetting = 'source' | 'crash';

export interface BuildFailure {
	canceled: boolean;
	phase: BuildPhaseId | null;
	step: BuildStep | null;
	title: string;
	fix: string | null;
	setting: FailureSetting | null;
	evidence: string[];
}

interface Rule {
	test: RegExp;
	phase?: BuildPhaseId;
	setting?: FailureSetting;
	title: (m: RegExpMatchArray, ctx: Context) => string;
	fix: (m: RegExpMatchArray, ctx: Context) => string | null;
	evidence?: RegExp;
}

interface Context {
	command: string | null;
	haystack: string;
}

const NOISE = [
	/^time="[^"]*" level=/,
	/^Error Type: /i,
	/^\[\d{10,}\] \[ERROR\] Error type: /i,
	/^Container \w+ terminated: /i,
	/^=== Build failed \(exit code: \d+\) ===$/,
	/^❌ Build failed at step /,
	/^\s*$/
];

const PREFIX_RE = /^\[\d{10,}\]\s*\[(?:INFO|ERROR|WARNING)\]\s?/;
const STEP_TIME_RE = /^\d+\.\d{3}\s?/;

function clean(line: string): string {
	return line.replace(PREFIX_RE, '').replace(STEP_TIME_RE, '').trimEnd();
}

export function isNoise(line: string): boolean {
	return NOISE.some((re) => re.test(line));
}

function stripFailedPrefix(text: string): string {
	let out = text.trim();
	for (;;) {
		const next = out.replace(/^(?:Build failed:\s*|error:\s*|Error:\s*)/i, '');
		if (next === out) return out;
		out = next;
	}
}

function code(text: string): string {
	return `\`${text}\``;
}

export function stepCommand(step: BuildStep | null): string | null {
	if (!step?.command) return null;
	const run = step.command.match(/^RUN\s+(?:--\S+\s+)*(.+)$/i);
	const cmd = (run ? run[1] : step.command).trim();
	return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
}

function manager(haystack: string): 'pnpm' | 'npm' | 'yarn' | 'bun' {
	if (/\bpnpm\b|ERR_PNPM/i.test(haystack)) return 'pnpm';
	if (/\byarn\b/i.test(haystack)) return 'yarn';
	if (/\bbun\b/i.test(haystack)) return 'bun';
	return 'npm';
}

const LOCKFILE: Record<ReturnType<typeof manager>, [string, string]> = {
	pnpm: ['pnpm install', 'pnpm-lock.yaml'],
	npm: ['npm install', 'package-lock.json'],
	yarn: ['yarn install', 'yarn.lock'],
	bun: ['bun install', 'bun.lock']
};

const RULES: Rule[] = [
	{
		test: /failed to read dockerfile|open Dockerfile: no such file|Dockerfile: no such file or directory/i,
		setting: 'source',
		title: () => 'There is no Dockerfile in the repo',
		fix: () =>
			'Add a Dockerfile at the root of the repo, or set the path to yours in Source & build.'
	},
	{
		test: /dockerfile parse error[^\n]*|unknown instruction: (\S+)/i,
		title: () => 'The Dockerfile has a syntax error',
		fix: () => 'Fix the line named below and push again.'
	},
	{
		test: /failed to compute cache key[^\n]*"\/?([^"]+)": not found|"\/?([^"]+)": not found/i,
		title: (m) => `${code(m[1] ?? m[2])} is not in the build`,
		fix: () => 'Commit it, or take it out of .dockerignore if it is listed there.'
	},
	{
		test: /pull access denied for ([^\s,]+)|failed to resolve source metadata for ([^\s:]+(?::[^\s:]+)?)|([^\s]+): not found: manifest unknown|manifest unknown/i,
		title: (m) => {
			const image = (m[1] ?? m[2] ?? m[3])?.replace(/^docker\.io\/(library\/)?/, '');
			return image
				? `The base image ${code(image)} can't be pulled`
				: "The base image can't be pulled";
		},
		fix: () => 'Check the image name and tag on the FROM line.'
	},
	{
		test: /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|lockfile[^\n]*(?:needs to be updated|not up to date|is outdated)|can only install packages when your package\.json and package-lock\.json[^\n]*in sync|are not in sync|Your lockfile needs to be updated/i,
		title: (_, ctx) => `${LOCKFILE[manager(ctx.haystack)][1]} doesn't match package.json`,
		fix: (_, ctx) => {
			const [install, file] = LOCKFILE[manager(ctx.haystack)];
			return `Run ${code(install)} locally and commit ${file}.`;
		}
	},
	{
		test: /error TS\d+:/,
		evidence: /error TS\d+:/,
		title: (_, ctx) => {
			const count = ctx.haystack.match(/error TS\d+:/g)?.length ?? 1;
			return count === 1 ? 'TypeScript found an error' : `TypeScript found ${count} errors`;
		},
		fix: (_, ctx) =>
			ctx.command
				? `Fix them and push. ${code(ctx.command)} fails the same way locally.`
				: 'Fix them and push.'
	},
	{
		test: /Cannot find module '([^']+)'|Can't resolve '([^']+)'|Cannot find package '([^']+)'/,
		title: (m) => `${code(m[1] ?? m[2] ?? m[3])} can't be found`,
		fix: (m) => {
			const mod = m[1] ?? m[2] ?? m[3];
			return /^[./]/.test(mod)
				? 'Check the import path and that the file is committed. Paths are case sensitive in the build.'
				: `Add ${code(mod)} to dependencies in package.json.`;
		}
	},
	{
		test: /JavaScript heap out of memory|exit code: 137|signal: killed|\bKilled\s*$/im,
		title: () => 'The build ran out of memory',
		fix: () => 'Cap Node with `ENV NODE_OPTIONS=--max-old-space-size=2048` before this step.'
	},
	{
		test: /(?:sh|bash)(?::\s*\d+)?:\s*([\w.@/-]+):\s*(?:command )?not found/i,
		title: (m) => `${code(m[1])} isn't installed in the image`,
		fix: () => 'Install it in an earlier RUN, or start FROM an image that has it.'
	},
	{
		test: /exit code: 127/,
		title: () => 'A command in this step is not installed',
		fix: () => 'Install it in an earlier RUN, or start FROM an image that has it.'
	},
	{
		test: /Remote branch (\S+) not found|couldn't find remote ref (?:refs\/heads\/)?(\S+)/i,
		phase: 'clone',
		setting: 'source',
		title: (m) => `The branch ${code(m[1] ?? m[2])} doesn't exist`,
		fix: () => 'Push it, or pick another branch in Source & build.'
	},
	{
		test: /Repository not found|could not read Username|Authentication failed for|Permission denied \(publickey\)/i,
		phase: 'clone',
		title: () => "Orchard can't read the repository",
		fix: () => 'Check that the Orchard GitHub app still has access to it.'
	},
	{
		test: /exceeded the maximum runtime/i,
		title: () => 'The build ran too long',
		fix: () => 'Install dependencies before COPY . . so they stay cached between builds.'
	},
	{
		test: /did not start within|could not be resumed or requeued|Recovery failed/i,
		phase: 'queue',
		title: () => "Orchard couldn't start a builder",
		fix: () => 'This is on Orchard, not your code. Redeploy to try again.'
	}
];

const CANCELED_RE = /cancell?ed by user|build cancell?ed\b/i;
const EXIT_RE = /did not complete successfully: exit code: (\d+)/;
const ERRORISH =
	/\berror\b|ERR!|ERR_|\bfailed\b|cannot|can't|could not|not found|ENOENT|denied|exception|panic/i;

function failedStep(parsed: ParsedBuildLogs): BuildStep | null {
	return [...parsed.steps].reverse().find((s) => s.status === 'error') ?? null;
}

function stepEvidence(step: BuildStep, focus?: RegExp): string[] {
	const lines = step.output.map(clean).filter((l) => l && !isNoise(l));
	if (focus) {
		const hits = lines.filter((l) => focus.test(l));
		if (hits.length) return hits.slice(0, 8);
	}
	const tail = lines.slice(-16);
	const first = tail.findIndex((l) => ERRORISH.test(l));
	if (first < 0) return tail.slice(-8);
	const from = tail.slice(first, first + 8).length < 3 ? Math.max(0, first - 1) : first;
	return tail.slice(from, from + 8);
}

function errorEvidence(parsed: ParsedBuildLogs, error: string | null): string[] {
	const fromError = (error ?? '')
		.split('\n')
		.map(clean)
		.filter((l) => l && !isNoise(l))
		.map(stripFailedPrefix);
	if (fromError.length) return [...new Set(fromError)].slice(0, 6);
	return parsed.messages
		.filter((m) => m.level === 'ERROR')
		.map((m) => stripFailedPrefix(clean(m.text)))
		.filter((l) => l && !isNoise(l))
		.slice(-6);
}

const PIPELINE: [string, BuildPhaseId][] = [
	['deploying', 'deploy'],
	['pushing', 'push'],
	['building', 'build'],
	['cloning', 'clone'],
	['scheduled', 'queue'],
	['submitted', 'queue'],
	['queued', 'queue']
];

function phaseFrom(
	buildStep: string | null | undefined,
	timestamps: Record<string, unknown> | null | undefined
): BuildPhaseId | null {
	const byStep = PIPELINE.find(([id]) => id === buildStep)?.[1];
	if (byStep) return byStep;
	for (const [id, phase] of PIPELINE) if (typeof timestamps?.[id] === 'number') return phase;
	return null;
}

export function diagnoseBuild(input: {
	parsed: ParsedBuildLogs;
	error?: string | null;
	buildStep?: string | null;
	timestamps?: Record<string, unknown> | null;
}): BuildFailure {
	const { parsed } = input;
	const error = input.error ?? null;
	const step = failedStep(parsed);
	const command = stepCommand(step);
	const messageText = parsed.messages
		.filter((m) => m.level === 'ERROR')
		.map((m) => m.text)
		.join('\n');
	const haystack = [step?.error ?? '', ...(step?.output ?? []), error ?? '', messageText].join(
		'\n'
	);
	const pushStep = step?.stage === 'push';
	const fallbackPhase: BuildPhaseId | null = step
		? pushStep
			? 'push'
			: 'build'
		: phaseFrom(input.buildStep, input.timestamps);

	if (!step && CANCELED_RE.test(`${error ?? ''}\n${messageText}`)) {
		return {
			canceled: true,
			phase: fallbackPhase,
			step: null,
			title: 'This build was canceled',
			fix: null,
			setting: null,
			evidence: []
		};
	}

	const ctx: Context = { command, haystack };
	const deploy = (error ?? '').match(
		/Deploy failed:\s*(.+?)\.?\s*The previous release kept serving/i
	);
	if (deploy) {
		return {
			canceled: false,
			phase: 'deploy',
			step: null,
			title: 'The image built, but the new version never became ready',
			fix: 'The previous version is still serving. Its crash output shows why the new one stopped.',
			setting: 'crash',
			evidence: [deploy[1]]
		};
	}
	for (const rule of RULES) {
		const m = haystack.match(rule.test);
		if (!m) continue;
		return {
			canceled: false,
			phase: rule.phase ?? fallbackPhase,
			step,
			title: rule.title(m, ctx),
			fix: rule.fix(m, ctx),
			setting: rule.setting ?? null,
			evidence: step ? stepEvidence(step, rule.evidence) : errorEvidence(parsed, error)
		};
	}

	if (pushStep) {
		return {
			canceled: false,
			phase: 'push',
			step,
			title: 'Pushing the image failed',
			fix: 'This is on Orchard, not your code. Redeploy to try again.',
			setting: null,
			evidence: step ? stepEvidence(step) : errorEvidence(parsed, error)
		};
	}

	if (step) {
		const exit = (step.error ?? '').match(EXIT_RE)?.[1];
		return {
			canceled: false,
			phase: 'build',
			step,
			title: command
				? `${code(command)} failed${exit ? ` with exit code ${exit}` : ''}`
				: 'A build step failed',
			fix: command ? `Run ${code(command)} locally to reproduce it.` : null,
			setting: null,
			evidence: stepEvidence(step)
		};
	}

	const evidence = errorEvidence(parsed, error);
	return {
		canceled: false,
		phase: fallbackPhase,
		step: null,
		title: evidence[0] ?? 'The build failed',
		fix: null,
		setting: null,
		evidence: evidence.slice(1)
	};
}
