# Changelog

## [2.56.0](https://github.com/hackclub/orchard/compare/server/v2.55.0...server/v2.56.0) (2026-10-07)


### Features

* add registry credentials from the image card and require encryption at rest for tokens ([e697d5d](https://github.com/hackclub/orchard/commit/e697d5d624636481a7a4fab3aa6254361062f9e7))

## [2.55.0](https://github.com/hackclub/orchard/compare/server/v2.54.1...server/v2.55.0) (2026-10-07)


### Features

* per-project registry credentials for pulling private images ([3b28852](https://github.com/hackclub/orchard/commit/3b28852869cb2d343ad8c534e6962a4757392ef1))

## [2.54.1](https://github.com/hackclub/orchard/compare/server/v2.54.0...server/v2.54.1) (2026-10-06)


### Bug Fixes

* namespace sync only prunes its own namespace and the mirror drops ingress rows the cluster lost ([7684945](https://github.com/hackclub/orchard/commit/76849455a892d3683554b0bc26ad20cb8e90b798))

## [2.54.0](https://github.com/hackclub/orchard/compare/server/v2.53.0...server/v2.54.0) (2026-10-04)


### Features

* **mcp:** accept API tokens as bearer credentials ([3e28db5](https://github.com/hackclub/orchard/commit/3e28db5e4be3f189e9903805e221bb3ba4a5c89e))

## [2.53.0](https://github.com/hackclub/orchard/compare/server/v2.52.0...server/v2.53.0) (2026-10-04)


### Features

* a database near a full disk goes read-only instead of growing or dying ([8558b0f](https://github.com/hackclub/orchard/commit/8558b0f1fae04e23b98965cbff966171ef60d408))
* databases grow their volume before it fills, and never go unwatched ([a0e2815](https://github.com/hackclub/orchard/commit/a0e28153ba05816b1524818e12f4c828f1cb5a63))
* pause live logs while idle and hidden ([#112](https://github.com/hackclub/orchard/issues/112)) ([afb0cbe](https://github.com/hackclub/orchard/commit/afb0cbe2ad7428dfbcfacd98c6a7631a5c4cc8b7))


### Bug Fixes

* backup endpoints must be full urls, and organizations on the instance bucket keep going through the r2-proxy ([0f1a5bb](https://github.com/hackclub/orchard/commit/0f1a5bb41de2333695a04b949cdd7d8cf3ee34a0))
* backup targets are repaired on the leader and probed on save ([7203e5d](https://github.com/hackclub/orchard/commit/7203e5d66a680ab22239949b5f6ca3eed57aa9c3))

## [2.52.0](https://github.com/hackclub/orchard/compare/server/v2.51.3...server/v2.52.0) (2026-09-30)


### Features

* opt-in anonymous usage reports for self-hosted instances ([91bbb19](https://github.com/hackclub/orchard/commit/91bbb19010cb72518a09b1556740b16347aa9823))


### Bug Fixes

* cap domains per app and per project ([acd3203](https://github.com/hackclub/orchard/commit/acd320334579d3f4ba30c8543e67d90f581233c8))
* caps on streams, uploads, env payloads and mcp oauth ([741a874](https://github.com/hackclub/orchard/commit/741a874e255c89d0815f17d819878cd624f4ce92))
* cross-site cookie mutations get a 403, not a 401 or 500 ([817f6a2](https://github.com/hackclub/orchard/commit/817f6a2a7ed97bdd836b71cd1b9a6d340f5b6dd3))
* database storage expansion resizes volumes directly, wal archives in parallel, disk pressure alerts ([577c5a4](https://github.com/hackclub/orchard/commit/577c5a47bf050d700f31fa5c85ba91d99f555edc))
* moving a project needs delete rights, demoted owners cannot transfer it, mcp acting users own their session ([1fc1e74](https://github.com/hackclub/orchard/commit/1fc1e748ad3992f04618aec5e4a4476e826965cd))
* only browser sessions pass the guard, refresh tokens rotate for real ([3209660](https://github.com/hackclub/orchard/commit/32096603c2a721870503dec6d93495f39eaeb6d3))
* otp stays out of logs, scim cannot mint owners, deeper audit redaction ([912db6a](https://github.com/hackclub/orchard/commit/912db6ad1a2c22a860744d65c662d99ae7515c8e))
* rate limit invitations per recipient and per organization ([d45c854](https://github.com/hackclub/orchard/commit/d45c854b23b3c820a02bb913e439dbd372a203be))
* stored credentials are encrypted at rest ([77409e2](https://github.com/hackclub/orchard/commit/77409e22f0339d7775a83fb79d5773d0ff5af49f))
* the builder role only grants what the server holds, so builds create their job again ([3ead11f](https://github.com/hackclub/orchard/commit/3ead11f57dd2c7a91b6c6e19832f1534cc57d282))

## [2.51.3](https://github.com/hackclub/orchard/compare/server/v2.51.2...server/v2.51.3) (2026-09-29)


### Bug Fixes

* orchardctl harden makes the k3s kubeconfig private ([05139c9](https://github.com/hackclub/orchard/commit/05139c91280ef83130ea7a34ce3b62845375fc2f))
* the engine banner waits out watch blips and shard handoffs ([babaaba](https://github.com/hackclub/orchard/commit/babaabae4d9edde79b67ce685e5f7ad8e35ff1b3))

## [2.51.2](https://github.com/hackclub/orchard/compare/server/v2.51.1...server/v2.51.2) (2026-09-29)


### Bug Fixes

* outbound fetches pin dns at connect time, job run snapshots encrypt secret values, organization backup keys never leave the database by default, and the protect page stops naming the project ([7278788](https://github.com/hackclub/orchard/commit/7278788dbe3ac1f69ec095a977b85f03ea2ad968))
* project viewers no longer see logs, secret values, log-derived error text or member emails anywhere, notification replay stays inside the channel scope, environment delete needs delete rights, and mutating sync needs deploy scope ([f490855](https://github.com/hackclub/orchard/commit/f490855fa3122a835005c565467df443bbdd0ed3))
* the r2 proxy refuses copies, bucket writes and out-of-prefix deletes, cookie sessions cannot mutate from other origins, trusted images are docker hub only, the mcp consent page and asset proxy pin their origins, the cli token never enters a url, logout is a post, and the k3s kubeconfig is private ([90ac6fc](https://github.com/hackclub/orchard/commit/90ac6fcf5bafc0b05488449bdd72ece7c32e88d4))
* the server binds a fixed tenant-secrets clusterrole instead of holding escalate, every tenant namespace keeps a floor quota, the backup proxy connects as a read-only postgres role, and plaintext registries come from values ([3c42bcb](https://github.com/hackclub/orchard/commit/3c42bcbeacea96a120dc9fa11696899e37534ed0))

## [2.51.1](https://github.com/hackclub/orchard/compare/server/v2.51.0...server/v2.51.1) (2026-09-28)


### Bug Fixes

* api tokens keep their scopes on superadmin routes and cannot enrol credentials, org-scoped sessions stay confined through mcp consent, exec and github linking, and sign-in codes are keyed on the instance secret ([fcc0100](https://github.com/hackclub/orchard/commit/fcc010083ba518cbc0422a93d78a76d2516b0840))
* build args and job env reach pods through secrets, build pods stay out of the mirror, and every user-supplied outbound url is checked against private networks ([03c6333](https://github.com/hackclub/orchard/commit/03c63336d5d95df268c290367abcbffaf6384506))
* build config, dockerfile target, auto-deploy branch and ingress host updates are validated like their create paths ([3c27464](https://github.com/hackclub/orchard/commit/3c274642c1f066ae72a8b76a653949f4499dee1b))
* sso providers are owner-managed and saml rejects unsolicited assertions, sign-in attempts are counted atomically, jwt secret has a floor, platform images are project-scoped and logs are editor-only ([d540422](https://github.com/hackclub/orchard/commit/d54042289c4d9311e4727968934e029e75b402b7))
* the org-scope and api-token deny lists ignore path case, and notification rules and channels list only what the caller can view ([23bf216](https://github.com/hackclub/orchard/commit/23bf2169b639e19fc38d2061600f9171617781d2))
* the self-host registry answers on loopback with a password, the installer opens ufw or firewalld for k3s, and orchardctl update retrofits both ([711a52a](https://github.com/hackclub/orchard/commit/711a52a84efe98815a4a9d368343928a27e671d2))

## [2.51.0](https://github.com/hackclub/orchard/compare/server/v2.50.0...server/v2.51.0) (2026-09-28)


### Features

* the template registry defaults to assets.orchard.my, with a latest copy of every template ([7ed8e49](https://github.com/hackclub/orchard/commit/7ed8e49e17125de6d969f4893e1f241bde588422))


### Bug Fixes

* built-in templates that no longer ship leave the gallery unless something was deployed from them ([b78c480](https://github.com/hackclub/orchard/commit/b78c480b281c156dc376104a76dd0a381ddac1e3))

## [2.50.0](https://github.com/hackclub/orchard/compare/server/v2.49.0...server/v2.50.0) (2026-09-28)


### Features

* a community template registry on r2 that the server syncs and the landing browses ([4ad1bd7](https://github.com/hackclub/orchard/commit/4ad1bd7663170a6fb0e8294cd65ec5dbd1d061b2))
* a credits page with live contributors, and third-party notices in every app, image and binary ([168c584](https://github.com/hackclub/orchard/commit/168c584bc5de82dd085d6148c54f44f8f61ebc37))
* a stopped app holds its pushes, start builds the newest one, and redeploy starts it ([2fd976f](https://github.com/hackclub/orchard/commit/2fd976f30f1edd865b5947ded6b7e2603e5b8451))
* an anomalies card on projects, apps and databases that names what is wrong and the one action that helps ([4dc261f](https://github.com/hackclub/orchard/commit/4dc261fb7f5d980f962802d70a9adbed03984dff))
* builds record when the job was submitted and scheduled, and the progress view shows where the time went ([0dfe05d](https://github.com/hackclub/orchard/commit/0dfe05d4fc697535d42a94769da922c7c03cefcc))
* database stats and cluster state mirrored by the informer so the page never flickers, with the postgres logo ([4b68095](https://github.com/hackclub/orchard/commit/4b680953da7fb183c0fe3d86e2db8e612aa59a0f))
* redirects can be edited in place, including the domain, from the app, the cli and mcp ([0b0ded2](https://github.com/hackclub/orchard/commit/0b0ded26f40a8dbb54ded854d9511a0ae6355251))
* the command palette searches every organization you belong to and switches on select ([6c6b41d](https://github.com/hackclub/orchard/commit/6c6b41d92d4159ac8f0e2b3e9206082d5f376c5e))


### Bug Fixes

* a service port change repoints every domain on it, keeps protected ones on the proxy, and retries through the apply queue ([dd51c44](https://github.com/hackclub/orchard/commit/dd51c440ac51bbdd0ad69f8b3722925ca33d27c7))
* metrics see blue green pods and environment namespaces, report the store being down, and count protected traffic ([4e90114](https://github.com/hackclub/orchard/commit/4e90114a44b824c60bf7a6a3a9ce7cbbd6f6ec35))
* tenant network policy reconcile only runs from a cluster member ([be90da6](https://github.com/hackclub/orchard/commit/be90da6370addf61baf32e3f3251d2f6a52a0a9f))


### Performance Improvements

* zstd images, a leaner cache export, explicit pull policy on builder containers, and warm daemons that live two hours ([2d1c09f](https://github.com/hackclub/orchard/commit/2d1c09f9783df84848eb220ebb137fe18ca7953b))

## [2.49.0](https://github.com/hackclub/orchard/compare/server/v2.48.0...server/v2.49.0) (2026-09-28)


### Features

* a superadmin picks their sign-in method instead of the login card picking for them ([54018a6](https://github.com/hackclub/orchard/commit/54018a69b6659dd3d38c38078bdc4ab0beef521a))

## [2.48.0](https://github.com/hackclub/orchard/compare/server/v2.47.1...server/v2.48.0) (2026-09-27)


### Features

* activity timeline per app with live audit events ([8abc9e4](https://github.com/hackclub/orchard/commit/8abc9e4603f01c52cec168ff669cc6d697224785))
* an instance backup bucket backs every database whose organization has none, and a leader-only pass brings existing clusters in ([250791e](https://github.com/hackclub/orchard/commit/250791e7c47470025268eef54b84e1fde6cf857e))
* auto-deploy for git providers registers the forge webhook, with docs for providers, score and terraform ([32d6a37](https://github.com/hackclub/orchard/commit/32d6a37df2c7d357e1e98576416780684e9e44ec))
* git providers per user with instance-registered oauth apps and per-connection webhook secrets ([b5584ac](https://github.com/hackclub/orchard/commit/b5584ac18baaedf5a42dc654be590eb3360341ef))
* public status pages with hosts, derived from crash state, replicas and alerts ([efa60a9](https://github.com/hackclub/orchard/commit/efa60a97818e96fcaad53ef5eae94207a015b7e9))
* resource bindings so apps follow a database across restores and password rotation ([ad9c7f4](https://github.com/hackclub/orchard/commit/ad9c7f4e5c8b73a24160d29da955b9e1c9934fd9))
* rollout gate with auto rollback, blue/green deploys and releases ([7cc9bc1](https://github.com/hackclub/orchard/commit/7cc9bc1068cff1dbb837d0f99d2e8ebe4018e7ad))
* score.yaml workloads and a terraform and opentofu provider on the cli api client ([33db897](https://github.com/hackclub/orchard/commit/33db89754e915b13ec0d40bcee4445a474108b6e))
* threshold alerts on app metrics with a shared metrics client ([e36774c](https://github.com/hackclub/orchard/commit/e36774c484955b5b68593b97b74284233ce14395))


### Bug Fixes

* cnpg server ca bundle is completed to a self-signed root, and new clusters cap slot wal so a dead replica cannot fill the primary ([5971bc7](https://github.com/hackclub/orchard/commit/5971bc7a20eaf6f771eb53cf74874d438984b4ab))
* existing cnpg clusters get the slot wal cap and a complete server ca bundle from a leader-only reconcile ([b7456dc](https://github.com/hackclub/orchard/commit/b7456dcc79b16d1ae5b783a974a5941415df8ca8))
* the slot wal cap keeps a fifth of the disk from 256MB up, so tiny databases are not capped at half their volume ([9502ed5](https://github.com/hackclub/orchard/commit/9502ed5e19c48a2b8c6a49f18145f938e4aeef3f))

## [2.47.1](https://github.com/hackclub/orchard/compare/server/v2.47.0...server/v2.47.1) (2026-09-25)


### Bug Fixes

* loading panel for metrics + HTTP tracing ([#95](https://github.com/hackclub/orchard/issues/95)) ([b2c7203](https://github.com/hackclub/orchard/commit/b2c72030c3b9bb62b17ff57d12134d860ddbbd57))

## [2.47.0](https://github.com/hackclub/orchard/compare/server/v2.46.1...server/v2.47.0) (2026-09-22)


### Features

* transcode buildkit rawjson progress into the build log ([c4afb30](https://github.com/hackclub/orchard/commit/c4afb30f270d4ff484e87875a4f5b12c2a34bba8))


### Bug Fixes

* build recovery decides from the k8s job informer instead of our own rows ([bf972a0](https://github.com/hackclub/orchard/commit/bf972a0628074ebb23244f104338fb68780e5b81))
* stop a dev server from doing a production instance's background work ([538a916](https://github.com/hackclub/orchard/commit/538a916632c3a15bcd41e8f02400a29c5349f1e6))

## [2.46.1](https://github.com/hackclub/orchard/compare/server/v2.46.0...server/v2.46.1) (2026-09-21)


### Bug Fixes

* detect proxy hops instead of counting them when reading client ip ([ec65eeb](https://github.com/hackclub/orchard/commit/ec65eeb642ccaf06f0f0753934bdaf55be415ed9))
* share rate limit counters in redis and read the real client ip ([4758b4f](https://github.com/hackclub/orchard/commit/4758b4fa37a6aba48663b41b675e1f1c7dcfdee1))

## [2.46.0](https://github.com/hackclub/orchard/compare/server/v2.45.1...server/v2.46.0) (2026-09-21)


### Features

* optional cloudflare turnstile on the auth pages ([4a435dd](https://github.com/hackclub/orchard/commit/4a435dd07b511ca16bbaa82175a3862659412c40))

## [2.45.1](https://github.com/hackclub/orchard/compare/server/v2.45.0...server/v2.45.1) (2026-09-20)


### Bug Fixes

* enforce ratelimits across the board ([#89](https://github.com/hackclub/orchard/issues/89)) ([145fa8f](https://github.com/hackclub/orchard/commit/145fa8ffe3ae6e1e670064146f5ed6dcc1f56c1f))

## [2.45.0](https://github.com/hackclub/orchard/compare/server/v2.44.0...server/v2.45.0) (2026-09-18)


### Features

* further harden deployment rollout handling ([#85](https://github.com/hackclub/orchard/issues/85)) ([e9787a0](https://github.com/hackclub/orchard/commit/e9787a053ce8a17449d4372d5aef1f55a8bf0ac9))


### Bug Fixes

* finish a build when the cluster accepts the image, not when the app is up ([e585024](https://github.com/hackclub/orchard/commit/e585024bee0903fc65c28d9cec7adc41c0d6bce0))
* keep domain redirects on the destination they were pointed at ([f42a8b0](https://github.com/hackclub/orchard/commit/f42a8b0043afd67659ac709dc108405271539273))
* report a failed stop or start instead of reporting success ([4699f5d](https://github.com/hackclub/orchard/commit/4699f5d372d1455ecc6a5d3cc9317690cf7c4d3f))
* show the replica count kubernetes is running, not orchard's intent ([35d95e5](https://github.com/hackclub/orchard/commit/35d95e57b556f297d1a2f3954f2d32dc79a30090))
* stop reporting impossible cpu percentages against the wrong pod budget ([c03e5f1](https://github.com/hackclub/orchard/commit/c03e5f1008bc393afe75fabd291de7797cf9217b))

## [2.44.0](https://github.com/hackclub/orchard/compare/server/v2.43.1...server/v2.44.0) (2026-09-18)


### Features

* persist the dockerfile build stage and expose it in the ui, mcp and cli ([8575b56](https://github.com/hackclub/orchard/commit/8575b566b7460c1f961f6b9a8e98e719b2ddb1b0))
* run a start command on dockerfile and image deployments ([aea28bd](https://github.com/hackclub/orchard/commit/aea28bd8725d66451a693da7da62c6eb156278d9))


### Bug Fixes

* correct the start command signal note to what the cluster actually does ([7d714e5](https://github.com/hackclub/orchard/commit/7d714e5c071d76289ac7927d8988f0200e7feddc))
* keep deliberately set start commands instead of clearing them on release ([00e2565](https://github.com/hackclub/orchard/commit/00e25652c62dbb0569bcb7a921f1de1b4a183ee5))

## [2.43.1](https://github.com/hackclub/orchard/compare/server/v2.43.0...server/v2.43.1) (2026-09-17)


### Bug Fixes

* unwedge the mirror informer when a burst of watch events hits the concurrency limit ([71ccb8b](https://github.com/hackclub/orchard/commit/71ccb8b4124f360b44b0eb4476612b80a4144bc0))

## [2.43.0](https://github.com/hackclub/orchard/compare/server/v2.42.1...server/v2.43.0) (2026-09-17)


### Features

* use better deploy strat ([#82](https://github.com/hackclub/orchard/issues/82)) ([5d87aa5](https://github.com/hackclub/orchard/commit/5d87aa54499c72bac03b61a327dab016d4342d74))


### Bug Fixes

* anchor the build timer to the build start, not the row's updatedAt ([e245ddf](https://github.com/hackclub/orchard/commit/e245ddff3d6b4769bf66d9b7d6623a1b0aee240e))

## [2.42.1](https://github.com/hackclub/orchard/compare/server/v2.42.0...server/v2.42.1) (2026-09-17)


### Bug Fixes

* resolve namespaces through environments, not just the project ([48c5300](https://github.com/hackclub/orchard/commit/48c5300abde209cbc2a5cbc1c699c44b8c2eca3c))

## [2.42.0](https://github.com/hackclub/orchard/compare/server/v2.41.1...server/v2.42.0) (2026-09-17)


### Features

* allow users to stop apps ([#61](https://github.com/hackclub/orchard/issues/61)) ([d45734a](https://github.com/hackclub/orchard/commit/d45734ad527fa868c0734c2c312c4db002803883))
* **auth:** sign in with a host-minted link or a superadmin password ([3b6f20c](https://github.com/hackclub/orchard/commit/3b6f20c07bac939e25a0fa11a3eb2fbb8d5bca10))
* **frontend:** mouse, paste, zoom, titles and a settings menu for the pod shell ([1817925](https://github.com/hackclub/orchard/commit/181792550b2984c93e2be4cd595188145fb7b725))
* **hostctl:** stop, start and restart the instance ([4601393](https://github.com/hackclub/orchard/commit/460139364f7a3da00802880abe2a449e4ab4fd90))
* let superadmins create unlimited sandboxes ([d30164e](https://github.com/hackclub/orchard/commit/d30164e70d2978c7c8aa776d9ef01979b7c11596))
* link domains to redirect to ([#72](https://github.com/hackclub/orchard/issues/72)) ([77c1c46](https://github.com/hackclub/orchard/commit/77c1c4682a024d9b6a21168da0097b399a9371f9))
* **server:** durable pod shell sessions that survive a dropped connection ([89309ff](https://github.com/hackclub/orchard/commit/89309ff9f0d0a5b8843879ce0b11e63829714be1))
* **setup:** offer a password where a passkey cannot be created ([9f9c8c7](https://github.com/hackclub/orchard/commit/9f9c8c7e25cf56c04f5ff17eaf257b12b1d4f8ac))


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))
* ensure smooth cutover ([#70](https://github.com/hackclub/orchard/issues/70)) ([63edee2](https://github.com/hackclub/orchard/commit/63edee24a4a1fbf79c406d6d700f4a13bf4889a6))
* handle query-statistics bug for JSON ([#60](https://github.com/hackclub/orchard/issues/60)) ([d45d892](https://github.com/hackclub/orchard/commit/d45d892e7d7adb3c0e2cc29c9ab835038fe0d54a))
* **hostctl:** stop claiming a hostname works before it is deployed ([46a3b89](https://github.com/hackclub/orchard/commit/46a3b898d34da6fa1e03b68cb8056f286dded703))
* **hostctl:** take the claim link's port from frontend_url ([f8b3ef9](https://github.com/hackclub/orchard/commit/f8b3ef92be902b1fead8862f3c0887600cfc1810))
* **install:** make a lan install reachable at the addresses it actually has ([2026400](https://github.com/hackclub/orchard/commit/2026400797c9239aef919e55f368a67cfd4e7247))
* measure sandbox max lifetime from the current run, not the row's age ([f8eb41c](https://github.com/hackclub/orchard/commit/f8eb41c10f87fee6ec68840e7eabc5357c3ed668))
* **server:** exec text frames are control only, real upstream backpressure, forced resize ([54a88fc](https://github.com/hackclub/orchard/commit/54a88fc52697e4f88d27e6929e0ce4edb0bc7e1f))
* **server:** keep a stopped app stopped through a rebuild ([981dff5](https://github.com/hackclub/orchard/commit/981dff503eff6ff08bc7c5a45f62e1f96ab170bf))
* **server:** safely transition health probe handlers ([b786b4e](https://github.com/hackclub/orchard/commit/b786b4e83f3b48ae1e895afba7ff23a6f960ddec))
* slugify template name params instead of rejecting spaces ([0c856a1](https://github.com/hackclub/orchard/commit/0c856a1267e3a1da927ac87aa8246951c25f102e))

## [2.41.1](https://github.com/hackclub/orchard/compare/server/v2.41.0...server/v2.41.1) (2026-09-17)


### Bug Fixes

* **server:** safely transition health probe handlers ([b786b4e](https://github.com/hackclub/orchard/commit/b786b4e83f3b48ae1e895afba7ff23a6f960ddec))

## [2.41.0](https://github.com/hackclub/orchard/compare/server/v2.40.0...server/v2.41.0) (2026-09-16)


### Features

* link domains to redirect to ([#72](https://github.com/hackclub/orchard/issues/72)) ([77c1c46](https://github.com/hackclub/orchard/commit/77c1c4682a024d9b6a21168da0097b399a9371f9))

## [2.40.0](https://github.com/hackclub/orchard/compare/server/v2.39.1...server/v2.40.0) (2026-09-16)


### Features

* **auth:** sign in with a host-minted link or a superadmin password ([3b6f20c](https://github.com/hackclub/orchard/commit/3b6f20c07bac939e25a0fa11a3eb2fbb8d5bca10))
* **setup:** offer a password where a passkey cannot be created ([9f9c8c7](https://github.com/hackclub/orchard/commit/9f9c8c7e25cf56c04f5ff17eaf257b12b1d4f8ac))


### Bug Fixes

* ensure smooth cutover ([#70](https://github.com/hackclub/orchard/issues/70)) ([63edee2](https://github.com/hackclub/orchard/commit/63edee24a4a1fbf79c406d6d700f4a13bf4889a6))

## [2.39.1](https://github.com/hackclub/orchard/compare/server/v2.39.0...server/v2.39.1) (2026-09-15)


### Bug Fixes

* **hostctl:** take the claim link's port from frontend_url ([f8b3ef9](https://github.com/hackclub/orchard/commit/f8b3ef92be902b1fead8862f3c0887600cfc1810))

## [2.39.0](https://github.com/hackclub/orchard/compare/server/v2.38.2...server/v2.39.0) (2026-09-15)


### Features

* **hostctl:** stop, start and restart the instance ([4601393](https://github.com/hackclub/orchard/commit/460139364f7a3da00802880abe2a449e4ab4fd90))


### Bug Fixes

* **hostctl:** stop claiming a hostname works before it is deployed ([46a3b89](https://github.com/hackclub/orchard/commit/46a3b898d34da6fa1e03b68cb8056f286dded703))

## [2.38.2](https://github.com/hackclub/orchard/compare/server/v2.38.1...server/v2.38.2) (2026-09-15)


### Bug Fixes

* **install:** make a lan install reachable at the addresses it actually has ([2026400](https://github.com/hackclub/orchard/commit/2026400797c9239aef919e55f368a67cfd4e7247))

## [2.38.1](https://github.com/hackclub/orchard/compare/server/v2.38.0...server/v2.38.1) (2026-09-15)


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))

## [2.38.0](https://github.com/hackclub/orchard/compare/server/v2.37.0...server/v2.38.0) (2026-09-15)


### Features

* allow users to stop apps ([#61](https://github.com/hackclub/orchard/issues/61)) ([d45734a](https://github.com/hackclub/orchard/commit/d45734ad527fa868c0734c2c312c4db002803883))


### Bug Fixes

* handle query-statistics bug for JSON ([#60](https://github.com/hackclub/orchard/issues/60)) ([d45d892](https://github.com/hackclub/orchard/commit/d45d892e7d7adb3c0e2cc29c9ab835038fe0d54a))
* **server:** keep a stopped app stopped through a rebuild ([981dff5](https://github.com/hackclub/orchard/commit/981dff503eff6ff08bc7c5a45f62e1f96ab170bf))

## [2.37.0](https://github.com/hackclub/orchard/compare/server/v2.36.0...server/v2.37.0) (2026-09-15)


### Features

* let superadmins create unlimited sandboxes ([d30164e](https://github.com/hackclub/orchard/commit/d30164e70d2978c7c8aa776d9ef01979b7c11596))


### Bug Fixes

* measure sandbox max lifetime from the current run, not the row's age ([f8eb41c](https://github.com/hackclub/orchard/commit/f8eb41c10f87fee6ec68840e7eabc5357c3ed668))

## [2.36.0](https://github.com/hackclub/orchard/compare/server/v2.35.1...server/v2.36.0) (2026-09-15)


### Features

* **frontend:** mouse, paste, zoom, titles and a settings menu for the pod shell ([1817925](https://github.com/hackclub/orchard/commit/181792550b2984c93e2be4cd595188145fb7b725))
* **server:** durable pod shell sessions that survive a dropped connection ([89309ff](https://github.com/hackclub/orchard/commit/89309ff9f0d0a5b8843879ce0b11e63829714be1))


### Bug Fixes

* **server:** exec text frames are control only, real upstream backpressure, forced resize ([54a88fc](https://github.com/hackclub/orchard/commit/54a88fc52697e4f88d27e6929e0ce4edb0bc7e1f))

## [2.35.1](https://github.com/hackclub/orchard/compare/server/v2.35.0...server/v2.35.1) (2026-09-15)


### Bug Fixes

* **server:** stop the pod shell reconnect loop and surface exec failures ([a6ef5bd](https://github.com/hackclub/orchard/commit/a6ef5bdd61c5e2a33d7e545ccff84eb5ecd2600a))

## [2.35.0](https://github.com/hackclub/orchard/compare/server/v2.34.2...server/v2.35.0) (2026-09-15)


### Features

* **server:** make the pod shell fast, reconnecting and colour-capable ([d428970](https://github.com/hackclub/orchard/commit/d428970618d3b9232c53781f8a468bd9428ca239))
* **server:** tell people when something signs in to their account ([f18f117](https://github.com/hackclub/orchard/commit/f18f117d079399033c5100a2515ae1a3ccbf5ac5))


### Bug Fixes

* repair the seed script after the workspace models were removed ([#54](https://github.com/hackclub/orchard/issues/54)) ([187090b](https://github.com/hackclub/orchard/commit/187090bd7ec945edc2660c655b9869ff625de30e))
* **server:** fill email placeholders the formatter padded ([a349bcb](https://github.com/hackclub/orchard/commit/a349bcbde184da5dccea73651d9491d25bf0e0c2))
* **server:** give the pod shell its real size, a heartbeat and no nagle ([254dc97](https://github.com/hackclub/orchard/commit/254dc970ecc17a8d2b8b3e104a47bb9df998abf4))
* **server:** put the sign-in details in the email that asks if it was you ([e197b34](https://github.com/hackclub/orchard/commit/e197b34346954f7f479292ad30bdb1bfffdade37))

## [2.34.2](https://github.com/hackclub/orchard/compare/server/v2.34.1...server/v2.34.2) (2026-09-14)


### Bug Fixes

* make the setup flow honest about github and app domains ([fe028da](https://github.com/hackclub/orchard/commit/fe028daf2ad22cbefec9a7d325567703ed529a61))

## [2.34.1](https://github.com/hackclub/orchard/compare/server/v2.34.0...server/v2.34.1) (2026-09-14)


### Bug Fixes

* **server:** mint a claim link when there is no other way into the instance ([2c95a80](https://github.com/hackclub/orchard/commit/2c95a80fcc8315d1cf37105fd8b5555f6e20fe98))

## [2.34.0](https://github.com/hackclub/orchard/compare/server/v2.33.0...server/v2.34.0) (2026-09-14)


### Features

* probe apps with the HEALTHCHECK their Dockerfile declares ([#44](https://github.com/hackclub/orchard/issues/44)) ([4afc98b](https://github.com/hackclub/orchard/commit/4afc98b71eaf5e83ed2d4135c29c54cb43b00fde))


### Bug Fixes

* **server:** enforce env-pinned config locks outside the admin panel ([fd181d9](https://github.com/hackclub/orchard/commit/fd181d94dc121fc14532e07b1ec9831448a0283a))
* **server:** make a deployment's secret env vars write-only and encrypted at rest ([d5f82d9](https://github.com/hackclub/orchard/commit/d5f82d99b07ddfabd8995fcf96c37ae8875c25fb))

## [2.33.0](https://github.com/hackclub/orchard/compare/server/v2.32.0...server/v2.33.0) (2026-09-13)


### Features

* **server:** pull authenticated base images with app credentials ([#42](https://github.com/hackclub/orchard/issues/42)) ([6a20212](https://github.com/hackclub/orchard/commit/6a2021299d7fb217c2d8ffeee7896a660747dc8a))

## [2.32.0](https://github.com/hackclub/orchard/compare/server/v2.31.0...server/v2.32.0) (2026-09-11)


### Features

* check dns for every hostname and configure cloudflare tunnel routes ([00be104](https://github.com/hackclub/orchard/commit/00be1041de3e9e0910cf44d1812c5f0bb6354865))


### Bug Fixes

* **server:** apply mid-build volumes, report queued rebuilds, gate auto-deploy ([10c0154](https://github.com/hackclub/orchard/commit/10c0154ecbb30f304a3159584ed1340ddb911198))

## [2.31.0](https://github.com/hackclub/orchard/compare/server/v2.30.0...server/v2.31.0) (2026-09-11)


### Features

* auto-configure the mcp endpoint and an instance-wide public ip ([46c7bbc](https://github.com/hackclub/orchard/commit/46c7bbc9d9a439a664244f514228a3b974700b40))

## [2.30.0](https://github.com/hackclub/orchard/compare/server/v2.29.0...server/v2.30.0) (2026-09-11)


### Features

* rewrite orchardctl as a go binary ([db82650](https://github.com/hackclub/orchard/commit/db8265032ae74fc36dbf453452f622ac5d8b332a))


### Bug Fixes

* let the ingress controller reach tenant apps on any cluster ([d83fe8f](https://github.com/hackclub/orchard/commit/d83fe8f2570a0d3223f15458ecf28685e2b68344))

## [2.29.0](https://github.com/hackclub/orchard/compare/server/v2.28.5...server/v2.29.0) (2026-09-11)


### Features

* allow the bundled registry on install and add orchardctl registry ([f809de5](https://github.com/hackclub/orchard/commit/f809de56c67a5f8fafb5292213528ab2e1964b70))

## [2.28.5](https://github.com/hackclub/orchard/compare/server/v2.28.4...server/v2.28.5) (2026-09-11)


### Bug Fixes

* put the real cause in the build failure headline ([328306c](https://github.com/hackclub/orchard/commit/328306c29ff0cc57acd1ade0c883221f4b225527))

## [2.28.4](https://github.com/hackclub/orchard/compare/server/v2.28.3...server/v2.28.4) (2026-09-10)


### Bug Fixes

* stop git lfs failures from killing the build clone ([1541c68](https://github.com/hackclub/orchard/commit/1541c68f249eb64cc5296664fc6f1a423a81c386))

## [2.28.3](https://github.com/hackclub/orchard/compare/server/v2.28.2...server/v2.28.3) (2026-09-10)


### Bug Fixes

* back build scratch with disk when there is no vm isolation ([1768f3a](https://github.com/hackclub/orchard/commit/1768f3a53c6885892fb8daa5ef990318d23d3dac))

## [2.28.2](https://github.com/hackclub/orchard/compare/server/v2.28.1...server/v2.28.2) (2026-09-09)


### Bug Fixes

* read the certificate namespace from instance config and cache the lookup ([1b432cd](https://github.com/hackclub/orchard/commit/1b432cdcd0164205d85600dace8c65e557a458bc))

## [2.28.1](https://github.com/hackclub/orchard/compare/server/v2.28.0...server/v2.28.1) (2026-09-09)


### Bug Fixes

* show whether the wildcard certificate actually issued, not just that it is configured ([1704e6b](https://github.com/hackclub/orchard/commit/1704e6b1e92d35c0bf7612054c0122333a2d897b))

## [2.28.0](https://github.com/hackclub/orchard/compare/server/v2.27.0...server/v2.28.0) (2026-09-09)


### Features

* configure object storage, email, domains and wildcard tls from the admin panel ([a1f4e02](https://github.com/hackclub/orchard/commit/a1f4e023fef2fd988e5197730091b89149fdb44a))


### Bug Fixes

* derive the github oauth callback url instead of requiring an env var ([2631105](https://github.com/hackclub/orchard/commit/26311056b08b498bd0edb245b873a28f6cd3a514))
* repoint existing ingresses when the wildcard certificate config changes ([546d416](https://github.com/hackclub/orchard/commit/546d416b159468194760c741df7bf2cd0a3daaf8))

## [2.27.0](https://github.com/hackclub/orchard/compare/server/v2.26.2...server/v2.27.0) (2026-09-09)


### Features

* rebuild the first-run setup flow ([b0d3930](https://github.com/hackclub/orchard/commit/b0d3930c7937845cdde9d74b602baa86d31d9260))


### Bug Fixes

* require an organization before setup can complete ([6d17c37](https://github.com/hackclub/orchard/commit/6d17c37f424a3c60f27b835eb1437eee42f93df5))

## [2.26.2](https://github.com/hackclub/orchard/compare/server/v2.26.1...server/v2.26.2) (2026-09-07)


### Bug Fixes

* ensure the organization on every claim path ([0789188](https://github.com/hackclub/orchard/commit/0789188534d409e1a3725fef8a1fb96d9e04d2ca))

## [2.26.1](https://github.com/hackclub/orchard/compare/server/v2.26.0...server/v2.26.1) (2026-09-07)


### Bug Fixes

* show the organization step until the org is actually named ([dd123f5](https://github.com/hackclub/orchard/commit/dd123f58e31797b4fd77c014eab0fb56782be546))

## [2.26.0](https://github.com/hackclub/orchard/compare/server/v2.25.1...server/v2.26.0) (2026-09-07)


### Features

* copy the wildcard certificate into tenant namespaces ([fff7752](https://github.com/hackclub/orchard/commit/fff7752bdef365ae038f5fa391b1055cb1cd8e61))
* create the first organization at claim time and derive setup state ([14ad42a](https://github.com/hackclub/orchard/commit/14ad42a40c2e1557884e6f7c7168f79e97698bd9))
* instance setup checklist in the admin area ([a80146e](https://github.com/hackclub/orchard/commit/a80146ee5541e34c0e9ec3e9171c2bc8d76d986d))
* surface certificate issuance status on ingresses ([23d5f0e](https://github.com/hackclub/orchard/commit/23d5f0e5ec378032fa9f12fb342281a6c99dd4c8))


### Bug Fixes

* issue per-host certificates when no wildcard secret is configured ([a3375f9](https://github.com/hackclub/orchard/commit/a3375f921a90d28eaf61f6e8fe1f2b04c812a6e3))
* re-pull moving image tags on update ([2d36e9a](https://github.com/hackclub/orchard/commit/2d36e9abe04e15800f658f13d74f6a525affa197))

## [2.25.1](https://github.com/hackclub/orchard/compare/server/v2.25.0...server/v2.25.1) (2026-09-05)


### Bug Fixes

* keep the host commands under apps/server so releases ship them ([21296e1](https://github.com/hackclub/orchard/commit/21296e11af2e24ef70938a7ce834fc6297dc2e4f))

## [2.25.0](https://github.com/hackclub/orchard/compare/server/v2.24.0...server/v2.25.0) (2026-09-05)


### Features

* ship host commands in the server image so updates carry them ([fbaeb43](https://github.com/hackclub/orchard/commit/fbaeb433b3114f3548105053e0c6ce094edf147f))

## [2.24.0](https://github.com/hackclub/orchard/compare/server/v2.23.0...server/v2.24.0) (2026-09-05)


### Features

* claim an instance without email and sign in from the claim link ([b260bb6](https://github.com/hackclub/orchard/commit/b260bb6c55aa8fcfb2fecef3134525a2932af871))

## [2.23.0](https://github.com/hackclub/orchard/compare/server/v2.22.1...server/v2.23.0) (2026-09-04)


### Features

* basic auth on an ingress without cilium ([ea36adf](https://github.com/hackclub/orchard/commit/ea36adff30dbc83caa372c895c8d87fd0c8ab830))


### Bug Fixes

* derive platform domains from config instead of hardcoding them ([ad585dd](https://github.com/hackclub/orchard/commit/ad585dd681bd5d796a88bc72e9f8f397e44ef803))
* derive sandbox state from an instance-scoped mirror shard ([9d9c071](https://github.com/hackclub/orchard/commit/9d9c0713b0b97322354941cc7d4942c79063209d))
* load a base64 kubeconfig everywhere kubeconfig_path is read ([0928bb3](https://github.com/hackclub/orchard/commit/0928bb350f3bd7d06cb1299b276353ac26051c4f))
* look up sandbox pods through the mirror everywhere ([6402d22](https://github.com/hackclub/orchard/commit/6402d22794e79d5c6e638f85f10f320c42dfec4d))
* recreate a sandbox whose cluster resource vanished ([7a8f82f](https://github.com/hackclub/orchard/commit/7a8f82fd588c181ac6421fe318abc9a458680e25))
* seed project roles in a migration so self-hosted installs have them ([252b98f](https://github.com/hackclub/orchard/commit/252b98f190dc3294fd1dff2e626b65aba9a096ec))

## [2.22.1](https://github.com/hackclub/orchard/compare/server/v2.22.0...server/v2.22.1) (2026-09-04)


### Bug Fixes

* reconcile the disruption budget when the cluster changes replicas ([cbef67a](https://github.com/hackclub/orchard/commit/cbef67a678125001828445acdd380d95e93495bc))

## [2.22.0](https://github.com/hackclub/orchard/compare/server/v2.21.1...server/v2.22.0) (2026-09-04)


### Features

* per-app pod disruption budget in deploy behavior ([e145faa](https://github.com/hackclub/orchard/commit/e145faaa7816b61c2a48a0184fd4d95788921778))


### Bug Fixes

* give super builds a git binary ([ad7ba80](https://github.com/hackclub/orchard/commit/ad7ba807bda1de5de2099274762fab18f2dcabd9))

## [2.21.1](https://github.com/hackclub/orchard/compare/server/v2.21.0...server/v2.21.1) (2026-09-04)


### Bug Fixes

* retry builds that die on a kata sandbox start fault ([c1c7dc9](https://github.com/hackclub/orchard/commit/c1c7dc9a3e03aba33751efb994e5b870be0070b4))
* stream super build logs ([e80353e](https://github.com/hackclub/orchard/commit/e80353ecac1c9ece8fa91b7b56f316cbcbf9c629))

## [2.21.0](https://github.com/hackclub/orchard/compare/server/v2.20.0...server/v2.21.0) (2026-09-04)


### Features

* run super builds under gvisor instead of kata ([a57d630](https://github.com/hackclub/orchard/commit/a57d6309def5f4b2fa9e403aa65698f4cfdabe5c))


### Bug Fixes

* push super builds to the public registry, not the cluster-internal one ([648bb89](https://github.com/hackclub/orchard/commit/648bb896a6469d19716790e342093e447ba333c4))
* stop super builds consuming local builder capacity ([c3547ad](https://github.com/hackclub/orchard/commit/c3547adb6107d7883f6e992564110e045daf7678))

## [2.20.0](https://github.com/hackclub/orchard/compare/server/v2.19.0...server/v2.20.0) (2026-09-04)


### Features

* warn when auto-deploy is enabled but not connected ([e4453d3](https://github.com/hackclub/orchard/commit/e4453d3f279dc5b29ca562ea0eeff5d95a91422a))


### Bug Fixes

* keep the cluster mirror converging when a derived write fails ([184c8ef](https://github.com/hackclub/orchard/commit/184c8ef2e31770967629f62c258c321df279507a))
* stop auto-deploy silently dropping pushes ([a999853](https://github.com/hackclub/orchard/commit/a999853e8d3ffdd4f1b39cb533151827006b8dae))

## [2.19.0](https://github.com/hackclub/orchard/compare/server/v2.18.4...server/v2.19.0) (2026-09-03)


### Features

* deploy templates from a github repo and add the nephthys template ([6716e15](https://github.com/hackclub/orchard/commit/6716e15cab546aea6ae30d8b8b71f91d4e21c216))
* move a project to another organization ([e878cc4](https://github.com/hackclub/orchard/commit/e878cc4a065ab03d9d976db7d5373537283a2660))
* switch a deployment between railpack and dockerfile builds ([c179afb](https://github.com/hackclub/orchard/commit/c179afbaf6a6fd0f26c7ef6f7010a0e61d958266))

## [2.18.4](https://github.com/hackclub/orchard/compare/server/v2.18.3...server/v2.18.4) (2026-09-03)


### Bug Fixes

* create deployments, databases and compose stacks in the selected environment ([166af35](https://github.com/hackclub/orchard/commit/166af35a79104df14617d19819c29727dccca700))

## [2.18.3](https://github.com/hackclub/orchard/compare/server/v2.18.2...server/v2.18.3) (2026-09-03)


### Bug Fixes

* **server:** apply compose deploy.resources limits to child deployments ([9f8577f](https://github.com/hackclub/orchard/commit/9f8577f245f1ec77267c24e51072018e33f8b8e1))
* **server:** point compose-managed resource errors at the compose file ([f96bf73](https://github.com/hackclub/orchard/commit/f96bf73d7953b804d86122f565f7163d935ce0d7))
* **server:** stop enqueue shadowing its own startNow ([26ee46a](https://github.com/hackclub/orchard/commit/26ee46a2caf9ade868d64b625defdd541e9b0f97))

## [2.18.2](https://github.com/hackclub/orchard/compare/server/v2.18.1...server/v2.18.2) (2026-09-02)


### Bug Fixes

* **server:** stop dropping auto-deploys and mark superseded pushes ([92aba4c](https://github.com/hackclub/orchard/commit/92aba4c7800356161169275fd231204b1bfaa4f7))
* **server:** unwedge auto-deploy when the build job is already gone ([8286b7e](https://github.com/hackclub/orchard/commit/8286b7e4ecea498b1b558749b570066b3521f13a))

## [2.18.1](https://github.com/hackclub/orchard/compare/server/v2.18.0...server/v2.18.1) (2026-09-01)


### Bug Fixes

* bound the inputs feeding quadratic path and url trimming ([a91ea49](https://github.com/hackclub/orchard/commit/a91ea49c237addff6307af24e66397aa4068e0bd))
* draw otp codes without modulo bias ([9bbdb1e](https://github.com/hackclub/orchard/commit/9bbdb1e411113fda8b8471eda553c0f20f25abde))

## [2.18.0](https://github.com/hackclub/orchard/compare/server/v2.17.1...server/v2.18.0) (2026-09-01)


### Features

* watch paths for github auto-deploy ([06b1e44](https://github.com/hackclub/orchard/commit/06b1e4426655bb2c40ea32c7a2a6b33641f2b862))


### Bug Fixes

* validate repo urls before they reach the build pipeline ([b17de6b](https://github.com/hackclub/orchard/commit/b17de6b1dc0fc22c1a9d3ccd4c0caf43ea46b521))

## [2.17.1](https://github.com/hackclub/orchard/compare/server/v2.17.0...server/v2.17.1) (2026-09-01)


### Bug Fixes

* bump sharp to 0.35.4 for patched libheif and libvips ([81969b8](https://github.com/hackclub/orchard/commit/81969b82cecf39c12b9554da6c633967f14a3952))

## [2.17.0](https://github.com/LeafdTK/leaf/compare/server/v2.16.0...server/v2.17.0) (2026-08-28)


### Features

* transfer project ownership by request and accept ([36bf9a7](https://github.com/LeafdTK/leaf/commit/36bf9a761fd7ae0e4df84e29fe6e11ac09a70e37))


### Bug Fixes

* reconcile the pod mirror when a replica becomes leader ([5d17a64](https://github.com/LeafdTK/leaf/commit/5d17a6498084e1183c20aab2046fee77fb9669ff))
* share one cluster snapshot instead of four full pod lists ([3e3bdc8](https://github.com/LeafdTK/leaf/commit/3e3bdc8d7fda779e897d2bea7e80f4eac21aa6e1))

## [2.16.0](https://github.com/LeafdTK/leaf/compare/server/v2.15.0...server/v2.16.0) (2026-08-27)


### Features

* database health is informer-driven with crash alerts and post-mortem logs ([06fc147](https://github.com/LeafdTK/leaf/commit/06fc147d20cf8a0a203ca3dbf11e8c665690bac7))
* next steps checklist on the app overview ([b6566b8](https://github.com/LeafdTK/leaf/commit/b6566b8addff2a5b66285216b59788be28bc54c0))
* per-app image pull policy so restart can re-pull a moving tag ([3253561](https://github.com/LeafdTK/leaf/commit/3253561ac68c450d345a38656f23ea4da55fd1e1))
* pull policy follows the image tag unless you pin it ([e5fb253](https://github.com/LeafdTK/leaf/commit/e5fb2532139cf419cf63075060b4872e768537c9))
* surface kubernetes pod events and fix stale ui after saves ([5a2a9da](https://github.com/LeafdTK/leaf/commit/5a2a9da9bff50f80fd6cb029dd6e6d0706677a7d))


### Bug Fixes

* size shared_buffers and backup compression from the memory limit ([95d1c77](https://github.com/LeafdTK/leaf/commit/95d1c77041e3d400720bbf1986ef4c661762bd75))

## [2.15.0](https://github.com/LeafdTK/leaf/compare/server/v2.14.1...server/v2.15.0) (2026-08-25)


### Features

* dns-verified org domains, tenant-scoped sso sessions, sso off by default ([61eeaa7](https://github.com/LeafdTK/leaf/commit/61eeaa7716bad680433f7fdc93d1f7f87506b796))


### Bug Fixes

* make deleting an already-deleted database idempotent ([56c8093](https://github.com/LeafdTK/leaf/commit/56c8093d0c7402ec83b1a67ee1d6de7200cdf646))
* return 503 not 500 when query stats hit a restarting database ([c43d7a6](https://github.com/LeafdTK/leaf/commit/c43d7a66f1ab4192f14e1972142ea1fbc722e163))
* stop logging an error when a build outlives its deployment ([4f918ea](https://github.com/LeafdTK/leaf/commit/4f918eab4dc61e5a7d143282c84a1fc9ec20b476))
* stop the build watch loop spinning when the informer reports a cached terminal ([08f5b56](https://github.com/LeafdTK/leaf/commit/08f5b567b8074b1a1233faf189652b4fffc0d784))
* suspend github installations that github no longer has ([9a40d23](https://github.com/LeafdTK/leaf/commit/9a40d23117e6f9869597a2fd989220d4ae052498))

## [2.14.1](https://github.com/LeafdTK/leaf/compare/server/v2.14.0...server/v2.14.1) (2026-08-25)


### Bug Fixes

* give mcp grants their own session so role changes stop killing them ([7ab489c](https://github.com/LeafdTK/leaf/commit/7ab489c2fdaee21de8c2bd3374a4d3c1b6ee0fce))

## [2.14.0](https://github.com/LeafdTK/leaf/compare/server/v2.13.0...server/v2.14.0) (2026-08-24)


### Features

* multi-provider sso with org login pages and per-org admin controls ([00cc117](https://github.com/LeafdTK/leaf/commit/00cc1172b6cbf07c896f9dfe641b997f08686e07))

## [2.13.0](https://github.com/LeafdTK/leaf/compare/server/v2.12.0...server/v2.13.0) (2026-08-24)


### Features

* show the internal cluster address under every port ([7f77da8](https://github.com/LeafdTK/leaf/commit/7f77da80f41be677ec7acdcfc361ffcfc0542c62))

## [2.12.0](https://github.com/LeafdTK/leaf/compare/server/v2.11.0...server/v2.12.0) (2026-08-24)


### Features

* import a profile picture from gravatar when the email has one ([296e97c](https://github.com/LeafdTK/leaf/commit/296e97c879b488d729fed03454fc3661ba01491e))


### Bug Fixes

* call them read replicas, not standbys ([168256f](https://github.com/LeafdTK/leaf/commit/168256fdf83841997f501fb1cc9af39ccf44d1bd))

## [2.11.0](https://github.com/LeafdTK/leaf/compare/server/v2.10.0...server/v2.11.0) (2026-08-24)


### Features

* managed databases can run standby replicas ([f0c0ab3](https://github.com/LeafdTK/leaf/commit/f0c0ab3c2e425fe59605c71a9b34c9a6621bec5a))


### Bug Fixes

* stop scraping a dockerfile's own PATH into the env vars that run our builder ([0fb6e0d](https://github.com/LeafdTK/leaf/commit/0fb6e0d6b1cabcc084c8d5608b7c0edb19c110d9))

## [2.10.0](https://github.com/LeafdTK/leaf/compare/server/v2.9.0...server/v2.10.0) (2026-08-20)


### Features

* a fresh instance mints a setup token to claim superadmin ([a3742b9](https://github.com/LeafdTK/leaf/commit/a3742b98ae987937ffa4fef7061c651f6b351757))
* github app is created through the manifest flow instead of six pasted values ([a81f05c](https://github.com/LeafdTK/leaf/commit/a81f05c6eeaa5a81b410d3a7682f2c09e1023170))

## [2.9.0](https://github.com/LeafdTK/leaf/compare/server/v2.8.0...server/v2.9.0) (2026-08-18)


### Features

* mcp goes stateless on the 2026-07-28 spec ([6631bec](https://github.com/LeafdTK/leaf/commit/6631bec61ac8e7a32693f03ce67396dc371d2797))

## [2.8.0](https://github.com/LeafdTK/leaf/compare/server/v2.7.1...server/v2.8.0) (2026-08-18)


### Features

* command-k finds every app and database a person built ([607324f](https://github.com/LeafdTK/leaf/commit/607324f4b48a258eb9494179795cd937d4b77ae9))
* mirror engine resumes watches, batches writes, and tracks crash state in the db ([4d870d4](https://github.com/LeafdTK/leaf/commit/4d870d409161663ddf0728e37bfaa2f072ec2856))


### Bug Fixes

* a running pod waiting on its health check said scheduled ([dbb5085](https://github.com/LeafdTK/leaf/commit/dbb508525e4dc847adfd54439a22edd13deef449))
* the pod manifest handed env values to project viewers ([9f83ff4](https://github.com/LeafdTK/leaf/commit/9f83ff4934576962b056f30cbbd76ac75543bdcd))

## [2.7.1](https://github.com/LeafdTK/leaf/compare/server/v2.7.0...server/v2.7.1) (2026-08-16)


### Bug Fixes

* namespace sync overwriting deployment env from the live pod spec ([0f2e671](https://github.com/LeafdTK/leaf/commit/0f2e6717fdb83d3ce134fe3e195434e7370e0bf5))

## [2.7.0](https://github.com/LeafdTK/leaf/compare/server/v2.6.1...server/v2.7.0) (2026-08-15)


### Features

* notification channels can belong to one app instead of the whole org ([0ce6747](https://github.com/LeafdTK/leaf/commit/0ce6747bf35e020a73e5e4a77bb9781172349df1))

## [2.6.1](https://github.com/LeafdTK/leaf/compare/server/v2.6.0...server/v2.6.1) (2026-08-15)


### Bug Fixes

* the auth wall proxy kept the app's own host header ([488fac3](https://github.com/LeafdTK/leaf/commit/488fac3a2cff4bb1cbb1b50aa42327909c8c2d9c))

## [2.6.0](https://github.com/LeafdTK/leaf/compare/server/v2.5.3...server/v2.6.0) (2026-08-14)


### Features

* public paths skip the domain auth wall ([6b5283b](https://github.com/LeafdTK/leaf/commit/6b5283b24dcd766551a0162576e7e88224490ad6))


### Bug Fixes

* build job status tracking is level-triggered off a k8s informer ([3a14452](https://github.com/LeafdTK/leaf/commit/3a144524b3212f61019bcac8ade6aa66c93553ef))
* marking an env var secret needs tenant secrets rbac ([e6cb59b](https://github.com/LeafdTK/leaf/commit/e6cb59b315ecaa95a923d6631042b7671f6274cc))

## [2.5.3](https://github.com/LeafdTK/leaf/compare/server/v2.5.2...server/v2.5.3) (2026-08-12)


### Bug Fixes

* backup schedule updates carry the resourceversion ([0276b22](https://github.com/LeafdTK/leaf/commit/0276b22c122f9f7ff0bd4c36944e658ecef22142))

## [2.5.2](https://github.com/LeafdTK/leaf/compare/server/v2.5.1...server/v2.5.2) (2026-08-12)


### Bug Fixes

* mirror adopts the cpu limit instead of the derived request ([e428cc0](https://github.com/LeafdTK/leaf/commit/e428cc01b5f2586b5fcea4a79350d325fd24d476))

## [2.5.1](https://github.com/LeafdTK/leaf/compare/server/v2.5.0...server/v2.5.1) (2026-08-12)


### Bug Fixes

* pod lists serve real containers from mirrored manifests ([5b37f27](https://github.com/LeafdTK/leaf/commit/5b37f277d4c2e9f3b87bfe703973c45e0212a15f))

## [2.5.0](https://github.com/LeafdTK/leaf/compare/server/v2.4.2...server/v2.5.0) (2026-08-12)


### Features

* external kubectl spec changes adopted into orchard state ([5e1ab22](https://github.com/LeafdTK/leaf/commit/5e1ab22da67364ab7f21d70aedcd4c0456765432))
* lease-based leader election with multi-replica sso state and protection proxy guard ([a7e7c8e](https://github.com/LeafdTK/leaf/commit/a7e7c8e7c60775a8f9bd8e9c169ac66b0e750be2))
* postgres cluster mirror with lease-sharded informers ([2242d46](https://github.com/LeafdTK/leaf/commit/2242d463d9b4ce6ccaee0bdbfe125713ca2f39d0))
* reads served from the postgres mirror with live escape hatches ([a2b60b5](https://github.com/LeafdTK/leaf/commit/a2b60b5878933a8c19a5e3bd34b25e8f834c200d))
* retrying apply queue takes kubernetes writes out of the request path ([6860c1b](https://github.com/LeafdTK/leaf/commit/6860c1b275dffc5776e90d35a55fec6e044af8c4))

## [2.4.2](https://github.com/LeafdTK/leaf/compare/server/v2.4.1...server/v2.4.2) (2026-08-11)


### Bug Fixes

* build args baked into image layers as ENV directives ([23ca1a6](https://github.com/LeafdTK/leaf/commit/23ca1a654217e782b84b744780efcfc4bcf1a1c6))
* env vars removed from a config surviving in the running container ([8c62a39](https://github.com/LeafdTK/leaf/commit/8c62a3947c9bbedbb8f5c4b788e3bbd61053d369))

## [2.4.1](https://github.com/LeafdTK/leaf/compare/server/v2.4.0...server/v2.4.1) (2026-08-10)


### Bug Fixes

* railpack builds shipping a bash container when no start command is detected ([a5b210b](https://github.com/LeafdTK/leaf/commit/a5b210b3478ecd190173f604e89088131d328044))
* tenant workloads reserving their full cpu limit on the node ([b0cb9b7](https://github.com/LeafdTK/leaf/commit/b0cb9b7670197dd93ea220e9d6369c8cae391597))

## [2.4.0](https://github.com/LeafdTK/leaf/compare/server/v2.3.3...server/v2.4.0) (2026-08-08)


### Features

* node pools, taints, and workflow affinity scheduling ([a96caf3](https://github.com/LeafdTK/leaf/commit/a96caf3b8b1d7aa3d7d7116b8361cf2628dc3b83))


### Bug Fixes

* node pool placement type errors ([9c447e2](https://github.com/LeafdTK/leaf/commit/9c447e2638bf013cb1637cf6a160531d42e8754e))

## [2.3.3](https://github.com/LeafdTK/leaf/compare/server/v2.3.2...server/v2.3.3) (2026-08-08)


### Bug Fixes

* deny unresolvable hosts at the protection wall instead of allowing them ([26f62e2](https://github.com/LeafdTK/leaf/commit/26f62e221b52e974a6c913d4d5b2e8860bf008e7))
* ingress rows cascade with their deployment and protection verifies it applied ([66862ae](https://github.com/LeafdTK/leaf/commit/66862ae4db1c225f8e34d15bc18d45e7315622e5))

## [2.3.2](https://github.com/LeafdTK/leaf/compare/server/v2.3.1...server/v2.3.2) (2026-08-08)


### Bug Fixes

* never ship wal without a backup schedule behind it ([a74fe22](https://github.com/LeafdTK/leaf/commit/a74fe22d85d3438bc06f6d92970b0f76b37847cb))
* surface real kubernetes errors instead of http request failed ([0b833f0](https://github.com/LeafdTK/leaf/commit/0b833f0d769753f30bc5e3001997a0a94613f545))

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
