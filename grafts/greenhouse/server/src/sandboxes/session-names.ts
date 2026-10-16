export const SESSION_TOWNS = [
  'Burlington',
  'Montpelier',
  'Rutland',
  'Barre',
  'Brattleboro',
  'Bennington',
  'St. Albans',
  'Middlebury',
  'Stowe',
  'Woodstock',
  'Manchester',
  'Winooski',
  'Essex',
  'Shelburne',
  'Williston',
  'Colchester',
  'Vergennes',
  'Newport',
  'St. Johnsbury',
  'Springfield',
  'Bellows Falls',
  'Windsor',
  'Randolph',
  'Northfield',
  'Waterbury',
  'Morrisville',
  'Hardwick',
  'Lyndonville',
  'Derby',
  'Swanton',
  'Enosburg Falls',
  'Richford',
  'Milton',
  'Jericho',
  'Underhill',
  'Richmond',
  'Hinesburg',
  'Bristol',
  'Brandon',
  'Castleton',
  'Fair Haven',
  'Poultney',
  'Wallingford',
  'Ludlow',
  'Chester',
  'Grafton',
  'Weston',
  'Dorset',
  'Arlington',
  'Wilmington',
  'Dover',
  'Putney',
  'Guilford',
  'Norwich',
  'Quechee',
  'Bethel',
  'Chelsea',
  'Bradford',
  'Craftsbury',
  'Greensboro',
  'Jay',
  'Montgomery',
  'Warren',
  'Waitsfield',
  'Moretown',
  'Plainfield',
  'Marshfield',
  'Cabot',
  'Peacham',
  'Danville',
  'Barnet',
  'Island Pond',
  'Canaan',
  'Lunenburg',
  'Guildhall',
  'Grand Isle',
  'North Hero',
  'Alburgh',
  'Isle La Motte',
  'Fairfax',
  'Georgia',
  'Westford',
  'Bolton',
  'Huntington',
  'Starksboro',
  'Lincoln',
  'Ripton',
  'Goshen',
  'Killington',
  'Plymouth',
  'Tunbridge'
] as const;

export function pickSessionName(
  taken: Iterable<string>,
  random: () => number = Math.random
): string {
  const used = new Set([...taken].map((t) => t.trim().toLowerCase()));
  const free = SESSION_TOWNS.filter((city) => !used.has(city.toLowerCase()));
  if (free.length > 0) return free[Math.floor(random() * free.length) % free.length];
  const city = SESSION_TOWNS[Math.floor(random() * SESSION_TOWNS.length) % SESSION_TOWNS.length];
  for (let n = 2; ; n++) {
    const name = `${city} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

const GENERATED = new Set(SESSION_TOWNS.map((c) => c.toLowerCase()));

export function isGeneratedSessionName(title: string): boolean {
  const name = title.trim().replace(/ \d+$/, '').toLowerCase();
  return GENERATED.has(name);
}

const TITLE_MAX = 60;

export function promptTitle(text: string): string | null {
  const lines = text
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/, '')
        .replace(/[*_`~]+/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const first = lines[0];
  if (!first || first.length < 3) return null;
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  let title = sentence.replace(/[.!?:;,]+$/, '');
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX - 1);
    const space = cut.lastIndexOf(' ');
    title = `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}…`;
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function isAgentDefaultTitle(title: string): boolean {
  return /^(new|child) (session|chat)\b/i.test(title.trim());
}

export function isAgentTitle(title: unknown): title is string {
  return (
    typeof title === 'string' &&
    title.trim().length >= 3 &&
    !isAgentDefaultTitle(title) &&
    !isGeneratedSessionName(title)
  );
}

export function chatTitleFor(sessionTitle: string): { title: string } | Record<string, never> {
  return isGeneratedSessionName(sessionTitle) ? {} : { title: sessionTitle };
}
