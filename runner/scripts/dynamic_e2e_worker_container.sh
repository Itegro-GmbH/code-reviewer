#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# The container, as far as a process in the privileged Dynamic e2e lane can be one (#332): what the Worker's `docker run`
# of the hosted deployment gives it that a plain process does not have. Called by the `docker` stand-in of the lane
# (fakes/sandbox/bin/docker-worker.sh, E2E_WORKER_WRAPPER) as
#
#   dynamic_e2e_worker_container.sh <the image's entry point> <the entry mode: worker-once or probe>
#
# with the Worker's environment already closed. It must `exec`: the stand-in knows the process by its id.
#
#   - A read-only root, as the hardened container spec has it (`--read-only`): every disk filesystem of a mount
#     namespace of its own is remounted read-only, and the container's writable paths are fresh tmpfs (/tmp here; /run,
#     where the lane's directories for the Worker live, is a tmpfs of the lane already). The Worker's startup self-check
#     (`root_filesystem_writable`) judges exactly this, so a writable root would not advertise `opencode`.
#   - The capabilities of the container: root, with exactly the eight of the spec (`--cap-drop ALL`, then `--cap-add` of
#     them) in the bounding set, no inheritable ones and no-new-privileges. The Worker's startup installs the engine
#     user's network rules and drops NET_ADMIN and SETPCAP itself.
#   - The work volume of the Implementer's profile (`--mount type=volume,...,target=/work`, which the stand-in accepts and
#     does not make): a fresh tmpfs at /work in the container's own mount namespace, read-write, `nosuid`, `nodev` and
#     executable (the volume is a mount of the VM's disk with those options; the agent runs a repository's scripts there),
#     where the Worker's start-up check wants it. It is gone with the container, as the volume is with the VM.
#   - A /tmp that is the container's: the Worker's temporary directories are made there, where the engine user can enter
#     them (the self-check runs `opencode --version` as that user from one). The stand-in points TMPDIR at the Worker's
#     home, a directory only root can enter, which is right for a host process and wrong for a container.
#
# The same arrangement as `probe_as_container` of dynamic_e2e_namespace.sh, which proves the `probe` mode on the lane's
# layout before any journey runs. The list of capabilities is the one of the hardened container spec, kept equal by
# app/src/ci/hosted-lane.test.ts.
set -euo pipefail
program="${1:?the program is required}"
mode="${2:?the entry mode is required}"

make_root_read_only() {
  local failed=0 mountpoint fstype
  mount -t tmpfs -o rw,noexec,nosuid,nodev,size=512m,mode=1777 tmpfs /tmp || return 1
  while read -r mountpoint fstype; do
    case "$fstype" in
      ext2 | ext3 | ext4 | xfs | btrfs | vfat | overlay | fuseblk | squashfs | erofs | f2fs)
        mount -o remount,bind,ro "$mountpoint" || { echo "could not make $mountpoint read-only" >&2; failed=1; } ;;
    esac
  done < <(awk '{ for (i = 1; i <= NF; i++) if ($i == "-") print $5, $(i + 1) }' /proc/self/mountinfo)
  [ "$failed" = 0 ]
}
export -f make_root_read_only

# The mounts of the container are made before the root goes read-only. The directory is the profile's (`/work`) and is only
# there for a container that is given a work directory.
make_work_volume() {
  [ -n "${RUNNER_IMPLEMENTER_WORK_DIR:-}" ] || return 0
  [ -d "$RUNNER_IMPLEMENTER_WORK_DIR" ] || return 1
  mount -t tmpfs -o rw,nosuid,nodev,exec,size=3g,mode=0755 tmpfs "$RUNNER_IMPLEMENTER_WORK_DIR"
}
export -f make_work_volume

exec unshare --mount -- bash -c '
  make_work_volume || { echo "the container'"'"'s work volume could not be made" >&2; exit 125; }
  make_root_read_only || { echo "the container'"'"'s read-only root could not be made" >&2; exit 125; }
  exec env TMPDIR=/tmp setpriv \
    --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap,+net_admin \
    --inh-caps=-all --no-new-privs "$0" "$1"
' "$program" "$mode"
