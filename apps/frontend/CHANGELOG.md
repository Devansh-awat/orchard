# Changelog

## [0.16.2](https://github.com/LeafdTK/leaf/compare/frontend/v0.16.1...frontend/v0.16.2) (2026-07-16)


### Bug Fixes

* username validation names the offending characters, strips invisible chars, backend enforces format ([4672510](https://github.com/LeafdTK/leaf/commit/46725103073c652bfeed0af0324b3da09e3522a4))

## [0.16.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.16.0...frontend/v0.16.1) (2026-07-15)


### Bug Fixes

* **frontend:** accept ?tab=advanced deep link alias ([985b76f](https://github.com/LeafdTK/leaf/commit/985b76f2b7b786959414b061a1a569e8054905c8))
* **frontend:** compact rows get per-project new button, card menu speaks hub vocabulary (github repo, docker image, database, templates) ([76c8d4c](https://github.com/LeafdTK/leaf/commit/76c8d4c69474c9ee4a244a478c670410e0af8b0f))
* **frontend:** defuse destructive-action styling, tooltips on icon-only actions, prod env badge no longer red ([7de037a](https://github.com/LeafdTK/leaf/commit/7de037a45d36303d61efc34bb897743bfbe5e3bb))
* **frontend:** deployment tabs deadlocked under rapid switching, url is now single source of truth via controlled melt value ([c8e58c7](https://github.com/LeafdTK/leaf/commit/c8e58c7deaa5365a34c2dd7a5075d252eb0e268e))
* **frontend:** env var row actions visible at rest, secret toggle on status tokens ([b473a48](https://github.com/LeafdTK/leaf/commit/b473a485c31246639199a72eba1c32d367d8da82))
* **frontend:** repo picker surfaces github errors, offers explicit use-typed-repo row, autofocuses search, autofills app name ([77bfb62](https://github.com/LeafdTK/leaf/commit/77bfb620efc09ee134514aec2209cdd0aff090bc))
* **frontend:** route github-link param cleanup through the router instead of raw history.replaceState ([3607ccd](https://github.com/LeafdTK/leaf/commit/3607ccd1c632f52b2b652b0f5b7fcd11927d0a02))
* **frontend:** template deploy suggests free subdomain, drops double project label and alarm top bar ([ad5a3b5](https://github.com/LeafdTK/leaf/commit/ad5a3b53b1c6dd35141dfb819d389c164c371e18))

## [0.16.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.15.0...frontend/v0.16.0) (2026-07-15)


### Features

* encrypt shared-var secrets at rest, size limits, write-only UI ([d812836](https://github.com/LeafdTK/leaf/commit/d812836479bca60b9637769043963ec6d265cd23))
* **frontend:** contrast, text size, and reduce transparency accessibility settings ([f0b17a4](https://github.com/LeafdTK/leaf/commit/f0b17a458d3d5a50dbfe4f82295d233ea8faba5c))
* **frontend:** dashboard density modes (compact/normal/expanded), animation level + accessibility settings, retire /projects page ([ec61d4b](https://github.com/LeafdTK/leaf/commit/ec61d4bb82df4669817ee6468811309ccb22b42b))
* **frontend:** deployment tab URL sync (?tab=), drop dead tab descriptions ([6d16c78](https://github.com/LeafdTK/leaf/commit/6d16c78ad2a73739905c308b1f23d86b7e0f33ba))
* **frontend:** high contrast mode outlines cards, rows, and controls ([97f810c](https://github.com/LeafdTK/leaf/commit/97f810c770fcb0a92c58ac7622b95feb6f632913))
* **frontend:** merge Metrics into Observe as default sub-view, ?view= deep links, clickable overview stat cards ([d1742ae](https://github.com/LeafdTK/leaf/commit/d1742ae96466cfc43aff8603404e64ae8e8f6bd7))
* **frontend:** pod detail rebuilt on PageHeader + LogViewer, de-orphaned via pod row links ([b313712](https://github.com/LeafdTK/leaf/commit/b31371223b43570dab6ed53e056976e11fde117a))
* **frontend:** semantic token layer + unified status module (StatusDot/StatusBadge) ([f7b1621](https://github.com/LeafdTK/leaf/commit/f7b162113ffc471cd11dbfad14bd0268dc95eeca))
* **frontend:** status-led build progress page with ambient mesh gradient, surface buildError ([90b6ab1](https://github.com/LeafdTK/leaf/commit/90b6ab10e5c66534da86f5f3d72be279e6201c34))
* **frontend:** ui/LogViewer + PodLogSource, overview console sheds 15 props from orchestrator ([fbefbd0](https://github.com/LeafdTK/leaf/commit/fbefbd04a7e6f8c9fe514b54fca1b13307f49d20))
* **frontend:** ui/Table primitive, /projects becomes management table with gradient identity swatches ([3b0225a](https://github.com/LeafdTK/leaf/commit/3b0225af29872ce6bda5c6b4af448b43d92836b5))
* project environments — namespace-isolated envs with shared + secret variables ([cfab235](https://github.com/LeafdTK/leaf/commit/cfab2358dbc6baebf5cfebc2f1c58b8538c79c8a))


### Bug Fixes

* **frontend:** animation setting now gates css keyframes + local motion copies (menus, quick search, hero, alerts, sidebar), compact rows get favicons, density switch collapses cards ([73a5413](https://github.com/LeafdTK/leaf/commit/73a54138a61c864d1a619a884ee6e8ee5ebdc2aa))
* **frontend:** deep-link tab boot crash (flag store TDZ), untracked tab/url sync effects, layout init never strands the boot spinner ([b895423](https://github.com/LeafdTK/leaf/commit/b89542379846e53e159d1f912c39e4d1f0d2ea61))
* **frontend:** gate remaining animations behind the setting (header collapse, project tabs, gated svelte transition wrappers, skeleton/orb/job pulse keyframes) ([b2f3487](https://github.com/LeafdTK/leaf/commit/b2f3487a5e81ae404c09c20f46f684805f7b6d4c))
* **frontend:** two density modes only, gate accordion body springs behind animation setting ([14aac86](https://github.com/LeafdTK/leaf/commit/14aac8663b93dfa09977b3c1ea5052e86ae28463))
* **server:** scrub ingress/db credential leaks, keep untouched secrets on shared-vars PUT, pod logs since params, per-PAT throttle, mcp validate_dns projectId ([eb7a3af](https://github.com/LeafdTK/leaf/commit/eb7a3af7bbd6aab3ddad6a1659b0ab719285ef36))

## [0.15.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.14.0...frontend/v0.15.0) (2026-07-09)


### Features

* orchard jobs — scheduled multi-step pipelines on kubernetes ([#93](https://github.com/LeafdTK/leaf/issues/93)) ([721f190](https://github.com/LeafdTK/leaf/commit/721f190dfada0e2777e47c9b0f3d04bd1ba87535))

## [0.14.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.13.1...frontend/v0.14.0) (2026-07-09)


### Features

* redesign notification channels UI with type tiles and event chips ([6995b2c](https://github.com/LeafdTK/leaf/commit/6995b2cd1d0cb5975d8203d2f9a251e4713ff5f9))

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
