import type { BuildMessage, BuildStep, ParsedBuildLogs } from './buildkitParser';
import type { BuildPhaseId } from './build-failure';

export const PHASE_ORDER: BuildPhaseId[] = ['queue', 'clone', 'build', 'push', 'deploy'];

export type SectionItem =
	| { kind: 'line'; key: string; message: BuildMessage }
	| { kind: 'step'; key: string; step: BuildStep };

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

function classify(text: string): BuildPhaseId | null {
	for (const [phase, re] of RULES) if (re.test(text)) return phase;
	return null;
}

const rank = (p: BuildPhaseId) => PHASE_ORDER.indexOf(p);

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
	return PHASE_ORDER.flatMap((p) => byPhase.get(p) ?? []);
}
