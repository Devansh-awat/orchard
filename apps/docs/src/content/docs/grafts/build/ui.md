---
title: Add UI
description: Add pages, navigation, tabs, and cards to Orchard's UI from a graft, using a Svelte island, slots, and the host object.
sidebar:
  order: 4
---

Add pages, navigation, tabs, and cards to Orchard's UI. A graft's UI is an island: a bundle with its own copy of Svelte. Orchard loads the bundle and gives it an empty element to draw in. A graft can use any library.

## Define what the graft adds

`ui/src/client.ts` default-exports what the graft adds:

```ts
import { mount, unmount } from 'svelte';
import { defineGraft } from '@orchardlabs/graft-sdk/client';
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

For each place a graft can add to, refer to the [slot reference](/reference/graft-slots/).

## Add a screen

List each screen in `graft.json` under `ui.screens`, with its path and layout:

| Layout       | Behavior                                  |
| ------------ | ----------------------------------------- |
| `shell`      | Draws inside Orchard's sidebar and header. |
| `fullscreen` | Takes the whole window.                   |

A screen at `/admin/<graft id>`, or below it, renders in the instance admin area, and only superadmins reach it. Pair it with an `admin.nav` entry. Orchard ignores a screen under `/admin/` that uses another path.

## Use the host object

Each mount function receives `host`, the graft's interface to Orchard's UI.

| Member | Description |
| --- | --- |
| `host.graft` | The graft's `id`, `version`, `apiBase`, and `assetBase`. |
| `host.api(path, init?)` | Returns JSON from the graft's API. Paths are relative to `/apiv1/<graft-id>`. `json` in `init` sends a body. |
| `host.fetch(path, init?)` | Returns the raw response. |
| `host.stores.user`, `.org`, `.theme`, `.route` | Svelte-compatible stores. Use `$user` in a component. |
| `host.navigate(href, options?)` | Navigates on the client. |
| `host.toast(message, tone?, options?)` | Shows one of Orchard's toasts. |
| `host.confirm({ title, body, confirmLabel, danger })` | Shows Orchard's confirmation dialog, and resolves to a boolean. |
| `host.onOrgEvent(handler)` | Receives live events for the current organization. |
| `host.refreshSlots()` | Evaluates the `visible` functions of the graft's slot items again. |

## Match Orchard's styles

`@orchardlabs/graft-ui` is Orchard's component kit, packaged for grafts. It includes components such as `Button`, `SectionCard`, `Field`, `Input`, `Select`, `Modal`, and `EmptyState`.

Orchard sets theme colors, fonts, and spacing as CSS variables on the page. You can use `var(--text-muted)` and `var(--bg-surface)` in a graft's own styles.

A graft bundles its copy of the kit. A graft built against an older Orchard keeps that version's components until you rebuild it. Colors and fonts follow the instance.

## Errors

Orchard wraps each mount. If a graft throws while mounting or updating, that element shows an error with a **Retry** button. The rest of the page keeps working.

## Related resources

- [Graft UI slots](/reference/graft-slots/): Review each slot and its props.
- [graft.json](/grafts/build/manifest/): Declare screens.
