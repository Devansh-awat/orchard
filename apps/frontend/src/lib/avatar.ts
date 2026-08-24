/**
 * Default profile pictures.
 *
 * Nobody's avatar is ever empty: a user with no uploaded image gets a mascot
 * picked deterministically from their id, the same way a project with no icon
 * falls back to `projectSwatch(slug)`. Deterministic matters more than it
 * sounds - a genuinely random pick would reshuffle on every render and make
 * the same person look like a different person between two rows of a table.
 *
 * Two independent axes keep collisions rare: which mascot, and a hue rotation
 * applied over it. They MUST come from different hashes - deriving both from
 * one would mean everyone holding the same mascot also held the same colour,
 * and the second axis would buy nothing.
 *
 * Sourced from ipaslogo.com, downscaled to 192px webp (~4KB each) and served
 * from `static/avatars/` rather than hotlinked, so an avatar never depends on
 * a third party being up.
 */
const MASCOTS = [
	'alpaca',
	'arctic-fox',
	'armadillo',
	'artichoke',
	'axolotl',
	'baby-dragon',
	'baby-griffin',
	'badger',
	'bamboo',
	'bat',
	'bear',
	'beaver',
	'bee',
	'bell-pepper',
	'bison',
	'boar',
	'bonsai',
	'boojum-tree',
	'bread-loaf',
	'bread-oven',
	'bubble-phoenix',
	'butterfly',
	'cactus',
	'cactus-bloom',
	'cactus-oracle',
	'camel',
	'capybara',
	'cat',
	'chameleon',
	'chicken',
	'cloud',
	'cloud-forge',
	'coconut',
	'coffee-bean',
	'coffee-grinder',
	'coffee-mug',
	'comet',
	'comet-unicorn',
	'corgi',
	'cow',
	'crocodile',
	'croissant',
	'crystal-mimic',
	'cupcake',
	'data-manta',
	'deer',
	'dog',
	'dolphin',
	'donkey',
	'donut',
	'dragon-fruit',
	'dragonfly',
	'dragonfruit',
	'duckling',
	'eagle',
	'elephant',
	'emperor-penguin',
	'fennec-fox',
	'firefly',
	'flamingo',
	'flying-squirrel',
	'fox',
	'friendly-yeti',
	'frog',
	'frog-sage',
	'ginkgo-leaf',
	'giraffe',
	'goat',
	'goose',
	'hammerhead-shark',
	'hamster',
	'hedgehog',
	'hermit-crab',
	'hippo',
	'hippopotamus',
	'horse',
	'ibex',
	'jellyfish',
	'kangaroo',
	'kiwi-bird',
	'koala',
	'koi',
	'ladybug',
	'leafy-seadragon',
	'lemur',
	'lion',
	'lion-cub',
	'lion-ochre',
	'lobster',
	'madeleine-cake',
	'manatee',
	'maned-wolf',
	'manta-navigator',
	'manta-ray',
	'meerkat',
	'mole',
	'mole-cricket',
	'monkey',
	'moon',
	'moon-gate',
	'moose',
	'mushroom',
	'mushroom-giant',
	'mushroom-knight',
	'mushroom-soup',
	'mushroom-sprite',
	'naan-bread',
	'narwhal',
	'nautilus',
	'octopus',
	'orca',
	'orchid-fairy',
	'otter',
	'owl',
	'owl-scout',
	'panda',
	'panda-curator',
	'pangolin',
	'parrot',
	'peanut',
	'pear',
	'pebble-gnome',
	'pelican',
	'pelican-collector',
	'penguin',
	'phoenix-egg',
	'phoenix-violin',
	'pig',
	'pinecone',
	'popcorn',
	'protea-flower',
	'pudding-dragonling',
	'puffin',
	'pumpkin',
	'quokka',
	'rabbit',
	'raccoon',
	'raccoon-apricot',
	'raccoon-picker',
	'rainbow',
	'rainbow-radar',
	'ram',
	'red-panda',
	'rhino',
	'rhinoceros',
	'rubber-duck',
	'rune-golem',
	'salamander',
	'scarab-beetle',
	'sea-otter',
	'sea-turtle',
	'seahorse',
	'seal',
	'sheep',
	'shetland-sheepdog',
	'shiba',
	'shiba-inu',
	'sloth',
	'snail',
	'snow-leopard',
	'snowflake',
	'spirit-level',
	'squid',
	'squirrel',
	'star',
	'star-creature',
	'strawberry',
	'sugar-glider',
	'sun',
	'sunflower',
	'sushi-roll',
	'swan',
	'taco',
	'tapir',
	'teacup-chimera',
	'teapot',
	'tiger',
	'tortoise',
	'toucan',
	'tulip',
	'turtle',
	'turtle-parchment',
	'walrus',
	'watermelon',
	'whale',
	'wolf-pup',
	'wombat',
	'yak',
	'yellow-chick',
	'yellow-duckling',
	'zebra',
] as const;

/** Rotations applied over the base art. Step 0 is the original colourway. */
const HUE_STEPS = 12;

function hash(seed: string, factor: number, init: number): number {
	let h = init;
	for (let i = 0; i < seed.length; i++) h = (h * factor + seed.charCodeAt(i)) >>> 0;
	return h;
}

function seedOf(user: AvatarUser | null | undefined): string {
	return user?.id || user?.username || user?.email || 'orchard';
}

/** The mascot assigned to `seed`, as a path under `static/`. */
export function defaultAvatar(seed: string | null | undefined): string {
	const key = seed || 'orchard';
	return `/avatars/${MASCOTS[hash(key, 31, 0) % MASCOTS.length]}.webp`;
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
	return defaultAvatar(seedOf(user));
}

/**
 * Hue rotation for a generated mascot, as a `filter` value. Empty for an
 * uploaded image (never recolour someone's own photo) and for step 0.
 *
 * The saturate bump is not decoration: the CSS hue-rotate matrix is an
 * approximation that desaturates at some angles, which left a few rotations
 * looking muddy next to the untouched art.
 */
export function avatarFilter(user: AvatarUser | null | undefined): string {
	if (user?.imageUrl) return '';
	const step = hash(seedOf(user), 131, 5381) % HUE_STEPS;
	if (step === 0) return '';
	return `hue-rotate(${step * (360 / HUE_STEPS)}deg) saturate(1.08)`;
}

/** Single-letter fallback for the rare case an avatar image itself fails to load. */
export function avatarInitial(user: AvatarUser | null | undefined): string {
	const source = user?.firstName || user?.name || user?.username || user?.email || '?';
	return source.charAt(0).toUpperCase();
}
