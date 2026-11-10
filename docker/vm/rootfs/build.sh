#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Builds the read-only guest root file system (#976): Ubuntu Base 26.04.1, then the golden snapshot's OWN install scripts, unchanged (Docker, buildx,
# Sysbox, the daemon configuration, the two prepare scripts), run in a chroot of it. Run as root.
# Usage: build.sh <recipe dir> <work dir> <out dir>
#   <recipe dir>  what `node dispatcher/src/vm-artifacts/recipe-main.ts <dir>` wrote: the pipeline's scripts and the pins as data
#   <out dir>     receives rootfs.ext4, rootfs-info.json (what was installed) and packages.txt (every package with its version and source)
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
recipe=$(realpath "${1:?recipe dir}"); work=$(realpath -m "${2:?work dir}"); out=$(realpath -m "${3:?out dir}")
dl="$work/dl"; root="$work/root"
mkdir -p "$out"
paths() { jq -r ".paths.$1" "$recipe/recipe.json"; }

fetch_pinned "$UBUNTU_BASE_URL" "$UBUNTU_BASE_SHA256" "$dl/ubuntu-base.tar.gz"
remove_tree "$root"; mkdir -p "$root"
tar -xpf "$dl/ubuntu-base.tar.gz" -C "$root"

# The mounts the chroot needed come down in the reverse order; one that does not is an error, and remove_tree then refuses to touch the tree.
cleanup() {
  local m status=0
  for m in dev/pts dev proc sys; do
    if mountpoint -q "$root/$m"; then umount "$root/$m" || status=1; fi
  done
  return "$status"
}
trap cleanup EXIT
mount -t proc proc "$root/proc"
mount --bind /dev "$root/dev"
mount -t devpts devpts "$root/dev/pts"
rm -f "$root/etc/resolv.conf"
cp /run/systemd/resolve/resolv.conf "$root/etc/resolv.conf" 2>/dev/null || cp /etc/resolv.conf "$root/etc/resolv.conf"
# No service starts inside the chroot (the packages' maintainer scripts ask for it; there is no init).
printf '#!/bin/sh\nexit 101\n' > "$root/usr/sbin/policy-rc.d"; chmod 0755 "$root/usr/sbin/policy-rc.d"
run() { chroot "$root" /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root DEBIAN_FRONTEND=noninteractive "$@"; }

log "the packages Ubuntu Base lacks and the hosted base image has"
packages=$(grep -vE '^\s*(#|$)' "$VM_DIR/rootfs/packages.txt" | tr '\n' ' ')
run apt-get update -qq
# shellcheck disable=SC2086
run apt-get install -y -qq --no-install-recommends $packages

# The golden snapshot's steps, in its order, with the scripts it sends (recipe.ts): staged where the pipeline stages them, run as it runs them.
stage() { install -D -m "$3" "$1" "$root$2"; }
runscript() { run /bin/bash "$1"; }

log "install Docker (golden snapshot step install_docker)"
stage "$recipe/10-install-docker.sh" /tmp/recipe-install-docker.sh 0755
runscript /tmp/recipe-install-docker.sh

log "install Sysbox (step install_sysbox)"
# The package's installer asks Docker for its containers (`docker ps -a`) and refuses to go on when it cannot. The hosted VM has a running daemon at
# this point (Docker's package starts it through its init script); a chroot has none (policy-rc.d). So the CLI is replaced, for this one step, by a
# stand-in that prints what an idle daemon prints, whatever way the installer calls it, and put back after.
mv "$root/usr/bin/docker" "$root/usr/bin/docker.real"
printf '#!/bin/sh\necho "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES"\n' > "$root/usr/bin/docker"
chmod 0755 "$root/usr/bin/docker"
# The package's postinst also calls `systemctl` (the guest has no systemd). The pipeline's script puts a stand-in first on the PATH of its own
# command; a maintainer script that does not go through that PATH finds none in a chroot, so one is there for this step too.
printf '#!/bin/sh\nexit 0\n' > "$root/usr/bin/systemctl"
chmod 0755 "$root/usr/bin/systemctl"
stage "$recipe/20-install-sysbox.sh" /tmp/recipe-install-sysbox.sh 0755
runscript /tmp/recipe-install-sysbox.sh
mv -f "$root/usr/bin/docker.real" "$root/usr/bin/docker"
rm -f "$root/usr/bin/systemctl"

log "write the daemon configuration (step write_daemon_config)"
stage "$recipe/30-daemon.json" "$(paths daemonJson)" 0644
stage "$recipe/31-write-daemon-config.sh" /tmp/recipe-write-daemon-config.sh 0755
runscript /tmp/recipe-write-daemon-config.sh

log "install the prepare scripts (step install_host_scripts)"
stage "$REPO_DIR/docker/sandbox/vm-prepare.sh" "$(paths vmPrepare)" 0755
stage "$REPO_DIR/docker/sandbox/sysbox-prepare.sh" "$(paths sysboxPrepare)" 0755
stage "$recipe/40-install-host-scripts.sh" /tmp/recipe-install-host-scripts.sh 0755
runscript /tmp/recipe-install-host-scripts.sh
# What the pipeline's clean step removes
rm -f "$root"/tmp/golden-* "$root"/tmp/recipe-*

