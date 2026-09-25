import { blobatarUri } from 'blobatar/uri';
import { happy, sleepy, thinking, wink } from 'blobatar/expression';

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
export const AVATAR_OPTIONS = { background: 'circle' } as const;

/**
 * The stable handle a blobatar is drawn from. Id first so it survives a rename,
 * falling back to whatever is available when a caller only has a partial user.
 */
export function avatarSeed(user: AvatarUser | null | undefined): string {
	return user?.id || user?.username || user?.email || 'orchard';
}

/** The blobatar assigned to `seed`, as a `data:` URI. */
export function defaultAvatar(seed: string | null | undefined): string {
	return blobatarUri(seed || 'orchard', AVATAR_OPTIONS);
}

/**
 * Poses a blobatar can hold.
 *
 * A pose is a state, not an event: nothing returns to idle on its own, so every
 * mood below is bound to something already true in the UI rather than fired and
 * forgotten. `idle` is deliberately absent as a value - omitting the expression
 * renders byte-identical markup and skips the pose machinery entirely, so the
 * default costs nothing.
 *
 * Four of the library's fourteen poses tint the palette, and none of them are
 * here. That is also what keeps the OKLab colour path out of the bundle: the
 * first tinted pose pulls in about 720 bytes the four below never touch.
 */
export const MOODS = { happy, thinking, sleepy, wink };

export type Mood = keyof typeof MOODS | 'idle';

export function moodPose(mood: Mood | null | undefined) {
	return mood && mood !== 'idle' ? MOODS[mood] : undefined;
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
	return defaultAvatar(avatarSeed(user));
}

/** Single-letter fallback for the rare case an avatar image itself fails to load. */
export function avatarInitial(user: AvatarUser | null | undefined): string {
	const source = user?.firstName || user?.name || user?.username || user?.email || '?';
	return source.charAt(0).toUpperCase();
}
