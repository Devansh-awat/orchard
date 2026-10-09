import { queryClient } from '$lib/query';
import { apiFetch } from '$lib/stores';

export type SettingsSectionId =
	| 'general'
	| 'setup'
	| 'projects'
	| 'usage'
	| 'danger'
	| 'appearance'
	| 'integrations';

export const MACHINE_SECTIONS: readonly SettingsSectionId[] = [
	'general',
	'setup',
	'projects',
	'usage',
	'danger'
];

export const PERSONAL_SECTIONS: readonly SettingsSectionId[] = ['appearance', 'integrations'];

export const SECTION_LABELS: Record<SettingsSectionId, string> = {
	general: 'General',
	setup: 'Setup script',
	projects: 'Projects',
	usage: 'Usage',
	danger: 'Danger zone',
	appearance: 'Appearance',
	integrations: 'Integrations'
};

export function isSettingsSection(value: unknown): value is SettingsSectionId {
	return typeof value === 'string' && value in SECTION_LABELS;
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
