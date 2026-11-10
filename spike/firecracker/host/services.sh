#!/usr/bin/env bash
# Spike #970: long-lived helpers of the runs. Proxy and host listener as fcuser, the LAN listener in the fixture namespace.
set -euo pipefail
work=${SPIKE_WORK:-/srv/fc}
for u in fc-proxy fc-listener fc-lan-listener; do systemctl stop "$u" 2>/dev/null || true; done
systemd-run -q --unit=fc-proxy --uid=fcuser --gid=fcuser --collect -E PROXY_LOG="$work/results/proxy.log" python3 "$work/spike/host/proxy.py"
systemd-run -q --unit=fc-listener --uid=fcuser --gid=fcuser --collect python3 "$work/spike/host/listener.py" host 9999
systemd-run -q --unit=fc-lan-listener --collect ip netns exec lan python3 "$work/spike/host/listener.py" lan 9999
sleep 1
systemctl is-active fc-proxy fc-listener fc-lan-listener
