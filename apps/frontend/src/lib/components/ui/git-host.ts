export type GitHost = 'github' | 'gitlab' | 'codeberg' | 'gitea' | 'bitbucket' | 'generic';

export function gitHostOf(provider: string, host?: string | null): GitHost {
	if (host && /(^|\.)codeberg\.org$/.test(host)) return 'codeberg';
	if (['github', 'gitlab', 'gitea', 'bitbucket'].includes(provider)) return provider as GitHost;
	return 'generic';
}
