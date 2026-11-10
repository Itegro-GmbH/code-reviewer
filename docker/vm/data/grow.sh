#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Grows an ext4 image FILE to a size, offline and unprivileged (what the launcher does to a job's copy of the data disk, #978; measured at 20 ms
# in the spike #970). Usage: grow.sh <image> <size, as truncate takes it (4G)>
set -euo pipefail
image=${1:?image}; size=${2:?size}
truncate -s "$size" "$image"
# resize2fs wants a checked file system; e2fsck exits 1 when it corrected something.
e2fsck -fy "$image" > /dev/null || [ $? -le 1 ]
resize2fs "$image" 2>&1 | tail -n 1
