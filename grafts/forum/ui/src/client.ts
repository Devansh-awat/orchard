import { mount, unmount } from 'svelte';
import { defineGraft } from '@orchardlabs/graft-sdk/client';
import Board from './Board.svelte';
import Thread from './Thread.svelte';

const TREES =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"/><path d="M7 16v6"/><path d="M13 19v3"/><path d="M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"/></svg>';

export default defineGraft({
  slots: {
    'nav.primary': [{ id: 'grove', label: 'The Grove', href: '/grove', icon: TREES }]
  },
  screens: {
    board: (target, _props, host) => {
      const app = mount(Board, { target, props: { host } });
      return () => unmount(app);
    },
    thread: (target, props, host) => {
      const app = mount(Thread, { target, props: { host, threadId: props.params.id ?? '' } });
      return () => unmount(app);
    }
  }
});
