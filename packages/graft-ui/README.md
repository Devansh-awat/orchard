# @orchardlabs/graft-ui

Orchard's UI components and design tokens, packaged for graft screens. A graft is an extension for [Orchard](https://github.com/hackclub/orchard), a self-hosted PaaS on Kubernetes. Use this package to make a graft's UI match the rest of Orchard.

The package has Svelte 5 components such as `Button`, `SectionCard`, `Field`, `Input`, `Select`, `Modal`, `Alert`, and `EmptyState`.

## Install

```sh
pnpm add @orchardlabs/graft-ui
```

The package needs `svelte` 5. To define the graft's UI and call its API, you also need [`@orchardlabs/graft-sdk`](https://www.npmjs.com/package/@orchardlabs/graft-sdk).

## Usage

Import components from the package root:

```svelte
<script lang="ts">
  import type { HostApi } from '@orchardlabs/graft-sdk/client';
  import { Button, SectionCard } from '@orchardlabs/graft-ui';

  let { host }: { host: HostApi } = $props();
  const user = host.stores.user;
  let reply = $state<string | null>(null);

  async function ping() {
    const res = await host.api<{ graft: string; version: string }>('/hello');
    reply = `${res.graft} ${res.version} says hi`;
  }
</script>

<SectionCard title="Hello from a graft">
  <p>Signed in as {$user?.name}.</p>
  <Button variant="primary" onclick={ping}>Ping the server</Button>
  {#if reply}<p>{reply}</p>{/if}
</SectionCard>
```

You can also import a single component by its path, such as `@orchardlabs/graft-ui/components/ui/StatusDot.svelte`.

Orchard sets theme colors, fonts, and spacing as CSS variables on the page, so the components follow the instance's theme. You can use the same variables, such as `var(--text-muted)` and `var(--bg-surface)`, in your own styles.

A graft bundles its copy of the kit. A graft built against an older version keeps that version's components until you rebuild it.

## Documentation

- [Add UI](https://docs.orchard.hackclub.com/grafts/build/ui/)
- [Get started](https://docs.orchard.hackclub.com/grafts/build/quickstart/)

## License

`@orchardlabs/graft-ui` is licensed under AGPL-3.0-only. A graft that imports `@orchardlabs/graft-ui` must be released under a license compatible with AGPL-3.0-only, and the AGPL's source-sharing terms apply to it. To use another license, build the graft's UI with `@orchardlabs/graft-sdk` and your own components. `@orchardlabs/graft-sdk` is MIT licensed, so a graft that only imports it can use any license.

## Development

In the Orchard repository, `src/` is copied from `apps/frontend/src/lib` and is not checked in. To refresh it, run:

```sh
pnpm --filter @orchardlabs/graft-ui sync
```

The copy also runs on `prepare` and `prepack`.
