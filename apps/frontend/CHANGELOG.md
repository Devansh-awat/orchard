# Changelog

## [0.29.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.28.0...frontend/v0.29.0) (2026-07-22)


### Features

* alert on failing wal archiving and missing backup schedules ([d9a2c3b](https://github.com/LeafdTK/leaf/commit/d9a2c3bdb824a5d82355319d84b89299899269ef))

## [0.28.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.27.0...frontend/v0.28.0) (2026-07-22)


### Features

* colors 1 darker ([d3bd882](https://github.com/LeafdTK/leaf/commit/d3bd882f58800e2b08a8089076e9fb0711e8a998))

## [0.27.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.26.0...frontend/v0.27.0) (2026-07-22)


### Features

* better contrast color scheme ([c0dfad1](https://github.com/LeafdTK/leaf/commit/c0dfad167a578c977e995fe7154f742b401e97f8))

## [0.26.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.25.1...frontend/v0.26.0) (2026-07-22)


### Features

* collapsible sidebar with spring width and label transitions ([192123d](https://github.com/LeafdTK/leaf/commit/192123d017abe2f84a89cfb37724cb41063bfe2d))
* landing style login page with smart passkey flow ([baffce5](https://github.com/LeafdTK/leaf/commit/baffce52db8900a5d38a1c40d010a82f2c67255f))


### Bug Fixes

* sidebar animations honor animation accessibility levels ([3678c72](https://github.com/LeafdTK/leaf/commit/3678c72da585db848842910d9e3cd0e76fb77b70))
* stable strip and section head layout during sidebar collapse ([1b662e7](https://github.com/LeafdTK/leaf/commit/1b662e7e9ae00aad98915568e2be080967a91e47))

## [0.25.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.25.0...frontend/v0.25.1) (2026-07-22)


### Bug Fixes

* hide hero bleed when mesh gradient is active ([5f6d18a](https://github.com/LeafdTK/leaf/commit/5f6d18a264b32d090ccf32f201b42c76fcee2205))
* project gradient bg continues under the sidebar ([61f42ed](https://github.com/LeafdTK/leaf/commit/61f42ed607611a9ebcc8929c3a01a7797785e2bb))

## [0.25.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.24.0...frontend/v0.25.0) (2026-07-21)


### Features

* **frontend:** prompt parked tabs to reload when a new version ships ([23d91ce](https://github.com/LeafdTK/leaf/commit/23d91ce07eebbbd33e328959b9203cda5776bfbd))

## [0.24.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.23.0...frontend/v0.24.0) (2026-07-21)


### Features

* database page adaptive polling fallback for sse ([dda9ba0](https://github.com/LeafdTK/leaf/commit/dda9ba0b5db1d8ddb6bc9ad61152264e85831f5a))
* database page engine hero and fused tab connection card ([69a39bf](https://github.com/LeafdTK/leaf/commit/69a39bfef035864cebe9c76778c66153031a39e3))
* database page underline tabs, divider stats and shared card primitives ([cd500e5](https://github.com/LeafdTK/leaf/commit/cd500e5144141a1e22c6d7a5ab6ccdadc9afe2bd))
* per query statistics tab from pg_stat_statements ([7654b99](https://github.com/LeafdTK/leaf/commit/7654b9977a4962b80d262cad754f8714e624211f))
* postgres version choice and database stop start restart ([8e8660a](https://github.com/LeafdTK/leaf/commit/8e8660a2a5366015c53ec47b248afb8ddc158d02))


### Bug Fixes

* confirm modal import on database page ([04f79dc](https://github.com/LeafdTK/leaf/commit/04f79dc34558e839244c9ff2cd3b9404b9fb9141))
* database page renders instantly, live stats load separately ([d7c90a7](https://github.com/LeafdTK/leaf/commit/d7c90a78d90115d5a8c15edca37b4e87d5ce4cdf))
* full page navigation after deploys so stale tabs keep working ([3de4f0d](https://github.com/LeafdTK/leaf/commit/3de4f0d59c78013d9e27ee42fa016a3adb6d0481))
* stale build reload guard only runs in production ([f26dc8c](https://github.com/LeafdTK/leaf/commit/f26dc8ccae4851be26612feee4b199e837d09f85))

## [0.23.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.22.1...frontend/v0.23.0) (2026-07-21)


### Features

* add signup_mode flag and de-hardcode asset, posthog and email hosts ([2b2bfb5](https://github.com/LeafdTK/leaf/commit/2b2bfb54bfeecedd47dc8b7e100e4a24b649cadc))
* generic oidc login provider and externalauthid rename ([d241af9](https://github.com/LeafdTK/leaf/commit/d241af93e8c50a06e7a08f31c5aa949ec9f10351))
* real env examples, dev compose stack, contributor docs and clerk cleanup ([e5b849b](https://github.com/LeafdTK/leaf/commit/e5b849b6fe08c181078af2209af0bde28524fd7f))
* self-hosting docs, k3d quickstart and chart tenant knobs ([9989f77](https://github.com/LeafdTK/leaf/commit/9989f772e518df2d468b1cc819810fd15c2a50da))

## [0.22.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.22.0...frontend/v0.22.1) (2026-07-20)


### Bug Fixes

* empty projects show on the apps page ([b070d6f](https://github.com/LeafdTK/leaf/commit/b070d6fb837795b22596ffa6d83af2b3b421872b))

## [0.22.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.21.1...frontend/v0.22.0) (2026-07-20)


### Features

* command deck sidebar with customizable nav ([3a426bf](https://github.com/LeafdTK/leaf/commit/3a426bf79e695a83a5e164b2c7ec5ea61c82c153))
* observe tab redesign, traces marked coming soon ([725a33c](https://github.com/LeafdTK/leaf/commit/725a33c870b9f436f2d4cc10cc8b97f47c233236))
* org settings shell with hero, grouped rail and overview grid ([b86ffe8](https://github.com/LeafdTK/leaf/commit/b86ffe8c119a47b88ab4c9df2325595ac13b1343))
* redesign user settings with identity hero and section rail ([25464b0](https://github.com/LeafdTK/leaf/commit/25464b0ca634aded2caf0428596a165fe755c22c))


### Bug Fixes

* deck panel uses raised surface tone ([edab8da](https://github.com/LeafdTK/leaf/commit/edab8da2e36b8d28dadf888eda01bc21a2be270b))
* deck sidebar panel tint on app bg, drop customize mode ([2f028c0](https://github.com/LeafdTK/leaf/commit/2f028c09a9bd3f0da43e2904baabb531821ca460))

## [0.21.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.21.0...frontend/v0.21.1) (2026-07-18)


### Bug Fixes

* hide org settings entry from non-admins ([c8c0250](https://github.com/LeafdTK/leaf/commit/c8c0250f2da931308425e6033975a841aabf497f))

## [0.21.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.20.0...frontend/v0.21.0) (2026-07-18)


### Features

* rename apps via display name, k8s name stays frozen ([898fd5e](https://github.com/LeafdTK/leaf/commit/898fd5e2746646eb2c744629db38987df6ac47ed))
* rename databases, compose stacks, template instances, environments and api tokens ([625ee58](https://github.com/LeafdTK/leaf/commit/625ee58d7657538e2127cd6a399221ab13c7a33b))


### Bug Fixes

* cmd+k search falls back to selected org outside org routes ([afa45e9](https://github.com/LeafdTK/leaf/commit/afa45e9ec8aec6f53cb6dbe06a30ac10d878927d))

## [0.20.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.19.1...frontend/v0.20.0) (2026-07-18)


### Features

* change github repo, branch and dockerfile of an app after creation ([c5b99da](https://github.com/LeafdTK/leaf/commit/c5b99da385ebe9d1f2951ddb71bd2322808be905))


### Bug Fixes

* friendly message when github is already linked elsewhere, and github-auth build failures now prompt to check repo access or reconnect (owner) ([f8e8402](https://github.com/LeafdTK/leaf/commit/f8e840288d264c6696d17b6050d50d63cf8584e3))

## [0.19.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.19.0...frontend/v0.19.1) (2026-07-18)


### Bug Fixes

* build queue widget froze the page, refetchinterval read reactive runs that its own effect wrote, breaking via q.state.data ([7658eae](https://github.com/LeafdTK/leaf/commit/7658eae44b5d07b1eaa782b9b110fce85462169b))

## [0.19.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.18.0...frontend/v0.19.0) (2026-07-18)


### Features

* auto-deploy queues the latest commit when a build is in progress instead of dropping it ([68f49a9](https://github.com/LeafdTK/leaf/commit/68f49a951e2fe6df47be4c332bb40a44e5c4dcb2))
* build queue rides the redis-streams sse bus with adaptive polling like the rest ([1a6c76b](https://github.com/LeafdTK/leaf/commit/1a6c76b161d293209d709d522294bfe99965f138))
* build queue view in Deploys tab with live run states, buildRunStatus badges, read API ([e102780](https://github.com/LeafdTK/leaf/commit/e1027802011392494f65913609794eb5d2e02f20))
* **frontend:** build widget is now draggable and collapsible with persisted position and state ([8c84c86](https://github.com/LeafdTK/leaf/commit/8c84c86b92f8649554ea498d826007c33cd68fb7))
* **frontend:** build widget snaps to the nearest corner on release with a spring glide ([9586cdb](https://github.com/LeafdTK/leaf/commit/9586cdb43d46c99b14303b31175f670a9a99110f))
* **frontend:** buildqueue=demo url param renders mock queue rows client-side ([5fddb96](https://github.com/LeafdTK/leaf/commit/5fddb96643a42cc860d12fc20b04a7360943aed9))
* **frontend:** deployment queue moves into the floating build widget, deploys tab is just deployments ([e7ff111](https://github.com/LeafdTK/leaf/commit/e7ff111eb673c02bc8dceb9e6d999cc200e1ea47))
* **frontend:** queue merges into the build widget as an up-next section, one card ([d6b5ddb](https://github.com/LeafdTK/leaf/commit/d6b5ddbb31b1428931aa0fdb4e4d430106f48481))
* **frontend:** quiet sidebar redesign, flat surfaces, section labels, guideline-clean active states ([20a2ba0](https://github.com/LeafdTK/leaf/commit/20a2ba0165f52f921aa25c719045da3e953fe68b))
* **frontend:** sidebar surfaces failing and pinned deployments with live status ([5b766ed](https://github.com/LeafdTK/leaf/commit/5b766edb22ab470e34c7793d11199e6b60425a3b))
* **frontend:** sidebar warmth, crimson wash actives and tinted org panel ([376e263](https://github.com/LeafdTK/leaf/commit/376e263d0e805fd07a88330c5fc55b11ce9fbc7a))


### Bug Fixes

* **frontend:** always mount build queue widget so demo mode shows without deployment id gate ([7d4043b](https://github.com/LeafdTK/leaf/commit/7d4043bf92a2b705c055714ca2aeb4f4da37f7bb))
* **frontend:** build queue TDZ crash, runs is now state read by refetchInterval ([5952643](https://github.com/LeafdTK/leaf/commit/5952643a59882e107b1da6c95723bbdff5daaa53))
* **frontend:** build widget anchors by its snapped corner so resize stays flush, queued commits link to github ([b2c3c1a](https://github.com/LeafdTK/leaf/commit/b2c3c1a6cb4a29a04c33d182709ba1896dc82c5c))
* **frontend:** near-critically damp springCollapse close so it doesnt overshoot the wrong way ([87a4dfd](https://github.com/LeafdTK/leaf/commit/87a4dfd91b0d09ea89915d7b6b30cc2817fa9d8b))
* **frontend:** realistic 40-char demo commit shas so github links are valid, gitignore local notes ([01c1a60](https://github.com/LeafdTK/leaf/commit/01c1a601330cc7a4237e82570d44cc34e7a49647))
* **frontend:** scope build widget progress bar transition to width so collapse doesnt stutter ([280a74d](https://github.com/LeafdTK/leaf/commit/280a74d74f3b7f54df39c5d08f167d3c4de7dbc6))

## [0.18.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.17.0...frontend/v0.18.0) (2026-07-17)


### Features

* **frontend:** grove composer redesign with type cards and scope chips, pill filter dropdowns ([8a72be6](https://github.com/LeafdTK/leaf/commit/8a72be67aeec156055a609dd37278ef334330ef1))
* grove becomes an issue tracker with numbers, priorities, triage statuses, image attachments and chat style replies ([1142e46](https://github.com/LeafdTK/leaf/commit/1142e461fe79f1b6231e3d071a66d910f563b758))
* grove delete for own posts and replies, superadmins delete anything ([2718719](https://github.com/LeafdTK/leaf/commit/271871957ee2739db164a1ac9ba63c5ec70e99f9))
* grove gated behind GROVE_ENABLED / PUBLIC_GROVE_ENABLED env flags ([a3f9f34](https://github.com/LeafdTK/leaf/commit/a3f9f34ac9966de7df769a74dbe8e90d06aa882f))
* grove scopes replace emoji categories, bugs and feature requests only ([6901477](https://github.com/LeafdTK/leaf/commit/6901477454598e9a6ab3c5ae0a34f358ecda5ecf))
* the grove, a community forum for bugs, ideas and showcase with votes, statuses and orchard pixel sprites ([178fb96](https://github.com/LeafdTK/leaf/commit/178fb96aff66a0159ff4719e8df42fd9126e3734))


### Bug Fixes

* drop dashboard scope, main platform covers it ([3ae9e45](https://github.com/LeafdTK/leaf/commit/3ae9e4574154b463998c701ef75fd67ad1e717b3))
* **frontend:** grove filter dropdowns actually render as pills ([0e71d3e](https://github.com/LeafdTK/leaf/commit/0e71d3efa676a968c7287854d8f305212f72696a))
* **frontend:** grove filters and admin controls on ui dropdown ([8ffe062](https://github.com/LeafdTK/leaf/commit/8ffe062006a1d1fe35b184f7124478fddb3ce679))
* volume attach failures now validated with real error messages, sizes and names normalized ([ba7fd9d](https://github.com/LeafdTK/leaf/commit/ba7fd9d0b88cf01cb278568364a71b6e4ab96fc9))

## [0.17.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.16.3...frontend/v0.17.0) (2026-07-16)


### Features

* **frontend:** collapsible project groups in compact dashboard view ([675e252](https://github.com/LeafdTK/leaf/commit/675e25294c60b4873b3bbb0ed585a77cbd8439f4))
* **frontend:** favicon clusters on compact group headers ([3362e7c](https://github.com/LeafdTK/leaf/commit/3362e7c169a3c32bdfd1fc57af5eba6b66f59d22))
* **frontend:** gradient swatch fallback for icon-less projects on cards ([15c0c84](https://github.com/LeafdTK/leaf/commit/15c0c84f7db0975c0a5ec7ec8eadaa7327649358))
* **frontend:** orchard palette pixel sprites with finer grid ([cd4033d](https://github.com/LeafdTK/leaf/commit/cd4033d286ee712a4ac01d29e53237f6831a7c08))
* **frontend:** pixel art identicons replace gradient swatches ([719f1d7](https://github.com/LeafdTK/leaf/commit/719f1d75c000d3b15cf663010812773275b9696e))


### Bug Fixes

* **frontend:** tighten compact group spacing ([9456f95](https://github.com/LeafdTK/leaf/commit/9456f95c004b3797bb7c541b903873abaeb8d85d))

## [0.16.3](https://github.com/LeafdTK/leaf/compare/frontend/v0.16.2...frontend/v0.16.3) (2026-07-16)


### Bug Fixes

* **frontend:** stable scrollbar gutters so popovers and page never shift width while scrolling ([b13c3be](https://github.com/LeafdTK/leaf/commit/b13c3bebd35874aaa7fbce29611380a668c5ac80))


### Performance Improvements

* **frontend:** pause mesh spin layers at rest, throttle card tilt retargeting, drop transform from btn transitions, composited dash-card hover shadow ([6ef7d26](https://github.com/LeafdTK/leaf/commit/6ef7d26de396a1873f7fe2ece08ec0e83f26099a))

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
