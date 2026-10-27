export const SEALED_PLACEHOLDER = '<sealed>';

const SECRET_KEY_RE =
	/(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|_KEY$|DATABASE_URL|DSN|CREDENTIALS?)/i;
const PUBLIC_BUNDLE_PREFIX_RE =
	/^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/i;

export function looksSecretKey(key: string): boolean {
	const trimmed = key.trim();
	if (!trimmed || PUBLIC_BUNDLE_PREFIX_RE.test(trimmed)) return false;
	return SECRET_KEY_RE.test(trimmed);
}

export interface EditableEnvVar {
	key: string;
	value: string;
	secret?: boolean;
	sealed?: boolean;
	secretTouched?: boolean;
}

export function parseEnvLines(raw: string): { key: string; value: string }[] {
	const parsed: { key: string; value: string }[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const equalIndex = trimmed.indexOf('=');
		if (equalIndex === -1) continue;
		const key = trimmed.substring(0, equalIndex).trim();
		const value = trimmed.substring(equalIndex + 1).trim();
		if (key) parsed.push({ key, value });
	}
	return parsed;
}

export function envVarsToSealedRaw(vars: EditableEnvVar[]): string {
	return vars
		.filter((e) => e.key.trim())
		.map((e) => `${e.key}=${e.secret ? SEALED_PLACEHOLDER : e.value}`)
		.join('\n');
}

export function mergeParsedEnv<T extends EditableEnvVar>(
	parsed: { key: string; value: string }[],
	previous: T[]
): EditableEnvVar[] {
	const before = new Map(previous.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e]));
	return parsed.map(({ key, value }) => {
		const old = before.get(key);
		if (old?.secret || old?.sealed) {
			return {
				...old,
				key,
				value: value === SEALED_PLACEHOLDER ? old.value : value,
				secret: true
			};
		}
		if (old) return { ...old, key, value };
		if (value === SEALED_PLACEHOLDER) return { key, value: '', secret: true };
		return looksSecretKey(key) ? { key, value, secret: true } : { key, value, secret: false };
	});
}

export function rawToEnvVarsKeepingSecrets<T extends EditableEnvVar>(
	raw: string,
	previous: T[]
): EditableEnvVar[] {
	return mergeParsedEnv(parseEnvLines(raw), previous);
}

export function autoSecretForKey<T extends EditableEnvVar>(row: T): T & { secret?: boolean } {
	if (row.sealed || row.secretTouched) return row;
	return { ...row, secret: looksSecretKey(row.key) };
}

export function toEnvWrite(
	rows: EditableEnvVar[]
): { key: string; value: string | null; secret: boolean }[] {
	return rows
		.filter((r) => r.key.trim())
		.map((r) => ({
			key: r.key.trim(),
			value: r.sealed && r.value === '' ? null : r.value,
			secret: Boolean(r.secret || r.sealed)
		}));
}
