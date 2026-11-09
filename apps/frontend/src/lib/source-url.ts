import { safeHttpUrl } from './utils/html';

export const DEFAULT_SOURCE_URL = 'https://github.com/hackclub/orchard';

export function sourceUrl(configured: string | null | undefined): string {
	return safeHttpUrl(configured) ?? DEFAULT_SOURCE_URL;
}
