import { get } from 'svelte/store';
import type { HostApi } from '@orchard/graft-sdk/client';

const KEY = 'greenhouse:access';
const REFRESH_MS = 5 * 60_000;

type Cached = { user: string; allowed: boolean };

let memory: Cached | null = null;
let probing: string | null = null;
let probedAt = 0;

function read(user: string): boolean | null {
  if (memory?.user === user) return memory.allowed;
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Cached) : null;
    if (saved?.user === user && typeof saved.allowed === 'boolean') {
      memory = saved;
      return saved.allowed;
    }
  } catch {
    return null;
  }
  return null;
}

function write(user: string, allowed: boolean, host?: HostApi) {
  const changed = memory?.user !== user || memory.allowed !== allowed;
  memory = { user, allowed };
  if (changed) host?.refreshSlots?.();
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    return;
  }
}

function probe(host: HostApi, user: string) {
  if (probing === user && Date.now() - probedAt < REFRESH_MS) return;
  probing = user;
  probedAt = Date.now();
  void host
    .fetch('/apiv1/sandboxes/credentials')
    .then((res) => {
      if (res.ok) write(user, true, host);
      else if (res.status === 401 || res.status === 403 || res.status === 404)
        write(user, false, host);
    })
    .catch(() => null);
}

export function greenhouseAllowed(host: HostApi): boolean {
  const user = get(host.stores.user);
  if (!user) return false;
  probe(host, user.id);
  return read(user.id) ?? false;
}

export function markGreenhouseAllowed(host: HostApi, allowed: boolean) {
  const user = get(host.stores.user);
  if (user) write(user.id, allowed, host);
}
