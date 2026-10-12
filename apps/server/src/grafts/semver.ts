type Version = [number, number, number];

function parse(input: string): Version | null {
  const match = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/.exec(input.trim());
  if (!match) return null;
  const part = (s: string | undefined) =>
    s === undefined || s === 'x' || s === '*' ? 0 : Number(s);
  return [part(match[1]), part(match[2]), part(match[3])];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function precision(input: string): number {
  const parts = input.replace(/^v/, '').split(/[-+]/)[0].split('.');
  return parts.filter((p) => p !== 'x' && p !== '*').length;
}

type Comparator = (v: Version) => boolean;

function caret(base: Version): Comparator {
  const upper: Version =
    base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
  return (v) => compare(v, base) >= 0 && compare(v, upper) < 0;
}

function tilde(base: Version, digits: number): Comparator {
  const upper: Version = digits <= 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
  return (v) => compare(v, base) >= 0 && compare(v, upper) < 0;
}

function comparator(token: string): Comparator {
  const op = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
  const base = parse(op[2]);
  if (!base) throw new Error(`invalid version range token "${token}"`);
  switch (op[1]) {
    case '>=':
      return (v) => compare(v, base) >= 0;
    case '<=':
      return (v) => compare(v, base) <= 0;
    case '>':
      return (v) => compare(v, base) > 0;
    case '<':
      return (v) => compare(v, base) < 0;
    case '^':
      return caret(base);
    case '~':
      return tilde(base, precision(op[2]));
    default: {
      const digits = precision(op[2]);
      if (digits >= 3) return (v) => compare(v, base) === 0;
      return tilde(base, digits === 0 ? 0 : digits === 1 ? 1 : 2);
    }
  }
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;
  return trimmed.split('||').some((alternative) => {
    const tokens = alternative
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    return tokens.map(comparator).every((check) => check(v));
  });
}

export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

export function compareVersions(a: string, b: string): number {
  return compare(parse(a) ?? [0, 0, 0], parse(b) ?? [0, 0, 0]);
}
