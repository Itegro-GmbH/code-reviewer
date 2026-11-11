#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: the golden Incus image `spike-docker` (Ubuntu 24.04 + the Docker 29.1.3 static bundle + compose + buildx, systemd units, busybox, hello-world,
# docker:29.1.3-dind and postgres:17-alpine pre-pulled). Written down from the commands run by hand. The instance has no internet by design:
# the files come from the host and everything else through the host proxy (proxy.py on 10.99.0.1:3128, started before).
# usage: build-image.sh <dir with docker-29.1.3.tgz docker-compose docker-buildx>   (sha256 of what the spike used: docs/runner.md)
set -u   # not -e: `ix` filters its output with grep, which fails on an empty one
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/lib.sh"; dl=$1; n=spk-build
ix launch images:ubuntu/24.04 $n -p spike -n spkout
ix config device set $n eth0 ipv4.address=10.99.0.250 security.ipv4_filtering=true
ix file push "$dl/docker-29.1.3.tgz" "$dl/docker-compose" "$dl/docker-buildx" $n/root/
ixs $n <<'EOS'
ip addr add 10.99.0.250/24 dev eth0; ip route replace default via 10.99.0.1
cd /root && tar xzf docker-29.1.3.tgz && cp docker/* /usr/local/bin/ && mkdir -p /usr/local/lib/docker/cli-plugins
install -m755 docker-compose docker-buildx /usr/local/lib/docker/cli-plugins/ && rm -rf docker docker-*.tgz docker-compose docker-buildx
sed -i 's,http://,https://,g' /etc/apt/sources.list
echo 'Acquire::https::Proxy "http://10.99.0.1:3128";' > /etc/apt/apt.conf.d/99proxy
export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq --no-install-recommends iptables nftables git xz-utils pigz procps iproute2 ca-certificates psmisc
printf 'HTTPS_PROXY=http://10.99.0.1:3128\nHTTP_PROXY=http://10.99.0.1:3128\nNO_PROXY=localhost,127.0.0.1\n' > /etc/default/docker-proxy
# no containerd.service of our own: dockerd starts and manages its containerd (the containerd image store lives under /var/lib/docker/containerd). A second, separate unit made the
# image's pre-pulled images depend on which of the two started first (the first build of the Incus 7.6 re-measure lost them that way).
cat > /etc/systemd/system/docker.service <<'U'
[Unit]
Description=Docker (spike)
After=network-online.target
[Service]
EnvironmentFile=-/etc/default/docker-proxy
ExecStart=/usr/local/bin/dockerd
Delegate=yes
KillMode=process
Restart=on-failure
LimitNOFILE=1048576
TasksMax=infinity
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload && systemctl enable docker && systemctl start docker
for i in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
for img in hello-world busybox docker:29.1.3-dind postgres:17-alpine; do docker pull -q $img; done
apt-get clean
EOS
ix stop $n; ix publish $n --alias spike-docker; ix delete $n
