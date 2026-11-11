#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The main process of the agent's container (#745, step 4), run by tini as root under the Sysbox runtime: the
# container's own Docker daemon, and nothing else. The runner starts OpenCode with an exec once `/run/agent-ready`
# is there. If the daemon ends, this script ends and so does the container, which the runner sees (the agent's
# Docker is part of what the container is for).
#
# One exception (#1009): the environment's setup script runs in this same container, and the container's network
# and proxy change when it ends. The daemon reads its proxy variables at its start, so the runner can ask for a
# start again: it writes the new variables to /run/agent-docker-env (assignments, quoted), creates
# /run/agent-docker-restart and ends the daemon with SIGTERM. The daemon runs under --live-restore, so the
# containers it started (a database of the setup) keep running while it is away, and the loop below starts it
# again. The variables of the first start are unset when that file is there: a container made for the setup
# has the setup's, and the agent must not inherit them.
#
# No secret, no credential and no network address of the VM is read or written here. The daemon logs to
# /var/log/dockerd.log, which the agent can read.
set -eu
mkdir -p /run /var/log /var/lib/docker
rm -f /run/agent-ready /var/run/docker.pid /run/agent-docker-restart
while :; do
  if [ -e /run/agent-docker-env ]; then
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    set -a
    . /run/agent-docker-env
    set +a
  fi
  dockerd --host=unix:///var/run/docker.sock --ipv6=false --live-restore >>/var/log/dockerd.log 2>&1 &
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
  status=0
  wait "$daemon" || status=$?
  if [ -e /run/agent-docker-restart ]; then
    rm -f /run/agent-docker-restart /run/agent-ready /var/run/docker.pid
    continue
  fi
  exit "$status"
done
