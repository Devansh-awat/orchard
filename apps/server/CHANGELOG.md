# Changelog

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
