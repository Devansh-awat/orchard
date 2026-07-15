# Changelog

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
