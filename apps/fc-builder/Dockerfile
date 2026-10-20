FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/ ./cmd/fc-host ./cmd/fc-guest

FROM alpine:3.22 AS assets
ARG TARGETARCH
ARG FIRECRACKER_VERSION=v1.17.0
ARG BUILDKIT_VERSION=v0.31.1
ARG RAILPACK_VERSION=v0.33.0
ARG KERNEL_BASE=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261016-5732b8331e1e-0
ARG KERNEL_VERSION=6.1.188
RUN apk add --no-cache curl e2fsprogs tar
WORKDIR /dl
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) FC_ARCH=x86_64; RP_ARCH=x86_64; \
             KERNEL_SHA=c16288854c798ded46c45b3ccab4bc85b8041552ab50f899fecbad550a641e92; \
             FC_SHA=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558; \
             BK_SHA=1fc78750d0c96bdc18799a3c0b551d6807bd4939e8cd79e357823e467451e16e; \
             RP_SHA=e62b8abaf1349aaa92ebe9d552ffd023ea06511b73b1197e6c32db26f483f511 ;; \
      arm64) FC_ARCH=aarch64; RP_ARCH=arm64; \
             KERNEL_SHA=01455a3dba8a456623cf55b2cb0114e8d23015e156ae127fc0ded00c68fff467; \
             FC_SHA=e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256; \
             BK_SHA=a4c9bef205f61c1e4253bdfd196e1db303aca25e8756105d75c6fddfbab7903f; \
             RP_SHA=7315e9a8d2f95f5faec1cd592a1b4d54be9ee2f855c600f58a90e41bd349488e ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o vmlinux "$KERNEL_BASE/$FC_ARCH/vmlinux-$KERNEL_VERSION"; \
    curl -fsSL -o fc.tgz "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-$FC_ARCH.tgz"; \
    curl -fsSL -o buildkit.tgz "https://github.com/moby/buildkit/releases/download/$BUILDKIT_VERSION/buildkit-$BUILDKIT_VERSION.linux-$TARGETARCH.tar.gz"; \
    curl -fsSL -o railpack.tgz "https://github.com/railwayapp/railpack/releases/download/$RAILPACK_VERSION/railpack-$RAILPACK_VERSION-$RP_ARCH-unknown-linux-musl.tar.gz"; \
    printf '%s  vmlinux\n%s  fc.tgz\n%s  buildkit.tgz\n%s  railpack.tgz\n' "$KERNEL_SHA" "$FC_SHA" "$BK_SHA" "$RP_SHA" | sha256sum -c -; \
    mkdir -p /out; \
    tar -xzf fc.tgz; \
    install -m 0755 "release-$FIRECRACKER_VERSION-$FC_ARCH/firecracker-$FIRECRACKER_VERSION-$FC_ARCH" /out/firecracker; \
    install -m 0755 "release-$FIRECRACKER_VERSION-$FC_ARCH/jailer-$FIRECRACKER_VERSION-$FC_ARCH" /out/jailer; \
    install -m 0644 vmlinux /out/vmlinux
COPY rootfs /rootfs-src
COPY --from=build /out/fc-guest /rootfs-src/fc-guest
RUN sh /rootfs-src/build-rootfs.sh /out/rootfs.ext4 /rootfs-src/fc-guest /dl/buildkit.tgz /dl/railpack.tgz /rootfs-src/init

FROM alpine:3.22
LABEL org.opencontainers.image.source="https://github.com/hackclub/orchard"
RUN apk add --no-cache iproute2 iptables e2fsprogs tini ca-certificates
COPY --from=assets /out/ /opt/fc/
COPY --from=build /out/fc-host /usr/local/bin/fc-host
COPY THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt
EXPOSE 8080 5000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/fc-host"]
