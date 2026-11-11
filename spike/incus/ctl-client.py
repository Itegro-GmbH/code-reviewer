# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: Control's side (inside instance A): 200 one-request connections over the proxied unix socket, latency in ms.  usage: ctl-client.py [socket path]  (/run is a tmpfs that systemd mounts over a socket made there at start: use /ctl.sock)
import json, socket, statistics, sys, time
lat = []
for n in range(200):
    t = time.perf_counter()
    s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1] if len(sys.argv) > 1 else "/run/ctl.sock")
    s.sendall((json.dumps({"type": "narrow", "n": n}) + "\n").encode())
    r = json.loads(s.makefile("rb").readline()); s.close()
    assert r["echo"] == n
    lat.append((time.perf_counter() - t) * 1000)
lat.sort()
print(f"200 requests: p50 {statistics.median(lat):.2f} ms  p95 {lat[189]:.2f} ms  max {lat[-1]:.2f} ms")
