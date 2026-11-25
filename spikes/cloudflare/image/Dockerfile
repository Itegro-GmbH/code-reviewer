# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149: the probe image for a Cloudflare Container (durable_object scheduling policy, a microVM with its own kernel).
# Same engine as the golden snapshot: Docker 29.1.3 (static bundle) and Sysbox 0.7.1 (pinned by sha256). Nothing here is product code.
FROM ubuntu:24.04
ARG DOCKER_SHA256=c019c608ba2bb009dd673f3230e4d743f36a78d36166c6c2444c05d0aa9ff0d9
ARG SYSBOX_SHA256=9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl iptables nftables iproute2 kmod fuse3 jq rsync procps psmisc python3 git xz-utils \
      libcap2-bin netcat-openbsd dnsutils iputils-ping e2fsprogs util-linux pigz xfsprogs \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.1.3.tgz -o /tmp/docker.tgz \
    && echo "$DOCKER_SHA256  /tmp/docker.tgz" | sha256sum -c - \
    && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 && rm /tmp/docker.tgz \
    && mkdir -p /etc/docker && printf '{"ipv6":false,"ip6tables":false,"live-restore":false}\n' > /etc/docker/daemon.json
# Sysbox: its maintainer scripts call systemctl; a no-op stub first on PATH for this one install (as the golden snapshot does).
RUN curl -fsSL https://github.com/nestybox/sysbox/releases/download/v0.7.1/sysbox-ce_0.7.1.linux_amd64.deb -o /tmp/sysbox.deb \
    && echo "$SYSBOX_SHA256  /tmp/sysbox.deb" | sha256sum -c - \
    && mkdir /tmp/stub && printf '#!/bin/sh\nexit 0\n' > /tmp/stub/systemctl && chmod +x /tmp/stub/systemctl \
    && PATH=/tmp/stub:$PATH apt-get update && PATH=/tmp/stub:$PATH apt-get install -y --no-install-recommends /tmp/sysbox.deb \
    ; rm -rf /tmp/sysbox.deb /tmp/stub /var/lib/apt/lists/*
COPY probes/ /opt/probes/
RUN chmod +x /opt/probes/*.sh
ENTRYPOINT ["docker-init", "--", "sleep", "infinity"]
