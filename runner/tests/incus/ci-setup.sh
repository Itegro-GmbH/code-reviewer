#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Prepares a GitHub `ubuntu-24.04` runner for the Incus lane of the host's nft table (#1008): Incus 7.6 from the Zabbly stable
# repository (the version the spike #1005 re-measured and the DevBox runs), a btrfs pool on a loop file, the default bridge
# `incusbr0` (the "other bridge" whose port 53 the table must close) and an image with the few tools the probes need
# (`ip`, `ping`, `nft`, `python3`; bash and `timeout` come with Ubuntu). Run as root: `sudo runner/tests/incus/ci-setup.sh`.
# It only ever runs on a throwaway runner VM; it is not an installer (#1011) and installs nothing for a customer.
set -euo pipefail

VERSION_SERIES="${INCUS_SERIES:-7.6}"
POOL="${CR_INCUS_LANE_POOL:-crpool}"
IMAGE="${CR_INCUS_LANE_IMAGE:-crlane-ubuntu}"
POOL_SIZE_GIB="${CR_INCUS_LANE_POOL_GIB:-12}"

say() { printf '== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

say "Incus ${VERSION_SERIES} from the Zabbly stable repository"
mkdir -p /etc/apt/keyrings
curl -fsSL --retry 3 --max-time 60 https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
codename="$(grep '^VERSION_CODENAME=' /etc/os-release | cut -d= -f2)"
cat >/etc/apt/sources.list.d/zabbly-incus-stable.sources <<SOURCES
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${codename}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
SOURCES
apt-get update -qq
available="$(apt-cache madison incus | awk '{print $3}')"
wanted="$(printf '%s\n' "${available}" | grep -E "^1:${VERSION_SERIES//./\\.}[-.]" | head -n 1 || true)"
if [ -z "${wanted}" ]; then
  echo "the Zabbly repository has no incus ${VERSION_SERIES} any more; it has:" >&2
  printf '%s\n' "${available}" >&2
  exit 1
fi
say "installing incus=${wanted}"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "incus=${wanted}" btrfs-progs nftables iproute2 curl
incus --version
modprobe btrfs || true
modprobe nf_tables || true

say "pool ${POOL} (btrfs on a ${POOL_SIZE_GIB} GiB loop file) and incusbr0"
incus admin init --preseed <<PRESEED
config: {}
networks:
- name: incusbr0
  type: bridge
  config:
    ipv4.address: 10.206.108.1/24
    ipv4.nat: "true"
    ipv6.address: none
storage_pools:
- name: ${POOL}
  driver: btrfs
  config:
    size: ${POOL_SIZE_GIB}GiB
profiles:
- name: default
  devices:
    root:
      path: /
      pool: ${POOL}
      type: disk
    eth0:
      name: eth0
      network: incusbr0
      type: nic
PRESEED
incus storage list
incus network list

# Docker (installed and running on the runner) sets the FORWARD policy to DROP, which stops the NAT of incusbr0 for the image
# build below: the sanctioned hook for that is DOCKER-USER. The rules are removed again before the lane runs.
say "image ${IMAGE}"
tag="crlane-image-build"
iptables -I DOCKER-USER -i incusbr0 -m comment --comment "${tag}" -j ACCEPT
iptables -I DOCKER-USER -o incusbr0 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "${tag}" -j ACCEPT
cleanup() {
  while iptables -D DOCKER-USER -i incusbr0 -m comment --comment "${tag}" -j ACCEPT 2>/dev/null; do :; done
  while iptables -D DOCKER-USER -o incusbr0 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "${tag}" -j ACCEPT 2>/dev/null; do :; done
  incus delete --force crlane-build 2>/dev/null || true
}
trap cleanup EXIT

incus launch images:ubuntu/24.04 crlane-build
for _ in $(seq 1 60); do
  if incus exec crlane-build -- getent hosts archive.ubuntu.com >/dev/null 2>&1; then break; fi
  sleep 2
done
incus exec crlane-build -- apt-get update -qq
incus exec crlane-build -- env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  iproute2 iputils-ping nftables python3 netcat-openbsd ca-certificates
incus stop crlane-build
incus publish crlane-build --alias "${IMAGE}"
incus delete crlane-build
incus image list
say "ready"
