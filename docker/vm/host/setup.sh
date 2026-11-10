#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Makes a GitHub-hosted ubuntu-24.04 runner able to boot a Firecracker microVM (#976): /dev/kvm usable by the runner's user (the udev rule of the
# spike #970; the runners expose KVM through nested virtualization) and the pinned Firecracker release. Run as root, once per job.
# This is the CI's setup, not the installer of the local Dispatcher (#982): there the user is a service user in the group kvm and nothing
# else is opened.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

log "KVM: /dev/kvm usable by every user of this runner"
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' > /etc/udev/rules.d/99-kvm4all.rules
udevadm control --reload-rules
udevadm trigger --name-match=kvm --action=add
udevadm settle || true
[ -c /dev/kvm ] || { echo "no /dev/kvm on this runner" >&2; exit 1; }
ls -l /dev/kvm

log "Firecracker $FIRECRACKER_VERSION (pinned, verified)"
tmp=$(mktemp -d)
fetch_pinned "$FIRECRACKER_URL" "$FIRECRACKER_SHA256" "$tmp/firecracker.tgz"
tar -xzf "$tmp/firecracker.tgz" -C "$tmp"
install -m 0755 "$tmp/release-v$FIRECRACKER_VERSION-x86_64/firecracker-v$FIRECRACKER_VERSION-x86_64" /usr/local/bin/firecracker
rm -rf "$tmp"
firecracker --version
