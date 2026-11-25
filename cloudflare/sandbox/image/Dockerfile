# syntax=docker/dockerfile:1
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The Container image of cr-sandbox (#1159, epic #1157): the content of the hosted VM, layout P1 of spike #1149 (Control, the doors and the agent run
# inside one Container, the agent under a patched Sysbox). It is the golden snapshot's recipe, run unchanged, on the same Ubuntu Base as the local
# VM's root file system (docker/vm/rootfs/build.sh): the pinned Docker, buildx and Sysbox, the daemon configuration and the two prepare scripts, with
# the same paths, plus what only a Container needs: the patched sysbox-mgr, the boot script and the Worker and agent images as archives.
#
# It is built from `generated/`, which image/prepare-context.sh and image/build-inner.sh make in CI (never by hand, never on a developer machine:
# the build downloads the base and installs 3 GB of images). The context is this directory. Nothing is pulled from Docker Hub at run time (429 for the
# platform's addresses), and at build time the base comes from a pinned tarball and apt, not from a registry's `latest`.
FROM public.ecr.aws/docker/library/ubuntu:24.04 AS fetch
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY generated/pins.env /pins.env
# The pinned Ubuntu Base (docker/vm/pins.env): refused unless it has the pinned checksum.
RUN set -eu; . /pins.env; \
    curl -fsSL --retry 3 --max-time 600 -o /ubuntu-base.tar.gz "$UBUNTU_BASE_URL"; \
    echo "$UBUNTU_BASE_SHA256  /ubuntu-base.tar.gz" | sha256sum -c -; \
    mkdir /rootfs; tar -xpf /ubuntu-base.tar.gz -C /rootfs

FROM scratch AS base
COPY --from=fetch /rootfs/ /
ENV DEBIAN_FRONTEND=noninteractive PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# No service starts while the image is built (the packages' maintainer scripts ask; there is no init).
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 0755 /usr/sbin/policy-rc.d
# The packages the hosted base image has and Ubuntu Base lacks (docker/vm/rootfs/packages.txt), and zstd for the image archives.
COPY generated/packages.txt /tmp/packages.txt
RUN set -eux; apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends $(grep -vE '^\s*(#|$)' /tmp/packages.txt | tr '\n' ' ') zstd; \
    rm -f /tmp/packages.txt

# The golden snapshot's steps, in its order, with the scripts it sends (dispatcher/src/vm-artifacts/recipe.ts), staged where the pipeline stages them.
COPY generated/recipe/ /tmp/recipe/
COPY generated/host/ /tmp/host/
RUN set -eux; bash /tmp/recipe/10-install-docker.sh
# The Sysbox package's installer asks Docker for its containers and calls systemctl; an image build has neither: stand-ins for this one step,
# exactly as docker/vm/rootfs/build.sh does.
RUN set -eux; \
    mv /usr/bin/docker /usr/bin/docker.real; \
    printf '#!/bin/sh\necho "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES"\n' > /usr/bin/docker; chmod 0755 /usr/bin/docker; \
    printf '#!/bin/sh\nexit 0\n' > /usr/bin/systemctl; chmod 0755 /usr/bin/systemctl; \
    bash /tmp/recipe/20-install-sysbox.sh; \
    mv -f /usr/bin/docker.real /usr/bin/docker; rm -f /usr/bin/systemctl
RUN set -eux; \
    path() { jq -r ".paths.$1" /tmp/recipe/recipe.json; }; \
    install -D -m 0644 /tmp/recipe/30-daemon.json "$(path daemonJson)"; \
    bash /tmp/recipe/31-write-daemon-config.sh; \
    install -D -m 0755 /tmp/host/vm-prepare.sh "$(path vmPrepare)"; \
    install -D -m 0755 /tmp/host/sysbox-prepare.sh "$(path sysboxPrepare)"; \
    bash /tmp/recipe/40-install-host-scripts.sh; \
    install -D -m 0644 /tmp/recipe/recipe.json /etc/code-reviewer-vm/recipe.json; \
    ln -s tini /usr/bin/docker-init; \
    rm -rf /tmp/golden-* /tmp/recipe /tmp/host

# The one patch (image/files/patch-sysbox-mgr.sh): verified before and after, a build fails when sysbox-mgr is not the pinned binary.
COPY files/patch-sysbox-mgr.sh /usr/local/share/cr-sandbox/patch-sysbox-mgr.sh
RUN set -eux; bash /usr/local/share/cr-sandbox/patch-sysbox-mgr.sh /usr/bin/sysbox-mgr /var/modules; \
    /usr/bin/sysbox-runc --version | head -n 1; \
    apt-get clean; rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/man/* /usr/share/info/* /usr/sbin/policy-rc.d /tmp/* /var/log/*

COPY files/cr-sandbox-boot.sh /usr/local/sbin/cr-sandbox-boot.sh
RUN chmod 0755 /usr/local/sbin/cr-sandbox-boot.sh
# The Worker and agent images (`docker save | zstd`, image/build-inner.sh): the last layer, so a change of the scripts above does not move 1.4 GB.
COPY generated/inner/ /opt/cr-sandbox/inner/
ENTRYPOINT ["/usr/bin/tini", "--", "sleep", "infinity"]
