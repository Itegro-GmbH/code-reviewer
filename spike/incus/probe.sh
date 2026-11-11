#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: probe TCP targets from inside an instance. usage: probe.sh host:port ...   (IPv6: [addr]:port, link-local with %eth0)
# prints REACHED (connection established), REFUSED (RST: reachable host, closed port) or BLOCKED (timeout / no route).
for t in "$@"; do
  h=${t%:*}; p=${t##*:}; h=${h#[}; h=${h%]}
  out=$(timeout 3 bash -c "exec 3<>/dev/tcp/$h/$p" 2>&1); rc=$?
  if [ $rc = 0 ]; then v=REACHED; elif [ $rc = 124 ]; then v=BLOCKED; else case "$out" in *efused*) v=REFUSED;; *) v="BLOCKED($out)";; esac; fi
  printf '%-34s %s\n' "$t" "$v"
done
