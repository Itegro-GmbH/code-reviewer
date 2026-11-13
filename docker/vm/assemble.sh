#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Collects the files of one release into a directory and writes the manifest (#976); it does NOT sign: the key is only in the release job.
# Usage: assemble.sh <out dir> <kernel dir> <rootfs dir> <data dir> <release number> <commit>
#   <kernel dir>  vmlinux, kernel.config, fc-base.config, config.fragment, linux-<version>.tar.xz (the kernel job's artifact)
#   <rootfs dir>  rootfs.ext4, rootfs-info.json, packages.txt (rootfs/build.sh)
#   <data dir>    dockerdata.ext4, images.json (data/build.sh)
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
out=$(realpath -m "${1:?out dir}"); kdir=$(realpath "${2:?kernel dir}"); rdir=$(realpath "${3:?rootfs dir}"); ddir=$(realpath "${4:?data dir}")
release=${5:?release number}; commit=${6:?commit}
mkdir -p "$out"
for f in vmlinux kernel.config fc-base.config config.fragment "linux-$KERNEL_VERSION.tar.xz"; do cp "$kdir/$f" "$out/$f"; done
cp "$rdir/packages.txt" "$out/packages.txt"
log "compress the root file system and the data disk (zstd)"
zstd -T0 -10 -q -f "$rdir/rootfs.ext4" -o "$out/rootfs.ext4.zst"
zstd -T0 -10 -q -f "$ddir/dockerdata.ext4" -o "$out/dockerdata.ext4.zst"
ls -l "$out"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$REPO_DIR/dispatcher/src/vm-artifacts/manifest-main.ts" \
  --dir "$out" --out "$out/manifest.json" --release "$release" --commit "$commit" \
  --kernel-version "$KERNEL_VERSION" --firecracker-version "$FIRECRACKER_VERSION" \
  --rootfs-info "$rdir/rootfs-info.json" --images "$ddir/images.json"
cat "$out/manifest.json"
