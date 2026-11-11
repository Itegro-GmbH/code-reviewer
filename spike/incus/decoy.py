# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: a decoy service of the HOST on every address (IPv4 and IPv6), so that a probe from an instance has something to reach.
import socket, sys
s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("::", int(sys.argv[1])))
s.listen(16)
while True:
    c, a = s.accept()
    print("decoy: connection from", a[0], flush=True)
    c.close()
