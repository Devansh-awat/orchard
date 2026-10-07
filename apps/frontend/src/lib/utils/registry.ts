export const REGISTRY_PRESETS = [
	{ value: 'ghcr.io', label: 'GitHub Packages (ghcr.io)' },
	{ value: 'docker.io', label: 'Docker Hub' },
	{ value: 'registry.gitlab.com', label: 'GitLab (registry.gitlab.com)' },
	{ value: 'quay.io', label: 'Quay (quay.io)' },
	{ value: 'custom', label: 'Another registry' }
];

export const REGISTRY_HINTS: Record<string, string> = {
	'ghcr.io':
		'Your GitHub username and a personal access token (classic) with the read:packages scope. Fine-grained tokens cannot read packages.',
	'docker.io': 'Your Docker Hub username and an access token from Account settings, Security.',
	'registry.gitlab.com':
		'A deploy token (username starts with gitlab+deploy-token) or a personal access token with the read_registry scope.',
	'quay.io': 'A robot account name and its token.',
	custom: 'Any registry that speaks the Docker v2 API with basic or bearer auth.'
};

export function registryHint(host: string): string {
	return REGISTRY_HINTS[host] ?? REGISTRY_HINTS.custom;
}

export function tokenLabel(host: string): string {
	return host === 'docker.io' ? 'Access token' : 'Token or password';
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

export function imageRegistryHost(image: string): string {
	const ref = (image ?? '').trim();
	if (!ref) return '';
	const first = ref.split('/')[0].toLowerCase();
	const hasRegistry = ref.includes('/') && (first.includes('.') || first.includes(':'));
	if (!hasRegistry) return 'docker.io';
	return DOCKER_HUB_ALIASES.has(first) ? 'docker.io' : first;
}
