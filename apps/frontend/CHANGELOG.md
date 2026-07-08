# Changelog

## [0.13.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.13.0...frontend/v0.13.1) (2026-07-08)


### Bug Fixes

* surface real error when scaling fails ([bfb963b](https://github.com/LeafdTK/leaf/commit/bfb963bb820b12f5b1bc71a652a27b3e669a9560))

## [0.13.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.12.0...frontend/v0.13.0) (2026-07-08)


### Features

* org notification channels for deploy, crash, and backup events ([ff906f1](https://github.com/LeafdTK/leaf/commit/ff906f10e4cb3041dc97094082fe11b7f595e2cc))

## [0.12.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.11.2...frontend/v0.12.0) (2026-07-07)


### Features

* make warm cache a superadmin only setting ([6793747](https://github.com/LeafdTK/leaf/commit/6793747d4167d6c605267e4a4ea064acbc65f51f))

## [0.11.2](https://github.com/LeafdTK/leaf/compare/frontend/v0.11.1...frontend/v0.11.2) (2026-07-07)


### Bug Fixes

* stop overview cards replaying expand/stagger animations on refetch ([4e52809](https://github.com/LeafdTK/leaf/commit/4e5280910a08a5af582df7f143854860218ba6bf))

## [0.11.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.11.0...frontend/v0.11.1) (2026-07-06)


### Bug Fixes

* mcp docs used invalid type url in claude code config ([08b3730](https://github.com/LeafdTK/leaf/commit/08b37307dc3771309ab275c1a20459767344996e))

## [0.11.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.10.0...frontend/v0.11.0) (2026-07-06)


### Features

* simplify protected deployment auth page ([bd76a86](https://github.com/LeafdTK/leaf/commit/bd76a86968fb59eb7eb6c72f282a215d0ad7ab34))


### Bug Fixes

* let anonymous visitors reach the protection auth page ([bbc6b76](https://github.com/LeafdTK/leaf/commit/bbc6b76d080bc466c18f7f1370ae81349ac87276))

## [0.10.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.9.0...frontend/v0.10.0) (2026-07-06)


### Features

* push live deployment metrics over sse, relax frontend polling ([95c53fb](https://github.com/LeafdTK/leaf/commit/95c53fbd88f65e6342c966862ae5418c3528f596))
* redesign the whole frontend on shared primitives ([d6ca434](https://github.com/LeafdTK/leaf/commit/d6ca434e516350052a36348af8d421c607e476e4))
* shared ui primitives (button, menu, modal, tabs, field, alert & co) ([4a506fb](https://github.com/LeafdTK/leaf/commit/4a506fb0c893812ca64d915b891f6fca3c8d4d69))


### Bug Fixes

* redirect expired sessions to login instead of dead deep links ([0d6ea7c](https://github.com/LeafdTK/leaf/commit/0d6ea7c2eeff2aeca0f85440eee3d39d30f83a28))

## [0.9.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.8.0...frontend/v0.9.0) (2026-07-02)


### Features

* informer-driven pod events on redis streams, OOM surfacing, killed-container logs ([#79](https://github.com/LeafdTK/leaf/issues/79)) ([2ba9309](https://github.com/LeafdTK/leaf/commit/2ba930913a6b3d4eaa8fe879081c66c24b114f85))

## [0.8.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.7.1...frontend/v0.8.0) (2026-06-30)


### Features

* terminal-style colored logs with grouping, scroll pagination, server-side search, sentry-style errors ([9564844](https://github.com/LeafdTK/leaf/commit/95648442a08a5b209d0809e81d29bf0e33c0c81e))


### Bug Fixes

* **frontend:** rename deployment/build UI labels to apps/deployments ([c3c1be9](https://github.com/LeafdTK/leaf/commit/c3c1be94a6ccd56c80d1225f8b6b6d90fb4b4258))

## [0.7.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.7.0...frontend/v0.7.1) (2026-06-29)


### Bug Fixes

* restore observe logs + http metrics after haproxy ingress switch ([47eda41](https://github.com/LeafdTK/leaf/commit/47eda417516a0d448de07eaa5d28fec3c99e260f))

## [0.7.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.6.0...frontend/v0.7.0) (2026-06-29)


### Features

* reliable live updates (redis streams bus, k8s pod informer, crash-loop surfacing) ([#72](https://github.com/LeafdTK/leaf/issues/72)) ([a710ece](https://github.com/LeafdTK/leaf/commit/a710ece69334fcfdfeee4ea5208954307865aec1))


### Bug Fixes

* make build-status SSE updates live and prompt reload on disconnect ([6a229dc](https://github.com/LeafdTK/leaf/commit/6a229dcb9b238d58fa049cedbf1c27c14ab473e2))

## [0.6.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.5.0...frontend/v0.6.0) (2026-06-28)


### Features

* accurate build phases (scheduling builder) and skip pod-ready wait on deploy ([#69](https://github.com/LeafdTK/leaf/issues/69)) ([5eabbe9](https://github.com/LeafdTK/leaf/commit/5eabbe9d569439e54376a5b60bed43b1d4c6e147))

## [0.5.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.4.5...frontend/v0.5.0) (2026-06-28)


### Features

* surface registry push as its own build step with live pusher logs ([#67](https://github.com/LeafdTK/leaf/issues/67)) ([0015ef8](https://github.com/LeafdTK/leaf/commit/0015ef88537cb9fd7849d57387f3995f2e2ee19b))

## [0.4.5](https://github.com/LeafdTK/leaf/compare/frontend/v0.4.4...frontend/v0.4.5) (2026-06-25)


### Bug Fixes

* ignore tsbuildinfo and .DS_Store ([bde19ad](https://github.com/LeafdTK/leaf/commit/bde19ada980e03ffe0c81d6feb08d40d06caae2f))

## [0.4.4](https://github.com/LeafdTK/leaf/compare/frontend/v0.4.3...frontend/v0.4.4) (2026-06-23)


### Bug Fixes

* forward newlyCreatedToken through DeploysTab to webhook banner ([#59](https://github.com/LeafdTK/leaf/issues/59)) ([0851ac9](https://github.com/LeafdTK/leaf/commit/0851ac9d6e5026dac9392c3cdad12e68e9f527b6))

## [0.4.3](https://github.com/LeafdTK/leaf/compare/frontend/v0.4.2...frontend/v0.4.3) (2026-06-23)


### Bug Fixes

* show webhook token banner on create ([#57](https://github.com/LeafdTK/leaf/issues/57)) ([e0d33f4](https://github.com/LeafdTK/leaf/commit/e0d33f4b5790cc1f31960378a7982de395b1e349))

## [0.4.2](https://github.com/LeafdTK/leaf/compare/frontend/v0.4.1...frontend/v0.4.2) (2026-06-23)


### Bug Fixes

* align build steps with frontend, fix NaN total duration from __jobName ([0ad95f9](https://github.com/LeafdTK/leaf/commit/0ad95f9fee2398e42617a827144738b3610d3839))


### Performance Improvements

* SSE-first polling, emit build step events, skip cache export for sidecar push ([4779a49](https://github.com/LeafdTK/leaf/commit/4779a4907b8d17920e36b6785c8a8061d6173346))

## [0.4.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.4.0...frontend/v0.4.1) (2026-06-20)


### Bug Fixes

* protection proxy security + restyle to match platform ([#48](https://github.com/LeafdTK/leaf/issues/48)) ([018cf71](https://github.com/LeafdTK/leaf/commit/018cf71fa58195c2fb72e2ba4f0c3e645a2257be))

## [0.4.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.3.1...frontend/v0.4.0) (2026-06-20)


### Features

* add deployment protection (password + orchard sign-in) ([#40](https://github.com/LeafdTK/leaf/issues/40)) ([a44e598](https://github.com/LeafdTK/leaf/commit/a44e598182c7dd64307b6983007cb7a5a75af0ff))

## [0.3.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.3.0...frontend/v0.3.1) (2026-06-16)


### Bug Fixes

* observability dashboard uptime, HTTP stats, and multi-container logs ([#26](https://github.com/LeafdTK/leaf/issues/26)) ([1c7c18a](https://github.com/LeafdTK/leaf/commit/1c7c18afc9998ef4ea8ad0ddbecbdcac3d9b1948))

## [0.3.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.2.0...frontend/v0.3.0) (2026-06-16)


### Features

* observability dashboard with runtime detection and error tracking ([#24](https://github.com/LeafdTK/leaf/issues/24)) ([c3b2bca](https://github.com/LeafdTK/leaf/commit/c3b2bca293bda8b1b7ca63210baa915f6b2c85b0))

## [0.2.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.1.0...frontend/v0.2.0) (2026-06-16)


### Features

* show app version on user settings page ([#22](https://github.com/LeafdTK/leaf/issues/22)) ([26b0522](https://github.com/LeafdTK/leaf/commit/26b052287c7c3c4b0b7f32afa5b95c7d15c16dde))

## [0.1.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.0.1...frontend/v0.1.0) (2026-06-16)


### Features

* SCIM 2.0 user/group provisioning ([#14](https://github.com/LeafdTK/leaf/issues/14)) ([eb242ee](https://github.com/LeafdTK/leaf/commit/eb242ee3cd19bc4b068a045d4772a4bcc17eefc0))

## 0.0.2 (2026-06-16)

### Fixes

- allow dots in github repo names for deploy
