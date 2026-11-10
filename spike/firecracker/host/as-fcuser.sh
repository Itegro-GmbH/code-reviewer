#!/usr/bin/env bash
# Spike #970: run the driver as the normal user fcuser inside a systemd service with Delegate=yes (a delegated cgroup subtree
# is what the plan's systemd unit gives the Dispatcher). Usage (as root): as-fcuser.sh <driver args>
set -euo pipefail
work=${SPIKE_WORK:-/srv/fc}
exec systemd-run --uid=fcuser --gid=fcuser -p Delegate=yes -p MemoryMax=12G -p TasksMax=8192 -p WorkingDirectory="$work" \
  --wait --pipe --collect -q \
  -E SPIKE_WORK="$work" -E HOST_IP="${HOST_IP:-}" -E PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  python3 "$work/spike/host/driver.py" "$@"
