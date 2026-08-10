// Kubernetes resource quantity helpers.
// Parses values like "500m", "2", "1.5" (cpu → millicores) and "64Mi", "1Gi", "500M" (memory → bytes).

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
  K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
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

export function formatCpuMilli(milli: number): string {
  if (milli >= 1000) return `${(milli / 1000).toFixed(2).replace(/\.?0+$/, '')} cores`;
  return `${milli}m`;
}

// K8s-compatible quantity strings for use inside pod specs.
export function cpuMilliToK8s(milli: number): string {
  return `${Math.max(1, Math.round(milli))}m`;
}

// The CPU a workload *reserves* on its node, derived from the CPU it's allowed
// to burst to. CPU is compressible — a container over its request is throttled,
// never killed — so reserving the full limit buys nothing at runtime and costs
// the scheduler the whole difference on every idle workload. Memory gets no
// equivalent: it's incompressible, and an over-committed node reclaims it by
// OOM-killing, so memory requests stay pinned to the limit.
export function cpuRequestFromLimitMilli(limitMilli: number): number {
  const ratio = Number(process.env.CPU_REQUEST_RATIO);
  const floor = Number(process.env.CPU_REQUEST_MIN_MILLI);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.1;
  const safeFloor = Number.isFinite(floor) && floor > 0 ? floor : 50;
  return Math.min(limitMilli, Math.max(safeFloor, Math.round(limitMilli * safeRatio)));
}

export function memoryBytesToK8s(bytes: number): string {
  // Prefer Mi if it divides cleanly, else raw bytes.
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}Mi`;
  return `${Math.max(1, Math.round(bytes))}`;
}

export function formatMemoryBytes(bytes: number): string {
  const units = [
    ['Ti', 1024 ** 4],
    ['Gi', 1024 ** 3],
    ['Mi', 1024 ** 2],
    ['Ki', 1024],
  ] as const;
  for (const [u, m] of units) {
    if (bytes >= (m as number)) return `${(bytes / (m as number)).toFixed(2).replace(/\.?0+$/, '')} ${u}`;
  }
  return `${bytes} B`;
}
