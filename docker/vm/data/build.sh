#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Builds the prepared Docker data disk (#976): an ext4 image holding the Worker image and the agent image in the guest's own Docker (its image
# store, containerd's and Sysbox's directories), the base of the per-job copy-on-write disk. The images are loaded INTO a guest by the same
# dockerd, with the same daemon.json, that uses them later; no host Docker writes the disk. Needs /dev/kvm and node, runs unprivileged.
# Usage: build.sh <images.tar> <vmlinux> <rootfs.ext4> <work dir> <out dir>
#   writes <out dir>/dockerdata.ext4 (shrunk to its minimum: the launcher grows the copy to the job's quota) and <out dir>/images.json
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
images=$(realpath "${1:?images.tar}"); kernel=$(realpath "${2:?vmlinux}"); rootfs=$(realpath "${3:?rootfs.ext4}")
work=$(realpath -m "${4:?work dir}"); out=$(realpath -m "${5:?out dir}")
mkdir -p "$work/seed" "$out"

log "seed disk: the image archive on a read-only drive"
rm -f "$work/seed/images.tar"
ln "$images" "$work/seed/images.tar" 2> /dev/null || cp "$images" "$work/seed/images.tar"
seed_mb=$(( $(stat -c %s "$images") / 1048576 + 256 ))
rm -f "$work/seed.ext4"
truncate -s "${seed_mb}M" "$work/seed.ext4"
mkfs.ext4 -q -m 0 -L seed -d "$work/seed" "$work/seed.ext4"
rm -f "$work/seed/images.tar"

log "empty data disk (sparse), booted once in seed mode"
rm -f "$work/data.ext4"
truncate -s "${DATA_DISK_GIB:-16}G" "$work/data.ext4"
mkfs.ext4 -q -m 0 -L jobdisk "$work/data.ext4"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$REPO_DIR/dispatcher/src/vm-artifacts/boot-main.ts" \
  --mode seed --kernel "$kernel" --rootfs "$rootfs" --data "$work/data.ext4" --seed "$work/seed.ext4" \
  --work "$work/seed-boot" --vcpus 4 --mem 6144 --timeout-s 1500 \
  --images-out "$out/images.json" --events-out "$work/seed-boot/events.json"

log "shrink the disk to its minimum: a per-job copy is grown (resize2fs on the file) to the quota before the start"
# e2fsck exits 1 when it corrected something (a journal replayed): fine; 2 and above is a file system that is not.
e2fsck -fy "$work/data.ext4" > "$work/e2fsck.log" || [ $? -le 1 ] || { cat "$work/e2fsck.log"; exit 1; }
resize2fs -M "$work/data.ext4" 2>&1 | tail -n 1
blocks=$(dumpe2fs -h "$work/data.ext4" 2> /dev/null | awk -F: '/^Block count/ {gsub(/ /,"",$2); print $2}')
bsize=$(dumpe2fs -h "$work/data.ext4" 2> /dev/null | awk -F: '/^Block size/ {gsub(/ /,"",$2); print $2}')
truncate -s "$((blocks * bsize))" "$work/data.ext4"
mv "$work/data.ext4" "$out/dockerdata.ext4"
ls -ls "$out/dockerdata.ext4"
log "data disk ready: $(( blocks * bsize / 1048576 )) MiB file system"
