#!/bin/sh
set -eu
OUT=$1
GUEST_BIN=$2
BUILDKIT_TGZ=$3
RAILPACK_TGZ=$4
INIT=$5
R=$(mktemp -d)
mkdir -p "$R/etc/apk"
cp -r /etc/apk/keys "$R/etc/apk/"
cp /etc/apk/repositories "$R/etc/apk/"
apk add --quiet --root "$R" --initdb --no-cache --no-scripts \
  alpine-baselayout busybox busybox-binsh musl ca-certificates ca-certificates-bundle tini e2fsprogs \
  git git-lfs jq curl openssh-client pigz
chroot "$R" /bin/busybox --install -s
mkdir -p "$R/usr/local/bin"
tar -xzf "$BUILDKIT_TGZ" -C "$R/usr/local" bin/buildkitd bin/buildctl bin/buildkit-runc
ln -sf buildkit-runc "$R/usr/local/bin/runc"
tar -xzf "$RAILPACK_TGZ" -C "$R/usr/local/bin" railpack
install -m 0755 "$GUEST_BIN" "$R/usr/local/bin/fc-guest"
install -m 0755 "$INIT" "$R/init"
for d in proc sys dev run tmp cache workspace orchard-build root; do mkdir -p "$R/$d"; done
ln -sf /run/resolv.conf "$R/etc/resolv.conf"
ln -sf /run/hosts "$R/etc/hosts"
echo buildvm > "$R/etc/hostname"
rm -rf "$R/var/cache/apk" "$R/etc/apk/keys"
SIZE_MB=$(( $(du -sm "$R" | cut -f1) + 256 ))
mkfs.ext4 -q -F -d "$R" -L fcroot "$OUT" "${SIZE_MB}M"
rm -rf "$R"
