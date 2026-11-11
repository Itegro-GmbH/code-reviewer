#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005 Q1: run INSIDE the Incus container (dockerd already running, proxy in the environment of the daemon).
set -u
now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f s", b-a}'; }
t=$(now); docker run --rm hello-world | sed -n 2p; echo "run hello-world $(el $t $(now))"
t=$(now); docker run --rm busybox sh -c 'echo uid=$(id -u); cat /proc/self/uid_map'; echo "run busybox $(el $t $(now))"
mkdir -p /tmp/b && cd /tmp/b && printf 'FROM busybox\nRUN echo built > /built.txt && dd if=/dev/zero of=/blob bs=1M count=50 2>/dev/null\nCMD ["cat","/built.txt"]\n' > Dockerfile
t=$(now); docker build -q -t spk-built . >/dev/null; echo "build $(el $t $(now))"; docker run --rm spk-built
printf 'services:\n  web:\n    image: busybox\n    command: sh -c "echo compose-up; sleep 3"\n' > compose.yml
t=$(now); docker compose up --abort-on-container-exit 2>&1 | grep -E "compose-up|exited"; echo "compose up $(el $t $(now))"; docker compose down >/dev/null 2>&1
docker info --format 'store={{.DriverStatus}} driver={{.Driver}}'
