import { mount, unmount, type Component } from 'svelte';
import { get } from 'svelte/store';
import type { HostApi, MountHandle } from '@orchardlabs/graft-sdk/client';
import { bindHost } from './host/context';
import { queryClient } from './host/query';
import { page } from './host/state.svelte';
import { organizations, selectedOrganization } from './host/stores';
import { sandboxesQueryOptions } from './lib/queries/sandboxes';
import Root from './screens/Root.svelte';

type AnyComponent = Component<Record<string, unknown>>;

let routeBound: HostApi | null = null;

export function attach(host: HostApi): void {
  bindHost(host);
  if (routeBound === host) return;
  routeBound = host;
  host.stores.route.subscribe((route) => page.sync(route));
}

export function warmSandboxes(): void {
  const org = get(selectedOrganization);
  void queryClient.prefetchQuery(sandboxesQueryOptions(org?.id));
  void organizations.load();
}

export function mountView(
  target: HTMLElement,
  component: unknown,
  initial: Record<string, unknown>
): MountHandle {
  const props = $state<Record<string, unknown>>({ ...initial });
  const app = mount(Root, {
    target,
    props: { component: component as AnyComponent, props }
  });
  return {
    update(next) {
      if (next && typeof next === 'object') Object.assign(props, next);
    },
    destroy() {
      void unmount(app);
    }
  };
}

type Persistent = {
  el: HTMLDivElement;
  app: Record<string, unknown>;
  owner: number;
  timer: ReturnType<typeof setTimeout> | null;
};

let shell: Persistent | null = null;
let owners = 0;

export function mountPersistent(target: HTMLElement, component: unknown): MountHandle {
  if (shell?.timer) {
    clearTimeout(shell.timer);
    shell.timer = null;
  }
  if (!shell) {
    const el = document.createElement('div');
    el.className = 'gh-island';
    const app = mount(Root, {
      target: el,
      props: { component: component as AnyComponent, props: {} }
    });
    shell = { el, app, owner: 0, timer: null };
  }
  const current = shell;
  const token = ++owners;
  current.owner = token;
  target.appendChild(current.el);
  return {
    destroy() {
      if (current.owner !== token) return;
      current.el.remove();
      current.timer = setTimeout(() => {
        if (current.owner !== token) return;
        if (shell === current) shell = null;
        void unmount(current.app);
      }, 0);
    }
  };
}
