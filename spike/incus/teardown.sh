#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: remove everything setup.sh and build-image.sh made, in the order Incus needs. Touches nothing it did not create.
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
bash "$(dirname "$0")/reap.sh"
ix network delete spkin; ix network delete spkout; ix network acl delete spk-outer; ix profile delete spike
ix image delete spike-docker
# the cached base image of build-image.sh (`images:ubuntu/24.04`, no alias): the only other image of this spike
sg incus-admin -c 'incus image list --format csv -c fld' </dev/null | awk -F, '$2=="" && $3 ~ /^Ubuntu noble amd64/ {print $1}' | while read -r fp; do ix image delete "$fp"; done
POOL=${SPIKE_POOL:-spike}
ix config unset storage.images_volume; ix storage volume delete "$POOL" images
if [ "$POOL" = spike ]; then ix storage delete spike; fi   # a pool of someone else's (crpool) is kept
rm -rf "${SPIKE_ROOT:-/home/luca/incus-spike-pool-parent}"
