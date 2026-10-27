export interface RollbackCandidate {
  id: string;
  image: string;
  isActive: boolean;
  createdAt: Date;
}

export function pickPreviousImage<T extends RollbackCandidate>(
  history: T[],
  currentImage: string | null | undefined
): T | null {
  const sorted = [...history].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const active = sorted.find((h) => h.isActive) ?? sorted.find((h) => h.image === currentImage);
  const baseline = active?.image ?? currentImage ?? null;
  const older = active ? sorted.filter((h) => h.createdAt < active.createdAt) : sorted;
  return older.find((h) => h.image !== baseline) ?? null;
}
