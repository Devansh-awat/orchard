# Changelog

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
