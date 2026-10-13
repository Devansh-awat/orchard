import { derived, writable, type Readable } from 'svelte/store';
import type { ApiInit, HostOrg, HostUser } from '@orchard/graft-sdk/client';
import { relay, useHost } from './context';

export type IslandUser = HostUser;

export interface IslandOrganization {
  id: string;
  slug: string;
  name: string;
  myRole?: 'owner' | 'admin' | 'member' | 'guest' | null;
}

export const user: Readable<HostUser | null> = relay((host) => host.stores.user, null);

export const isSuperAdmin: Readable<boolean> = derived(
  user,
  ($user) => $user?.isSuperAdmin === true
);

export const selectedOrganization: Readable<HostOrg | null> = relay(
  (host) => host.stores.org,
  null
);

const orgList = writable<IslandOrganization[]>([]);
let orgsLoading: Promise<IslandOrganization[]> | null = null;

function loadOrganizations(force = false): Promise<IslandOrganization[]> {
  if (orgsLoading && !force) return orgsLoading;
  orgsLoading = useHost()
    .fetch('/apiv1/organizations/user')
    .then(async (res) => {
      if (!res.ok) return [];
      const list = (await res.json()) as IslandOrganization[];
      const orgs = Array.isArray(list) ? list : [];
      orgList.set(orgs);
      return orgs;
    })
    .catch(() => {
      orgsLoading = null;
      return [];
    });
  return orgsLoading;
}

export const organizations = {
  subscribe(run: (value: IslandOrganization[]) => void) {
    void loadOrganizations();
    return orgList.subscribe(run);
  },
  load: loadOrganizations
};

export interface ToastInput {
  title: string;
  description?: string;
  color: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  action?: { label: string; onClick: () => void };
}

function toastText(toast: ToastInput): string {
  if (!toast.description) return toast.title;
  const title = toast.title.trimEnd();
  return /[.!?:]$/.test(title) ? `${title} ${toast.description}` : `${title}. ${toast.description}`;
}

export const toasts = {
  add(toast: ToastInput): string {
    useHost().toast(toastText(toast), toast.color === 'warning' ? 'info' : toast.color);
    return Math.random().toString(36).slice(2, 9);
  }
};

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return useHost().fetch(path, init as ApiInit);
}