log "what is local to this VM: the guest init, vm-init, the self-check, the recipe as data"
[ -e "$root/usr/bin/docker-init" ] || ln -s tini "$root/usr/bin/docker-init"
[ -x "$root/usr/bin/docker-init" ] || { echo "no docker-init (tini) in the root file system" >&2; exit 1; }
# `vm-boot` is what PID 1's child runs in every boot (the release's initCommand): the mounts, the job disk, the cgroup controllers, the network,
# then vm-init for a job's VM. `vm-build-init` is the placeholder of #976, kept only for the build-only boots (seed, smoke): the one place that
# still runs vm-prepare.sh and sysbox-prepare.sh in the guest.
install -D -m 0755 "$VM_DIR/rootfs/vm-boot" "$root/usr/local/sbin/vm-boot"
install -D -m 0755 "$VM_DIR/rootfs/vm-build-init" "$root/usr/local/sbin/vm-build-init"
# The real vm-init (#977): a zipapp of runner/src/code_reviewer_runner/vm_init/ at /usr/local/sbin/vm-init, and the seccomp profile of the
# Control container at /etc/code-reviewer/control-seccomp.json. The shebang is the root file system's python3 (the build host's is not).
"$REPO_DIR/runner/vm-init/install.sh" "$root"
install -D -m 0755 "$recipe/check-worker-probe.sh" "$root/usr/local/share/code-reviewer-vm/check-worker-probe.sh"
install -D -m 0644 "$recipe/recipe.json" "$root/etc/code-reviewer-vm/recipe.json"

log "what was installed"
version() { run dpkg-query -W -f='${Version}' "$1"; }
dockerd=$(version docker.io); buildx=$(version docker-buildx); sysbox=$(version sysbox-ce)
jq -n --arg ubuntuBase "$UBUNTU_BASE_VERSION" --arg dockerd "$dockerd" --arg buildx "$buildx" --arg sysbox "$sysbox" \
  --arg sysboxSha256 "$(jq -r .sysboxSha256 "$recipe/recipe.json")" \
  '{ubuntuBase: $ubuntuBase, dockerd: $dockerd, buildx: $buildx, sysbox: $sysbox, sysboxSha256: $sysboxSha256}' > "$out/rootfs-info.json"
cat "$out/rootfs-info.json"
# Every package with the source it was built from: what a GPL source offer for the root file system points at (Ubuntu's snapshot service as of the build date, see the release notes).
run dpkg-query -W -f='${binary:Package} ${Version} ${source:Package} ${source:Version}\n' | sort > "$out/packages.txt"
wc -l "$out/packages.txt"
run /usr/bin/dockerd --version
run /usr/bin/sysbox-runc --version | head -n 1

log "read-only root: every file that must be written is on a tmpfs or the job disk (vm-init mounts them)"
run apt-get clean
rm -f "$root/usr/sbin/policy-rc.d"
# The copyright files in /usr/share/doc stay: the root file system is distributed.
rm -rf --one-file-system "$root/var/lib/apt/lists"/* "$root/var/cache/apt"/* "$root/usr/share/man"/* "$root/usr/share/info"/* "$root/tmp"/* "$root/var/log"/*
rm -f "$root/etc/resolv.conf"; ln -s /run/resolv.conf "$root/etc/resolv.conf"
ln -sf /proc/self/mounts "$root/etc/mtab"
echo "code-reviewer-vm" > "$root/etc/hostname"
printf '127.0.0.1 localhost code-reviewer-vm\n::1 localhost\n' > "$root/etc/hosts"
mkdir -p "$root/jobdisk" "$root/seed" "$root/var/lib/docker" "$root/var/lib/containerd" "$root/var/lib/sysbox" "$root/var/lib/sysboxfs" \
  "$root/run" "$root/tmp" "$root/var/log" "$root/var/tmp" "$root/var/cache" "$root/root" "$root/sys/fs/cgroup"
chmod 1777 "$root/tmp" "$root/var/tmp"
cleanup
# mkfs.ext4 -d copies what is in the tree: nothing of the host (/dev, /proc) may be in it.
[ -z "$(mounted_under "$root")" ] || { echo "something is still mounted under $root: $(mounted_under "$root" | tr '\n' ' ')" >&2; exit 1; }

used_kb=$(du -sk "$root" | cut -f1)
size_mb=$(( used_kb / 1024 * 12 / 10 + 64 ))
log "root tree $((used_kb / 1024)) MiB, image $size_mb MiB"
rm -f "$out/rootfs.ext4"
truncate -s "${size_mb}M" "$out/rootfs.ext4"
mkfs.ext4 -q -L rootfs -m 0 -O ^has_journal -E root_owner=0:0 -d "$root" "$out/rootfs.ext4"
ls -ls "$out/rootfs.ext4"
remove_tree "$root"
