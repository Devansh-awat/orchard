import { defineGraft, type Mount, type MountHandle } from '@orchard/graft-sdk/client';
import { greenhouseAllowed } from './host/access';
import { bindHost } from './host/context';
import { rememberUrlSecret, type UrlSecretKind } from './lib/utils/url-secrets';

const SPROUT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/></svg>';

type Runtime = typeof import('./mount.svelte');
type Loaded = { default: unknown };

const runtime = (): Promise<Runtime> => import('./mount.svelte');

function lazy<P>(
  load: () => Promise<Loaded>,
  start: (rt: Runtime, target: HTMLElement, props: P, component: unknown) => MountHandle
): Mount<P> {
  return (target, props, host) => {
    bindHost(host);
    let handle: MountHandle | null = null;
    let cancelled = false;
    let latest = props;
    void Promise.all([runtime(), load()]).then(([rt, mod]) => {
      if (cancelled) return;
      rt.attach(host);
      handle = start(rt, target, latest, mod.default);
    });
    return {
      update(next) {
        latest = next as P;
        handle?.update?.(next);
      },
      destroy() {
        cancelled = true;
        handle?.destroy();
        handle = null;
      }
    };
  };
}

function view<P>(load: () => Promise<Loaded>): Mount<P> {
  return lazy<P>(load, (rt, target, _props, component) => rt.mountView(target, component, {}));
}

const sandboxScreen = lazy(
  () => import('./screens/Sandboxes.svelte'),
  (rt, target, _props, component) => {
    rt.warmSandboxes();
    return rt.mountPersistent(target, component);
  }
);

function tokenScreen(
  kind: UrlSecretKind,
  base: string,
  load: () => Promise<Loaded>
): Mount<{ params: Record<string, string>; search: string }> {
  const inner = view(load);
  return (target, props, host) => {
    bindHost(host);
    const token = props.params['*']?.trim();
    if (token) {
      rememberUrlSecret(kind, token);
      host.navigate(`${base}${props.search ?? ''}`, { replace: true });
      return;
    }
    return inner(target, props, host);
  };
}

const allowed = (host: Parameters<typeof greenhouseAllowed>[0]) => {
  bindHost(host);
  return greenhouseAllowed(host);
};

export default defineGraft({
  slots: {
    'nav.primary': [
      {
        id: 'sandboxes',
        label: 'Greenhouse',
        href: '/sandboxes',
        icon: SPROUT,
        order: 40,
        visible: allowed
      }
    ],
    'admin.nav': [{ id: 'admin', label: 'Greenhouse', href: '/admin/greenhouse', icon: SPROUT }],
    'user.settings.tabs': [
      {
        id: 'sandbox',
        label: 'Greenhouse',
        mount: view(() => import('./screens/UserSettingsTab.svelte'))
      }
    ],
    'org.usage.tabs': [
      {
        id: 'sandbox',
        label: 'Sandboxes',
        visible: allowed,
        mount: view(() => import('./components/sandbox/SandboxUsageTab.svelte'))
      }
    ]
  },
  screens: {
    sandboxes: sandboxScreen,
    sandbox: sandboxScreen,
    share: view(() => import('./screens/Share.svelte')),
    'share-token': tokenScreen(
      'share:sandbox',
      '/share/sandbox',
      () => import('./screens/Share.svelte')
    ),
    'slack-link': view(() => import('./screens/SlackLink.svelte')),
    'slack-link-token': tokenScreen(
      'link:slack',
      '/integrations/slack/link',
      () => import('./screens/SlackLink.svelte')
    ),
    admin: view(() => import('./screens/Admin.svelte')),
    tour: view(() => import('./screens/Tour.svelte'))
  }
});
