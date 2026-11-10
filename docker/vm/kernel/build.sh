#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Builds the guest kernel (#976). Usage: build.sh <work dir> <out dir>
# Outputs in <out dir>: vmlinux (what Firecracker boots), kernel.config (the final .config), added-options.txt, build-seconds.txt.
# Needs: flex bison libelf-dev libssl-dev bc dwarves and a C toolchain. About 10 minutes on 4 cores (measured: 566 s).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
work=$(realpath -m "${1:?work dir}"); out=$(realpath -m "${2:?out dir}")
mkdir -p "$out"
"$VM_DIR/kernel/configure.sh" "$work"
start=$(date +%s)
(cd "$work/linux" && make -j"$(nproc)" vmlinux 2>&1 | tail -n 5)
echo "$(( $(date +%s) - start ))" > "$out/build-seconds.txt"
cp "$work/linux/vmlinux" "$out/vmlinux"
cp "$work/linux/.config" "$out/kernel.config"
cp "$work/added-options.txt" "$out/added-options.txt"
ls -l "$out"
log "kernel built in $(cat "$out/build-seconds.txt") s on $(nproc) cores"
