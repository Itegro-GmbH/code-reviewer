#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The main process of the agent's container (#745, step 4), run by tini as root under the Sysbox runtime:
# the container's own Docker daemon, and nothing else. The runner starts OpenCode with an exec once
# `/run/agent-ready` is there. If the daemon ends, this script ends and so does the container, which the
# runner sees (the agent's Docker is part of what the container is for).
#
# No secret, no credential and no network address of the VM is read or written here. The daemon logs to
# /var/log/dockerd.log, which the agent can read.
set -eu
mkdir -p /run /var/log /var/lib/docker
rm -f /run/agent-ready /var/run/docker.pid
dockerd --host=unix:///var/run/docker.sock --ipv6=false >/var/log/dockerd.log 2>&1 &
daemon=$!
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ] || ! kill -0 "$daemon" 2>/dev/null; then
    echo "agent-init: dockerd did not become ready" >&2
    tail -n 20 /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 0.2
done
touch /run/agent-ready
wait "$daemon"
