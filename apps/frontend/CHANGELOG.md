# Changelog

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
