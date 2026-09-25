export const RESOURCE_REF_RE =
	/\$\{\{\s*resource\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;

export type BindableResourceType = 'database' | 'deployment';

export interface Binding {
	id: string;
	name: string;
	resourceType: BindableResourceType;
	resourceId: string;
	resource: { name: string; status: string } | null;
	endpoint: string | null;
	fields: string[];
	usedBy: string[];
	createdAt: string;
}

export interface BindingOption {
	resourceType: BindableResourceType;
	resourceId: string;
	name: string;
	status: string;
	endpoint: string | null;
	suggestedName: string;
}

export const FIELD_LABELS: Record<string, string> = {
	connection_string: 'Connection string',
	url: 'URL',
	host: 'Host',
	port: 'Port',
	database: 'Database name',
	user: 'User',
	password: 'Password'
};

export const PRIMARY_FIELD: Record<BindableResourceType, string> = {
	database: 'connection_string',
	deployment: 'url'
};

export const KIND_LABELS: Record<BindableResourceType, string> = {
	database: 'Database',
	deployment: 'App'
};

export function isResourceRef(value: string): boolean {
	return RESOURCE_REF_RE.test(value);
}

export function refParts(value: string): { binding: string; field: string } | null {
	const m = RESOURCE_REF_RE.exec(value.trim());
	if (!m) return null;
	return { binding: m[1], field: m[2] };
}

export function refFor(binding: string, field: string): string {
	return `\${{resource.${binding}.${field}}}`;
}

export function fieldLabel(field: string): string {
	return FIELD_LABELS[field] ?? field;
}

export function refLabel(value: string, bindings: Binding[]): string | null {
	const parts = refParts(value);
	if (!parts) return null;
	const bound = bindings.find((b) => b.name === parts.binding);
	const field = fieldLabel(parts.field);
	return bound?.resource ? `${bound.resource.name} · ${field}` : `${parts.binding} · ${field}`;
}

function upper(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function suggestedKey(binding: Binding, field: string, taken: string[]): string {
	const suffix = field === 'connection_string' ? 'URL' : field.toUpperCase();
	const preferred =
		field === 'connection_string' && binding.resourceType === 'database' ? 'DATABASE_URL' : null;
	let key =
		preferred && !taken.includes(preferred) ? preferred : `${upper(binding.name)}_${suffix}`;
	let n = 2;
	while (taken.includes(key)) key = `${upper(binding.name)}_${suffix}_${n++}`;
	return key;
}

export function autoEnvKey(option: BindingOption, taken: string[]): string | null {
	const key =
		option.resourceType === 'database' ? 'DATABASE_URL' : `${upper(option.suggestedName)}_URL`;
	return taken.includes(key) ? null : key;
}
