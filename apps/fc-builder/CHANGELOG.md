# Changelog

## [1.0.3](https://github.com/hackclub/orchard/compare/fc-builder/v1.0.2...fc-builder/v1.0.3) (2026-10-21)


### Bug Fixes

* build go binaries with go 1.26.10 and bump cli grpc and x/net for open advisories ([576c8ac](https://github.com/hackclub/orchard/commit/576c8ac59c882677d503ff0135c23495fed919c7))

## [1.0.2](https://github.com/hackclub/orchard/compare/fc-builder/v1.0.1...fc-builder/v1.0.2) (2026-10-20)


### Bug Fixes

* **fc-builder:** stop oom-killing build vms by giving the host page cache room and reclaiming it early ([48bb56e](https://github.com/hackclub/orchard/commit/48bb56eb4602700a4f8f133ed2c7c5943d4a66dc))

## [1.0.1](https://github.com/hackclub/orchard/compare/fc-builder/v1.0.0...fc-builder/v1.0.1) (2026-10-20)


### Bug Fixes

* **fc-builder:** keep vm cgroups inside the pod and stop booting vms when the node runs low on memory ([4bfcb7b](https://github.com/hackclub/orchard/commit/4bfcb7b1d495140345251024983dd91b66b3993a))

## 1.0.0 (2026-10-20)


### Features

* **fc-builder:** firecracker microvm build host with scoped push proxy ([c82bd82](https://github.com/hackclub/orchard/commit/c82bd829955c58f4300e46bf2757760e42f09c62))

## Changelog
