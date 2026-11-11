#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: start time of one instance from the golden image: init (copy of the image into the pool), start, dockerd answers.
# usage: time-start.sh <name> <image> [incus init args...]
set -u
n=$1; img=$2; shift 2
now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
i() { sg incus-admin -c "incus $(printf '%q ' "$@") </dev/null" >/dev/null 2>&1; }
t0=$(now); i init "$img" "$n" "$@"; t1=$(now)
i start "$n"; t2=$(now)
until sg incus-admin -c "incus exec $n -- docker info" >/dev/null 2>&1; do sleep 0.05; [ "$(awk -v a=$t0 -v b=$(now) 'BEGIN{print (b-a>60)}')" = 1 ] && { echo "TIMEOUT"; exit 1; }; done
t3=$(now)
echo "$n init=$(el $t0 $t1)s start=$(el $t1 $t2)s dockerd_ready_after_start=$(el $t2 $t3)s total=$(el $t0 $t3)s"
