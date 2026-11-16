# fc-builder

An experimental image builder. Each project builds inside its own Firecracker
microVM, with that project's BuildKit cache kept on a persistent disk image
between builds.

## Who runs it

Any instance can, but it is off by default. It needs nodes with `/dev/kvm` and
runs as a privileged pod. Without it, builds use the standard Kubernetes
builder.

Turning it on takes two steps in the Helm chart:

1. `fcBuilder.enabled: true` deploys the hosts: a StatefulSet in
   `orchard-fc-builders`, at most one pod per node, on nodes labelled
   `orchard-fc-builder: "true"`.
2. `fcBuilder.serverEnabled: true` lets the server send builds to them
   (`FC_BUILDER_ENABLED`, `FC_BUILDER_HOSTS`, `FC_BUILDER_TOKEN` on the server).

Even then a build only goes to a VM when the deployment's builder override
says `firecracker` or the `firecracker-builder` PostHog feature flag picks the
project. Everything else uses the standard builder.

## How it works

The image holds two binaries.

- `fc-host` runs in the pod. It boots and reuses VMs (one per project, up to
  `FC_MAX_VMS`), stops idle ones, keeps one cache image per project and evicts
  old ones. It serves the build API the server calls on `:8080` and a registry
  push proxy on `:5000`.
- `fc-guest` runs inside each VM. It runs `buildkitd` and the build steps, and
  talks to the host over vsock.

The image also carries the Firecracker and jailer binaries, a guest kernel and
a root filesystem built by `rootfs/build-rootfs.sh` with BuildKit and Railpack.

The server authenticates to the API with expiring HS256 tokens signed with the
shared secret `FC_BUILDER_TOKEN`. Guests never see registry credentials: they
push through the proxy, which only accepts the repository granted to the build
running in that VM, and adds the credentials on the way upstream. VMs cannot
reach each other or link-local addresses.

API, all under `/v1/` and authenticated:

- `POST /v1/builds`, `GET /v1/builds/{id}`, `GET /v1/builds/{id}/events`
- `DELETE /v1/builds/{id}`, `DELETE /v1/builds`
- `GET /v1/status`

`GET /healthz` returns `ok`.

## Configuration

Environment for `fc-host`. The chart sets these from `fcBuilder.*` in
[`values.yaml`](../../infra/charts/orchard/values.yaml).

- `FC_BUILDER_TOKEN`: shared secret with the server. Required.
- `HARBOR_USERNAME`, `HARBOR_PASSWORD`: credentials for the upstream registry.
  Required.
- `FC_UPSTREAM_REGISTRY`: where the push proxy forwards (default
  `http://harbor-core.harbor.svc.cluster.local`)
- `FC_LISTEN`: API address (default `:8080`)
- `FC_PROXY_PORT`: push proxy port (default `5000`)
- `FC_STATE_DIR`: VM state, cache images and build logs (default `/state`)
- `FC_ASSETS_DIR`: kernel, rootfs and Firecracker binaries (default `/opt/fc`)
- `FC_HOST_ID`: name reported in status (default `$HOSTNAME`)
- `FC_MAX_VMS` (default `6`), `FC_VM_VCPUS` (default `8`), `FC_VM_MEM_MIB`
  (default `12288`), `FC_VM_MEM_OVERHEAD_MIB` (default `1536`): VM sizing
- `FC_VM_IDLE_SECONDS` (default `300`), `FC_VM_BOOT_TIMEOUT_SECONDS` (default
  `60`), `FC_ACQUIRE_WAIT_SECONDS` (default `20`), `FC_DRAIN_SECONDS` (default
  `20`): timeouts
- `FC_MIN_NODE_FREE_MIB` (default `32768`): no new VM boots when the node has
  less free memory than this
- `FC_HOST_RESERVE_MIB` (default `2048`): memory kept back for the host when
  fitting VMs into the pod's limit
- `FC_USE_JAILER`, `FC_JAILER_CGROUPS` (both default `true`): run VMs under
  the Firecracker jailer, in their own cgroups
- `FC_IO_ENGINE`: Firecracker block I/O engine (default `Async`)
- `FC_BASE_UID` (default `300000`): first uid for jailed VMs
- `FC_CACHE_IMAGE_SIZE` (default `50G`): size of each project's cache image
- `BUILDKIT_CACHE_MAX_AGE_DAYS` (default `14`), `BUILDKIT_CACHE_HIGH_PCT`
  (default `80`), `BUILDKIT_CACHE_TARGET_PCT` (default `60`),
  `BUILDKIT_CACHE_IDLE_MINUTES` (default `60`): cache image eviction

## Develop

```sh
cd apps/fc-builder
go build ./...
go test ./...
```

The tests do not need KVM. Booting real VMs needs Linux with `/dev/kvm`, root
and the assets the `Dockerfile` downloads.

## Release

release-please versions it as `fc-builder/vX.Y.Z` from `fix(fc-builder):` and
`feat(fc-builder):` commits. A release builds the `Dockerfile` and publishes
`ghcr.io/hackclub/orchard/fc-builder`. The chart pins the tag in
`fcBuilder.image.tag`. Firecracker, BuildKit, Railpack and the guest kernel
are pinned by version and checksum in the `Dockerfile`.
