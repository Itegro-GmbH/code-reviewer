#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Per-VM-start preparation of Sysbox on a Sandbox VM (plan implementer-sandbox, step 2). Run it as root AFTER
# vm-prepare.sh and ONLY on a VM that will run a Sysbox container: the golden snapshot (#330) installs it as
# /usr/local/sbin/sysbox-prepare.sh, the Sandbox-Launcher runs it for the Implementer's VM and the snapshot's own
# proof runs it in the check VM. A review (Diff, Dynamic) never runs it and its VM is as it was. The snapshot stores
# files, not the state of the kernel, so none of this can be done once at build time.
#
# Why each step (measured on the platform VM, Ubuntu 26.04, kernel 6.18, no systemd, no KVM):
#   1. cgroups  vm-prepare.sh has made the cgroup v2 root a domain with the controllers Sysbox needs; this only checks it
#               (a VM that skipped vm-prepare.sh fails here with a name, not later inside `docker run`)
#   2. tun      /dev/net/tun is mode 0600 root; root of a Sysbox container is host uid 165536 and could not open it
#   3. proc     the platform mounts a read-only devtmpfs over /proc/kcore and /proc/keys. With it in place
#               `docker run --runtime=sysbox-runc` fails with "re-mounting procfs caused: operation not permitted".
#               This unmounts them for the WHOLE VM, which is why the script runs on the Implementer's VM only
#   4. sysctl   the limits the Sysbox package sets at install time (inotify, keyring) are gone after a restore
#   5. daemons  sysbox-mgr, then sysbox-fs, detached; each must answer on its socket
#   6. runtime  dockerd (started by vm-prepare.sh) must list the `sysbox-runc` runtime from daemon.json
# Every step is idempotent (a second run in the same boot leaves a running pair alone) and every failure is loud: a
# line `sysbox-prepare: <name> ...` on stderr and an exit status of its own, so a VM that is not ready never gets an agent.
#
#   10 sysbox_not_installed   20 sysbox_cgroup_not_ready   21 sysbox_tun_failed        22 sysbox_proc_unmount_failed
#   23 sysbox_sysctl_failed   24 sysbox_mgr_not_ready      25 sysbox_fs_not_ready      26 sysbox_runtime_not_registered
#
# The variables below exist for the test, which runs the script against a directory and stand-ins for the daemons.
set -euo pipefail
cgroup_root="${SYSBOX_PREPARE_CGROUP_ROOT:-/sys/fs/cgroup}"
tun="${SYSBOX_PREPARE_TUN:-/dev/net/tun}"
mountinfo="${SYSBOX_PREPARE_MOUNTINFO:-/proc/self/mountinfo}"
sysctl_conf="${SYSBOX_PREPARE_SYSCTL_CONF:-/lib/sysctl.d/99-sysbox-sysctl.conf}"
run_dir="${SYSBOX_PREPARE_RUN_DIR:-/run/sysbox}"
log_dir="${SYSBOX_PREPARE_LOG_DIR:-/var/log}"
wait_tenths="${SYSBOX_PREPARE_WAIT_TENTHS:-300}"

fail() {
  local status=$1 name=$2
  shift 2
  echo "sysbox-prepare: $name $*" >&2
  exit "$status"
}

# The end of a daemon's log, for the failure line: the script is ours, the daemons are not, so it stays short.
log_tail() { tail -n 3 "$1" 2>/dev/null | tr '\n' '|' || true; }

# 1. the packages and the cgroup layout vm-prepare.sh made
for binary in sysbox-runc sysbox-mgr sysbox-fs; do
  command -v "$binary" >/dev/null 2>&1 || fail 10 sysbox_not_installed "$binary"
done
for controller in memory pids; do
  grep -qw "$controller" "$cgroup_root/cgroup.subtree_control" ||
    fail 20 sysbox_cgroup_not_ready "$controller is not enabled (vm-prepare.sh did not run?)"
done

# A pair that already answers (a second run in the same boot) is left alone: the daemons are not restarted under a container.
if pgrep -x sysbox-mgr >/dev/null && pgrep -x sysbox-fs >/dev/null && [ -S "$run_dir/sysmgr.sock" ] && [ -S "$run_dir/sysfs.sock" ]; then
  exit 0
fi

# 2.
chmod 0666 "$tun" 2>/dev/null || fail 21 sysbox_tun_failed "$tun"

# 3. Only a mount that is there is unmounted: after the first run the files are the kernel's own.
for node in /proc/kcore /proc/keys; do
  if grep -q " $node " "$mountinfo"; then
    umount "$node" 2>/dev/null || fail 22 sysbox_proc_unmount_failed "$node"
  fi
done

# 4. `-e` skips a key this kernel does not have (kernel.unprivileged_userns_clone); a key that is there must be accepted.
if [ -f "$sysctl_conf" ]; then
  sysctl -q -e -p "$sysctl_conf" >/dev/null 2>&1 || fail 23 sysbox_sysctl_failed "$sysctl_conf"
fi

# 5. The manager first: sysbox-fs asks it for the container's id mapping.
start() {
  local daemon=$1 socket=$2 status=$3 log="$log_dir/$1.log" _
  if ! pgrep -x "$daemon" >/dev/null; then nohup setsid "$daemon" > "$log" 2>&1 & fi
  for _ in $(seq 1 "$wait_tenths"); do
    if pgrep -x "$daemon" >/dev/null && [ -S "$run_dir/$socket" ]; then return 0; fi
    sleep 0.1
  done
  fail "$status" "${daemon//-/_}_not_ready" "$(log_tail "$log")"
}
start sysbox-mgr sysmgr.sock 24
start sysbox-fs sysfs.sock 25

# 6. The runtime is registered by daemon.json when the daemon starts; this only reads it back.
docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"sysbox-runc"' ||
  fail 26 sysbox_runtime_not_registered "daemon.json"
