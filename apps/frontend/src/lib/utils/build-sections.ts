import type { BuildMessage, BuildStep, ParsedBuildLogs, StepStatus } from './buildkitParser';
import type { BuildPhaseId } from './build-failure';

export const PHASE_ORDER: BuildPhaseId[] = ['queue', 'clone', 'build', 'push', 'deploy'];

export interface StepItem {
	kind: 'step';
	key: string;
	step: BuildStep;
}

export type StageKind = 'setup' | 'stage' | 'export';

export interface StageGroup {
	key: string;
	kind: StageKind;
	name: string | null;
	items: StepItem[];
	steps: number;
	total: number;
	cached: number;
	durationSec: number | null;
	status: StepStatus;
}

export type SectionItem =
	| { kind: 'line'; key: string; message: BuildMessage }
	| StepItem
	| { kind: 'stage'; key: string; stage: StageGroup };

export interface BuildSection {
	phase: BuildPhaseId;
	items: SectionItem[];
	steps: number;
	cached: number;
}

const RULES: [BuildPhaseId, RegExp][] = [
	[
		'deploy',
		/Creating Kubernetes|Image applied|rolling (?:the new pods )?out|Rolling out|new pods? to become ready|Pod \S+ is ready|Deployment is live|Rebuild complete/i
	],
	['push', /push(?:ing)? (?:layers|manifest|the image)|Build and push completed|^Image: \S+:\S+/i],
	['build', /^=+\s*Building image|BuildKit build for|load build definition/i],
	[
		'clone',
		/^=+\s*Fetching source|^Repository: |^Branch: |Cloning |HEAD is now at|source repository is shallow|--local is ignored|^Commit: [0-9a-f]{40}/i
	]
];

const SETUP_STAGES = new Set(['internal', 'auth']);

function classify(text: string): BuildPhaseId | null {
	for (const [phase, re] of RULES) if (re.test(text)) return phase;
	return null;
}

const rank = (p: BuildPhaseId) => PHASE_ORDER.indexOf(p);

function isDockerfileStep(step: BuildStep): boolean {
	return !!step.stagePos || (!!step.stage && !SETUP_STAGES.has(step.stage));
}

function stageTotal(step: BuildStep): number {
	const of = step.stagePos?.split('/')[1];
	return of ? Number(of) || 0 : 0;
}

function stageStatus(steps: BuildStep[]): StepStatus {
	if (steps.some((s) => s.status === 'error')) return 'error';
	if (steps.some((s) => s.status === 'running' || s.status === 'pending')) return 'running';
	if (steps.some((s) => s.status === 'canceled')) return 'canceled';
	if (steps.every((s) => s.status === 'cached')) return 'cached';
	return 'done';
}

function finishStage(group: StageGroup): StageGroup {
	const steps = group.items.map((i) => i.step);
	const timed = steps.filter((s) => s.status !== 'cached' && s.durationSec !== null);
	return {
		...group,
		steps: steps.length,
		total: Math.max(steps.length, ...steps.map(stageTotal)),
		cached: steps.filter((s) => s.status === 'cached').length,
		durationSec: timed.length ? timed.reduce((sum, s) => sum + (s.durationSec ?? 0), 0) : null,
		status: stageStatus(steps)
	};
}

export function groupStages(items: SectionItem[]): SectionItem[] {
	if (!items.some((i) => i.kind === 'step' && isDockerfileStep(i.step))) return items;
	const groups = new Map<string, StageGroup>();
	const out: SectionItem[] = [];
	let seenStage = false;
	for (const item of items) {
		if (item.kind !== 'step') {
			out.push(item);
			continue;
		}
		const step = item.step;
		let kind: StageKind;
		if (isDockerfileStep(step)) {
			kind = 'stage';
			seenStage = true;
		} else if (step.stage && SETUP_STAGES.has(step.stage)) {
			kind = 'setup';
		} else {
			kind = seenStage ? 'export' : 'setup';
		}
		const name = kind === 'stage' ? step.stage : null;
		const key = `g:${kind}:${name ?? ''}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				kind,
				name,
				items: [],
				steps: 0,
				total: 0,
				cached: 0,
				durationSec: null,
				status: 'done'
			};
			groups.set(key, group);
			out.push({ kind: 'stage', key, stage: group });
		}
		group.items.push(item);
	}
	return out.map((item) =>
		item.kind === 'stage' ? { ...item, stage: finishStage(item.stage) } : item
	);
}

export function sectionSteps(section: BuildSection): StepItem[] {
	return section.items.flatMap((i) =>
		i.kind === 'step' ? [i] : i.kind === 'stage' ? i.stage.items : []
	);
}

export function buildSections(parsed: ParsedBuildLogs): BuildSection[] {
	const items = [
		...parsed.steps.map((step) => ({ order: step.order, step })),
		...parsed.messages.map((message) => ({ order: message.order, message }))
	].sort((a, b) => a.order - b.order);

	const byPhase = new Map<BuildPhaseId, BuildSection>();
	let current: BuildPhaseId = 'queue';
	for (const item of items) {
		let phase: BuildPhaseId;
		if ('step' in item) {
			phase = item.step.stage === 'push' ? 'push' : 'build';
		} else {
			phase = classify(item.message.text.trim()) ?? current;
		}
		if (rank(phase) < rank(current)) phase = current;
		current = phase;
		let section = byPhase.get(phase);
		if (!section) {
			section = { phase, items: [], steps: 0, cached: 0 };
			byPhase.set(phase, section);
		}
		if ('step' in item) {
			section.items.push({ kind: 'step', key: `s:${item.step.id}`, step: { ...item.step } });
			section.steps++;
			if (item.step.status === 'cached') section.cached++;
		} else {
			section.items.push({ kind: 'line', key: `l:${item.order}`, message: item.message });
		}
	}
	const build = byPhase.get('build');
	if (build) build.items = groupStages(build.items);
	return PHASE_ORDER.flatMap((p) => byPhase.get(p) ?? []);
}
