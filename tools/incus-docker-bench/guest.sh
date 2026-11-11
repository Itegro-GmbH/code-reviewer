#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The series of the Incus/Docker bench (#1013) that run next to the Docker daemon under test: inside an Incus instance, or on the host for
# the control that has no Incus. No `incus exec` is in the measured path, so the numbers have no client overhead.
# usage: guest.sh <variant> <out.tsv>        env: BENCH_N (repetitions, default 12), BENCH_BATTERY=1 (also the first spike's battery),
#                                                  CTR_SOCK (containerd's socket, to run a container without dockerd)
# Rep 0 of every series is the first (warm-up) run and is reported apart; reps 1..N are the sample.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
BENCH_VARIANT=$1
BENCH_OUT=$2
N=${BENCH_N:-12}
CTR_SOCK=${CTR_SOCK:-/var/run/docker/containerd/containerd.sock}
# shellcheck source=tools/incus-docker-bench/lib.sh
. "$HERE/lib.sh"
RUN=(docker run --rm --pull=never)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; docker rm -f bench-timeline >/dev/null 2>&1' EXIT

# --- the preflight: a container must really run here, or nothing below means anything
pre=$("${RUN[@]}" busybox echo preflight-ok 2>&1 </dev/null)
if [ "$pre" != preflight-ok ]; then
  record preflight 0 FAILED "docker run busybox echo printed '$(flat "$pre")'"
  exit 2
fi
printf '%s\n' "loadavg before: $(cut -d' ' -f1-3 /proc/loadavg)" >&2

# --- the bundle for runc and the image for ctr (controls: they skip dockerd, or dockerd and containerd)
ctl_runc=0
if command -v runc >/dev/null 2>&1; then
  mkdir -p "$WORK/bundle/rootfs"
  cid=$(docker create --pull=never busybox true 2>/dev/null)
  if [ -n "$cid" ] && docker export "$cid" | tar -x -C "$WORK/bundle/rootfs" 2>/dev/null \
    && (cd "$WORK/bundle" && runc spec 2>/dev/null) \
    && sed -i -e 's/"terminal": true/"terminal": false/' -e 's/"sh"/"true"/' "$WORK/bundle/config.json" \
    && (cd "$WORK/bundle" && runc run bench-probe >/dev/null 2>&1 </dev/null); then
    ctl_runc=1
  else
    record ctl.runc 0 FAILED "could not set up or run a runc bundle of busybox"
  fi
  [ -n "$cid" ] && docker rm "$cid" >/dev/null 2>&1
fi
ctl_ctr=0
if command -v ctr >/dev/null 2>&1 && [ -S "$CTR_SOCK" ]; then
  if ctr -a "$CTR_SOCK" -n moby run --rm docker.io/library/busybox:latest bench-probe true >/dev/null 2>&1 </dev/null; then ctl_ctr=1
  else record ctl.ctr 0 FAILED "ctr could not run docker.io/library/busybox:latest in namespace moby"; fi
fi

# --- one `docker run busybox true` and its parts, with the controls around it
for rep in $(seq 0 "$N"); do
  timed run.total "$rep" -- "${RUN[@]}" busybox true
  # the parts of the same work: create, start (returns when the task runs), wait (returns when it has exited), rm
  if timed split.create "$rep" -- docker create --pull=never busybox true; then
    cid=$TIMED_OUT
    parts=$TIMED_SECS
    if timed split.start "$rep" -- docker start "$cid"; then parts="$parts $TIMED_SECS"; fi
    if timed split.wait "$rep" -- docker wait "$cid"; then parts="$parts $TIMED_SECS"; fi
    if timed split.rm "$rep" -- docker rm "$cid"; then parts="$parts $TIMED_SECS"; fi
    # shellcheck disable=SC2086 # the parts are separate words
    [ "$(wc -w <<<"$parts")" = 4 ] && record split.total "$rep" "$(sum $parts)"
  fi
  # options that take away one thing each: the container's network, seccomp and AppArmor
  timed opt.nonet "$rep" -- "${RUN[@]}" --network none busybox true
  timed opt.unconfined "$rep" -- "${RUN[@]}" --security-opt seccomp=unconfined --security-opt apparmor=unconfined busybox true
  # floors: a daemon round trip, the client alone, 200 process starts
  timed ctl.api.ps "$rep" -- docker ps -q
  timed ctl.client.version "$rep" -- docker --version
  t0=$EPOCHREALTIME; for _ in $(seq 1 200); do /bin/true; done; record ctl.spawn200 "$rep" "$(elapsed "$t0" "$EPOCHREALTIME")"
  # what Docker waits for when the disk is busy: 20 small writes, each forced to the disk (on the file system Docker's data root is on)
  timed ctl.fsync20 "$rep" -- dd if=/dev/zero of="$WORK/fsync" bs=4k count=20 oflag=dsync
  # below dockerd: containerd's client (the shim, runc) and runc alone
  if [ "$ctl_ctr" = 1 ]; then timed ctl.ctr "$rep" -- ctr -a "$CTR_SOCK" -n moby run --rm docker.io/library/busybox:latest bench-probe true; fi
  if [ "$ctl_runc" = 1 ]; then t0=$EPOCHREALTIME; if (cd "$WORK/bundle" && runc run bench-probe >/dev/null 2>&1 </dev/null); then record ctl.runc "$rep" "$(elapsed "$t0" "$EPOCHREALTIME")"; else record ctl.runc "$rep" FAILED "runc run exited non-zero"; fi; fi
