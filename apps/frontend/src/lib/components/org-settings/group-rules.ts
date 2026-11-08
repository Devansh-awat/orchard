import type { GroupRule, MappableRole, RulePreview } from './sso-types';

export const ROLE_OPTIONS: Array<{ value: MappableRole; label: string }> = [
	{ value: 'admin', label: 'Admin' },
	{ value: 'member', label: 'Member' },
	{ value: 'guest', label: 'Guest' }
];

export const MAX_GROUPS_PREVIEW = 500;

export interface RuleRow {
	key: string;
	value: string;
	role: MappableRole;
	organizationId: string;
}

let counter = 0;

export function newRow(over: Partial<RuleRow> = {}): RuleRow {
	counter += 1;
	return { key: `row-${counter}`, value: '', role: 'member', organizationId: '', ...over };
}

export function rowsFromRules(rules: GroupRule[]): RuleRow[] {
	return rules.map((r) =>
		newRow({ value: r.value, role: r.role, organizationId: r.organizationId })
	);
}

export function rulesFromRows(rows: RuleRow[], fixedOrganizationId: string | null): GroupRule[] {
	return rows
		.filter((r) => r.value.trim() !== '')
		.map((r) => ({
			value: r.value.trim(),
			role: r.role,
			organizationId: fixedOrganizationId ?? r.organizationId
		}));
}

export function snapshot(groupClaim: string, rows: RuleRow[], fixed: string | null): string {
	return JSON.stringify([
		groupClaim.trim(),
		rulesFromRows(rows, fixed).map((r) => [r.organizationId, r.value, r.role])
	]);
}

export function duplicateValue(rows: RuleRow[], fixed: string | null): string | null {
	const seen = new Set<string>();
	for (const rule of rulesFromRows(rows, fixed)) {
		const key = `${rule.organizationId}\u0000${rule.value.normalize('NFC')}`;
		if (seen.has(key)) return rule.value;
		seen.add(key);
	}
	return null;
}

export function missingOrganization(rows: RuleRow[], fixed: string | null): boolean {
	return fixed === null && rulesFromRows(rows, fixed).some((r) => !r.organizationId);
}

export function parseGroupList(text: string): string[] {
	const out: string[] = [];
	for (const part of text.split(/[\n,]/)) {
		const name = part.trim();
		if (name && !out.includes(name)) out.push(name);
	}
	return out.slice(0, MAX_GROUPS_PREVIEW);
}

export interface PreviewLine {
	tone: 'success' | 'warning' | 'info';
	title: string;
	detail?: string;
}

export function describePreview(
	result: RulePreview,
	organizationName: (id: string) => string | null
): PreviewLine {
	if (!result.hasRules) {
		return {
			tone: 'info',
			title: 'No rules yet',
			detail: "Everyone who signs in gets the connection's default role."
		};
	}
	if (!result.allowed) {
		return {
			tone: 'warning',
			title: 'Refused with sso_not_mapped',
			detail:
				'None of these groups match a rule. If members you expect to get in see this, the group claim name is probably not the one your provider sends.'
		};
	}
	const lines = result.matches.map((m) => {
		const name = organizationName(m.organizationId);
		return name ? `${m.role} in ${name}` : m.role;
	});
	return { tone: 'success', title: `Signs in as ${lines.join(', ')}` };
}

export function describeSignInError(code: string): string | null {
	if (code === 'sso_not_mapped') {
		return 'Your identity provider signed you in, but none of your groups give access. Ask an admin to map one of your groups.';
	}
	return null;
}

export function describeSaveError(message: string): string {
	if (/never owner/i.test(message)) return 'Rules can grant admin, member or guest, never owner.';
	if (/another identity provider already has group rules/i.test(message)) {
		return 'Another identity provider already maps groups into this organization. Remove its rules first.';
	}
	return message;
}
