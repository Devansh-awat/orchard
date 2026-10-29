const HOUR_MS = 60 * 60 * 1000;

export const FORECAST_MIN_POD_AGE_MS = 6 * HOUR_MS;
export const FORECAST_MIN_POINTS = 12;
export const FORECAST_MIN_R2 = 0.8;
export const FORECAST_HORIZON_MS = 24 * HOUR_MS;

export interface ForecastPoint {
  t: number;
  v: number;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

export interface MemoryForecastInput {
  points: ForecastPoint[];
  limitBytes: number;
  podStartedAt: number;
  now: number;
}

export interface MemoryForecast {
  hitsLimitAt: number;
  slopeBytesPerHour: number;
  confidence: number;
}

export function linearFit(points: ForecastPoint[]): LinearFit {
  const usable = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  const n = usable.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  let sumT = 0;
  let sumV = 0;
  for (const p of usable) {
    sumT += p.t;
    sumV += p.v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of usable) {
    const dt = p.t - meanT;
    const dv = p.v - meanV;
    sxx += dt * dt;
    sxy += dt * dv;
    syy += dv * dv;
  }
  if (sxx === 0) return { slope: 0, intercept: meanV, r2: 0 };
  const slope = sxy / sxx;
  const intercept = meanV - slope * meanT;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

export function projection(
  points: ForecastPoint[],
  fit: LinearFit,
  until: number
): ForecastPoint[] {
  if (points.length === 0) return [];
  const lastT = points.reduce((max, p) => (p.t > max ? p.t : max), -Infinity);
  const at = (t: number) => fit.slope * t + fit.intercept;
  return [
    { t: lastT, v: at(lastT) },
    { t: until, v: at(until) }
  ];
}

export function forecastMemoryLimit(input: MemoryForecastInput): MemoryForecast | null {
  const { limitBytes, podStartedAt, now } = input;
  if (!(limitBytes > 0)) return null;
  if (now - podStartedAt < FORECAST_MIN_POD_AGE_MS) return null;
  const points = input.points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t <= now)
    .sort((a, b) => a.t - b.t);
  if (points.length < FORECAST_MIN_POINTS) return null;
  if (points[points.length - 1].v >= limitBytes) return null;
  const fit = linearFit(points);
  if (fit.slope <= 0 || fit.r2 < FORECAST_MIN_R2) return null;
  const hitsLimitAt = Math.round((limitBytes - fit.intercept) / fit.slope);
  if (hitsLimitAt <= now || hitsLimitAt > now + FORECAST_HORIZON_MS) return null;
  return {
    hitsLimitAt,
    slopeBytesPerHour: fit.slope * HOUR_MS,
    confidence: fit.r2
  };
}
