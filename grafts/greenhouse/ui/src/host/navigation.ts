import { get } from 'svelte/store';
import { useHost } from './context';

export interface GotoOptions {
  replaceState?: boolean;
  keepFocus?: boolean;
  noScroll?: boolean;
}

function restoreFocus(target: HTMLElement) {
  const host = useHost();
  const start = get(host.stores.route);
  const startKey = `${start.path}${start.search}`;
  let stop: (() => void) | null = null;
  const timer = setTimeout(() => stop?.(), 2000);
  stop = host.stores.route.subscribe((route) => {
    if (`${route.path}${route.search}` === startKey) return;
    clearTimeout(timer);
    queueMicrotask(() => stop?.());
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (target.isConnected && (!active || active === document.body)) {
        target.focus({ preventScroll: true });
      }
    });
  });
}

export function goto(href: string, options: GotoOptions = {}): Promise<void> {
  const active = document.activeElement;
  if (options.keepFocus && active instanceof HTMLElement && active !== document.body) {
    restoreFocus(active);
  }
  useHost().navigate(href, {
    replace: options.replaceState ?? false,
    keepFocus: options.keepFocus,
    noScroll: options.noScroll
  } as { replace?: boolean });
  return Promise.resolve();
}
