# @orchardlabs/graft-sdk

Build, pack, and sign grafts. A graft is an extension for [Orchard](https://github.com/hackclub/orchard), a self-hosted PaaS on Kubernetes. A graft can add pages, API routes, database tables, MCP tools, and settings to an Orchard instance.

The package has three parts:

- The `graft` command, which scaffolds, builds, packs, and signs a graft.
- `@orchardlabs/graft-sdk/server`: route decorators and doors for the graft's NestJS module.
- `@orchardlabs/graft-sdk/client`: `defineGraft` and the types for the graft's Svelte UI.

## Install

To scaffold a new graft, run:

```sh
npx -p @orchardlabs/graft-sdk graft init snippets
cd snippets
pnpm install
```

To add the package to an existing graft, run:

```sh
pnpm add @orchardlabs/graft-sdk
```

The server entry needs `@nestjs/common` and `@nestjs/core` 11. The client entry needs `svelte` 5.

## Usage

`server/src/index.ts` default-exports a NestJS module. Orchard mounts its controllers under `/apiv1/<graft-id>/`. A graft reaches Orchard through doors, which you inject with `@Inject(Doors.<name>)`.

```ts
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { Auth, Doors, GraftUserId, type ContextDoor } from '@orchardlabs/graft-sdk/server';

@Controller('hello')
class HelloController {
  constructor(@Inject(Doors.context) private readonly graft: ContextDoor) {}

  @Get()
  @Auth()
  hello(@GraftUserId() userId: string) {
    return { graft: this.graft.id, version: this.graft.version, userId };
  }
}

@Module({ controllers: [HelloController] })
export default class GraftModule {}
```

A route with no decorator is open to superadmins only. `@Auth()` opens it to anyone signed in, and `@Public()` opens it to anyone.

`ui/src/client.ts` default-exports what the graft adds to Orchard's UI:

```ts
import { mount, unmount } from 'svelte';
import { defineGraft } from '@orchardlabs/graft-sdk/client';
import Home from './Home.svelte';

export default defineGraft({
  slots: {
    'nav.primary': [{ id: 'home', label: 'snippets', href: '/snippets' }]
  },
  screens: {
    home: (target, props, host) => {
      const app = mount(Home, { target, props: { host } });
      return () => unmount(app);
    }
  }
});
```

## The graft command

| Command                                            | Description                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `graft init <id> [dir]`                            | Scaffolds a new graft.                                                      |
| `graft dev [dir]`                                  | Rebuilds into `.graft-dev/` on each change, for a local Orchard.            |
| `graft build [dir]`                                | Builds the server, MCP tools, and UI into `dist/`.                          |
| `graft doctor [dir]`                               | Checks `graft.json` and the migrations for common mistakes.                 |
| `graft keygen [file]`                              | Creates an ed25519 signing key, and prints its public key.                  |
| `graft pack [dir] [--key <pem>] [--output <file>]` | Builds, hashes, and signs the graft into `<id>-<version>.graft`.            |
| `graft tap init` and `graft tap add`               | Starts a tap, a catalog of grafts you host yourself, and adds grafts to it. |
| `graft bump <values.yaml...>`                      | Moves pinned grafts in Helm values to newer marketplace versions.           |

Run `graft help` for every flag.

Grafts run with the same access as Orchard. Only ship what you would install yourself.

## Documentation

- [Get started](https://docs.orchard.hackclub.com/grafts/build/quickstart/)
- [graft.json](https://docs.orchard.hackclub.com/grafts/build/manifest/)
- [Write server code](https://docs.orchard.hackclub.com/grafts/build/server/)
- [Add UI](https://docs.orchard.hackclub.com/grafts/build/ui/)
- [Use the database](https://docs.orchard.hackclub.com/grafts/build/database/)
- [Publish a graft](https://docs.orchard.hackclub.com/grafts/build/publishing/)

## License

`@orchardlabs/graft-sdk` is MIT licensed, so a graft that only imports it can use any license. `@orchardlabs/graft-ui` is licensed under AGPL-3.0-only. A graft that imports `@orchardlabs/graft-ui` must be released under a license compatible with AGPL-3.0-only, and the AGPL's source-sharing terms apply to it. To use another license, build the graft's UI with `@orchardlabs/graft-sdk` and your own components.

`graft init` adds `@orchardlabs/graft-ui` to a new graft, and its starter screen imports it. Remove both to use another license.
