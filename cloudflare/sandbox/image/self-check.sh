#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The build's own run of the Container image (#1159), on a CI runner: it starts the built image privileged, runs the boot script in self-check mode
# (the real vm-prepare.sh, the real `docker load` of both archives, the tags checked, the daemon stopped cleanly), then looks at the result without
# the daemon: the patched sysbox-mgr, the pinned Sysbox and Docker, the prepare scripts at the golden snapshot's paths. It prints
# what the Worker publishes in /health, as `KEY=value` lines for the workflow: IMAGE_VERSION is the caller's, WORKER_FEATURES, WORKER_IMAGE_ID and
# AGENT_IMAGE_ID are read from the images by the boot script. A private cgroup namespace keeps the cgroup fix of vm-prepare.sh inside the container.
# Usage: image/self-check.sh <image tag> <output file>
set -euo pipefail
image="${1:?image tag}"
output="${2:?output file}"
name="cr-sandbox-self-check-$$"
trap 'docker rm --force "$name" > /dev/null 2>&1 || true' EXIT
log="$(mktemp)"
# /var/lib/docker and /var/lib/containerd as volumes: dockerd's overlay snapshotter cannot sit on the overlay of the container's own root.
status=0
docker run --name "$name" --privileged --cgroupns=private -e CR_SANDBOX_SELF_CHECK=1 \
  --volume /var/lib/docker --volume /var/lib/containerd \
  "$image" /usr/local/sbin/cr-sandbox-boot.sh > "$log" 2> "$log.err" || status=$?
tail -n 40 "$log.err" >&2
if [ "$status" != 0 ]; then echo "self-check: the boot script ended with $status" >&2; exit "$status"; fi
cat "$log" >&2

worker_id=$(awk '$1 == "IMAGE_ID" && $2 ~ /worker/ { print $3 }' "$log")
agent_id=$(awk '$1 == "IMAGE_ID" && $2 ~ /agent/ { print $3 }' "$log")
features=$(awk '$1 == "WORKER_FEATURES" { print $2 }' "$log")
[[ "$worker_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "self-check: no Worker image id" >&2; exit 1; }
[[ "$agent_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "self-check: no agent image id" >&2; exit 1; }
[ -n "$features" ] || { echo "self-check: no Worker features line" >&2; exit 1; }

# What is in the image besides the loaded engine: one container, no daemon.
docker run --rm --entrypoint /bin/bash "$image" -ec '
  test -x /usr/local/sbin/vm-prepare.sh && test -x /usr/local/sbin/sysbox-prepare.sh && test -x /usr/local/sbin/cr-sandbox-boot.sh
  test -f /etc/docker/daemon.json && grep -q sysbox-runc /etc/docker/daemon.json
  test -x /usr/bin/tini && test -x /usr/bin/docker-init
  sysbox-runc --version | head -n 1
  dockerd --version
  test "$(sha256sum /usr/bin/sysbox-mgr | cut -d" " -f1)" = 4171c9eaa158d121b86df7992b77fc7807b9ee7ba443b7d691e3969250253ebf
  if grep -qa "/proc/modules" /usr/bin/sysbox-mgr; then echo "sysbox-mgr still names /proc/modules"; exit 1; fi
  test -f /var/modules && test ! -s /var/modules
' >&2
{
  echo "WORKER_FEATURES=$features"
  echo "WORKER_IMAGE_ID=$worker_id"
  echo "AGENT_IMAGE_ID=$agent_id"
} > "$output"
rm -f "$log" "$log.err"
echo "self-check: ok" >&2
