#!/usr/bin/env bash
# Spike #970: build the read-only guest root file system (ext4 image) with Docker, Sysbox, our init and agent.
# Run as root. Usage: build.sh <work dir> <out image>
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
work=$(realpath -m "${1:?work dir}"); out=$(realpath -m "${2:?out image}")
repo=$(git -C "$SPIKE_DIR" rev-parse --show-toplevel)
dl="$work/dl"; root="$work/root"
fetch_pinned "$UBUNTU_BASE_URL" "$UBUNTU_BASE_SHA256" "$dl/ubuntu-base.tar.gz"
fetch_pinned "$DOCKER_URL" "$DOCKER_SHA256" "$dl/docker.tgz"
fetch_pinned "$SYSBOX_URL" "$SYSBOX_SHA256" "$dl/sysbox.deb"

rm -rf "$root"; mkdir -p "$root"
tar -xpf "$dl/ubuntu-base.tar.gz" -C "$root"
cleanup() {
  for m in dev/pts dev proc sys; do umount "$root/$m" 2>/dev/null || true; done
}
trap cleanup EXIT
mount -t proc proc "$root/proc"
mount --bind /dev "$root/dev"
mount -t devpts devpts "$root/dev/pts"
rm -f "$root/etc/resolv.conf"
cp /run/systemd/resolve/resolv.conf "$root/etc/resolv.conf" 2>/dev/null || cp /etc/resolv.conf "$root/etc/resolv.conf"
cp "$dl/sysbox.deb" "$root/tmp/sysbox.deb"

log "apt: packages the guest needs"
chroot "$root" /bin/bash -euxc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends iproute2 iptables nftables kmod fuse3 lsb-release rsync jq procps \
    iputils-ping util-linux e2fsprogs xfsprogs python3-minimal ca-certificates curl pigz xz-utils openssl psmisc
'
log "Sysbox $SYSBOX_VERSION (a systemctl that does nothing, as the golden snapshot does: the guest has no systemd)"
# ... and a `docker` that lists no containers: the package's config script runs `docker ps -a` and refuses to go on when it does not see
# the one header line (the golden snapshot runs it with a docker installed; here Docker is added after Sysbox). Both stubs are removed again.
printf '#!/bin/sh\nexit 0\n' > "$root/usr/local/sbin/systemctl"
printf '#!/bin/sh\necho "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES"\n' > "$root/usr/local/sbin/docker"
chmod 0755 "$root/usr/local/sbin/systemctl" "$root/usr/local/sbin/docker"
cat > "$root/tmp/sysbox-install.sh" <<SH
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq /tmp/sysbox.deb || dpkg -i --force-depends /tmp/sysbox.deb
installed=\$(dpkg-query -W -f='\${Version}' sysbox-ce)
case "\$installed" in $SYSBOX_VERSION*) ;; *) echo "sysbox-ce is \$installed" >&2; exit 1 ;; esac
sysbox-runc --version
SH
chroot "$root" /bin/bash /tmp/sysbox-install.sh
rm -f "$root/usr/local/sbin/systemctl" "$root/usr/local/sbin/docker" "$root/tmp/sysbox.deb" "$root/tmp/sysbox-install.sh"

log "Docker $DOCKER_VERSION (static bundle)"
tar -xzf "$dl/docker.tgz" -C "$root/usr/bin" --strip-components=1
chroot "$root" /usr/bin/dockerd --version

log "daemon.json (the golden snapshot's, plus the data root on the job disk), our files"
python3 - "$root/etc/docker/daemon.json" <<'PY'
import json, os, sys
path = sys.argv[1]
os.makedirs(os.path.dirname(path), exist_ok=True)
cfg = {
    "ipv6": False,
    "ip6tables": False,
    "live-restore": False,
    "data-root": "/jobdisk/docker",
    "features": {"containerd-snapshotter": False},
    "runtimes": {"sysbox-runc": {"path": "/usr/bin/sysbox-runc"}},
    "log-opts": {"max-size": "10m", "max-file": "2"},
}
json.dump(cfg, open(path, "w"), indent=2)
PY
fetch_pinned "$CHECK_CONFIG_URL" "$CHECK_CONFIG_SHA256" "$dl/check-config.sh"
install -D -m 0755 "$dl/check-config.sh" "$root/spike/check-config.sh"
install -D -m 0755 "$SPIKE_DIR/rootfs/init" "$root/spike/init"
install -D -m 0755 "$SPIKE_DIR/rootfs/agent.py" "$root/spike/agent.py"
install -D -m 0755 "$SPIKE_DIR/rootfs/probe.py" "$root/spike/probe.py"
# The same two scripts the hosted VM runs (docs/golden-snapshot.md): cgroup layout + dockerd, then the Sysbox daemons.
install -D -m 0755 "$repo/docker/sandbox/vm-prepare.sh" "$root/usr/local/sbin/vm-prepare.sh"
install -D -m 0755 "$repo/docker/sandbox/sysbox-prepare.sh" "$root/usr/local/sbin/sysbox-prepare.sh"
chroot "$root" python3 -m compileall -q /spike || true

# Read-only root: every file that must be written is on a tmpfs or the job disk (mounted by init).
rm -f "$root/etc/resolv.conf"; ln -s /run/resolv.conf "$root/etc/resolv.conf"
ln -sf /proc/self/mounts "$root/etc/mtab"
echo "spike-vm" > "$root/etc/hostname"
printf '127.0.0.1 localhost spike-vm\n::1 localhost\n' > "$root/etc/hosts"
mkdir -p "$root/jobdisk" "$root/var/lib/sysbox" "$root/var/lib/containerd" "$root/var/lib/sysboxfs" "$root/run" "$root/tmp" "$root/var/log" "$root/var/tmp" "$root/root" "$root/sys/fs/cgroup"
chroot "$root" apt-get clean
rm -rf "$root/var/lib/apt/lists"/* "$root/var/cache/apt"/* "$root/usr/share/doc"/* "$root/usr/share/man"/*
cleanup

used_kb=$(du -sk "$root" | cut -f1)
size_mb=$(( used_kb / 1024 * 12 / 10 + 64 ))
log "root tree $((used_kb / 1024)) MiB, image $size_mb MiB"
rm -f "$out"
truncate -s "${size_mb}M" "$out"
mkfs.ext4 -q -L rootfs -m 0 -O ^has_journal -E root_owner=0:0 -d "$root" "$out"
ls -ls "$out"
rm -rf "$root"
