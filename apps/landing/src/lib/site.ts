export const SITE = 'https://orchard.my';

export function absolute(path: string) {
	return new URL(path, SITE).href;
}
