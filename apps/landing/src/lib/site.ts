export const SITE = 'https://orchard.hackclub.com';

export function absolute(path: string) {
	return new URL(path, SITE).href;
}
