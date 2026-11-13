#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The guest kernel's configuration (#976): the pinned kernel source, Firecracker's recommended config and our fragment make a .config, and
# EVERY option of the fragment must have the requested value in it, or this fails. It runs no compiler beyond the small kconfig tools, so it
# takes seconds on any machine and every CI run does it, even when the built kernel comes from the cache.
# Usage: configure.sh <work dir>; leaves <work dir>/linux (the tree with .config), <work dir>/added-options.txt and the downloaded files.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
work=$(realpath -m "${1:?work dir}")
fragment="$VM_DIR/kernel/config.fragment"
mkdir -p "$work"
fetch_pinned "$KERNEL_URL" "$KERNEL_SHA256" "$work/linux-$KERNEL_VERSION.tar.xz"
fetch_pinned "$FC_GUEST_CONFIG_URL" "$FC_GUEST_CONFIG_SHA256" "$work/fc-base.config"
tree="$work/linux"
if [ ! -f "$tree/Makefile" ]; then
  mkdir -p "$tree"
  tar -xf "$work/linux-$KERNEL_VERSION.tar.xz" -C "$tree" --strip-components=1
fi
cp "$work/fc-base.config" "$tree/.config"
(cd "$tree" && KCONFIG_CONFIG=.config ./scripts/kconfig/merge_config.sh -m .config "$fragment" >/dev/null && make olddefconfig >/dev/null)

"$VM_DIR/kernel/verify-config.sh" "$tree/.config" "$work/fc-base.config" "$work/added-options.txt"
