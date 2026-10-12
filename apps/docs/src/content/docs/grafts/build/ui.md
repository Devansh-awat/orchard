---
title: UI islands and slots
description: Add pages, navigation, tabs and cards to Orchard's UI.
sidebar:
  order: 4
---

A graft's UI is an island: a bundle with its own copy of Svelte that Orchard
loads and hands an empty element to draw in. Orchard can upgrade its own UI
without ever breaking a graft, and a graft can use any library it likes.

`ui/src/client.ts` default-exports what the graft adds:

```ts
import { mount, unmount } from 'svelte';
import { defineGraft } from '@orchard/graft-sdk/client';
import Notes from './Notes.svelte';
import NotesCard from './NotesCard.svelte';

export default defineGraft({
  slots: {
    'nav.primary': [{ id: 'notes', label: 'Notes', href: '/notes' }],
    'project.overview.cards': [
      {
        id: 'recent',
        mount: (target, props, host) => {
          const app = mount(NotesCard, { target, props: { ...props, host } });
          return () => unmount(app);
        }
      }
    ]
  },
  screens: {
    home: (target, props, host) => {
      const app = mount(Notes, { target, props: { host } });
      return () => unmount(app);
    }
  }
});
```

Screens are listed in `graft.json` under `ui.screens` with their path and
layout: `shell` draws inside Orchard's sidebar and header, `fullscreen` takes
the whole window. Every place a graft can add to is in the
[slot reference](/reference/graft-slots/).

## The host object

Every mount function gets `host`, the graft's way to talk to Orchard's UI:

| Member | Gives you |
| --- | --- |
| `host.api(path, init?)` | JSON from the graft's API. Paths are relative to `/apiv1/<graft-id>`; `json` in `init` sends a body |
| `host.fetch(path, init?)` | The raw response |
| `host.stores.user`, `.org`, `.theme`, `.route` | Svelte-compatible stores: use `$user` in a component |
| `host.navigate(href)` | Client-side navigation |
| `host.toast(message, tone?)` | Orchard's toasts |
| `host.confirm({ title, body, confirmLabel, danger })` | Orchard's confirmation dialog, resolves to a boolean |
| `host.onOrgEvent(handler)` | Live events for the current organization, including the graft's own |

## Looking like Orchard

`@orchard/graft-ui` is Orchard's own component kit (`Button`, `Alert`,
`SectionCard`, `Field`, `Input`, `Modal`, `Table`, `ConfirmModal` and the rest)
packaged for grafts. Theme colours, fonts and spacing are CSS variables Orchard
sets on the page, so `var(--text-muted)`, `var(--bg-surface)` and friends work
in a graft's own styles too.

Because a graft bundles its copy of the kit, a graft built against an older
Orchard keeps that version's component shapes until it is rebuilt. Colours and
fonts always follow the instance.

## When something throws

Each mount is wrapped by Orchard. If a graft throws while mounting or updating,
only that box shows an error with a retry button; the page around it keeps
working.
