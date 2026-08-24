/**
 * Default profile pictures.
 *
 * Nobody's avatar is ever empty: a user with no uploaded image gets a mascot
 * picked deterministically from their id, the same way a project with no icon
 * falls back to `projectSwatch(slug)`. Deterministic matters more than it
 * sounds — a genuinely random pick would reshuffle on every render and make
 * the same person look like a different person between two rows of a table.
 *
 * Sourced from ipaslogo.com, downscaled to 256px webp (~5KB each) and served
 * from `static/avatars/` rather than hotlinked, so an avatar never depends on
 * a third party being up.
 */
const MASCOTS = [
	'arctic-fox',
	'axolotl',
	'bee',
	'cactus',
	'capybara',
	'corgi',
	'deer',
	'dolphin',
	'duckling',
	'fox',
	'frog',
	'hamster',
	'hedgehog',
	'hermit-crab',
	'jellyfish',
	'koala',
	'ladybug',
	'lemur',
	'meerkat',
	'mushroom',
	'narwhal',
	'octopus',
	'otter',
	'owl',
	'panda',
	'penguin',
	'quokka',
	'raccoon',
	'red-panda',
	'shiba-inu',
	'sloth',
	'snail',
	'squirrel',
	'toucan',
	'turtle',
	'whale'
] as const;

/** The mascot assigned to `seed`, as a path under `static/`. */
export function defaultAvatar(seed: string | null | undefined): string {
	const key = seed || 'orchard';
	let hash = 0;
	for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
	return `/avatars/${MASCOTS[hash % MASCOTS.length]}.webp`;
}

export interface AvatarUser {
	id?: string | null;
	imageUrl?: string | null;
	username?: string | null;
	email?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	name?: string | null;
}

/**
 * The image to render for a user: their upload if they have one, otherwise
 * their mascot. Seeded by id so it survives a rename, falling back to whatever
 * stable handle is available when a caller only has a partial user.
 */
export function avatarUrl(user: AvatarUser | null | undefined): string {
	if (user?.imageUrl) return user.imageUrl;
	return defaultAvatar(user?.id || user?.username || user?.email || null);
}

/** Single-letter fallback for the rare case an avatar image itself fails to load. */
export function avatarInitial(user: AvatarUser | null | undefined): string {
	const source =
		user?.firstName || user?.name || user?.username || user?.email || '?';
	return source.charAt(0).toUpperCase();
}
