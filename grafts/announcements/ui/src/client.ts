import { mount, unmount } from 'svelte';
import { defineGraft, type HostApi, type Mount } from '@orchardlabs/graft-sdk/client';
import Banner from './Banner.svelte';
import Manage from './Manage.svelte';

const MEGAPHONE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';

const banner: Mount<unknown> = (target, _props, host: HostApi) => {
  const app = mount(Banner, { target, props: { host } });
  return () => unmount(app);
};

export default defineGraft({
  slots: {
    'admin.nav': [
      { id: 'manage', label: 'Announcements', href: '/announcements', icon: MEGAPHONE }
    ],
    'project.overview.cards': [{ id: 'banner', order: 0, mount: banner }],
    'deployment.overview.cards': [{ id: 'banner', order: 0, mount: banner }]
  },
  screens: {
    manage: (target, _props, host) => {
      const app = mount(Manage, { target, props: { host, user: host.stores.user } });
      return () => unmount(app);
    }
  }
});