done
for m in run.total split.create split.start split.wait split.rm split.total opt.nonet opt.unconfined ctl.api.ps ctl.client.version; do expect_samples "$m" "$N"; done
printf '%s\n' "loadavg after the series: $(cut -d' ' -f1-3 /proc/loadavg)" >&2

# --- what happens during one `docker run`, as the daemons see it (timestamps of Docker's and containerd's events)
{
  docker events --format '{{.TimeNano}} docker {{.Type}} {{.Action}}' >"$WORK/ev-docker" 2>&1 &
  evd=$!
  if [ "$ctl_ctr" = 1 ]; then ctr -a "$CTR_SOCK" -n moby events >"$WORK/ev-ctr" 2>&1 & evc=$!; fi
  sleep 0.5
  s=$EPOCHREALTIME
  docker run --name bench-timeline --pull=never busybox true >/dev/null 2>&1; e=$EPOCHREALTIME
  sleep 0.5
  kill "$evd" ${evc:+"$evc"} 2>/dev/null; wait 2>/dev/null
  docker rm -f bench-timeline >/dev/null 2>&1
  echo "timeline of one docker run (the client's call took $(elapsed "$s" "$e") s):"
  awk -v s="$s" '{ t = $1 / 1e9 - s; printf "  %+7.3f s  %s\n", t, substr($0, index($0, " ") + 1) }' "$WORK/ev-docker" | grep -E 'container (create|attach|start|die|destroy)|network'
  [ -s "$WORK/ev-ctr" ] && sed 's/^/  ctr: /' "$WORK/ev-ctr" | head -40
} >&2

# --- the first spike's comparison points (hello-world, builds, compose, cpu and disk), checked
if [ "${BENCH_BATTERY:-}" = 1 ]; then
  for rep in 1 2 3; do
    timed battery.hello-world "$rep" -e 'Hello from Docker' -- "${RUN[@]}" hello-world
    mkdir -p "$WORK/q1" "$WORK/b3"
    printf 'FROM busybox\nRUN echo built > /built.txt && dd if=/dev/zero of=/blob bs=1M count=50 2>/dev/null\n' >"$WORK/q1/Dockerfile"
    timed_build battery.build-1layer-50MB "$rep" bench-q1 "$WORK/q1"
    # the first spike's bench.sh build (three RUN layers: 150 MB random + gzip, 200 MB zeros, a tar), with the marker the check reads
    printf 'FROM busybox\nRUN dd if=/dev/urandom of=/a bs=1M count=150 2>/dev/null && gzip -k /a\nRUN cat /a /a.gz | md5sum > /sum && dd if=/dev/zero of=/z bs=1M count=200 2>/dev/null\nRUN tar cf /t.tar /a /z /sum && echo built > /built.txt\n' >"$WORK/b3/Dockerfile"
    timed_build battery.build-3layers "$rep" bench-b3 "$WORK/b3"
    mkdir -p "$WORK/compose"
    printf 'services:\n  web:\n    image: busybox\n    pull_policy: never\n    command: sh -c "echo compose-up; sleep 3"\n' >"$WORK/compose/compose.yml"
    timed battery.compose-up "$rep" -e 'compose-up' -- docker compose -f "$WORK/compose/compose.yml" -p benchq up --abort-on-container-exit
    docker compose -f "$WORK/compose/compose.yml" -p benchq down >/dev/null 2>&1
    timed battery.cpu-sha256-1GiB "$rep" -- bash -c 'dd if=/dev/zero bs=1M count=1024 2>/dev/null | sha256sum'
    timed battery.disk-write-1GiB-fdatasync "$rep" -- bash -c "dd if=/dev/zero of='$WORK/w' bs=1M count=1024 conv=fdatasync 2>&1 && rm -f '$WORK/w'"
  done
  for m in battery.hello-world battery.build-1layer-50MB battery.build-3layers battery.compose-up battery.cpu-sha256-1GiB battery.disk-write-1GiB-fdatasync; do expect_samples "$m" 3; done
fi
