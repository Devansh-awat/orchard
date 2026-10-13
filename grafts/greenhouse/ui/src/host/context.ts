import { writable, type Readable } from 'svelte/store';
import type { HostApi } from '@orchard/graft-sdk/client';

let current: HostApi | null = null;
const bound = writable<HostApi | null>(null);

export function bindHost(host: HostApi): void {
  if (current === host) return;
  current = host;
  bound.set(host);
}

export function useHost(): HostApi {
  if (!current) throw new Error('greenhouse: the host api is not bound yet');
  return current;
}

export function relay<T>(pick: (host: HostApi) => Readable<T>, fallback: T): Readable<T> {
  return {
    subscribe(run) {
      let inner: (() => void) | null = null;
      const outer = bound.subscribe((host) => {
        inner?.();
        inner = null;
        if (host) inner = pick(host).subscribe(run);
        else run(fallback);
      });
      return () => {
        outer();
        inner?.();
      };
    }
  };
}
