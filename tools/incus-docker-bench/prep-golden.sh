#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Runs inside the Incus instance that becomes the golden image of the bench (#1013), as root: Docker's static bundle (the spike's recipe, no containerd
# unit of our own: dockerd starts and manages its containerd), the compose and buildx plugins, and the two images the bench runs, pulled from the
# ECR mirror of Docker Hub's library (no pull limit for a runner) and tagged `busybox` and `hello-world`. The files are in /root (pushed by bench.sh,
# already checked against their pins there).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BUSYBOX_REF=${BUSYBOX_REF:?}
HELLO_REF=${HELLO_REF:?}

apt-get update -qq
apt-get install -y -qq --no-install-recommends iptables nftables git xz-utils pigz procps iproute2 ca-certificates psmisc curl kmod
cd /root
tar xzf docker.tgz
cp docker/* /usr/local/bin/
rm -rf docker docker.tgz
install -d /usr/local/lib/docker/cli-plugins
install -m 0755 docker-compose docker-buildx /usr/local/lib/docker/cli-plugins/
rm -f docker-compose docker-buildx
install -d /etc/docker
# the containerd image store on purpose, not as a default that may change
printf '{"features":{"containerd-snapshotter":true}}\n' >/etc/docker/daemon.json
cat >/etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=Docker (bench)
After=network-online.target
[Service]
ExecStart=/usr/local/bin/dockerd
Delegate=yes
KillMode=process
Restart=on-failure
LimitNOFILE=1048576
TasksMax=infinity
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable docker
systemctl start docker
for _ in $(seq 1 150); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
docker info >/dev/null
pull() { local n; for n in 1 2 3 4 5; do docker pull -q "$1" >/dev/null && return 0; sleep $((n * 15)); done; return 1; }
pull "$BUSYBOX_REF"
docker tag "$BUSYBOX_REF" busybox
pull "$HELLO_REF"
docker tag "$HELLO_REF" hello-world
# what the image must hold, checked: both images by tag, a container that really runs, the containerd image store
docker image inspect busybox hello-world >/dev/null
[ "$(docker run --rm --pull=never busybox echo golden-ok)" = golden-ok ]
docker info --format '{{.DriverStatus}}' | grep -q 'io.containerd.snapshotter.v1'
apt-get clean
echo "golden: $(docker --version); $(docker compose version); busybox $(docker image inspect busybox --format '{{.Id}}')"
