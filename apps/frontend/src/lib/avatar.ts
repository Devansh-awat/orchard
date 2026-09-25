import { blobatarUri } from 'blobatar/uri';

/**
 * Default profile pictures.
 *
 * Nobody's avatar is ever empty: a user with no uploaded image gets a blobatar
 * generated from their id, the same way a project with no icon falls back to
 * `projectSwatch(slug)`. Deterministic matters more than it sounds - a
 * genuinely random pick would reshuffle on every render and make the same
 * person look like a different person between two rows of a table.
 *
 * Generated in-process by `blobatar` rather than fetched from
 * `blobatar.dev/avatar/<name>`, so an avatar never depends on a third party
 * being up and no name ever leaves the browser. The result is a percent-encoded
 * `data:` URI of about a kilobyte, which keeps every caller's `<img src>`
 * working unchanged.
 */

/**
 * `circle` rather than the default transparent backdrop: a blobatar's body does
 * not fill its own viewBox, so without a backdrop the avatar frame shows
 * through around it and reads as a hole rather than a picture.
 */
const OPTIONS = { background: 'circle' } as const;

function seedOf(user: AvatarUser | null | undefined): string {
	return user?.id || user?.username || user?.email || 'orchard';
}

/** The blobatar assigned to `seed`, as a `data:` URI. */
export function defaultAvatar(seed: string | null | undefined): string {
	return blobatarUri(seed || 'orchard', OPTIONS);
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
 * their blobatar. Seeded by id so it survives a rename, falling back to
 * whatever stable handle is available when a caller only has a partial user.
 */
export function avatarUrl(user: AvatarUser | null | undefined): string {
	if (user?.imageUrl) return user.imageUrl;
	return defaultAvatar(seedOf(user));
}

/** Single-letter fallback for the rare case an avatar image itself fails to load. */
export function avatarInitial(user: AvatarUser | null | undefined): string {
	const source = user?.firstName || user?.name || user?.username || user?.email || '?';
	return source.charAt(0).toUpperCase();
}
