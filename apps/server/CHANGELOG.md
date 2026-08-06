# Changelog

## [2.3.1](https://github.com/LeafdTK/leaf/compare/server/v2.3.0...server/v2.3.1) (2026-08-06)


### Bug Fixes

* bound shared buildkit cache with tenant eviction ([5c34368](https://github.com/LeafdTK/leaf/commit/5c34368be478bed853393fddd73aef0ee410eaf1))

## [2.3.0](https://github.com/LeafdTK/leaf/compare/server/v2.2.1...server/v2.3.0) (2026-08-05)


### Features

* sandbox boot phases and terminal readiness gate ([9f95737](https://github.com/LeafdTK/leaf/commit/9f95737e55b3ef9a5e8629c75e8fe75c72291d14))
* scim role provisioning and enterprise extension ([6902152](https://github.com/LeafdTK/leaf/commit/6902152f1347b84dd58891ff196361fd63722b46))


### Bug Fixes

* make scim provisioning rfc 7644 compliant ([56ab24a](https://github.com/LeafdTK/leaf/commit/56ab24a7c25cab878dcaefe7c333447bad88d51e))
* scope scim-managed profiles to the provisioning org ([5588231](https://github.com/LeafdTK/leaf/commit/55882318fc0b22931a0aa51d2fe16afa40b5bc35))

## [2.2.1](https://github.com/LeafdTK/leaf/compare/server/v2.2.0...server/v2.2.1) (2026-08-05)


### Bug Fixes

* refresh sandbox secret and pod spec on start ([a5af781](https://github.com/LeafdTK/leaf/commit/a5af781ab3faa5b163dac8f7b806a25a95540072))

## [2.2.0](https://github.com/LeafdTK/leaf/compare/server/v2.1.0...server/v2.2.0) (2026-08-05)


### Features

* scope sandboxes to organizations with role based access ([7ae69e6](https://github.com/LeafdTK/leaf/commit/7ae69e67cbbf8b5d708b6e1a04f042d55975fabe))

## [2.1.0](https://github.com/LeafdTK/leaf/compare/server/v2.0.0...server/v2.1.0) (2026-08-05)


### Features

* auto-create sandbox namespace and isolation policy ([938e989](https://github.com/LeafdTK/leaf/commit/938e989bb0a5b1179ee639354fefe15267204241))
* bootstrap sandboxes from stock debian with setup scripts ([05a266a](https://github.com/LeafdTK/leaf/commit/05a266a1bbfbb66bebfc6204e5088306112d898b))
* build worker kill switch for shared infra dev servers ([3f0c075](https://github.com/LeafdTK/leaf/commit/3f0c07521b95fc7de0529c6656256c15ac5aa5ab))
* conductor style workspace and multi repo sandboxes ([96d1dd4](https://github.com/LeafdTK/leaf/commit/96d1dd49925225dc902afb0332cbdde973a6fbd5))
* default sandbox image from ghcr with publish workflow ([b3561b9](https://github.com/LeafdTK/leaf/commit/b3561b9b40712a78ff4cba4c799976bdc8ea63ba))
* enable sandboxes by default in dev ([25b367f](https://github.com/LeafdTK/leaf/commit/25b367fd8872f89ee2ec6e858b5a40a5b44d526b))
* full git operations for sandbox workspace ([c7f2b75](https://github.com/LeafdTK/leaf/commit/c7f2b754822fe2f46660823ae482a39c7c95d095))
* greenhouse ai sandboxes ([31e2325](https://github.com/LeafdTK/leaf/commit/31e23252b882f05daba9740df85bc621c8c93002))
* ide style cloud code workspace with live git changes ([0126efa](https://github.com/LeafdTK/leaf/commit/0126efa1eab06f9b5509912afc45725a6f68b967))
* opencode serve harness with proxy and native chat sessions ([e520d80](https://github.com/LeafdTK/leaf/commit/e520d80bf85c3c830b4b1653745f5d9f01334c6e))
* orchard mcp by default plus git and file endpoints ([9396499](https://github.com/LeafdTK/leaf/commit/93964994070821a51e61e6e7674b9ef87befbb71))
* sandbox cards, ssh identities, and cloud code chat ([e09fa8e](https://github.com/LeafdTK/leaf/commit/e09fa8ea3ae7d18ab405f53e0f1e80f38405901c))
* sandbox conversations with disk backed history and markdown transcript ([1032977](https://github.com/LeafdTK/leaf/commit/10329772860dbc5d9f5da9d7b11243bcb0c7a622))
* sandbox terminal websocket over pod exec ([5ae3a2c](https://github.com/LeafdTK/leaf/commit/5ae3a2cdbfbe6458616dd8beb873feeede2d67b1))


### Bug Fixes

* argv chat prompt and gate greenhouse behind posthog flag ([3fc34d5](https://github.com/LeafdTK/leaf/commit/3fc34d596aa51af7742370f8c3f215514355bd53))
* idle busy check understands opencode sessions ([1a142c0](https://github.com/LeafdTK/leaf/commit/1a142c04bb4206c46663044ef43debf1688fca0b))
* inject agent token per chat exec instead of boot env ([57afb77](https://github.com/LeafdTK/leaf/commit/57afb77f59b67301fe2739538f4db5112016a373))
* purge orphaned R2 backup objects when a database is deleted ([#153](https://github.com/LeafdTK/leaf/issues/153)) ([7b0285a](https://github.com/LeafdTK/leaf/commit/7b0285a81bf87b39ef203e197c3002e28042cf92))
* sandbox storage class falls back to cluster default ([aa335fe](https://github.com/LeafdTK/leaf/commit/aa335fe49633c138e5fb204d0d52338f2ae792f7))
* shell syntax in repo listing and clone scripts ([32e707b](https://github.com/LeafdTK/leaf/commit/32e707b8a67409bd371e7e2eac32ebdddd18be5c))
* strip whitespace from pasted agent tokens ([43381f8](https://github.com/LeafdTK/leaf/commit/43381f8c8901204edf5a4929d64ca1f06ebf2f3c))
* surface sandbox k8s errors and show status message in list ([a31e74e](https://github.com/LeafdTK/leaf/commit/a31e74e2aea830f0824a86518ace9505ce98289c))

## [2.0.0](https://github.com/LeafdTK/leaf/compare/server/v1.37.0...server/v2.0.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* ui version 2.0 ([#150](https://github.com/LeafdTK/leaf/issues/150))

### Features

* ui version 2.0 ([#150](https://github.com/LeafdTK/leaf/issues/150)) ([12878ec](https://github.com/LeafdTK/leaf/commit/12878ec3e5987942f20bebc64bea06a56a189857))

## [1.37.0](https://github.com/LeafdTK/leaf/compare/server/v1.36.0...server/v1.37.0) (2026-07-30)


### Features

* **builder:** make tmpfs scratch an explicit bounded mode ([19f0f5a](https://github.com/LeafdTK/leaf/commit/19f0f5a3a6f5e4a3a53f3c16afd6617e3e19df80))


### Bug Fixes

* **builder:** drop build retries and skip the cache instead of rebuilding ([9950e25](https://github.com/LeafdTK/leaf/commit/9950e2535fa45ad2aefeced1e285428e0e5f926a))
* **builder:** stop retrying builds that failed inside a dockerfile step ([43569e1](https://github.com/LeafdTK/leaf/commit/43569e1b62f7004c919ba575a16b0b2d32770ca5))

## [1.36.0](https://github.com/LeafdTK/leaf/compare/server/v1.35.4...server/v1.36.0) (2026-07-30)


### Features

* **builder:** add disk-backed scratch mode as an alternative to block and tmpfs ([d3355f0](https://github.com/LeafdTK/leaf/commit/d3355f0b639eaca306dc873c6a09d6ee9ce82d49))


### Bug Fixes

* **databases:** send sslrootcert=system when the import source verifies its certificate ([86468fd](https://github.com/LeafdTK/leaf/commit/86468fd941e36844c124a79523c8c7d5161ac6eb))
* **network:** let in-cluster pods reach publicly exposed databases and deployments ([ba56e71](https://github.com/LeafdTK/leaf/commit/ba56e718c758a425bfd3cfe697577c8d3ad1428c))

## [1.35.4](https://github.com/LeafdTK/leaf/compare/server/v1.35.3...server/v1.35.4) (2026-07-30)


### Bug Fixes

* **builder:** make scratch reset survive the daemonless buildkitd lifecycle ([0eedf5b](https://github.com/LeafdTK/leaf/commit/0eedf5b67b8c5cb231834afb1fa3ec6f4ff1feb1))
* **compose:** claim a pvc for named volumes instead of silently mounting emptydir ([7959700](https://github.com/LeafdTK/leaf/commit/7959700ef7e7ad8d847cc4f7e36c05975651c666))
* **deployments:** keep public port exposure across namespace sync and exposure toggle ([fb0fea7](https://github.com/LeafdTK/leaf/commit/fb0fea7b370b1cb2018395a8eb09722a378ec95c))
* **quotas:** give database images a workable resource default ([a300234](https://github.com/LeafdTK/leaf/commit/a3002346c55ac27243dcd8e2cb7593a21fee98e8))

## [1.35.3](https://github.com/LeafdTK/leaf/compare/server/v1.35.2...server/v1.35.3) (2026-07-30)


### Bug Fixes

* **builder:** derive build status from pod phase and fail fast on unschedulable pods ([86e0e42](https://github.com/LeafdTK/leaf/commit/86e0e42e8c57690b66e4e21dab93fd7c87fb71ec))
* **builder:** retry storage io errors and rebuild scratch filesystem before retrying ([99545bb](https://github.com/LeafdTK/leaf/commit/99545bbb5e4a32b824d52baa806a375cefdd89ba))
* **builder:** stop stripping local cache export for sidecar push ([c522eac](https://github.com/LeafdTK/leaf/commit/c522eacabfcf4d4cebaed51874ff59b9e7caf1bb))

## [1.35.2](https://github.com/LeafdTK/leaf/compare/server/v1.35.1...server/v1.35.2) (2026-07-30)


### Bug Fixes

* **github:** only expose repos the user can access on github ([084d4d6](https://github.com/LeafdTK/leaf/commit/084d4d65fd378332d58d84266e4bcf96a5cc6bb8))
* **mcp:** delete unreferenced remote entrypoint with unvalidated oauth redirect ([e97ee4b](https://github.com/LeafdTK/leaf/commit/e97ee4b2299b72ce44b6d6cb27eaeee1cffeb626))

## [1.35.1](https://github.com/LeafdTK/leaf/compare/server/v1.35.0...server/v1.35.1) (2026-07-29)


### Bug Fixes

* allow removing an org member who is the sole admin of a project ([3497ad6](https://github.com/LeafdTK/leaf/commit/3497ad6d30028378d92df0c0bcefb8988f4cefed))

## [1.35.0](https://github.com/LeafdTK/leaf/compare/server/v1.34.3...server/v1.35.0) (2026-07-28)


### Features

* **builder:** make orchard build settings outrank a repo railpack.json ([0590c6c](https://github.com/LeafdTK/leaf/commit/0590c6c3986296ce1078222e1725da39d63d2b2f))


### Bug Fixes

* **builder:** detect the sveltekit adapter from config, not installed deps ([60c281b](https://github.com/LeafdTK/leaf/commit/60c281bc3a1b877b9b1b93eb9bd928b669816a96))
* **builder:** stop the local build path overwriting the chosen framework too ([82c9af5](https://github.com/LeafdTK/leaf/commit/82c9af5c49258f6a54168d77afb0cc3627e60f8e))

## [1.34.3](https://github.com/LeafdTK/leaf/compare/server/v1.34.2...server/v1.34.3) (2026-07-28)


### Bug Fixes

* **builder:** pin the railpack frontend to the cli version and stop spurious no-cache retries ([4ab7892](https://github.com/LeafdTK/leaf/commit/4ab7892c2e86ff3ac5cfa4da1fc206c6120ea9fb))

## [1.34.2](https://github.com/LeafdTK/leaf/compare/server/v1.34.1...server/v1.34.2) (2026-07-28)


### Bug Fixes

* **builder:** stop the cache prune and no-cache retry trampling live builds ([d3eda11](https://github.com/LeafdTK/leaf/commit/d3eda11cc70150c32caeb6084ef09ce7fa48bf4c))

## [1.34.1](https://github.com/LeafdTK/leaf/compare/server/v1.34.0...server/v1.34.1) (2026-07-28)


### Bug Fixes

* **builder:** stop the railpack binary squatting on railpack's cache dir ([12b5b07](https://github.com/LeafdTK/leaf/commit/12b5b073843e53288c848079be248823bb18aa65))

## [1.34.0](https://github.com/LeafdTK/leaf/compare/server/v1.33.0...server/v1.34.0) (2026-07-28)


### Features

* **builder:** detect frameworks and expose build overrides on railpack builds ([d827c87](https://github.com/LeafdTK/leaf/commit/d827c87780f095f389b3d06759aa5a529074e228))

## [1.33.0](https://github.com/LeafdTK/leaf/compare/server/v1.32.6...server/v1.33.0) (2026-07-24)


### Features

* **builder:** block-device scratch mode so build state lands on disk not ram ([5b2e8a8](https://github.com/LeafdTK/leaf/commit/5b2e8a83c04d420a423c45b99da048d34ac4bb28))

## [1.32.6](https://github.com/LeafdTK/leaf/compare/server/v1.32.5...server/v1.32.6) (2026-07-24)


### Bug Fixes

* **builder:** clear buildkit state before no-cache retry ([0cf60fb](https://github.com/LeafdTK/leaf/commit/0cf60fbab82aee5153fdf0cbff92b54ec81e82e3))

## [1.32.5](https://github.com/LeafdTK/leaf/compare/server/v1.32.4...server/v1.32.5) (2026-07-24)


### Bug Fixes

* **builder:** raise build vm memory so tmpfs fits large builds ([c11c07c](https://github.com/LeafdTK/leaf/commit/c11c07c3913b6072711edd828d4e6ef5f94665cd))

## [1.32.4](https://github.com/LeafdTK/leaf/compare/server/v1.32.3...server/v1.32.4) (2026-07-24)


### Bug Fixes

* **builder:** keep buildkit state on tmpfs, virtiofs causes ebadf ([c6bd76c](https://github.com/LeafdTK/leaf/commit/c6bd76cd3ceaa5c3fa7428af1978d3112769fb47))

## [1.32.3](https://github.com/LeafdTK/leaf/compare/server/v1.32.2...server/v1.32.3) (2026-07-24)


### Bug Fixes

* pin buildkit, retry builds without cache when it fills ([38e17be](https://github.com/LeafdTK/leaf/commit/38e17becb82086970c7ee88965ee0d35ead12ca7))

## [1.32.2](https://github.com/LeafdTK/leaf/compare/server/v1.32.1...server/v1.32.2) (2026-07-24)


### Bug Fixes

* buildkit gc so the cache volume stops filling up ([024b7ba](https://github.com/LeafdTK/leaf/commit/024b7ba2b032db04b81db934e4403f87191dc760))

## [1.32.1](https://github.com/LeafdTK/leaf/compare/server/v1.32.0...server/v1.32.1) (2026-07-23)


### Bug Fixes

* **builder:** move buildkit-state and output emptyDirs off tmpfs to disk ([fe4d790](https://github.com/LeafdTK/leaf/commit/fe4d79066a04908dedfeda6218bd182634cf4396))

## [1.32.0](https://github.com/LeafdTK/leaf/compare/server/v1.31.0...server/v1.32.0) (2026-07-22)


### Features

* github repo mirror, picker served from db ([3284a3d](https://github.com/LeafdTK/leaf/commit/3284a3d48c7e7436c613106da9d7aba88d4244a5))


### Performance Improvements

* parallel repo pagination, serve cached list instantly ([22ce7c7](https://github.com/LeafdTK/leaf/commit/22ce7c7817a369cc970bffd0a80efbc803241183))

## [1.31.0](https://github.com/LeafdTK/leaf/compare/server/v1.30.1...server/v1.31.0) (2026-07-22)


### Features

* auto deploy on by default for github deployments ([c09109d](https://github.com/LeafdTK/leaf/commit/c09109d49a2f28a1634e7573e31a6af3a1a3df09))
* auto-generated protected url on deployment create ([ad7b7d2](https://github.com/LeafdTK/leaf/commit/ad7b7d2a5be0319cef570e6b8fb7ddd80aeaefd9))
* gate local deploys behind LOCAL_DEPLOYS_ENABLED, off by default ([d37baeb](https://github.com/LeafdTK/leaf/commit/d37baeb1322c2bb9d7e57bd88229b5200364e4d8))
* live build log streaming over sse ([32e8b2f](https://github.com/LeafdTK/leaf/commit/32e8b2f4aadd4fbe66c61cbdea658ca4033a4cf5))
* one-shot github import endpoint and orchard import ([70398a2](https://github.com/LeafdTK/leaf/commit/70398a2efac3300e7400b951a7cca016ca351fc6))
* orchard up local directory deploys ([685b735](https://github.com/LeafdTK/leaf/commit/685b7350af9cff84abf50ac42e02339a3a3c558a))
* runtime log streaming over sse and event-driven metrics refresh ([81dc35f](https://github.com/LeafdTK/leaf/commit/81dc35fc16953aba8a58d3a60f6e70899d33806c))
* zero-config repo detection endpoint and create form pre-fill ([53ebf72](https://github.com/LeafdTK/leaf/commit/53ebf72057e7b859b64526db9f569f084e4d34ee))


### Bug Fixes

* resolve sub to uuid in project member filters, creamy card hover ([c71be35](https://github.com/LeafdTK/leaf/commit/c71be35e01850e73f5233eb0b66d1995cd756560))
* timeout, parallelize and cache github repo listing ([fdae0be](https://github.com/LeafdTK/leaf/commit/fdae0be26ffa96821a9f953ec14fc8440bdc4f09))

## [1.30.1](https://github.com/LeafdTK/leaf/compare/server/v1.30.0...server/v1.30.1) (2026-07-22)


### Bug Fixes

* hoist logUrl so auto deploys stop crashing on scope ([4c1561b](https://github.com/LeafdTK/leaf/commit/4c1561bf89b1f984977139de3e4b6f80e584d04d))

## [1.30.0](https://github.com/LeafdTK/leaf/compare/server/v1.29.1...server/v1.30.0) (2026-07-22)


### Features

* alert on failing wal archiving and missing backup schedules ([d9a2c3b](https://github.com/LeafdTK/leaf/commit/d9a2c3bdb824a5d82355319d84b89299899269ef))


### Bug Fixes

* platform db policy allows r2-proxy namespace ([1d3209c](https://github.com/LeafdTK/leaf/commit/1d3209ccdace68514679f2e25ae8e57d637ba977))

## [1.29.1](https://github.com/LeafdTK/leaf/compare/server/v1.29.0...server/v1.29.1) (2026-07-22)


### Bug Fixes

* watchdog timeout on build start so hung pre-job phases fail instead of spinning forever ([b91ee34](https://github.com/LeafdTK/leaf/commit/b91ee34859ee2b4308885be23185c5361f3badb4))

## [1.29.0](https://github.com/LeafdTK/leaf/compare/server/v1.28.0...server/v1.29.0) (2026-07-22)


### Features

* seamless build recovery with log continuity and deploy history ([aab1df3](https://github.com/LeafdTK/leaf/commit/aab1df31c34177f2e29cc3e9c01c54d204e3085a))


### Bug Fixes

* recover finished builds from job status or registry instead of marking lost ([e0763db](https://github.com/LeafdTK/leaf/commit/e0763db429e6451683859257ccdd0d77a8fb0745))
* requeue builds orphaned by server restart instead of failing ([3e6e12f](https://github.com/LeafdTK/leaf/commit/3e6e12fc00003997ed01ce06366eac2ecf82c305))

## [1.28.0](https://github.com/LeafdTK/leaf/compare/server/v1.27.1...server/v1.28.0) (2026-07-22)


### Features

* pass GIT_SHA build arg with checked out commit to image builds ([b346611](https://github.com/LeafdTK/leaf/commit/b34661142bf858ca69258c65635094f056870efd))

## [1.27.1](https://github.com/LeafdTK/leaf/compare/server/v1.27.0...server/v1.27.1) (2026-07-21)


### Bug Fixes

* public db hostnames are namespace qualified to prevent cross org collisions ([60b424a](https://github.com/LeafdTK/leaf/commit/60b424a18fd5279cdbe82df4ca8efb2c78900863))

## [1.27.0](https://github.com/LeafdTK/leaf/compare/server/v1.26.2...server/v1.27.0) (2026-07-21)


### Features

* per query statistics tab from pg_stat_statements ([7654b99](https://github.com/LeafdTK/leaf/commit/7654b9977a4962b80d262cad754f8714e624211f))
* postgres version choice and database stop start restart ([8e8660a](https://github.com/LeafdTK/leaf/commit/8e8660a2a5366015c53ec47b248afb8ddc158d02))


### Bug Fixes

* database page renders instantly, live stats load separately ([d7c90a7](https://github.com/LeafdTK/leaf/commit/d7c90a78d90115d5a8c15edca37b4e87d5ce4cdf))
* database size and connection stats, psql vars do not expand in -c ([a632218](https://github.com/LeafdTK/leaf/commit/a6322189f7299765324a3636d76013076792033d))

## [1.26.2](https://github.com/LeafdTK/leaf/compare/server/v1.26.1...server/v1.26.2) (2026-07-21)


### Bug Fixes

* github checks link to orchard logs instead of embedding them, reclaim closes orphaned runs ([1a7943f](https://github.com/LeafdTK/leaf/commit/1a7943f415afc18946aaa1bd6831fe243eb5cd41))
* redeploy forces recreate strategy when a pvc volume is mounted ([41d5f30](https://github.com/LeafdTK/leaf/commit/41d5f30cd1a55779d2250091ef0c2deb35404bcf))

## [1.26.1](https://github.com/LeafdTK/leaf/compare/server/v1.26.0...server/v1.26.1) (2026-07-21)


### Bug Fixes

* accept legacy hackclubid jwt claim in raw token readers ([3638dde](https://github.com/LeafdTK/leaf/commit/3638dde44c40476f088d9cb7f191e9cf0f02555e))

## [1.26.0](https://github.com/LeafdTK/leaf/compare/server/v1.25.2...server/v1.26.0) (2026-07-21)


### Features

* add signup_mode flag and de-hardcode asset, posthog and email hosts ([2b2bfb5](https://github.com/LeafdTK/leaf/commit/2b2bfb54bfeecedd47dc8b7e100e4a24b649cadc))
* generic oidc login provider and externalauthid rename ([d241af9](https://github.com/LeafdTK/leaf/commit/d241af93e8c50a06e7a08f31c5aa949ec9f10351))
* make registry project, pull secret and no_proxy configurable ([99cca73](https://github.com/LeafdTK/leaf/commit/99cca7318c9f2d2843a08cdf9176d01981427bc4))
* make storage class, ingress class, cert issuer and wildcard domains configurable ([33816bc](https://github.com/LeafdTK/leaf/commit/33816bcbd364b4b57fb0d7e61637b2ac1d74585a))
* real env examples, dev compose stack, contributor docs and clerk cleanup ([e5b849b](https://github.com/LeafdTK/leaf/commit/e5b849b6fe08c181078af2209af0bde28524fd7f))


### Bug Fixes

* cnpg operator netpol sweep targets only orchard managed namespaces ([b67abe0](https://github.com/LeafdTK/leaf/commit/b67abe020bd88aa92327da14a91523d12037f3bc))
* platform ensures its own db network policies at boot ([5ac7f0c](https://github.com/LeafdTK/leaf/commit/5ac7f0cf2db11ba5d4c5a62eb7adb762046047a9))
* read legacy orchard.dev labels and annotations during rename transition ([c88528f](https://github.com/LeafdTK/leaf/commit/c88528f00ef9f58dbc4ba73d27a1fdf7b2308b17))
* unify k8s label and annotation keys on orchard.my ([d1b42b2](https://github.com/LeafdTK/leaf/commit/d1b42b2c0d8c324f8a28fdc013ffb5983f962561))

## [1.25.2](https://github.com/LeafdTK/leaf/compare/server/v1.25.1...server/v1.25.2) (2026-07-20)


### Bug Fixes

* tenant namespaces allow cnpg operator to instance managers ([1082bae](https://github.com/LeafdTK/leaf/commit/1082bae50ac20872fcb2263369ee90fe4c3deabd))

## [1.25.1](https://github.com/LeafdTK/leaf/compare/server/v1.25.0...server/v1.25.1) (2026-07-20)


### Bug Fixes

* scrub credentials from clone logs and check run output ([581ed88](https://github.com/LeafdTK/leaf/commit/581ed886188fe76774bb6b73442a26b8057bfc3e))

## [1.25.0](https://github.com/LeafdTK/leaf/compare/server/v1.24.1...server/v1.25.0) (2026-07-20)


### Features

* version aware db imports, provision cluster at source pg major ([7d22a8a](https://github.com/LeafdTK/leaf/commit/7d22a8a4b27f89e35633c640b5ed132f5be6c543))

## [1.24.1](https://github.com/LeafdTK/leaf/compare/server/v1.24.0...server/v1.24.1) (2026-07-18)


### Bug Fixes

* hide org settings entry from non-admins ([c8c0250](https://github.com/LeafdTK/leaf/commit/c8c0250f2da931308425e6033975a841aabf497f))

## [1.24.0](https://github.com/LeafdTK/leaf/compare/server/v1.23.0...server/v1.24.0) (2026-07-18)


### Features

* rename apps via display name, k8s name stays frozen ([898fd5e](https://github.com/LeafdTK/leaf/commit/898fd5e2746646eb2c744629db38987df6ac47ed))
* rename databases, compose stacks, template instances, environments and api tokens ([625ee58](https://github.com/LeafdTK/leaf/commit/625ee58d7657538e2127cd6a399221ab13c7a33b))

## [1.23.0](https://github.com/LeafdTK/leaf/compare/server/v1.22.3...server/v1.23.0) (2026-07-18)


### Features

* change github repo, branch and dockerfile of an app after creation ([c5b99da](https://github.com/LeafdTK/leaf/commit/c5b99da385ebe9d1f2951ddb71bd2322808be905))

## [1.22.3](https://github.com/LeafdTK/leaf/compare/server/v1.22.2...server/v1.22.3) (2026-07-18)


### Bug Fixes

* csrf-protect github link oauth flow with an httponly nonce cookie checked against state, rejects forged callbacks ([9bbfada](https://github.com/LeafdTK/leaf/commit/9bbfadab8538a442a49ea2633bb05743db850ed4))
* github link threw account-exists for otp/passkey sessions, resolve existing user by hackclubid or internal id instead of findorcreate on sub ([c8d8173](https://github.com/LeafdTK/leaf/commit/c8d8173b45410070a802ab2780ff6e1ff2ed2d78))

## [1.22.2](https://github.com/LeafdTK/leaf/compare/server/v1.22.1...server/v1.22.2) (2026-07-18)


### Bug Fixes

* enqueue advisory lock threw deserializing void, use executeraw not queryraw ([18763b8](https://github.com/LeafdTK/leaf/commit/18763b80fcd95eba8ad81149dd8cf86c81e0fd00))

## [1.22.1](https://github.com/LeafdTK/leaf/compare/server/v1.22.0...server/v1.22.1) (2026-07-18)


### Bug Fixes

* build queue crash-looped the server on boot via circular dep, resolve with moduleref and a non-blocking claim lock ([4d28aec](https://github.com/LeafdTK/leaf/commit/4d28aec87c1984ca07beba548a92a1bcd3fe9d61))

## [1.22.0](https://github.com/LeafdTK/leaf/compare/server/v1.21.0...server/v1.22.0) (2026-07-18)


### Features

* auto-deploy queues the latest commit when a build is in progress instead of dropping it ([68f49a9](https://github.com/LeafdTK/leaf/commit/68f49a951e2fe6df47be4c332bb40a44e5c4dcb2))
* build queue rides the redis-streams sse bus with adaptive polling like the rest ([1a6c76b](https://github.com/LeafdTK/leaf/commit/1a6c76b161d293209d709d522294bfe99965f138))
* build queue view in Deploys tab with live run states, buildRunStatus badges, read API ([e102780](https://github.com/LeafdTK/leaf/commit/e1027802011392494f65913609794eb5d2e02f20))
* the build queue is real now, postgres skip-locked gates every build path through per-app and per-instance caps ([a8a1485](https://github.com/LeafdTK/leaf/commit/a8a1485118f6cf11006ef2970a3d699a34cfded5))

## [1.21.0](https://github.com/LeafdTK/leaf/compare/server/v1.20.2...server/v1.21.0) (2026-07-17)


### Features

* grove becomes an issue tracker with numbers, priorities, triage statuses, image attachments and chat style replies ([1142e46](https://github.com/LeafdTK/leaf/commit/1142e461fe79f1b6231e3d071a66d910f563b758))
* grove delete for own posts and replies, superadmins delete anything ([2718719](https://github.com/LeafdTK/leaf/commit/271871957ee2739db164a1ac9ba63c5ec70e99f9))
* grove gated behind GROVE_ENABLED / PUBLIC_GROVE_ENABLED env flags ([a3f9f34](https://github.com/LeafdTK/leaf/commit/a3f9f34ac9966de7df769a74dbe8e90d06aa882f))
* grove scopes replace emoji categories, bugs and feature requests only ([6901477](https://github.com/LeafdTK/leaf/commit/6901477454598e9a6ab3c5ae0a34f358ecda5ecf))
* the grove, a community forum for bugs, ideas and showcase with votes, statuses and orchard pixel sprites ([178fb96](https://github.com/LeafdTK/leaf/commit/178fb96aff66a0159ff4719e8df42fd9126e3734))


### Bug Fixes

* drop dashboard scope, main platform covers it ([3ae9e45](https://github.com/LeafdTK/leaf/commit/3ae9e4574154b463998c701ef75fd67ad1e717b3))
* **server:** forum images restricted to own storage prefix, upload extension from validated mimetype ([a275058](https://github.com/LeafdTK/leaf/commit/a2750588294a60aaec0d7c4165e12b3d52f888f9))
* volume attach failures now validated with real error messages, sizes and names normalized ([ba7fd9d](https://github.com/LeafdTK/leaf/commit/ba7fd9d0b88cf01cb278568364a71b6e4ab96fc9))

## [1.20.2](https://github.com/LeafdTK/leaf/compare/server/v1.20.1...server/v1.20.2) (2026-07-16)


### Bug Fixes

* **server:** sanitize auto-generated usernames from email local-parts across all signup paths ([d3f2357](https://github.com/LeafdTK/leaf/commit/d3f23575637f8cf670c9186338fc213d9e48bab3))

## [1.20.1](https://github.com/LeafdTK/leaf/compare/server/v1.20.0...server/v1.20.1) (2026-07-16)


### Bug Fixes

* username validation names the offending characters, strips invisible chars, backend enforces format ([4672510](https://github.com/LeafdTK/leaf/commit/46725103073c652bfeed0af0324b3da09e3522a4))

## [1.20.0](https://github.com/LeafdTK/leaf/compare/server/v1.19.0...server/v1.20.0) (2026-07-15)


### Features

* encrypt shared-var secrets at rest, size limits, write-only UI ([d812836](https://github.com/LeafdTK/leaf/commit/d812836479bca60b9637769043963ec6d265cd23))
* project environments — namespace-isolated envs with shared + secret variables ([cfab235](https://github.com/LeafdTK/leaf/commit/cfab2358dbc6baebf5cfebc2f1c58b8538c79c8a))


### Bug Fixes

* **server:** scrub ingress/db credential leaks, keep untouched secrets on shared-vars PUT, pod logs since params, per-PAT throttle, mcp validate_dns projectId ([eb7a3af](https://github.com/LeafdTK/leaf/commit/eb7a3af7bbd6aab3ddad6a1659b0ab719285ef36))

## [1.19.0](https://github.com/LeafdTK/leaf/compare/server/v1.18.0...server/v1.19.0) (2026-07-09)


### Features

* orchard jobs — scheduled multi-step pipelines on kubernetes ([#93](https://github.com/LeafdTK/leaf/issues/93)) ([721f190](https://github.com/LeafdTK/leaf/commit/721f190dfada0e2777e47c9b0f3d04bd1ba87535))

## [1.18.0](https://github.com/LeafdTK/leaf/compare/server/v1.17.1...server/v1.18.0) (2026-07-09)


### Features

* notification channel MCP tools ([ab74f5c](https://github.com/LeafdTK/leaf/commit/ab74f5c72b17d278da1d87fdd14e25f21e195031))


### Bug Fixes

* tailscale proxy apiserver egress via CiliumNetworkPolicy ([fcca09d](https://github.com/LeafdTK/leaf/commit/fcca09da032f0a44c233a1d305c5666a5ba379fc))

## [1.17.1](https://github.com/LeafdTK/leaf/compare/server/v1.17.0...server/v1.17.1) (2026-07-08)


### Bug Fixes

* allow kube apiserver egress in tailscale proxy network policy ([b976cca](https://github.com/LeafdTK/leaf/commit/b976ccaa7c93872bd51e12dec029b077f8997c76))
* boost db resources during import, settle after, and guard storage size ([e593566](https://github.com/LeafdTK/leaf/commit/e593566ae9e0e17c6659c050bd1abc7a841f353f))
* make depot build failures loud and match buildkit lint behavior ([2cad74a](https://github.com/LeafdTK/leaf/commit/2cad74ac66ccd3d9d8992be35557d4a56997f2ed))
* run ANALYZE after cnpg import so restored dbs have planner stats ([6f8458a](https://github.com/LeafdTK/leaf/commit/6f8458a61f895bb0d6735374bd5b0aaf42288417))
* surface real error when scaling fails ([bfb963b](https://github.com/LeafdTK/leaf/commit/bfb963bb820b12f5b1bc71a652a27b3e669a9560))

## [1.17.0](https://github.com/LeafdTK/leaf/compare/server/v1.16.0...server/v1.17.0) (2026-07-08)


### Features

* org notification channels for deploy, crash, and backup events ([ff906f1](https://github.com/LeafdTK/leaf/commit/ff906f10e4cb3041dc97094082fe11b7f595e2cc))

## [1.16.0](https://github.com/LeafdTK/leaf/compare/server/v1.15.2...server/v1.16.0) (2026-07-07)


### Features

* make warm cache a superadmin only setting ([6793747](https://github.com/LeafdTK/leaf/commit/6793747d4167d6c605267e4a4ea064acbc65f51f))

## [1.15.2](https://github.com/LeafdTK/leaf/compare/server/v1.15.1...server/v1.15.2) (2026-07-07)


### Bug Fixes

* fetch size and connections for cnpg databases ([c3f0dd6](https://github.com/LeafdTK/leaf/commit/c3f0dd69ce52ab877529d10823653d0ef8579822))
* restrict buildkit daemon ingress to build-job pods ([9e9709f](https://github.com/LeafdTK/leaf/commit/9e9709fa12a808545f389ebf301d3e04176f98b6))
* tailscale proxy rbac and pod env for containerboot ([6e27afb](https://github.com/LeafdTK/leaf/commit/6e27afb05d4f93cea61fc6bd4f34e7c987811458))

## [1.15.1](https://github.com/LeafdTK/leaf/compare/server/v1.15.0...server/v1.15.1) (2026-07-06)


### Bug Fixes

* persist mcp oauth client registrations across restarts ([91b3ebc](https://github.com/LeafdTK/leaf/commit/91b3ebce0abf0ec90f69b2b397b4958bab2d52e8))

## [1.15.0](https://github.com/LeafdTK/leaf/compare/server/v1.14.4...server/v1.15.0) (2026-07-06)


### Features

* grow-only database storage expansion with mcp tool ([f422d4f](https://github.com/LeafdTK/leaf/commit/f422d4ff41c048ed5a9c02f91f7de4131d93ab72))
* warn on failing wal archiving when expanding database storage ([95c4d39](https://github.com/LeafdTK/leaf/commit/95c4d3999be05a5a8c83bfb56d108cc531a35054))

## [1.14.4](https://github.com/LeafdTK/leaf/compare/server/v1.14.3...server/v1.14.4) (2026-07-06)


### Bug Fixes

* skip SecretsUsedInArgOrEnv lint so check=error dockerfiles build ([d6c0fa0](https://github.com/LeafdTK/leaf/commit/d6c0fa0d1a039c2589915773354a3f68f69147f0))
* surface the real build error instead of container termination noise ([af67c68](https://github.com/LeafdTK/leaf/commit/af67c68343640b217c378f445644a2be81633031))

## [1.14.3](https://github.com/LeafdTK/leaf/compare/server/v1.14.2...server/v1.14.3) (2026-07-06)


### Bug Fixes

* proxy protected apps before body parsing and tunnel websockets ([7bc7922](https://github.com/LeafdTK/leaf/commit/7bc792217a27a278b13df99d132b9c6e1f58f071))

## [1.14.2](https://github.com/LeafdTK/leaf/compare/server/v1.14.1...server/v1.14.2) (2026-07-06)


### Bug Fixes

* mark protection proxy endpoints ready and restore orphaned backends ([3878314](https://github.com/LeafdTK/leaf/commit/3878314bd693f1209a86f230bcbfcb217563fd2e))
* mcp crash on boot from required leader election dependency ([8b8cd11](https://github.com/LeafdTK/leaf/commit/8b8cd11ceb83c4f593e4c5c7098227e92d780eed))

## [1.14.1](https://github.com/LeafdTK/leaf/compare/server/v1.14.0...server/v1.14.1) (2026-07-06)


### Bug Fixes

* protection proxy endpoints no longer go stale on server redeploy ([7281c42](https://github.com/LeafdTK/leaf/commit/7281c429a0e7c3d3a0ddb0f911e51f5f212a7934))

## [1.14.0](https://github.com/LeafdTK/leaf/compare/server/v1.13.0...server/v1.14.0) (2026-07-06)


### Features

* cnpg pod informer emits database.changed health events ([34eaca9](https://github.com/LeafdTK/leaf/commit/34eaca94b33efaa0be0dde4e6548bdd7bf4bf55f))
* flood-fill white matte off scraped favicons ([0c03d16](https://github.com/LeafdTK/leaf/commit/0c03d163f025ecc475bb58d5f538e0c785bbdc84))
* **mcp:** killed-container log tools + previous-logs param ([609d318](https://github.com/LeafdTK/leaf/commit/609d31858db8d4d9ad5c6947cbeb49d80bcb2f93))
* push live deployment metrics over sse, relax frontend polling ([95c53fb](https://github.com/LeafdTK/leaf/commit/95c53fbd88f65e6342c966862ae5418c3528f596))
* scoped org builds feed endpoint, tighter deployment access checks ([d809db6](https://github.com/LeafdTK/leaf/commit/d809db6f3d501315ecf0a5e315c6d41534c8b039))
* summarize build failures instead of dumping full logs ([af18f15](https://github.com/LeafdTK/leaf/commit/af18f157659300fd7e814ee420d7c8d04bd5f3a6))


### Bug Fixes

* gate singleton background jobs behind leader election ([92aa32a](https://github.com/LeafdTK/leaf/commit/92aa32a3bb76cabf43d462e99a0f5eaea30d31dd))
* strip trailing dashes when truncating k8s resource names ([87bb10b](https://github.com/LeafdTK/leaf/commit/87bb10bd18f75a4424bd79ab00ae92c1c622af03))

## [1.13.0](https://github.com/LeafdTK/leaf/compare/server/v1.12.2...server/v1.13.0) (2026-07-02)


### Features

* informer-driven pod events on redis streams, OOM surfacing, killed-container logs ([#79](https://github.com/LeafdTK/leaf/issues/79)) ([2ba9309](https://github.com/LeafdTK/leaf/commit/2ba930913a6b3d4eaa8fe879081c66c24b114f85))

## [1.12.2](https://github.com/LeafdTK/leaf/compare/server/v1.12.1...server/v1.12.2) (2026-07-01)


### Bug Fixes

* exclude a deployment from its own member-allowance usage so redeploys don't double-count ([799a75f](https://github.com/LeafdTK/leaf/commit/799a75f7658dd6d7b2bf1916acd3dafb34781c13))
* namespace sync only reaps successfully-built deployments missing from k8s, and logs it ([7d6bdcd](https://github.com/LeafdTK/leaf/commit/7d6bdcd35e757b55076f2f9a66e54ede8d5113a8))
* zero-surge rolling updates (maxSurge 0) so deploys don't momentarily double pod resources ([9f14205](https://github.com/LeafdTK/leaf/commit/9f1420579394360094362687ff1a8c61c08bfd45))

## [1.12.1](https://github.com/LeafdTK/leaf/compare/server/v1.12.0...server/v1.12.1) (2026-07-01)


### Bug Fixes

* allow env var updates on compose-managed deployments, preserve them across redeploy ([67b95df](https://github.com/LeafdTK/leaf/commit/67b95df7a401fb3db033dda00da475ec8c551b99))

## [1.12.0](https://github.com/LeafdTK/leaf/compare/server/v1.11.2...server/v1.12.0) (2026-06-30)


### Features

* terminal-style colored logs with grouping, scroll pagination, server-side search, sentry-style errors ([9564844](https://github.com/LeafdTK/leaf/commit/95648442a08a5b209d0809e81d29bf0e33c0c81e))


### Bug Fixes

* cap prisma connection pool to prevent postgres connection exhaustion ([79f7b24](https://github.com/LeafdTK/leaf/commit/79f7b2412b9401363fa3cc9ad8ed4f14ef986b9d))

## [1.11.2](https://github.com/LeafdTK/leaf/compare/server/v1.11.1...server/v1.11.2) (2026-06-29)


### Bug Fixes

* restore observe logs + http metrics after haproxy ingress switch ([47eda41](https://github.com/LeafdTK/leaf/commit/47eda417516a0d448de07eaa5d28fec3c99e260f))

## [1.11.1](https://github.com/LeafdTK/leaf/compare/server/v1.11.0...server/v1.11.1) (2026-06-29)


### Bug Fixes

* pass label selector in correct arg position for pod informer list ([#73](https://github.com/LeafdTK/leaf/issues/73)) ([b7af352](https://github.com/LeafdTK/leaf/commit/b7af35299b2ee31bc722cede1ccc48a05dd5183f))

## [1.11.0](https://github.com/LeafdTK/leaf/compare/server/v1.10.0...server/v1.11.0) (2026-06-29)


### Features

* reliable live updates (redis streams bus, k8s pod informer, crash-loop surfacing) ([#72](https://github.com/LeafdTK/leaf/issues/72)) ([a710ece](https://github.com/LeafdTK/leaf/commit/a710ece69334fcfdfeee4ea5208954307865aec1))


### Bug Fixes

* make build-status SSE updates live and prompt reload on disconnect ([6a229dc](https://github.com/LeafdTK/leaf/commit/6a229dcb9b238d58fa049cedbf1c27c14ab473e2))

## [1.10.0](https://github.com/LeafdTK/leaf/compare/server/v1.9.0...server/v1.10.0) (2026-06-28)


### Features

* accurate build phases (scheduling builder) and skip pod-ready wait on deploy ([#69](https://github.com/LeafdTK/leaf/issues/69)) ([5eabbe9](https://github.com/LeafdTK/leaf/commit/5eabbe9d569439e54376a5b60bed43b1d4c6e147))

## [1.9.0](https://github.com/LeafdTK/leaf/compare/server/v1.8.0...server/v1.9.0) (2026-06-28)


### Features

* surface registry push as its own build step with live pusher logs ([#67](https://github.com/LeafdTK/leaf/issues/67)) ([0015ef8](https://github.com/LeafdTK/leaf/commit/0015ef88537cb9fd7849d57387f3995f2e2ee19b))

## [1.8.0](https://github.com/LeafdTK/leaf/compare/server/v1.7.2...server/v1.8.0) (2026-06-25)


### Features

* grant SYS_CHROOT to tenant workloads ([#65](https://github.com/LeafdTK/leaf/issues/65)) ([7691dda](https://github.com/LeafdTK/leaf/commit/7691dda84655b0423599ee9a69640c9ab598759e))

## [1.7.2](https://github.com/LeafdTK/leaf/compare/server/v1.7.1...server/v1.7.2) (2026-06-25)


### Bug Fixes

* re-apply health check probes on deployment rebuild ([#61](https://github.com/LeafdTK/leaf/issues/61)) ([80a3d2e](https://github.com/LeafdTK/leaf/commit/80a3d2e19c4d9aeff54aeae360b310cc69873388))

## [1.7.1](https://github.com/LeafdTK/leaf/compare/server/v1.7.0...server/v1.7.1) (2026-06-23)


### Bug Fixes

* show webhook token banner on create ([#57](https://github.com/LeafdTK/leaf/issues/57)) ([e0d33f4](https://github.com/LeafdTK/leaf/commit/e0d33f4b5790cc1f31960378a7982de395b1e349))

## [1.7.0](https://github.com/LeafdTK/leaf/compare/server/v1.6.6...server/v1.7.0) (2026-06-23)


### Features

* pull git-lfs files in builder clone ([#55](https://github.com/LeafdTK/leaf/issues/55)) ([76f1c32](https://github.com/LeafdTK/leaf/commit/76f1c323f46f338123f6be974ccaa08fb4a485d9))

## [1.6.6](https://github.com/LeafdTK/leaf/compare/server/v1.6.5...server/v1.6.6) (2026-06-23)


### Bug Fixes

* migrate tenant ingress to haproxy class, drop lua redirect CEC ([#52](https://github.com/LeafdTK/leaf/issues/52)) ([1a5fd6b](https://github.com/LeafdTK/leaf/commit/1a5fd6ba7886dcdb5cc5c58c981b4ea92b14024c))

## [1.6.5](https://github.com/LeafdTK/leaf/compare/server/v1.6.4...server/v1.6.5) (2026-06-23)


### Bug Fixes

* add DB-level claim for recovery, prevent wrong-image deploy ([df258c2](https://github.com/LeafdTK/leaf/commit/df258c257cae404419b609c151389076623fcab1))
* add host and remote-node entities to allow-cilium-ingress CNP ([5eeaa8c](https://github.com/LeafdTK/leaf/commit/5eeaa8ccfe4a0648084e4aeb24d862952e060399))
* align build steps with frontend, fix NaN total duration from __jobName ([0ad95f9](https://github.com/LeafdTK/leaf/commit/0ad95f9fee2398e42617a827144738b3610d3839))
* don't mark build succeeded when k8s deployment missing, sort jobs by creation time ([9c83edd](https://github.com/LeafdTK/leaf/commit/9c83eddd69b9836916944c81bb5a714489daa9d1))
* keep cache export in sidecar push, run it after .done marker ([ce9caa5](https://github.com/LeafdTK/leaf/commit/ce9caa5f7fb8daa0b1c07538ea9455de8810c477))
* speed up post-build deploy, add build recovery on server restart ([4d0cd4c](https://github.com/LeafdTK/leaf/commit/4d0cd4c30183ccb8363dca9365352db909b211d4))
* wait for rollout before marking build as succeeded ([df2c74f](https://github.com/LeafdTK/leaf/commit/df2c74fe16c165c2ab4b232fd79fe0c16547eac6))


### Performance Improvements

* parallelize pre-build setup, reduce DB round trips in build pipeline ([2309a68](https://github.com/LeafdTK/leaf/commit/2309a680ecb6de3a33c2c0e7121feb2e6290c7e9))
* SSE-first polling, emit build step events, skip cache export for sidecar push ([4779a49](https://github.com/LeafdTK/leaf/commit/4779a4907b8d17920e36b6785c8a8061d6173346))

## [1.6.4](https://github.com/LeafdTK/leaf/compare/server/v1.6.3...server/v1.6.4) (2026-06-22)


### Bug Fixes

* allow allowance overcommit, reconcile k8s replicas on redeploy/restart ([9f0520b](https://github.com/LeafdTK/leaf/commit/9f0520bcb18cd398558b7acea0aa1696d7640a5e))

## [1.6.3](https://github.com/LeafdTK/leaf/compare/server/v1.6.2...server/v1.6.3) (2026-06-20)


### Bug Fixes

* protection proxy security + restyle to match platform ([#48](https://github.com/LeafdTK/leaf/issues/48)) ([018cf71](https://github.com/LeafdTK/leaf/commit/018cf71fa58195c2fb72e2ba4f0c3e645a2257be))

## [1.6.2](https://github.com/LeafdTK/leaf/compare/server/v1.6.1...server/v1.6.2) (2026-06-20)


### Bug Fixes

* replace CEC-based protection with reverse proxy through orchard server ([#45](https://github.com/LeafdTK/leaf/issues/45)) ([c916942](https://github.com/LeafdTK/leaf/commit/c91694205f6d1c1df0e5bcbaf7bfef2d30399e72))

## [1.6.1](https://github.com/LeafdTK/leaf/compare/server/v1.6.0...server/v1.6.1) (2026-06-20)


### Bug Fixes

* backendServices.number must be string array, not integer ([#43](https://github.com/LeafdTK/leaf/issues/43)) ([18594b1](https://github.com/LeafdTK/leaf/commit/18594b1e9859ebb44733300968ecd1755ef13ddf))

## [1.6.0](https://github.com/LeafdTK/leaf/compare/server/v1.5.2...server/v1.6.0) (2026-06-20)


### Features

* add deployment protection (password + orchard sign-in) ([#40](https://github.com/LeafdTK/leaf/issues/40)) ([a44e598](https://github.com/LeafdTK/leaf/commit/a44e598182c7dd64307b6983007cb7a5a75af0ff))

## [1.5.2](https://github.com/LeafdTK/leaf/compare/server/v1.5.1...server/v1.5.2) (2026-06-20)


### Bug Fixes

* add route_config to CECs, set force-https disabled on TLS ingresses ([#38](https://github.com/LeafdTK/leaf/issues/38)) ([f760c1f](https://github.com/LeafdTK/leaf/commit/f760c1fb62ebfb786a82ae1073d0d4b21e1468b7))

## [1.5.1](https://github.com/LeafdTK/leaf/compare/server/v1.5.0...server/v1.5.1) (2026-06-20)


### Bug Fixes

* replace force-https with per-service envoy lua redirect ([#36](https://github.com/LeafdTK/leaf/issues/36)) ([f24a517](https://github.com/LeafdTK/leaf/commit/f24a51762d04def745c1c83f1542917398cdef71))

## [1.5.0](https://github.com/LeafdTK/leaf/compare/server/v1.4.3...server/v1.5.0) (2026-06-20)


### Features

* migrate ingress from traefik to cilium ([#33](https://github.com/LeafdTK/leaf/issues/33)) ([6f56338](https://github.com/LeafdTK/leaf/commit/6f56338ad3fbc98378cff94c32caa42a368176f7))


### Bug Fixes

* add allow-cilium-ingress CNP to tenant namespace setup ([#35](https://github.com/LeafdTK/leaf/issues/35)) ([fc2a17d](https://github.com/LeafdTK/leaf/commit/fc2a17d79c2418c9046afa7ae75ba78a229da114))

## [1.4.3](https://github.com/LeafdTK/leaf/compare/server/v1.4.2...server/v1.4.3) (2026-06-20)


### Bug Fixes

* add sharing-cross-namespace annotation for cilium lb ipam ([#32](https://github.com/LeafdTK/leaf/issues/32)) ([5000dbe](https://github.com/LeafdTK/leaf/commit/5000dbef9e9e141cbb3b1dae1cbd4b064cd73ac2))
* use cilium lbipam sharing-key instead of metallb allow-shared-ip ([#30](https://github.com/LeafdTK/leaf/issues/30)) ([a7a29e8](https://github.com/LeafdTK/leaf/commit/a7a29e8bf269092afb1d0b6981ee4ec1b5aabc18))

## [1.4.2](https://github.com/LeafdTK/leaf/compare/server/v1.4.1...server/v1.4.2) (2026-06-20)


### Bug Fixes

* normalize .git suffix on github repo URLs for autodeploy matching ([#28](https://github.com/LeafdTK/leaf/issues/28)) ([8f3ba7d](https://github.com/LeafdTK/leaf/commit/8f3ba7d1335c4176033000c1acb40e1c95687674))

## [1.4.1](https://github.com/LeafdTK/leaf/compare/server/v1.4.0...server/v1.4.1) (2026-06-16)


### Bug Fixes

* observability dashboard uptime, HTTP stats, and multi-container logs ([#26](https://github.com/LeafdTK/leaf/issues/26)) ([1c7c18a](https://github.com/LeafdTK/leaf/commit/1c7c18afc9998ef4ea8ad0ddbecbdcac3d9b1948))

## [1.4.0](https://github.com/LeafdTK/leaf/compare/server/v1.3.0...server/v1.4.0) (2026-06-16)


### Features

* observability dashboard with runtime detection and error tracking ([#24](https://github.com/LeafdTK/leaf/issues/24)) ([c3b2bca](https://github.com/LeafdTK/leaf/commit/c3b2bca293bda8b1b7ca63210baa915f6b2c85b0))

## [1.3.0](https://github.com/LeafdTK/leaf/compare/server/v1.2.0...server/v1.3.0) (2026-06-16)


### Features

* show app version on user settings page ([#22](https://github.com/LeafdTK/leaf/issues/22)) ([26b0522](https://github.com/LeafdTK/leaf/commit/26b052287c7c3c4b0b7f32afa5b95c7d15c16dde))

## [1.2.0](https://github.com/LeafdTK/leaf/compare/server/v1.1.0...server/v1.2.0) (2026-06-16)


### Features

* production hardening — probes/HA, rate limiting, LICENSE ([#18](https://github.com/LeafdTK/leaf/issues/18)) ([3031369](https://github.com/LeafdTK/leaf/commit/303136918d186e601437ac4da26608ed1601236b))

## [1.1.0](https://github.com/LeafdTK/leaf/compare/server/v1.0.1...server/v1.1.0) (2026-06-16)


### Features

* SCIM 2.0 user/group provisioning ([#14](https://github.com/LeafdTK/leaf/issues/14)) ([eb242ee](https://github.com/LeafdTK/leaf/commit/eb242ee3cd19bc4b068a045d4772a4bcc17eefc0))

## [1.0.1](https://github.com/LeafdTK/leaf/compare/server/v1.0.0...server/v1.0.1) (2026-06-16)


### Bug Fixes

* allow dots in github repo names for deploy ([cb1364d](https://github.com/LeafdTK/leaf/commit/cb1364d0b83a7a613cd400a3556cd477e4aa48c9))

## 1.0.1 (2026-06-16)

### Fixes

- allow dots in github repo names for deploy
