import type { JobStepDraft, JobStep } from '$lib/types/jobs';

export function emptyStepDraft(type: JobStepDraft['type'] = 'script'): JobStepDraft {
	return {
		name: '',
		type,
		deploymentId: '',
		image: '',
		command: '',
		script: '',
		scriptRuntime: 'bash',
		envVars: [],
		cpuRequestMilli: null,
		memoryRequestBytes: null,
		timeoutSeconds: 1800,
		retries: 0
	};
}

export function stepToDraft(step: JobStep): JobStepDraft {
	return {
		name: step.name,
		type: step.type,
		deploymentId: step.deploymentId ?? '',
		image: step.image ?? '',
		command: step.command ?? '',
		script: step.script ?? '',
		scriptRuntime: step.scriptRuntime ?? 'bash',
		envVars: (step.envVars ?? []).map((e) => ({ ...e })),
		cpuRequestMilli: step.cpuRequestMilli,
		memoryRequestBytes: step.memoryRequestBytes,
		timeoutSeconds: step.timeoutSeconds,
		retries: step.retries
	};
}

export function draftError(steps: JobStepDraft[]): string | null {
	if (steps.length === 0) return 'Add at least one step';
	for (let i = 0; i < steps.length; i += 1) {
		const s = steps[i];
		const n = i + 1;
		if (s.type === 'script' && !s.script.trim()) return `Step ${n}: write a script`;
		if (s.type === 'image' && !s.image.trim()) return `Step ${n}: enter an image`;
		if (s.type === 'app' && !s.deploymentId) return `Step ${n}: select an app`;
		if (s.type === 'app' && !s.command.trim()) return `Step ${n}: enter a command`;
	}
	return null;
}

export function draftToPayload(steps: JobStepDraft[]) {
	return steps.map((s, i) => ({
		name: s.name.trim() || `Step ${i + 1}`,
		type: s.type,
		deploymentId: s.type === 'app' && s.deploymentId ? s.deploymentId : undefined,
		image: s.type === 'image' ? s.image.trim() : undefined,
		command: s.type !== 'script' && s.command.trim() ? s.command.trim() : undefined,
		script: s.type === 'script' ? s.script : undefined,
		scriptRuntime: s.type === 'script' ? s.scriptRuntime : undefined,
		envVars: s.envVars.filter((e) => e.key.trim()),
		cpuRequestMilli: s.cpuRequestMilli ? Number(s.cpuRequestMilli) : undefined,
		memoryRequestBytes: s.memoryRequestBytes ? String(s.memoryRequestBytes) : undefined,
		timeoutSeconds: Number(s.timeoutSeconds) || 1800,
		retries: Number(s.retries) || 0
	}));
}
