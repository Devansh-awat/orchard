const ROW_MAY_BE_PENDING_MS = 2 * 60 * 1000;

export function rowMayBePending(createdAt: Date | string | undefined, now = Date.now()): boolean {
  if (!createdAt) return false;
  const at = new Date(createdAt).getTime();
  return !Number.isNaN(at) && now - at < ROW_MAY_BE_PENDING_MS;
}
