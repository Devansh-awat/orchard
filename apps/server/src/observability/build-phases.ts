export interface BuildPhase {
  id: string;
  label: string;
  ms: number;
}

const ORDER: { id: string; label: string; from: string; to: string }[] = [
  { id: 'queue', label: 'Queue', from: '__start', to: 'submitted' },
  { id: 'schedule', label: 'Builder', from: 'submitted', to: 'scheduled' },
  { id: 'start', label: 'Start', from: 'scheduled', to: 'cloning' },
  { id: 'clone', label: 'Clone', from: 'cloning', to: 'building' },
  { id: 'build', label: 'Build', from: 'building', to: 'pushing' },
  { id: 'push', label: 'Push', from: 'pushing', to: 'deploying' },
  { id: 'rollout', label: 'Apply', from: 'deploying', to: 'complete' }
];

export function buildPhases(stamps: unknown): BuildPhase[] {
  if (!stamps || typeof stamps !== 'object') return [];
  const t = stamps as Record<string, unknown>;
  const at = (k: string) => (typeof t[k] === 'number' ? (t[k] as number) : null);
  const out: BuildPhase[] = [];
  ORDER.forEach((p, i) => {
    const from = at(p.from);
    if (from === null) return;
    const to =
      at(p.to) ??
      ORDER.slice(i + 1)
        .map((q) => at(q.to))
        .find((v): v is number => v !== null) ??
      null;
    if (to === null) return;
    out.push({ id: p.id, label: p.label, ms: Math.max(0, to - from) });
  });
  return out;
}
