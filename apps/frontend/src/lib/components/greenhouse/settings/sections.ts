import { queryClient } from '$lib/query';
import { apiFetch } from '$lib/stores';

export type SettingsSectionId =
	| 'general'
	| 'setup'
	| 'projects'
	| 'usage'
	| 'danger'
	| 'preferences'
	| 'sounds'
	| 'appearance'
	| 'git'
	| 'agents'
	| 'integrations'
	| 'shortcuts';

export const MACHINE_SECTIONS: readonly SettingsSectionId[] = [
	'general',
	'setup',
	'projects',
	'usage',
	'danger'
];

export const PERSONAL_SECTIONS: readonly SettingsSectionId[] = [
	'preferences',
	'sounds',
	'appearance',
	'git',
	'agents',
	'integrations',
	'shortcuts'
];

export const DEFAULT_SECTION: SettingsSectionId = 'preferences';

export const SECTION_LABELS: Record<SettingsSectionId, string> = {
	general: 'General',
	setup: 'Setup script',
	projects: 'Projects',
	usage: 'Usage',
	danger: 'Danger zone',
	preferences: 'Preferences',
	sounds: 'Sounds',
	appearance: 'Appearance',
	git: 'Git',
	agents: 'Agents',
	integrations: 'Integrations',
	shortcuts: 'Shortcuts'
};

export function isSettingsSection(value: unknown): value is SettingsSectionId {
	return (
		typeof value === 'string' &&
		[...MACHINE_SECTIONS, ...PERSONAL_SECTIONS].includes(value as SettingsSectionId)
	);
}

export async function patchMachine(id: string, body: Record<string, unknown>) {
	const res = await apiFetch(`/apiv1/sandboxes/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Save failed');
	await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
}

export function errorText(e: unknown): string | undefined {
	return e instanceof Error ? e.message : undefined;
}
