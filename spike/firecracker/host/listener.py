#!/usr/bin/env python3
"""Spike #970: probe targets. TCP listeners that answer a banner and UDP echo on the given ports, IPv4 and IPv6.
Usage: listener.py <name> <port> [<port> ...]"""
import socket
import sys
import threading

name = sys.argv[1]
ports = [int(p) for p in sys.argv[2:]]


def tcp(family: int, addr: str, port: int) -> None:
    s = socket.socket(family, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((addr, port))
    s.listen(64)
    while True:
        c, _ = s.accept()
        try:
            c.settimeout(1)
            try:
                c.recv(200)
            except OSError:
                pass
            c.sendall(f"HTTP/1.0 200 OK listener={name}\r\n\r\n".encode())
        finally:
            c.close()


def udp(family: int, addr: str, port: int) -> None:
    s = socket.socket(family, socket.SOCK_DGRAM)
    if family == socket.AF_INET6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((addr, port))
    while True:
        data, peer = s.recvfrom(1000)
        s.sendto(f"echo from {name}".encode(), peer)


for port in ports:
    for fam, addr in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
        for fn in (tcp, udp):
            threading.Thread(target=fn, args=(fam, addr, port), daemon=True).start()
print(f"listener {name} on {ports}", flush=True)
threading.Event().wait()
