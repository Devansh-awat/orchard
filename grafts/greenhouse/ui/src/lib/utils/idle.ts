export function whenIdle(run: () => void, timeout = 3000): () => void {
  if (typeof window === 'undefined') return () => {};
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(() => run(), { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(run, Math.min(timeout, 1500));
  return () => clearTimeout(timer);
}
