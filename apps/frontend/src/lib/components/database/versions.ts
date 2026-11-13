import { apiFetch } from '$lib/stores';
import type { DropdownOption } from '$lib/components/ui';
import type { Severity } from '$lib/components/ui/severity';
import type { DatabaseSecurity, DatabaseVersion, DatabaseVersions, MinorUpdate } from './types';

let cached: Promise<DatabaseVersions | null> | null = null;

export function loadVersions(): Promise<DatabaseVersions | null> {
	cached ??= apiFetch('/apiv1/database-versions')
		.then((res) => (res.ok ? (res.json() as Promise<DatabaseVersions>) : null))
		.catch(() => null)
		.then((data) => {
			if (!data) cached = null;
			return data;
		});
	return cached;
}

export function monthYear(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function ended(v: DatabaseVersion) {
	return v.supported === false || (!!v.eolDate && Date.parse(v.eolDate) < Date.now());
}

export function versionNote(v: DatabaseVersion, defaultMajor?: number): string | undefined {
	if (ended(v)) return v.eolDate ? `End of life since ${monthYear(v.eolDate)}` : 'Unsupported';
	const parts: string[] = [];
	if (v.major === defaultMajor) parts.push('Recommended');
	if (v.eolDate) parts.push(`Supported until ${monthYear(v.eolDate)}`);
	return parts.join(' · ') || undefined;
}

export function versionOptions(data: DatabaseVersions | null): DropdownOption[] {
	if (!data) return [];
	return [...data.versions]
		.sort((a, b) => b.major - a.major)
		.map((v) => ({
			value: String(v.major),
			label: `Postgres ${v.major}`,
			description: versionNote(v, data.defaultMajor)
		}));
}

export function severityOf(score: number | null | undefined): Severity {
	if (score == null) return 'unknown';
	if (score >= 9) return 'critical';
	if (score >= 7) return 'high';
	if (score >= 4) return 'medium';
	return 'low';
}

export function upgradeMajors(s: { upgrades: DatabaseVersion[] }): number[] {
	return s.upgrades.map((v) => v.major).sort((a, b) => a - b);
}

export function minorUpdateLine(m: MinorUpdate): string {
	if (m.blocked) return `${m.to} can't be applied in place`;
	return m.automatic ? `${m.to} is applied automatically` : `update to ${m.to} available`;
}

export function securityHeadline(s: DatabaseSecurity): string | null {
	if (s.action === 'none') return null;
	const count = s.vulnerabilities.length;
	const vulns = count ? `${count} known ${count === 1 ? 'vulnerability' : 'vulnerabilities'}` : '';
	if (s.supported === false)
		return `Postgres ${s.major} no longer gets security fixes${vulns ? ` · ${vulns}` : ''}`;
	if (s.action === 'minor_update' && s.minorUpdate)
		return `${vulns || 'Update available'} · ${minorUpdateLine(s.minorUpdate)}`;
	if (s.action === 'major_upgrade') {
		const newest = upgradeMajors(s).at(-1);
		return `${vulns ? `${vulns} · ` : ''}${newest ? `upgrade to Postgres ${newest} to fix` : 'move to a supported version'}`;
	}
	if (s.endOfLifeSoon) return `Postgres ${s.major} support ends ${monthYear(s.eolDate)}`;
	return vulns || null;
}
