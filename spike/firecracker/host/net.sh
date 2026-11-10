#!/usr/bin/env bash
# Spike #970: TAP devices (owned by fcuser, created once, as root), forwarding turned ON on purpose (the wall must hold
# on a host that forwards, as the GitHub runner does for its own Docker), and the fixtures the probes aim at.
set -euo pipefail
sysctl -q -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1

# One TAP per VM slot: IPv4 /30 and IPv6 /64, the host side is .1 / ::1
for n in 0 1; do
  tap=fctap$n
  ip link show "$tap" >/dev/null 2>&1 || ip tuntap add dev "$tap" mode tap user fcuser group fcuser
  ip addr replace "172.31.0.$((n * 4 + 1))/30" dev "$tap"
  sysctl -q -w "net.ipv6.conf.$tap.accept_ra=0" "net.ipv6.conf.$tap.accept_dad=0"
  ip -6 addr replace "fd00:fc:$n::1/64" dev "$tap" nodad
  ip link set "$tap" up
done
# A TAP that fcuser does NOT own: the negative control of "ownership is what lets Firecracker open it"
ip link show rootowned0 >/dev/null 2>&1 || ip tuntap add dev rootowned0 mode tap
ip link set rootowned0 up

# A "LAN" behind the host: a namespace holding RFC1918 and link-local addresses, reached through the host's FORWARD path
ip netns add lan 2>/dev/null || true
if ! ip link show vlan0 >/dev/null 2>&1; then
  ip link add vlan0 type veth peer name vlan1
  ip link set vlan1 netns lan
fi
ip addr replace 10.77.0.1/24 dev vlan0
ip -6 addr replace fd00:77::1/64 dev vlan0 nodad
ip link set vlan0 up
for a in 172.16.77.2 192.168.77.2 169.254.169.253; do ip route replace "$a/32" dev vlan0; done
ip netns exec lan sh -c '
  ip link set lo up
  ip link set vlan1 up
  ip addr replace 10.77.0.2/24 dev vlan1
  ip addr replace 172.16.77.2/32 dev vlan1
  ip addr replace 192.168.77.2/32 dev vlan1
  ip addr replace 169.254.169.253/32 dev vlan1
  ip -6 addr replace fd00:77::2/64 dev vlan1 nodad
  ip route replace default via 10.77.0.1
  ip -6 route replace default via fd00:77::1
'
ip -br addr show | grep -E 'fctap|vlan0|rootowned' || true
