export function parseCpu(value: string): number {
  if (!value) return 0;
  const v = value.trim();
  if (v.endsWith('m')) {
    const n = parseFloat(v.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

const MEM_UNITS: Record<string, number> = {
  '': 1,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6
};

export function parseMemory(value: string): number {
  if (!value) return 0;
  const v = value.trim();
  const m = v.match(/^([0-9.]+)([A-Za-z]*)$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = m[2] || '';
  const mult = MEM_UNITS[unit];
  if (!Number.isFinite(num) || !mult) return 0;
  return Math.round(num * mult);
}
