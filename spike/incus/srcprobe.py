# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: connect to host:port from a chosen source address. usage: srcprobe.py <source-ip> <host> <port>
import socket, sys
s = socket.socket(); s.settimeout(3)
s.bind((sys.argv[1], 0))
try:
    s.connect((sys.argv[2], int(sys.argv[3]))); print(f"src {sys.argv[1]} -> {sys.argv[2]}:{sys.argv[3]} REACHED")
except OSError as e:
    print(f"src {sys.argv[1]} -> {sys.argv[2]}:{sys.argv[3]} BLOCKED ({e})")
