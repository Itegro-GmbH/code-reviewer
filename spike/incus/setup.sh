#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: the objects the spike creates (never the `default` pool, never `incusbr0`).
# First run (Incus 6.0.0): a `dir` pool of our own under /home/luca. Second run (Incus 7.6, "Re-measured on Incus 7.6 + btrfs"): the btrfs pool `crpool` that the owner made
# (SPIKE_POOL=crpool, not created and not deleted here). SPIKE_APPARMOR_OFF=1 adds the `raw.lxc` workaround of Incus 6.0.0, which 7.6 no longer needs.
# Written down from the commands that were run by hand; jobset.sh, probe.sh, reap.sh, bench.sh and time-start.sh were run as they are here.
set -u   # not -e: `ix` filters its output with grep, which fails on an empty one
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
ROOT=${SPIKE_ROOT:-/home/luca/incus-spike-pool-parent}
POOL=${SPIKE_POOL:-spike}
mkdir -p "$ROOT"
if [ "$POOL" = spike ]; then mkdir -p "$ROOT/dir"; ix storage create spike dir source="$ROOT/dir"; fi
# the image store of Incus is on `/` unless told otherwise: put it on the pool (undone by teardown.sh)
ix storage volume show "$POOL" images >/dev/null 2>&1 || ix storage volume create "$POOL" images
ix config set storage.images_volume="$POOL/images"
# the outer bridge: an address for the host proxy and nothing else. No routing, no NAT (Docker's FORWARD policy would drop it anyway),
# no DHCP, no IPv6, and no DNS from dnsmasq (`port=0`: dns.mode=none still leaves it listening on :53).
ix network create spkout ipv4.address=10.99.0.1/24 ipv4.nat=false ipv4.routing=false ipv4.dhcp=false ipv6.address=none dns.mode=none raw.dnsmasq="port=0"
timeout 20 sg incus-admin -c "incus network acl create spk-outer < $HERE/acl-outer.yaml"
ix network set spkout security.acls=spk-outer security.acls.default.egress.action=drop security.acls.default.ingress.action=drop
# the inner bridge between A (Control, doors) and B (setup, agent): no address at all, so the host is not on it
ix network create spkin ipv4.address=none ipv6.address=none
# the profile: unprivileged, isolated idmap, nesting, limits. The AppArmor line is the workaround of Q1 (runc's CVE-2025-52881 patch against Incus 6.0.0's profile)
ix profile create spike
ix profile device add spike root disk path=/ pool="$POOL"
ix profile set spike security.nesting=true security.privileged=false security.idmap.isolated=true limits.cpu=2 limits.memory=2GiB limits.processes=4096
if [ -n "${SPIKE_APPARMOR_OFF:-}" ]; then printf 'lxc.apparmor.profile=unconfined\n' | sg incus-admin -c 'incus profile set spike raw.lxc -'; fi
echo "next: build-image.sh, then the host proxy: python3 -I proxy.py --listen 10.99.0.1 --port 3128, then jobset.sh <job> <slot>"
