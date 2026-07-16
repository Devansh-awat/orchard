# Changelog

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
