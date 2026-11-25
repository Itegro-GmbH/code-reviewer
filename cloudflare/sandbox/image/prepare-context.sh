#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Makes image/generated/ for one build of the Cloudflare image (#1159): the golden snapshot's recipe (the scripts and pins as data, from the
# Dispatcher's own code), the two prepare scripts, the Ubuntu Base pin and the package list of the local VM's root file system. Nothing is copied
# by hand and no version is written a second time: a bump of the golden snapshot's pin is a bump of this image. Needs Node 24 (the recipe is
# TypeScript that Node runs as it is) and no Docker. Usage: image/prepare-context.sh   (from anywhere)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$here/generated"
rm -rf "$out"
mkdir -p "$out/recipe" "$out/host" "$out/inner"
node "$repo/dispatcher/src/vm-artifacts/recipe-main.ts" "$out/recipe"
install -m 0755 "$repo/docker/sandbox/vm-prepare.sh" "$repo/docker/sandbox/sysbox-prepare.sh" "$out/host/"
install -m 0644 "$repo/docker/vm/rootfs/packages.txt" "$out/packages.txt"
# Only the Ubuntu Base pin of docker/vm/pins.env: the file also holds the kernel and Firecracker pins, which this image has no use for.
grep -E '^UBUNTU_BASE_(VERSION|URL|SHA256)=' "$repo/docker/vm/pins.env" > "$out/pins.env"
[ "$(wc -l < "$out/pins.env")" = 3 ] || { echo "prepare-context: the Ubuntu Base pins are not all in docker/vm/pins.env" >&2; exit 1; }
echo "prepare-context: wrote $out" >&2
