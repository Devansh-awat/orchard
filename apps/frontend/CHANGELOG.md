# Changelog

## [1.35.1](https://github.com/hackclub/orchard/compare/frontend/v1.35.0...frontend/v1.35.1) (2026-09-17)


### Bug Fixes

* list every branch in the branch pickers, not just the selected one ([0ebbf3c](https://github.com/hackclub/orchard/commit/0ebbf3c30a4fdf0c6d643d8f2463079ea5db05eb))
* slugify template name params instead of rejecting spaces ([0c856a1](https://github.com/hackclub/orchard/commit/0c856a1267e3a1da927ac87aa8246951c25f102e))

## [1.35.0](https://github.com/hackclub/orchard/compare/frontend/v1.34.0...frontend/v1.35.0) (2026-09-16)


### Features

* link domains to redirect to ([#72](https://github.com/hackclub/orchard/issues/72)) ([77c1c46](https://github.com/hackclub/orchard/commit/77c1c4682a024d9b6a21168da0097b399a9371f9))

## [1.34.0](https://github.com/hackclub/orchard/compare/frontend/v1.33.0...frontend/v1.34.0) (2026-09-16)


### Features

* **auth:** sign in with a host-minted link or a superadmin password ([3b6f20c](https://github.com/hackclub/orchard/commit/3b6f20c07bac939e25a0fa11a3eb2fbb8d5bca10))
* **setup:** offer a password where a passkey cannot be created ([9f9c8c7](https://github.com/hackclub/orchard/commit/9f9c8c7e25cf56c04f5ff17eaf257b12b1d4f8ac))

## [1.33.0](https://github.com/hackclub/orchard/compare/frontend/v1.32.0...frontend/v1.33.0) (2026-09-15)


### Features

* **frontend:** rebuild themes around a collaborative colour wheel ([5f4abfe](https://github.com/hackclub/orchard/commit/5f4abfe5165aba87c0313058971c02ca3040ef03))

## [1.32.0](https://github.com/hackclub/orchard/compare/frontend/v1.31.0...frontend/v1.32.0) (2026-09-15)


### Features

* **install:** let lan mode serve on ports other than 80 and 443 ([76f50ba](https://github.com/hackclub/orchard/commit/76f50ba8f077b67a39a5a228224a2b872214ada4))


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))

## [1.31.0](https://github.com/hackclub/orchard/compare/frontend/v1.30.0...frontend/v1.31.0) (2026-09-15)


### Features

* allow users to stop apps ([#61](https://github.com/hackclub/orchard/issues/61)) ([d45734a](https://github.com/hackclub/orchard/commit/d45734ad527fa868c0734c2c312c4db002803883))
* **frontend:** add database storage expansion controls ([#59](https://github.com/hackclub/orchard/issues/59)) ([773b815](https://github.com/hackclub/orchard/commit/773b8154ea0b5183f321199974d4414f3ec8ac74))


### Bug Fixes

* **frontend:** correct the stop confirm styling and the scale toast ([ef935b0](https://github.com/hackclub/orchard/commit/ef935b0890bacf1c32614df4e9738e355bbcd6cc))
* **frontend:** survive an empty storage expand response ([76a4c6e](https://github.com/hackclub/orchard/commit/76a4c6e3fbd03179142eca8c87203429e292ba6c))

## [1.30.0](https://github.com/hackclub/orchard/compare/frontend/v1.29.0...frontend/v1.30.0) (2026-09-15)


### Features

* let superadmins create unlimited sandboxes ([d30164e](https://github.com/hackclub/orchard/commit/d30164e70d2978c7c8aa776d9ef01979b7c11596))


### Bug Fixes

* measure sandbox max lifetime from the current run, not the row's age ([f8eb41c](https://github.com/hackclub/orchard/commit/f8eb41c10f87fee6ec68840e7eabc5357c3ed668))

## [1.29.0](https://github.com/hackclub/orchard/compare/frontend/v1.28.2...frontend/v1.29.0) (2026-09-15)


### Features

* **frontend:** mouse, paste, zoom, titles and a settings menu for the pod shell ([1817925](https://github.com/hackclub/orchard/commit/181792550b2984c93e2be4cd595188145fb7b725))
* **frontend:** predictive local echo for the pod shell ([9fc5f56](https://github.com/hackclub/orchard/commit/9fc5f567c574aa86c60b121e8b3cb2ab3c65672c))
* **frontend:** render terminals in jetbrains mono ([bc8feaa](https://github.com/hackclub/orchard/commit/bc8feaaae5da4677964749d08c78c0518c9a625e))
* **server:** durable pod shell sessions that survive a dropped connection ([89309ff](https://github.com/hackclub/orchard/commit/89309ff9f0d0a5b8843879ce0b11e63829714be1))


### Bug Fixes

* **frontend:** keep pod shells alive across console tabs and guard stale sockets ([2e421a5](https://github.com/hackclub/orchard/commit/2e421a53a15f1ba5dbb19d837a583d9817913b1d))
* **frontend:** render the terminal in the system mono instead of space mono ([f537274](https://github.com/hackclub/orchard/commit/f537274a83d4667b02f7f3a532ac987cfe2bfcec))
* **server:** exec text frames are control only, real upstream backpressure, forced resize ([54a88fc](https://github.com/hackclub/orchard/commit/54a88fc52697e4f88d27e6929e0ce4edb0bc7e1f))

## [1.28.2](https://github.com/hackclub/orchard/compare/frontend/v1.28.1...frontend/v1.28.2) (2026-09-15)


### Bug Fixes

* **frontend:** stop swallowing every keystroke in the pod shell ([b3be0bb](https://github.com/hackclub/orchard/commit/b3be0bbecf9cd9f6179eb0407cfb4aef453e1660))
* **server:** stop the pod shell reconnect loop and surface exec failures ([a6ef5bd](https://github.com/hackclub/orchard/commit/a6ef5bdd61c5e2a33d7e545ccff84eb5ecd2600a))

## [1.28.1](https://github.com/hackclub/orchard/compare/frontend/v1.28.0...frontend/v1.28.1) (2026-09-15)


### Bug Fixes

* **frontend:** make the live logs button actually follow ([69ef413](https://github.com/hackclub/orchard/commit/69ef413c0e607c423f3cda8275f6e9c40f3a7049))

## [1.28.0](https://github.com/hackclub/orchard/compare/frontend/v1.27.3...frontend/v1.28.0) (2026-09-15)


### Features

* make consoles follow the theme and improve log timestamps ([#52](https://github.com/hackclub/orchard/issues/52)) ([586d4d7](https://github.com/hackclub/orchard/commit/586d4d7a118820d3e34ecb46c0faeb9e7ee448c0))
* **server:** make the pod shell fast, reconnecting and colour-capable ([d428970](https://github.com/hackclub/orchard/commit/d428970618d3b9232c53781f8a468bd9428ca239))
* **server:** tell people when something signs in to their account ([f18f117](https://github.com/hackclub/orchard/commit/f18f117d079399033c5100a2515ae1a3ccbf5ac5))


### Bug Fixes

* **server:** give the pod shell its real size, a heartbeat and no nagle ([254dc97](https://github.com/hackclub/orchard/commit/254dc970ecc17a8d2b8b3e104a47bb9df998abf4))

## [1.27.3](https://github.com/hackclub/orchard/compare/frontend/v1.27.2...frontend/v1.27.3) (2026-09-14)


### Bug Fixes

* make the setup flow honest about github and app domains ([fe028da](https://github.com/hackclub/orchard/commit/fe028daf2ad22cbefec9a7d325567703ed529a61))

## [1.27.2](https://github.com/hackclub/orchard/compare/frontend/v1.27.1...frontend/v1.27.2) (2026-09-14)


### Bug Fixes

* **frontend:** restore the setup overture's original pacing ([cf9cae5](https://github.com/hackclub/orchard/commit/cf9cae5ac39e37094e31478c5d58055905672745))

## [1.27.1](https://github.com/hackclub/orchard/compare/frontend/v1.27.0...frontend/v1.27.1) (2026-09-14)


### Bug Fixes

* **frontend:** let the setup scene land instead of cutting to the card ([eeb983d](https://github.com/hackclub/orchard/commit/eeb983da42d9cb21976a0a4657252df4553602c7))

## [1.27.0](https://github.com/hackclub/orchard/compare/frontend/v1.26.1...frontend/v1.27.0) (2026-09-14)


### Features

* probe apps with the HEALTHCHECK their Dockerfile declares ([#44](https://github.com/hackclub/orchard/issues/44)) ([4afc98b](https://github.com/hackclub/orchard/commit/4afc98b71eaf5e83ed2d4135c29c54cb43b00fde))


### Bug Fixes

* **frontend:** make the setup logo petals actually appear ([dd6e533](https://github.com/hackclub/orchard/commit/dd6e5333988b9e2c6f8d5a3fa6839ed7e2c28b42))
* **frontend:** show the project icon you set, on the tile you set it for ([#45](https://github.com/hackclub/orchard/issues/45)) ([93f873e](https://github.com/hackclub/orchard/commit/93f873e347594867772d9d8e3a48fe9452cd8615))
* **server:** make a deployment's secret env vars write-only and encrypted at rest ([d5f82d9](https://github.com/hackclub/orchard/commit/d5f82d99b07ddfabd8995fcf96c37ae8875c25fb))

## [1.26.1](https://github.com/hackclub/orchard/compare/frontend/v1.26.0...frontend/v1.26.1) (2026-09-11)


### Bug Fixes

* stop blaming capacity for every failed scheduling event ([97d8347](https://github.com/hackclub/orchard/commit/97d834719d323e7cad829af4e497d702e810f6f6))

## [1.26.0](https://github.com/hackclub/orchard/compare/frontend/v1.25.0...frontend/v1.26.0) (2026-09-11)


### Features

* check dns for every hostname and configure cloudflare tunnel routes ([00be104](https://github.com/hackclub/orchard/commit/00be1041de3e9e0910cf44d1812c5f0bb6354865))

## [1.25.0](https://github.com/hackclub/orchard/compare/frontend/v1.24.1...frontend/v1.25.0) (2026-09-11)


### Features

* auto-configure the mcp endpoint and an instance-wide public ip ([46c7bbc](https://github.com/hackclub/orchard/commit/46c7bbc9d9a439a664244f514228a3b974700b40))

## [1.24.1](https://github.com/hackclub/orchard/compare/frontend/v1.24.0...frontend/v1.24.1) (2026-09-10)


### Bug Fixes

* stop creating an empty project just for opening the deploy form ([f2e03f1](https://github.com/hackclub/orchard/commit/f2e03f1fafb658c87f6a13cf80eff57451195ec6))

## [1.24.0](https://github.com/hackclub/orchard/compare/frontend/v1.23.0...frontend/v1.24.0) (2026-09-09)


### Features

* configure object storage, email, domains and wildcard tls from the admin panel ([a1f4e02](https://github.com/hackclub/orchard/commit/a1f4e023fef2fd988e5197730091b89149fdb44a))

## [1.23.0](https://github.com/hackclub/orchard/compare/frontend/v1.22.1...frontend/v1.23.0) (2026-09-09)


### Features

* make the admin panel usable on self-hosted instances ([ba8ec59](https://github.com/hackclub/orchard/commit/ba8ec591e2a7ac041d71df946d7aed0ab4892cc4))
* rebuild the first-run setup flow ([b0d3930](https://github.com/hackclub/orchard/commit/b0d3930c7937845cdde9d74b602baa86d31d9260))

## [1.22.1](https://github.com/hackclub/orchard/compare/frontend/v1.22.0...frontend/v1.22.1) (2026-09-07)


### Bug Fixes

* ensure the organization on every claim path ([0789188](https://github.com/hackclub/orchard/commit/0789188534d409e1a3725fef8a1fb96d9e04d2ca))

## [1.22.0](https://github.com/hackclub/orchard/compare/frontend/v1.21.1...frontend/v1.22.0) (2026-09-07)


### Features

* blocking first-run setup gate ([c1dca7d](https://github.com/hackclub/orchard/commit/c1dca7db0388b1cfeda69499e9562ed69824d0d7))
* instance setup checklist in the admin area ([a80146e](https://github.com/hackclub/orchard/commit/a80146ee5541e34c0e9ec3e9171c2bc8d76d986d))


### Bug Fixes

* hold release notes until onboarding is done ([1a33f8c](https://github.com/hackclub/orchard/commit/1a33f8c82a6f72c9b293749ec86b996a8d5d5d1b))
* send a freshly claimed instance into the setup flow ([1cae1b4](https://github.com/hackclub/orchard/commit/1cae1b40c5991979430ebbdd3bbce28293406896))

## [1.21.1](https://github.com/hackclub/orchard/compare/frontend/v1.21.0...frontend/v1.21.1) (2026-09-05)


### Bug Fixes

* let the claim page load when signed out ([1ee2f07](https://github.com/hackclub/orchard/commit/1ee2f07570bc0647343cd30451674b8557a7299b))

## [1.21.0](https://github.com/hackclub/orchard/compare/frontend/v1.20.1...frontend/v1.21.0) (2026-09-05)


### Features

* claim an instance without email and sign in from the claim link ([b260bb6](https://github.com/hackclub/orchard/commit/b260bb6c55aa8fcfb2fecef3134525a2932af871))

## [1.20.1](https://github.com/hackclub/orchard/compare/frontend/v1.20.0...frontend/v1.20.1) (2026-09-04)


### Bug Fixes

* derive platform domains from config instead of hardcoding them ([ad585dd](https://github.com/hackclub/orchard/commit/ad585dd681bd5d796a88bc72e9f8f397e44ef803))

## [1.20.0](https://github.com/hackclub/orchard/compare/frontend/v1.19.0...frontend/v1.20.0) (2026-09-04)


### Features

* per-app pod disruption budget in deploy behavior ([e145faa](https://github.com/hackclub/orchard/commit/e145faaa7816b61c2a48a0184fd4d95788921778))


### Bug Fixes

* use the ui button in the disruption budget card ([fa54760](https://github.com/hackclub/orchard/commit/fa54760ac40a585da5376cc86597d091ce07d96d))

## [1.19.0](https://github.com/hackclub/orchard/compare/frontend/v1.18.0...frontend/v1.19.0) (2026-09-04)


### Features

* warn when auto-deploy is enabled but not connected ([e4453d3](https://github.com/hackclub/orchard/commit/e4453d3f279dc5b29ca562ea0eeff5d95a91422a))

## [1.18.0](https://github.com/hackclub/orchard/compare/frontend/v1.17.2...frontend/v1.18.0) (2026-09-03)


### Features

* deploy templates from a github repo and add the nephthys template ([6716e15](https://github.com/hackclub/orchard/commit/6716e15cab546aea6ae30d8b8b71f91d4e21c216))
* move a project to another organization ([e878cc4](https://github.com/hackclub/orchard/commit/e878cc4a065ab03d9d976db7d5373537283a2660))
* switch a deployment between railpack and dockerfile builds ([c179afb](https://github.com/hackclub/orchard/commit/c179afbaf6a6fd0f26c7ef6f7010a0e61d958266))


### Bug Fixes

* stop database detail page blanking on background refetch ([60c5e49](https://github.com/hackclub/orchard/commit/60c5e495161b0b37f85576e854d204046808a52b))

## [1.17.2](https://github.com/hackclub/orchard/compare/frontend/v1.17.1...frontend/v1.17.2) (2026-09-03)


### Bug Fixes

* create deployments, databases and compose stacks in the selected environment ([166af35](https://github.com/hackclub/orchard/commit/166af35a79104df14617d19819c29727dccca700))
* **frontend:** hide new project option from org guests ([ee387a9](https://github.com/hackclub/orchard/commit/ee387a9cdac72b25df80ed0e03ffa83d426faae8))

## [1.17.1](https://github.com/hackclub/orchard/compare/frontend/v1.17.0...frontend/v1.17.1) (2026-09-02)


### Bug Fixes

* **frontend:** show queued and superseded deploys in the deploys list ([428ea73](https://github.com/hackclub/orchard/commit/428ea7319c1df73a2e62f2254a5aaf33821624bd))

## [1.17.0](https://github.com/hackclub/orchard/compare/frontend/v1.16.1...frontend/v1.17.0) (2026-09-01)


### Features

* watch paths for github auto-deploy ([06b1e44](https://github.com/hackclub/orchard/commit/06b1e4426655bb2c40ea32c7a2a6b33641f2b862))


### Bug Fixes

* sanitize agent markdown before rendering it ([c7ff93d](https://github.com/hackclub/orchard/commit/c7ff93dfbcebf3fc4522c4871bbb01bd07d2bf2b))

## [1.16.1](https://github.com/hackclub/orchard/compare/frontend/v1.16.0...frontend/v1.16.1) (2026-09-01)


### Bug Fixes

* dont fire icon animations below the full motion tier ([#2](https://github.com/hackclub/orchard/issues/2)) ([0adb5d6](https://github.com/hackclub/orchard/commit/0adb5d600d377c97756a4e0009720b462306feac))

## [1.16.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.15.0...frontend/v1.16.0) (2026-08-28)


### Features

* rebuild the usage page around what you have left to spend ([e8c040d](https://github.com/LeafdTK/leaf/commit/e8c040d4b6573104bea14ccfb34a517690cf78b1))
* transfer project ownership by request and accept ([36bf9a7](https://github.com/LeafdTK/leaf/commit/36bf9a761fd7ae0e4df84e29fe6e11ac09a70e37))


### Bug Fixes

* drop the deleted project from the overview cache before leaving the page ([7b46f64](https://github.com/LeafdTK/leaf/commit/7b46f6408011e9aa16293e53384e2126271cdcb1))
* move the command line entry into the sidebar menu that renders ([2defda8](https://github.com/LeafdTK/leaf/commit/2defda8d5110241e60fe28bd9740ad345de4b7bc))
* share one cluster snapshot instead of four full pod lists ([3e3bdc8](https://github.com/LeafdTK/leaf/commit/3e3bdc8d7fda779e897d2bea7e80f4eac21aa6e1))

## [1.15.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.14.0...frontend/v1.15.0) (2026-08-27)


### Features

* database health is informer-driven with crash alerts and post-mortem logs ([06fc147](https://github.com/LeafdTK/leaf/commit/06fc147d20cf8a0a203ca3dbf11e8c665690bac7))
* next steps checklist on the app overview ([b6566b8](https://github.com/LeafdTK/leaf/commit/b6566b8addff2a5b66285216b59788be28bc54c0))
* per-app image pull policy so restart can re-pull a moving tag ([3253561](https://github.com/LeafdTK/leaf/commit/3253561ac68c450d345a38656f23ea4da55fd1e1))
* pull policy follows the image tag unless you pin it ([e5fb253](https://github.com/LeafdTK/leaf/commit/e5fb2532139cf419cf63075060b4872e768537c9))
* surface kubernetes pod events and fix stale ui after saves ([5a2a9da](https://github.com/LeafdTK/leaf/commit/5a2a9da9bff50f80fd6cb029dd6e6d0706677a7d))
* surface the orchard cli inside the dashboard ([d302283](https://github.com/LeafdTK/leaf/commit/d302283633ae8b7370bf3e5948de78a092839cd2))


### Bug Fixes

* size shared_buffers and backup compression from the memory limit ([95d1c77](https://github.com/LeafdTK/leaf/commit/95d1c77041e3d400720bbf1986ef4c661762bd75))

## [1.14.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.13.0...frontend/v1.14.0) (2026-08-25)


### Features

* dns-verified org domains, tenant-scoped sso sessions, sso off by default ([61eeaa7](https://github.com/LeafdTK/leaf/commit/61eeaa7716bad680433f7fdc93d1f7f87506b796))

## [1.13.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.12.0...frontend/v1.13.0) (2026-08-24)


### Features

* multi-provider sso with org login pages and per-org admin controls ([00cc117](https://github.com/LeafdTK/leaf/commit/00cc1172b6cbf07c896f9dfe641b997f08686e07))


### Bug Fixes

* style the mcp and cli consent pages against the design system ([153103c](https://github.com/LeafdTK/leaf/commit/153103c3f514c3d81d8ac330bc509db081ed82c4))

## [1.12.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.11.0...frontend/v1.12.0) (2026-08-24)


### Features

* show the internal cluster address under every port ([7f77da8](https://github.com/LeafdTK/leaf/commit/7f77da80f41be677ec7acdcfc361ffcfc0542c62))

## [1.11.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.10.0...frontend/v1.11.0) (2026-08-24)


### Features

* 191 mascots plus hue variations so avatars stop colliding ([4eb64ea](https://github.com/LeafdTK/leaf/commit/4eb64ea5a8958a9f9b06c66cd4bcd5afbb20584f))


### Bug Fixes

* call them read replicas, not standbys ([168256f](https://github.com/LeafdTK/leaf/commit/168256fdf83841997f501fb1cc9af39ccf44d1bd))

## [1.10.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.9.0...frontend/v1.10.0) (2026-08-24)


### Features

* everyone gets a mascot for a default profile picture ([73eaa67](https://github.com/LeafdTK/leaf/commit/73eaa6753645611a2c18a220110d40537252dbfd))
* managed databases can run standby replicas ([f0c0ab3](https://github.com/LeafdTK/leaf/commit/f0c0ab3c2e425fe59605c71a9b34c9a6621bec5a))

## [1.9.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.8.0...frontend/v1.9.0) (2026-08-20)


### Features

* a fresh instance mints a setup token to claim superadmin ([a3742b9](https://github.com/LeafdTK/leaf/commit/a3742b98ae987937ffa4fef7061c651f6b351757))
* github app is created through the manifest flow instead of six pasted values ([a81f05c](https://github.com/LeafdTK/leaf/commit/a81f05c6eeaa5a81b410d3a7682f2c09e1023170))

## [1.8.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.7.1...frontend/v1.8.0) (2026-08-18)


### Features

* command-k finds every app and database a person built ([607324f](https://github.com/LeafdTK/leaf/commit/607324f4b48a258eb9494179795cd937d4b77ae9))


### Bug Fixes

* a running pod waiting on its health check said scheduled ([dbb5085](https://github.com/LeafdTK/leaf/commit/dbb508525e4dc847adfd54439a22edd13deef449))

## [1.7.1](https://github.com/LeafdTK/leaf/compare/frontend/v1.7.0...frontend/v1.7.1) (2026-08-16)


### Bug Fixes

* app settings keep the previous app's values when switching mid-build ([64eeb32](https://github.com/LeafdTK/leaf/commit/64eeb324d7c5432bb9115c7fc8794e1ae3dee525))
* app settings left blank when the page opens during a build ([b09cf5a](https://github.com/LeafdTK/leaf/commit/b09cf5a40d0cb8b3b9e52f1dba263e95208b0a13))

## [1.7.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.6.0...frontend/v1.7.0) (2026-08-15)


### Features

* notification channels can belong to one app instead of the whole org ([0ce6747](https://github.com/LeafdTK/leaf/commit/0ce6747bf35e020a73e5e4a77bb9781172349df1))

## [1.6.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.5.1...frontend/v1.6.0) (2026-08-14)


### Features

* public paths skip the domain auth wall ([6b5283b](https://github.com/LeafdTK/leaf/commit/6b5283b24dcd766551a0162576e7e88224490ad6))


### Bug Fixes

* marking an env var secret needs tenant secrets rbac ([e6cb59b](https://github.com/LeafdTK/leaf/commit/e6cb59b315ecaa95a923d6631042b7671f6274cc))

## [1.5.1](https://github.com/LeafdTK/leaf/compare/frontend/v1.5.0...frontend/v1.5.1) (2026-08-12)


### Bug Fixes

* relative timestamps tick in realtime ([7f3859b](https://github.com/LeafdTK/leaf/commit/7f3859b15d5a84073ea62e53f68778b839d7c27d))

## [1.5.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.4.1...frontend/v1.5.0) (2026-08-12)


### Features

* reads served from the postgres mirror with live escape hatches ([a2b60b5](https://github.com/LeafdTK/leaf/commit/a2b60b5878933a8c19a5e3bd34b25e8f834c200d))
* retrying apply queue takes kubernetes writes out of the request path ([6860c1b](https://github.com/LeafdTK/leaf/commit/6860c1b275dffc5776e90d35a55fec6e044af8c4))

## [1.4.1](https://github.com/LeafdTK/leaf/compare/frontend/v1.4.0...frontend/v1.4.1) (2026-08-08)


### Bug Fixes

* node pool selector inputs collapsed to zero width in flex rows ([058179d](https://github.com/LeafdTK/leaf/commit/058179d1e1b204ab55458f2d35fc3326098d288e))

## [1.4.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.3.0...frontend/v1.4.0) (2026-08-08)


### Features

* node pools, taints, and workflow affinity scheduling ([a96caf3](https://github.com/LeafdTK/leaf/commit/a96caf3b8b1d7aa3d7d7116b8361cf2628dc3b83))

## [1.3.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.2.1...frontend/v1.3.0) (2026-08-08)


### Features

* apply apple design polish to icons, cmd+k, and sidebar ([a1d0e8d](https://github.com/LeafdTK/leaf/commit/a1d0e8daadf97c90a5cbc8e21f592d9d2f35e5fd))


### Bug Fixes

* allow fractional cpu and memory in the resource picker ([63ef2d6](https://github.com/LeafdTK/leaf/commit/63ef2d6f328c6d463034837fd23539f62f458158))
* never ship wal without a backup schedule behind it ([a74fe22](https://github.com/LeafdTK/leaf/commit/a74fe22d85d3438bc06f6d92970b0f76b37847cb))

## [1.2.1](https://github.com/LeafdTK/leaf/compare/frontend/v1.2.0...frontend/v1.2.1) (2026-08-06)


### Bug Fixes

* sandbox boot progress, optimistic actions, terminal tabs, and layout polish ([0820116](https://github.com/LeafdTK/leaf/commit/0820116267467cc07a1e14bb1980bcf1f3b007d4))

## [1.2.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.1.0...frontend/v1.2.0) (2026-08-05)


### Features

* scope sandboxes to organizations with role based access ([7ae69e6](https://github.com/LeafdTK/leaf/commit/7ae69e67cbbf8b5d708b6e1a04f042d55975fabe))

## [1.1.0](https://github.com/LeafdTK/leaf/compare/frontend/v1.0.0...frontend/v1.1.0) (2026-08-05)


### Features

* bootstrap sandboxes from stock debian with setup scripts ([05a266a](https://github.com/LeafdTK/leaf/commit/05a266a1bbfbb66bebfc6204e5088306112d898b))
* conductor style workspace and multi repo sandboxes ([96d1dd4](https://github.com/LeafdTK/leaf/commit/96d1dd49925225dc902afb0332cbdde973a6fbd5))
* enable sandboxes by default in dev ([25b367f](https://github.com/LeafdTK/leaf/commit/25b367fd8872f89ee2ec6e858b5a40a5b44d526b))
* file explorer, git panel, and code editor in sandbox workspace ([b6086ab](https://github.com/LeafdTK/leaf/commit/b6086ab5fb6acc38393cb701a4e4b5b8c8cd3cf8))
* full git operations for sandbox workspace ([c7f2b75](https://github.com/LeafdTK/leaf/commit/c7f2b754822fe2f46660823ae482a39c7c95d095))
* greenhouse ai sandboxes ([31e2325](https://github.com/LeafdTK/leaf/commit/31e23252b882f05daba9740df85bc621c8c93002))
* ide style cloud code workspace with live git changes ([0126efa](https://github.com/LeafdTK/leaf/commit/0126efa1eab06f9b5509912afc45725a6f68b967))
* live terminal panel in sandbox workspace ([dabb0e2](https://github.com/LeafdTK/leaf/commit/dabb0e23fad62aa5fe11783b9ecafc2ef9730255))
* opencode serve harness with proxy and native chat sessions ([e520d80](https://github.com/LeafdTK/leaf/commit/e520d80bf85c3c830b4b1653745f5d9f01334c6e))
* orchard mcp by default plus git and file endpoints ([9396499](https://github.com/LeafdTK/leaf/commit/93964994070821a51e61e6e7674b9ef87befbb71))
* sandbox cards, ssh identities, and cloud code chat ([e09fa8e](https://github.com/LeafdTK/leaf/commit/e09fa8ea3ae7d18ab405f53e0f1e80f38405901c))
* sandbox conversations with disk backed history and markdown transcript ([1032977](https://github.com/LeafdTK/leaf/commit/10329772860dbc5d9f5da9d7b11243bcb0c7a622))
* sandbox terminal websocket over pod exec ([5ae3a2c](https://github.com/LeafdTK/leaf/commit/5ae3a2cdbfbe6458616dd8beb873feeede2d67b1))


### Bug Fixes

* argv chat prompt and gate greenhouse behind posthog flag ([3fc34d5](https://github.com/LeafdTK/leaf/commit/3fc34d596aa51af7742370f8c3f215514355bd53))
* surface sandbox k8s errors and show status message in list ([a31e74e](https://github.com/LeafdTK/leaf/commit/a31e74e2aea830f0824a86518ace9505ce98289c))

## [1.0.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.32.1...frontend/v1.0.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* ui version 2.0 ([#150](https://github.com/LeafdTK/leaf/issues/150))

### Features

* ui version 2.0 ([#150](https://github.com/LeafdTK/leaf/issues/150)) ([12878ec](https://github.com/LeafdTK/leaf/commit/12878ec3e5987942f20bebc64bea06a56a189857))

## [0.32.1](https://github.com/LeafdTK/leaf/compare/frontend/v0.32.0...frontend/v0.32.1) (2026-07-29)


### Bug Fixes

* allow removing an org member who is the sole admin of a project ([3497ad6](https://github.com/LeafdTK/leaf/commit/3497ad6d30028378d92df0c0bcefb8988f4cefed))

## [0.32.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.31.0...frontend/v0.32.0) (2026-07-28)


### Features

* **frontend:** add a direct link option to the repo account picker ([8344f75](https://github.com/LeafdTK/leaf/commit/8344f7552a84f867ad8bfe61692255ff6a0f21e1))
* **frontend:** auto-expand build settings for dockerfile and add a disclosure chevron ([366cf7e](https://github.com/LeafdTK/leaf/commit/366cf7e07d2414b72ac1d78a1010b60fc8a49729))
* **frontend:** surface that build settings override a repo railpack.json ([5f21011](https://github.com/LeafdTK/leaf/commit/5f21011b3a6163b57bc9b77df520155ada1aecb4))

## [0.31.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.30.0...frontend/v0.31.0) (2026-07-28)


### Features

* **frontend:** framework picker and build settings in the create flow ([bbd6791](https://github.com/LeafdTK/leaf/commit/bbd6791bcb994c217f0fd26277bc309d5e4d709a))


### Bug Fixes

* **frontend:** drop the favicon mesh wash from the build progress page ([8a52c89](https://github.com/LeafdTK/leaf/commit/8a52c894bbb99b34210a983f89fe2df980da54fe))
* **frontend:** show projects on the dashboard when they have no deployments ([6485beb](https://github.com/LeafdTK/leaf/commit/6485bebcc8648f80da543c8ff0bdb8557ae8e1ea))
* **ui:** revive dead global rules, invisible skeletons and nested dropdown scrolling ([e4380bc](https://github.com/LeafdTK/leaf/commit/e4380bc2d411dbea2bcd7ecbb1f9b749d918ce0f))

## [0.30.0](https://github.com/LeafdTK/leaf/compare/frontend/v0.29.0...frontend/v0.30.0) (2026-07-22)


### Features

* auto-generated protected url on deployment create ([ad7b7d2](https://github.com/LeafdTK/leaf/commit/ad7b7d2a5be0319cef570e6b8fb7ddd80aeaefd9))
* create form notes auto deploy on branch pushes ([1dce9eb](https://github.com/LeafdTK/leaf/commit/1dce9ebd3a277e10923ff0e06e1727285e2c9af7))
* hero restored as fixed header, rail and content detached ([eed91d3](https://github.com/LeafdTK/leaf/commit/eed91d36a9fbb634fcb41ac83de823337e8dfc5c))
* live build log streaming over sse ([32e8b2f](https://github.com/LeafdTK/leaf/commit/32e8b2f4aadd4fbe66c61cbdea658ca4033a4cf5))
* one-shot github import endpoint and orchard import ([70398a2](https://github.com/LeafdTK/leaf/commit/70398a2efac3300e7400b951a7cca016ca351fc6))
* repo-first create form with detection summary ([d5db91c](https://github.com/LeafdTK/leaf/commit/d5db91cbd1de0666c8adfb679f359e1dc83820f8))
* runtime log streaming over sse and event-driven metrics refresh ([81dc35f](https://github.com/LeafdTK/leaf/commit/81dc35fc16953aba8a58d3a60f6e70899d33806c))
* settings without hero, tab pane scrolls internally ([fa2f690](https://github.com/LeafdTK/leaf/commit/fa2f69030966a81807f907614707282f8b1a149d))
* split repo selector into account and repo pickers ([15fe925](https://github.com/LeafdTK/leaf/commit/15fe9257c9515da60ef01ed5a72b99b5293ba97d))
* stepper and toggle rows for advanced section ([830aa62](https://github.com/LeafdTK/leaf/commit/830aa626c53f14ec86b6cc707401bb3123abbd32))
* swatch grid appearance tab, sticky hero and rail ([2b9d2bb](https://github.com/LeafdTK/leaf/commit/2b9d2bb8f79a057af95ca842f53b7b7d5f0962d2))
* ui togglerow component, sized owner row, tighter url copy ([3c07c9c](https://github.com/LeafdTK/leaf/commit/3c07c9cecd7bbf0e4c1f8e631ac6a680b7d582ce))
* unified user settings tabs, three new built-in themes ([efcee2f](https://github.com/LeafdTK/leaf/commit/efcee2ff7b81c0c41048052202bf71643895471e))
* zero-config repo detection endpoint and create form pre-fill ([53ebf72](https://github.com/LeafdTK/leaf/commit/53ebf72057e7b859b64526db9f569f084e4d34ee))


### Bug Fixes

* drop empty profile tab hint ([61616fb](https://github.com/LeafdTK/leaf/commit/61616fbd1f3927b06230e760a3fe5f148f2afbc0))
* equal heights for account and repo pickers ([d5ded5d](https://github.com/LeafdTK/leaf/commit/d5ded5da0ae177e002a8dc58352e7df60fd59539))
* resolve sub to uuid in project member filters, creamy card hover ([c71be35](https://github.com/LeafdTK/leaf/commit/c71be35e01850e73f5233eb0b66d1995cd756560))
* tidy source card, footer treatment for project name row ([b426f6e](https://github.com/LeafdTK/leaf/commit/b426f6e942067cd022d4689530391856b931bfb4))

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
