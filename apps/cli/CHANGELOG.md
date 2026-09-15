# Changelog

## [0.15.1](https://github.com/hackclub/orchard/compare/cli/v0.15.0...cli/v0.15.1) (2026-09-15)


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))

## [0.15.0](https://github.com/hackclub/orchard/compare/cli/v0.14.0...cli/v0.15.0) (2026-09-14)


### Features

* probe apps with the HEALTHCHECK their Dockerfile declares ([#44](https://github.com/hackclub/orchard/issues/44)) ([4afc98b](https://github.com/hackclub/orchard/commit/4afc98b71eaf5e83ed2d4135c29c54cb43b00fde))


### Bug Fixes

* **server:** make a deployment's secret env vars write-only and encrypted at rest ([d5f82d9](https://github.com/hackclub/orchard/commit/d5f82d99b07ddfabd8995fcf96c37ae8875c25fb))

## [0.14.0](https://github.com/hackclub/orchard/compare/cli/v0.13.1...cli/v0.14.0) (2026-09-04)


### Features

* warn when auto-deploy is enabled but not connected ([e4453d3](https://github.com/hackclub/orchard/commit/e4453d3f279dc5b29ca562ea0eeff5d95a91422a))

## [0.13.1](https://github.com/hackclub/orchard/compare/cli/v0.13.0...cli/v0.13.1) (2026-09-02)


### Bug Fixes

* pin the go toolchain floor so the stdlib patches land ([b1d2b0e](https://github.com/hackclub/orchard/commit/b1d2b0e8e125a959b9b21ca5a8d87cef989a539e))

## [0.13.0](https://github.com/hackclub/orchard/compare/cli/v0.12.0...cli/v0.13.0) (2026-09-01)


### Features

* watch paths for github auto-deploy ([06b1e44](https://github.com/hackclub/orchard/commit/06b1e4426655bb2c40ea32c7a2a6b33641f2b862))


### Bug Fixes

* match express 5 splat routes in the cli parity map ([024b94b](https://github.com/hackclub/orchard/commit/024b94b034f6994fd8f96f2c415c586f738e9581))

## [0.12.0](https://github.com/LeafdTK/leaf/compare/cli/v0.11.0...cli/v0.12.0) (2026-08-28)


### Features

* transfer project ownership by request and accept ([36bf9a7](https://github.com/LeafdTK/leaf/commit/36bf9a761fd7ae0e4df84e29fe6e11ac09a70e37))

## [0.11.0](https://github.com/LeafdTK/leaf/compare/cli/v0.10.0...cli/v0.11.0) (2026-08-27)


### Features

* database health is informer-driven with crash alerts and post-mortem logs ([06fc147](https://github.com/LeafdTK/leaf/commit/06fc147d20cf8a0a203ca3dbf11e8c665690bac7))
* next steps checklist on the app overview ([b6566b8](https://github.com/LeafdTK/leaf/commit/b6566b8addff2a5b66285216b59788be28bc54c0))
* per-app image pull policy so restart can re-pull a moving tag ([3253561](https://github.com/LeafdTK/leaf/commit/3253561ac68c450d345a38656f23ea4da55fd1e1))
* pull policy follows the image tag unless you pin it ([e5fb253](https://github.com/LeafdTK/leaf/commit/e5fb2532139cf419cf63075060b4872e768537c9))


### Bug Fixes

* format docs and close the cli route parity gaps ([b495832](https://github.com/LeafdTK/leaf/commit/b495832ae8fd57254fc9a0e732730199c5c01285))

## [0.10.0](https://github.com/LeafdTK/leaf/compare/cli/v0.9.0...cli/v0.10.0) (2026-08-25)


### Features

* dns-verified org domains, tenant-scoped sso sessions, sso off by default ([61eeaa7](https://github.com/LeafdTK/leaf/commit/61eeaa7716bad680433f7fdc93d1f7f87506b796))

## [0.9.0](https://github.com/LeafdTK/leaf/compare/cli/v0.8.0...cli/v0.9.0) (2026-08-24)


### Features

* multi-provider sso with org login pages and per-org admin controls ([00cc117](https://github.com/LeafdTK/leaf/commit/00cc1172b6cbf07c896f9dfe641b997f08686e07))

## [0.8.0](https://github.com/LeafdTK/leaf/compare/cli/v0.7.0...cli/v0.8.0) (2026-08-05)


### Features

* sandbox boot phases and terminal readiness gate ([9f95737](https://github.com/LeafdTK/leaf/commit/9f95737e55b3ef9a5e8629c75e8fe75c72291d14))


### Bug Fixes

* scope scim-managed profiles to the provisioning org ([5588231](https://github.com/LeafdTK/leaf/commit/55882318fc0b22931a0aa51d2fe16afa40b5bc35))

## [0.7.0](https://github.com/LeafdTK/leaf/compare/cli/v0.6.0...cli/v0.7.0) (2026-08-05)


### Features

* bootstrap sandboxes from stock debian with setup scripts ([05a266a](https://github.com/LeafdTK/leaf/commit/05a266a1bbfbb66bebfc6204e5088306112d898b))
* conductor style workspace and multi repo sandboxes ([96d1dd4](https://github.com/LeafdTK/leaf/commit/96d1dd49925225dc902afb0332cbdde973a6fbd5))
* full git operations for sandbox workspace ([c7f2b75](https://github.com/LeafdTK/leaf/commit/c7f2b754822fe2f46660823ae482a39c7c95d095))
* greenhouse ai sandboxes ([31e2325](https://github.com/LeafdTK/leaf/commit/31e23252b882f05daba9740df85bc621c8c93002))
* ide style cloud code workspace with live git changes ([0126efa](https://github.com/LeafdTK/leaf/commit/0126efa1eab06f9b5509912afc45725a6f68b967))
* opencode serve harness with proxy and native chat sessions ([e520d80](https://github.com/LeafdTK/leaf/commit/e520d80bf85c3c830b4b1653745f5d9f01334c6e))
* orchard mcp by default plus git and file endpoints ([9396499](https://github.com/LeafdTK/leaf/commit/93964994070821a51e61e6e7674b9ef87befbb71))
* sandbox cards, ssh identities, and cloud code chat ([e09fa8e](https://github.com/LeafdTK/leaf/commit/e09fa8ea3ae7d18ab405f53e0f1e80f38405901c))
* sandbox conversations with disk backed history and markdown transcript ([1032977](https://github.com/LeafdTK/leaf/commit/10329772860dbc5d9f5da9d7b11243bcb0c7a622))

## [0.6.0](https://github.com/LeafdTK/leaf/compare/cli/v0.5.0...cli/v0.6.0) (2026-07-28)


### Features

* **builder:** detect frameworks and expose build overrides on railpack builds ([d827c87](https://github.com/LeafdTK/leaf/commit/d827c87780f095f389b3d06759aa5a529074e228))

## [0.5.0](https://github.com/LeafdTK/leaf/compare/cli/v0.4.0...cli/v0.5.0) (2026-07-22)


### Features

* auto-generated protected url on deployment create ([ad7b7d2](https://github.com/LeafdTK/leaf/commit/ad7b7d2a5be0319cef570e6b8fb7ddd80aeaefd9))
* cli spinner, orchard open, deploy success block ([4d5bba4](https://github.com/LeafdTK/leaf/commit/4d5bba44c725b38f5c88cae843056b6de930c20d))
* live build log streaming over sse ([32e8b2f](https://github.com/LeafdTK/leaf/commit/32e8b2f4aadd4fbe66c61cbdea658ca4033a4cf5))
* one-shot github import endpoint and orchard import ([70398a2](https://github.com/LeafdTK/leaf/commit/70398a2efac3300e7400b951a7cca016ca351fc6))
* orchard env pull ([ce899ca](https://github.com/LeafdTK/leaf/commit/ce899ca6b79bb5df1eb0b51a8299ecd1d8430065))
* orchard link per-directory project context ([8f557b5](https://github.com/LeafdTK/leaf/commit/8f557b5ef493000bf00be770843ae1b231319df6))
* orchard up local directory deploys ([685b735](https://github.com/LeafdTK/leaf/commit/685b7350af9cff84abf50ac42e02339a3a3c558a))
* runtime log streaming over sse and event-driven metrics refresh ([81dc35f](https://github.com/LeafdTK/leaf/commit/81dc35fc16953aba8a58d3a60f6e70899d33806c))

## [0.4.0](https://github.com/LeafdTK/leaf/compare/cli/v0.3.2...cli/v0.4.0) (2026-07-21)


### Features

* allow overriding cli default api url via ldflags ([bbb6143](https://github.com/LeafdTK/leaf/commit/bbb6143cd3fec40c2a6310f293ddd01272c1f466))

## [0.3.2](https://github.com/LeafdTK/leaf/compare/cli/v0.3.1...cli/v0.3.2) (2026-07-16)


### Bug Fixes

* **cli:** brew cask links binary orchard, not the cask name ([f4551a5](https://github.com/LeafdTK/leaf/commit/f4551a5508b2b048bdae7d37b9b305d3e16ad9c9))

## [0.3.1](https://github.com/LeafdTK/leaf/compare/cli/v0.3.0...cli/v0.3.1) (2026-07-16)


### Bug Fixes

* **cli:** publish release binaries to public orchard-releases repo ([a44085c](https://github.com/LeafdTK/leaf/commit/a44085c8fb353500729dd9a350f2b89b0707ba42))
* **cli:** rename brew cask to orchard-cli, homebrew core owns orchard ([75e49ab](https://github.com/LeafdTK/leaf/commit/75e49ab0ce99a2ea8f88fd0bcfd7843bfed07c7e))

## [0.3.0](https://github.com/LeafdTK/leaf/compare/cli/v0.2.0...cli/v0.3.0) (2026-07-16)


### Features

* **cli:** database screen with backups, extensions, metrics and psql ([ffcf1d2](https://github.com/LeafdTK/leaf/commit/ffcf1d201ffb8f7676681ec7f6a14921f2dcc090))
* **cli:** deployment screen tabs for deploys, network, storage, resources, advanced ([9923a19](https://github.com/LeafdTK/leaf/commit/9923a195d063e990a9fa20643f7c1cdcd7451a9e))
* **cli:** jobs screens with cron and step editor ([eba1363](https://github.com/LeafdTK/leaf/commit/eba1363d0a5ff2fb8cb230f38923be9833055b90))
* **cli:** org switcher, ctrl+k search and org settings screens ([66467ca](https://github.com/LeafdTK/leaf/commit/66467cab9bc1dff3b2e1d18c3cf9ca40d411e620))
* **cli:** publish brew cask to homebrew-tap on release ([3785757](https://github.com/LeafdTK/leaf/commit/378575722d24b741c423e0f29a0c5d84a5cf074a))
* **cli:** sse live updates and confirm modal in tui ([9ef4809](https://github.com/LeafdTK/leaf/commit/9ef4809f8d30a85fab111b60e0992cea92bb23d7))

## [0.2.0](https://github.com/LeafdTK/leaf/compare/cli/v0.1.0...cli/v0.2.0) (2026-07-15)


### Features

* **cli:** M1 command parity for org, project, env, deploy, db, pod, service, domain ([fc520b6](https://github.com/LeafdTK/leaf/commit/fc520b62adebe5af0de2f3a70437cfc8ecb9165a))
* **cli:** M2 commands for jobs, templates, compose, github, tailscale, webhook ([e5f7591](https://github.com/LeafdTK/leaf/commit/e5f759189ed64e8dd2f6f1c4457bc1a6d1559bff))
* **cli:** M3 streaming (events tail, --follow, --watch) + M5 domains (observe, members, notify, audit, quota, tokens, user) ([82baa6e](https://github.com/LeafdTK/leaf/commit/82baa6ea93833ac3cef1a82590481320f5fc24ff))
* **cli:** M4 distribution (goreleaser, install.sh) + AI polish (AGENTS.md, skill, commands --json, parity gate) ([ec78ebd](https://github.com/LeafdTK/leaf/commit/ec78ebda857e2d6332c8a49b4524240cb5783dfc))
* **cli:** shared infra for parity push (ctx client, SSE, ws exec, scope context, exit codes, wait/pagination) ([2f6262e](https://github.com/LeafdTK/leaf/commit/2f6262eb0f10c04789ecba9c23c4264e75f5de30))

## 0.1.1 (2026-06-16)

### Fixes

- allow dots in github repo names for deploy
