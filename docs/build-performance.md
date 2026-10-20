# Orchard build performance

This investigation tests platform overhead around full Rails image builds using Flavortown and Stardance. Orchard repeats avoidable checkout setup and image export work, and a persistent-worker fallback can accidentally disable external cache. The implementation changes address those paths while preserving the existing builder and pusher credential boundary.

## Implemented changes

- Select cache and output arguments after acquiring the persistent BuildKit worker. When acquisition fails, or app-specific registry credentials require an isolated worker, the standard builder retains its configured external cache and OCI sidecar output.
- Export the local cache once. The old local-sidecar path ran the solve and materialized an OCI archive a second time after the first image was ready.
- Make deferred S3 publication a cache-only solve. It retains the original build arguments, inferred Git SHA, and Railpack working directory, without another image output or cache import.
- Reuse Git LFS when it is already installed in the source image. Keep best-effort installation for older images and the existing nonfatal handling of LFS download failures.
- Raise the CPU limit for `git-clone` and uploaded-context extraction from `500m` to `2`. Configure `BUILDER_SOURCE_CPU_LIMIT` to override it, including `500m` to retain the former limit. The CPU request remains `100m`; the higher limit lets source preparation use available CPU without reserving two cores.

The generated-job tests execute the emitted shell with recording command substitutes and inspect submitted job resources. All 19 current tests pass. The earlier 15-test regression suite failed 11 tests against the original service; four resource-limit cases were added afterward. An independent review found no concrete regression. The existing related test suites pass 56 tests; repository lint passes. A real BuildKit/S3 integration separately verifies cache-only publication and recovery on a worker starting with zero cache, preserving the OCI image and payload exactly.

The LFS setup microbenchmark measured a median of 1.6495 s for the old package-install path versus 0.354 s when reusing preinstalled Git LFS, across three fresh-container trials per variant. These timings include container creation and removal, use unshaped internet, and ran alongside Rails and network work. They measure setup only, not a complete clone or build.

## Test environment and scope

The test machine is a local ARM64 Colima VM with 2 CPUs and 8 GB RAM, Docker 29.5.2 and BuildKit 0.31.1. The application snapshots contain only committed public source, without their private `secrets` submodules or production credentials. Original repositories remain unchanged. Registry pushes target an isolated local registry; packet shaping changes only benchmark-container network namespaces.

| Repository | Tested revision                                                   |
| ---------- | ----------------------------------------------------------------- |
| Orchard    | `1d092d37fb99b3af6ba4c9a65115dd3a905c4ff5` plus the working patch |
| Flavortown | `5d4a441ff5d9d6db56331c2a61ec13a86c016c40`                        |
| Stardance  | `46747a16861894f89721276c7e3b948af821d1ac`                        |
| kubeops    | `500610892c40ee70cf16f18a06554e94787a583d`                        |

These are build-path integration tests and controlled network experiments. They do not measure production Kubernetes queueing, Kata VM startup, Longhorn latency, private-submodule retrieval, or a complete production application rollout. Vertex timings can overlap; adding them together does not give wall-clock latency.

The unmodified Stardance ARM64 build failed because its sqlite-vec helper installed the repackaged gem outside Bundler's deployment path. The comparison fixture sets `GEM_HOME` to `${BUNDLE_PATH}/ruby/<Ruby API version>` only while running that helper. The same adjustment is applied to both comparison variants. It does not change gem versions or skip Rails asset compilation.

## Hack Club topology

