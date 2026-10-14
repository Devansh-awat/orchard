function parse(input) {
  const match = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/.exec(String(input).trim());
  if (!match) return null;
  const part = (s) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
  return [part(match[1]), part(match[2]), part(match[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function precision(input) {
  const parts = input.replace(/^v/, '').split(/[-+]/)[0].split('.');
  return parts.filter((p) => p !== 'x' && p !== '*').length;
}

function caret(base) {
  const upper =
    base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
  return (v) => compare(v, base) >= 0 && compare(v, upper) < 0;
}

function tilde(base, digits) {
  const upper = digits <= 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
  return (v) => compare(v, base) >= 0 && compare(v, upper) < 0;
}

function comparator(token) {
  const op = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
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

export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  const trimmed = String(range).trim();
  if (trimmed === '' || trimmed === '*') return true;
  return trimmed.split('||').some((alternative) =>
    alternative
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean)
      .map(comparator)
      .every((check) => check(v))
  );
}

export function compareVersions(a, b) {
  return compare(parse(a) ?? [0, 0, 0], parse(b) ?? [0, 0, 0]);
}
