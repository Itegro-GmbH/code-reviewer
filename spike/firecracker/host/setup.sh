#!/usr/bin/env bash
# Spike #970, install-time part: everything that needs root and is done ONCE per machine (the plan's "root only at install").
# Run as root on the GitHub runner. After this the driver runs as the normal user `fcuser`.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
work=${SPIKE_WORK:-/srv/fc}

log "1. KVM: group kvm may open /dev/kvm (the usual udev rule), user fcuser in group kvm"
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0660", OPTIONS+="static_node=kvm"' > /etc/udev/rules.d/99-kvm-spike.rules
udevadm control --reload-rules
udevadm trigger --name-match=kvm --action=add
udevadm settle || true
ls -l /dev/kvm
id fcuser >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups kvm fcuser
id fcuser

log "2. Firecracker $FIRECRACKER_VERSION (pinned, verified)"
fetch_pinned "$FIRECRACKER_URL" "$FIRECRACKER_SHA256" /tmp/spike-dl/firecracker.tgz
tar -xzf /tmp/spike-dl/firecracker.tgz -C /tmp/spike-dl
install -m 0755 "/tmp/spike-dl/release-v$FIRECRACKER_VERSION-x86_64/firecracker-v$FIRECRACKER_VERSION-x86_64" /usr/local/bin/firecracker
firecracker --version

log "3. the work volume: XFS with reflink on a loop file (the plan: XFS or btrfs on the host), owned by fcuser"
mkdir -p "$work"
if ! mountpoint -q "$work"; then
  truncate -s 40G /mnt/fc-xfs.img
  mkfs.xfs -q -m reflink=1 /mnt/fc-xfs.img
  mount -o loop,noatime /mnt/fc-xfs.img "$work"
fi
mkdir -p "$work"/{artifacts,base,results,vms}
chown -R fcuser:fcuser "$work"
xfs_info "$work" | grep -E 'reflink' || true

log "4. network: pre-created TAP devices owned by fcuser, test fixtures, the static wall"
"$SPIKE_DIR/host/net.sh"
log "setup done"

log "5. the scripts the unprivileged user runs, and the services every run uses (proxy, listeners)"
rm -rf "$work/spike"; cp -r "$SPIKE_DIR" "$work/spike"; chown -R fcuser:fcuser "$work/spike"