The inspected manifests describe one six-node Talos cluster with VLAN 4037 and MTU 1400. Only `house` is labelled as an Orchard builder, and build concurrency is capped at two. They do not document measured RTT, available bandwidth, or a multi-region build deployment. See the pinned [Talos configuration](https://github.com/hackclub/kubeops/blob/500610892c40ee70cf16f18a06554e94787a583d/talos/talconfig.yaml) and [Orchard release values](https://github.com/hackclub/kubeops/blob/500610892c40ee70cf16f18a06554e94787a583d/kubernetes/apps/orchard/app/helmrelease.yaml).

Builds use Kata, a sidecar pusher, 24 GiB tmpfs scratch and a 32 GiB memory limit. The 100 GiB build-cache PVC uses Longhorn. Its configured default replication is two; Harbor uses a filesystem PVC. These values describe intended configuration, not a live verification of running resources. [Longhorn configuration](https://github.com/hackclub/kubeops/blob/500610892c40ee70cf16f18a06554e94787a583d/kubernetes/apps/longhorn-system/helm-release.yaml), [Harbor storage](https://github.com/hackclub/kubeops/blob/500610892c40ee70cf16f18a06554e94787a583d/kubernetes/apps/harbor/app/harbor-values-configmap.yaml).

The release already uses tmpfs to retain overlayfs. Historical comments about roughly eight-second native-snapshotter COPY operations describe an earlier disk-scratch configuration. Switching to tmpfs is therefore not a new optimization for this deployment.

Orchard's current image builder uses one configured Kubernetes context and process-wide registry endpoints; Depot is its explicit remote-builder path. The separate-cluster scenarios below model source and registry network placement, not an existing arbitrary multi-cluster scheduler. A future multi-cluster deployment should keep the active worker, hot cache and registry close together, with portable cache for worker replacement. Currently the local-cache setting overrides S3 rather than combining local and remote cache tiers. [Builder configuration](../apps/server/src/docker/image-builder.service.ts).

The new source-init limit also affects effective pod limits. Standard BuildKit jobs already allow at least four CPUs, and persistent-worker client jobs allow two. Depot's main container allows one CPU, so its two-CPU source init raises the effective pod CPU limit to two, before any runtime overhead. Its effective CPU request remains unchanged. Account for that limit when applying namespace quotas or sizing Kata VMs; this investigation did not measure Kata's resulting VM allocation. Kubernetes uses the higher of the init limit and the sum of regular-container limits. [Init-container resource accounting](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/#resource-sharing-within-containers).

## Network experiments

| Scenario                        | Configured RTT | Rate per direction |
| ------------------------------- | -------------: | -----------------: |
| Same cluster, separate servers  |           2 ms |         1,000 Mbps |
| Separate clusters in one region |          10 ms |           500 Mbps |
| Separate regions                |          80 ms |           100 Mbps |
| Constrained remote server       |         150 ms |            20 Mbps |

These are explicit test assumptions, not measured Hack Club network characteristics. Each endpoint receives half the configured delay. The harness records observed ping, qdisc statistics, interface counters, checked-out revision and configured CPU quota. Source tests use Git's native protocol and omit HTTPS, LFS and submodules. A warm source result means an existing object database plus a new detached worktree; it does not mean reusing a dirty checkout.

There are 76 source measurements: 48 in the first four-profile matrix, 24 in the CPU comparison below, and four constrained-link confirmations. The first matrix ran alongside cold Rails compilation, at MTU 1500. Its fast-link timings are affected by contention and are not used to estimate the CPU improvement.

For the CPU comparison, Rails compilation was stopped and both endpoints used MTU 1400, 2 ms configured RTT and 1,000 Mbps per direction. Each cell below is the median of three runs. Host background activity was not isolated, and the CPU groups ran sequentially.

| Source preparation                     | 500m CPU |  2 CPUs | Reduction |
| -------------------------------------- | -------: | ------: | --------: |
| Flavortown fresh shallow clone         |  1.826 s | 1.028 s |       44% |
| Stardance fresh shallow clone          |  3.717 s | 2.054 s |       45% |
| Flavortown warm fetch and new worktree |  0.782 s | 0.462 s |       41% |
| Stardance warm fetch and new worktree  |  1.213 s | 0.703 s |       42% |

The fresh-clone comparison supports the implemented CPU-limit change. Warm source caching is an experiment, not an implemented Orchard feature. These unchanged-HEAD warm runs received about 1.2 KB, versus roughly 65 MB for Flavortown and 146 MB for Stardance fresh clones; an updated commit would require additional transfer.

At MTU 1400, 150 ms RTT and 20 Mbps, one additional run per app and mode measured Flavortown at 30.112 s fresh versus 2.215 s warm, and Stardance at 65.266 s versus 3.448 s. These are single confirmations, not repeated medians or a CPU comparison; Rails work could resume during them.

## Rails build and push measurements

The first completed pipeline cohort uses Stardance, a warm BuildKit daemon and a fresh destination repository for every push. It measures repeated full-image export and push, not cold dependency compilation. Both the initial and duplicate OCI archives in this cohort were written to the host bind mount under `/exports`; production's duplicate archive uses the container's `/tmp`, so its storage costs can differ.

| Registry link                  | Samples per variant |          Before |           After | Observed change             |
| ------------------------------ | ------------------: | --------------: | --------------: | --------------------------- |
| 2 ms RTT, 1,000 Mbps, MTU 1400 |                   3 | 17.936 s median | 16.943 s median | 5.5% lower                  |
| 80 ms RTT, 100 Mbps, MTU 1400  |                   1 |        97.623 s |        98.055 s | No improvement; 0.4% higher |

The fast-link result is a modest observed reduction across three runs per variant, not a production-wide estimate. On the remote link, the roughly 960 MB image upload dominated the overlapping duplicate work, and removing that work did not shorten this single pair. All eight runs verified the pushed manifest, image configuration and layer digests; the same image manifest was preserved across both variants and both link profiles.

The earlier compatible Stardance build completed in 149.843 s, including Rails compilation, OCI output and local cache export. Base-image and system-package work was already cached after the original ARM64 failure, so this is a base/system-warm build, not a cold-build measurement or a before/after result.

A separate warm-redeploy cohort reused one populated destination repository, the same unchanged source and image, and a warm BuildKit daemon. The baseline wrote its duplicate archive to the client container's `/tmp`, matching the production path more closely. With 2 ms RTT, 1,000 Mbps and MTU 1400, three runs per variant gave a median of **10.820 s before versus 7.708 s after, 28.8% lower**. The duplicate solves took 4.666, 4.832 and 4.893 s, overlapping pushes that could reuse the existing registry layers. This result applies to that warm-redeploy condition; changed image layers, a cold worker or a slower destination can change which phase dominates.

All six warm-redeploy runs verified the same complete Stardance image as the eight fresh-repository runs: approximately 960 MB of compressed layers, with identical manifest, configuration and layer digests across all 14 runs.

Keep this cohort separate from the host-bind-mount cohort above: both the registry state and duplicate-output filesystem changed. The warm cohort copied the duplicate archive out of the container for verification after timing ended.

The harness builds the complete Rails image, writes its OCI archive and exports a local `mode=max` zstd cache. The baseline then pushes the archive while concurrently repeating the solve and archive/cache export; the fixed path only pushes. Both solves use an existing client container, avoiding an extra container-start cost in the baseline. The harness verifies the pushed manifest, image configuration and layer digests against the archive.

Registry-link shaping affects the actual Skopeo push while build and package traffic remain unshaped. `build_and_push_seconds` adds the first build to the overlapping tail's wall duration, rather than summing concurrent push and duplicate-solve times. Source checkout/extraction and Kubernetes queueing are outside these pipeline timings; BuildKit context transfer remains included. Network-namespace setup, verification and cleanup are recorded separately and excluded from this comparison. Repeated warm-worker trials and initial cold-build timings must be reported separately.

The exported Stardance image also passes an offline runtime smoke test as its existing non-root user: production Rails initialization, `/up` returning 200, compiled JavaScript and CSS returning 200 with hashes matching their files, and actual MJML rendering. The public snapshot lacks the private S3 bucket configuration, so the initial unmodified runtime configuration fails during Active Storage initialization. The successful smoke explicitly selects local Active Storage, dummy localhost database URLs and `--network none`; it does not validate database-backed flows, external storage or the migration-running deployment entrypoint.

Flavortown's unmodified ARM64 build failed after 129.004 s because its frozen lockfile lists `arm64-linux`, while the runtime reports `aarch64-linux`. Completed steps included 23.927 s for base OS packages, 81.756 s for build packages and libheif compilation, and 15.363 s for Node/npm/Yarn setup. These are observations from a failed cold build, not a successful build baseline or measured optimization.

A benchmark-only Flavortown fixture subsequently completed the full build, including unchanged Rails asset compilation and OCI export, in 132.828 s with those native/system stages cached. It adds matching `aarch64-linux` gem variants and the sqlite-vec repack helper; all 251 locked gem name/version sets, Bundler 4.0.22 and the existing Git dependency revision are preserved. The image was pushed to the isolated registry and its manifest, configuration bytes and layer descriptors verified against the OCI archive. This establishes full-image build/push coverage for Flavortown; its measured before/after speedup is the source CPU comparison, not a full-build percentage. Both original application repositories remain unchanged.

## Further optimizations

1. Keep a tenant-scoped source object cache close to the builder. Public-root checkout experiments demonstrate the potential; production integration must retain authorization checks, exact revisions, submodule and LFS behavior, concurrent-build isolation and bounded cache eviction. Do not mount a shared cross-tenant repository cache into arbitrary build steps.
2. Use persistent workers with stable tenant placement and local hot storage. Orchard's single shared ReadWriteOnce cache PVC is not node-local NVMe and can constrain placement across servers. Use portable registry or S3 cache for recovery between workers or clusters. Docker's [Kubernetes builder driver](https://docs.docker.com/build/builders/drivers/kubernetes/) documents sticky routing and per-replica storage; Orchard must retain its tenant isolation.
3. Preserve intermediate Rails stages across worker replacement. Local cache already exports `mode=max`, while the S3 path uses `mode=min`. Compare the additional bytes of `max` against avoided apt, libheif and gem work before changing remote-cache policy. [Registry cache modes](https://docs.docker.com/build/cache/backends/registry/).
4. Mirror common base images near builders, and preinstall versioned Railpack and Depot tooling. Railpack currently downloads its executable and checksums per build. [BuildKit registry mirrors](https://docs.docker.com/build/buildkit/configure/#registry-mirror).
5. Avoid repeated Rails dependency work. Both examples install Yarn dependencies before `COPY . .`, but jsbundling-rails 1.3.1 installs again during asset precompile. Its [documented task implementation](https://github.com/rails/jsbundling-rails/blob/v1.3.1/lib/tasks/jsbundling/build.rake) supports `SKIP_YARN_INSTALL=1` while retaining JavaScript compilation. This change has not been benchmarked, and neither application repository was changed. Independent Ruby and JavaScript dependency stages also avoid invalidating Yarn when only Gemfile changes.
6. Exclude development and test gems from runtime images where application behavior permits; both examples currently exclude only `development`. Retain Stardance's runtime MJML dependencies. Evaluate targeted ownership during COPY instead of recursive chown, and exclude docs/tests from the Docker context where appropriate. [Docker cache optimization](https://docs.docker.com/build/cache/optimize/).
7. Correct phase attribution before interpreting Orchard's timeline. The current cloning timestamp precedes job submission, while scheduled is recorded after the pod leaves Pending, which includes init-container execution. Measure queue, scheduling, image pulls, each init container, source transfer, solve, image export, cache export and push independently, preserving overlap.

Do not raise the concurrency cap without measuring memory and queueing together. The configured two-build limit and 24 GiB tmpfs allocation make memory capacity relevant even when spare CPU exists.

## Evidence retention

The benchmark harness, compatibility fixtures, raw measurements, build logs, OCI archives and exported cache are retained in the local task workspace `.orchard-build-bench` beside the repository. They are excluded from PR #163 and are not included in the repository. This report summarizes the measurements and their limitations; reproducing the experiments requires that separately retained harness and evidence.

The experiments used Docker, Python 3, a host path shared into the Docker VM and an isolated benchmark network. Pipeline trials ran sequentially, with separate fresh-repository and populated-repository cohorts. The source CPU comparison ran without intentional concurrent heavy workloads. No production kubeconfig or registry credentials were used.

After verification, the temporary benchmark containers, network and worker-cache volume were removed. The local evidence remains available; no pre-existing application containers were stopped.

The S3 smoke used a digest-pinned [source-built MinIO image](https://github.com/coollabsio/minio/blob/main/Dockerfile), disposable credentials, no published ports and a separate BuildKit worker. It verified cache-only export, import on a worker starting with zero cache, unchanged OCI output and restored payload. Its tiny fixture demonstrates cache behavior and artifact preservation; it is not a Rails performance measurement.
