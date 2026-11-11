#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Installs, updates, rolls back and removes the Factory-Runner on a Linux machine with KVM (#982, Runner v2,
# docs/decisions/0005): the local Dispatcher as a systemd service of a normal user, and the Firecracker VMs it
# starts a job in. No Docker is needed on the machine and the machine's Docker is never touched. As root:
#
#   curl -fsSL https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/install/install.sh | sudo sh
#
# The token of the app (Runners, "Add a runner") is asked for on the terminal (hidden), or comes from
# --token-file FILE (`-`: standard input, which is this script under `curl | sh`: save the script first) or from
# FACTORY_RUNNER_TOKEN (visible in the history, the log of sudo and the process list: only where that does not matter).
# Never an argument.
#
# What `install` does, in this order. Nothing is changed before the checks and the two signed manifests have passed
# (a machine without /dev/kvm, without nft, a manifest that does not verify: it stops and says so).
#   1. preflight: Linux, x86_64, root, systemd, cgroup v2, /dev/kvm, nft, tools, no other install, free space;
#   2. the two release channels (runner/release-channel.json and docker/vm/release-channel.json, or the files you
#      name): the program and the VM artifacts, each a signed manifest that is verified with `openssl`;
#   3. the service user (a member of `kvm`), the directories, the program and the VM artifacts downloaded by their
#      digest and verified (the artifacts are owned by root and read-only for the service), the TAP devices of
#      `--parallel-runs` slots owned by the user, the static nft table loaded AND listed again, the units;
#   4. registers the machine with the token and starts the service.
# The service runs `FACTORY_RUNNER_SANDBOX=firecracker`; `FACTORY_RUNNER_OUTER_WALL=proxy` is in its unit only because
# `nft list table inet code_reviewer_wall` succeeded, and the service checks it again before every start.
#
# The installed copy of this script is the one inside the program release (`libexec/host.sh`): `factory-runner update`,
# `rollback` and `uninstall` and the units run it, so an update of the program also updates the updater, and all of it
# is signed. Commands (the installed one is `/usr/local/bin/factory-runner update|rollback|status|uninstall`):
#   install (the default)  --refresh runs it again over an install that exists (nothing is restarted)
#   update [--scheduled]   stage the newest signed release; the service switches to it between two jobs
#   rollback [--now]       go back to the release before, or cancel a staged one; the release left is never taken again
#   status                 the releases that are current, previous and waiting
#   uninstall              remove everything this installer made, and nothing else
#   prestart | run-service | switch   what the unit runs
#
# Under `curl | sh` the shell reads this file while it runs. So all of it is functions and the last line is the only
# command that does anything: a download that is cut off changes nothing. `--dry-run` says what would be done.
# FACTORY_RUNNER_ROOT puts every path below another directory (for the tests that run this script against stand-ins).

set -eu

# -- the layout ------------------------------------------------------------------------------------------------
ROOT="${FACTORY_RUNNER_ROOT:-}"
SERVICE="factory-runner"
SVC_USER="factory-runner"
KVM_GROUP="kvm"
# Paths as they are written into units and files (OPT_PATH), and as this script reaches them ($OPT).
OPT_PATH="/opt/code-reviewer"
STATE_PATH="/var/lib/code-reviewer"
CONF_PATH="/etc/code-reviewer"
HOME_PATH="/var/lib/factory-runner"
COMMAND_PATH="/usr/local/bin/factory-runner"
UNIT_DIR_PATH="/etc/systemd/system"
OPT="$ROOT$OPT_PATH"
STATE="$ROOT$STATE_PATH"
CONF="$ROOT$CONF_PATH"
HOME_DIR="$ROOT$HOME_PATH"
COMMAND="$ROOT$COMMAND_PATH"
UNIT_DIR="$ROOT$UNIT_DIR_PATH"
KVM="$ROOT/dev/kvm"
WALL_TABLE="code_reviewer_wall"

PROGRAM_CHANNEL_URL="https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/release-channel.json"
VM_CHANNEL_URL="https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/docker/vm/release-channel.json"
MAX_PROGRAM_MANIFEST=65536
MAX_VM_MANIFEST=262144
MIN_SYSTEMD=247

# -- options ---------------------------------------------------------------------------------------------------
CMD="install"
DRY_RUN=0
REFRESH=0
NOW=0
SCHEDULED=0
TOKEN_FILE=""
TOKEN_TYPED=""
PROGRAM_CHANNEL_FILE=""
VM_CHANNEL_FILE=""
CURL_CONFIG=""
RUNNER_NAME=""
RUNNER_LABELS=""
RUNNER_URL=""
RUNNER_CPUS=""
RUNNER_MEMORY=""
RUNNER_DISK=""
PARALLEL=""

# -- bookkeeping -----------------------------------------------------------------------------------------------
TMPDIRS=""
WORK=""
# The directory the downloads are staged in (removed when the script ends, however it ends).
STAGING_ROOT=""
# Set once an install changed the machine for the first time; a failure after that removes what was made.
FRESH=0
UNDOING=0
NO_TOKEN=0
SWITCH_LOCKED=0

cleanup() {
  unset IFS
  if [ -n "$STAGING_ROOT" ]; then
    rm -rf -- "$STAGING_ROOT"
  fi
  # shellcheck disable=SC2086 # the paths of mktemp hold no space
  for dir in $TMPDIRS; do
    rm -rf -- "$dir"
  done
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
warn() { printf 'install: %s\n' "$*" >&2; }
fail() {
  printf 'install: %s\n' "$*" >&2
  if [ "$FRESH" = 1 ] && [ "$UNDOING" = 0 ]; then
    UNDOING=1
    warn "removing what this install made, so that nothing is left behind"
    remove_everything >/dev/null 2>&1 || warn "the removal did not finish: run this script with --uninstall"
  fi
  exit 1
}

make_tmpdir() { # sets TMPDIR_MADE
  TMPDIR_MADE="$(mktemp -d)"
  TMPDIRS="$TMPDIRS $TMPDIR_MADE"
}

usage() {
  cat <<'EOF'
Usage: sh install.sh [install] [options]       sh install.sh update|rollback|status|uninstall [options]
  --token-file FILE        registration token from a file (- = standard input); else FACTORY_RUNNER_TOKEN
                           (visible in history, sudo log, process list); else asked on the terminal (hidden).
                           Never an argument.
  --name NAME              the name in the list of runners (default: the host name)
  --labels a,b             labels the runner announces (e.g. linux,gpu)
  --url URL                the app (default: https://code-review.com)
  --cpus N                 CPUs a job's VM may use          --memory-mb N   memory of the agent in the VM
  --disk-gb N              the disk quota of a job (default 16, at least 8)
  --parallel-runs N        jobs at once, 1 to 64: one TAP device and one VM each (default 1)
  --program-channel-file F the release channel of the program (default: runner/release-channel.json of main)
  --vm-channel-file F      the release channel of the VM artifacts (default: docker/vm/release-channel.json of main)
  --curl-config FILE       a curl configuration (a header with a token, say) for a release address that needs a login;
                           kept for updates in a file only root can read
  --refresh                run the install again over one that exists (never restarts a running service)
  --now                    rollback: restart the service at once instead of waiting for it to be between two jobs
  --dry-run                say what would be done, change nothing
  --uninstall              remove everything this installer made, and nothing else
EOF
}

parse_args() {
  if [ $# -gt 0 ]; then
    case "$1" in
      install|update|rollback|status|uninstall|switch|prestart|run-service) CMD="$1"; shift ;;
    esac
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --token-file) [ $# -ge 2 ] || fail "--token-file needs a file"; TOKEN_FILE="$2"; shift 2 ;;
      --name) [ $# -ge 2 ] || fail "--name needs a value"; RUNNER_NAME="$2"; shift 2 ;;
      --labels) [ $# -ge 2 ] || fail "--labels needs a value"; RUNNER_LABELS="$2"; shift 2 ;;
      --url) [ $# -ge 2 ] || fail "--url needs a value"; RUNNER_URL="$2"; shift 2 ;;
      --cpus) [ $# -ge 2 ] || fail "--cpus needs a value"; RUNNER_CPUS="$2"; shift 2 ;;
      --memory-mb) [ $# -ge 2 ] || fail "--memory-mb needs a value"; RUNNER_MEMORY="$2"; shift 2 ;;
      --disk-gb) [ $# -ge 2 ] || fail "--disk-gb needs a value"; RUNNER_DISK="$2"; shift 2 ;;
      --parallel-runs) [ $# -ge 2 ] || fail "--parallel-runs needs a value"; PARALLEL="$2"; shift 2 ;;
      --program-channel-file) [ $# -ge 2 ] || fail "--program-channel-file needs a file"; PROGRAM_CHANNEL_FILE="$2"; shift 2 ;;
      --vm-channel-file) [ $# -ge 2 ] || fail "--vm-channel-file needs a file"; VM_CHANNEL_FILE="$2"; shift 2 ;;
      --curl-config) [ $# -ge 2 ] || fail "--curl-config needs a file"; CURL_CONFIG="$2"; shift 2 ;;
      --refresh) REFRESH=1; shift ;;
      --now) NOW=1; shift ;;
      --scheduled) SCHEDULED=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --uninstall) CMD="uninstall"; shift ;;
      -h|--help) usage; exit 0 ;;
      --token|--token=*) fail "a token is never an argument (it would be in the process list and the shell history): use the prompt, --token-file or FACTORY_RUNNER_TOKEN" ;;
      *) usage >&2; fail "unknown option: $1" ;;
    esac
  done
  if [ -n "$PARALLEL" ]; then
    is_uint "$PARALLEL" && [ "$PARALLEL" -ge 1 ] && [ "$PARALLEL" -le 64 ] || fail "--parallel-runs is a whole number from 1 to 64"
  fi
  if [ -n "$TOKEN_FILE" ] && [ "$TOKEN_FILE" != "-" ] && [ ! -r "$TOKEN_FILE" ]; then
    fail "the token file $TOKEN_FILE does not exist or cannot be read"
  fi
  if [ -n "$CURL_CONFIG" ] && [ ! -r "$CURL_CONFIG" ]; then
    fail "the curl configuration $CURL_CONFIG does not exist or cannot be read"
  fi
}

# -- small helpers ---------------------------------------------------------------------------------------------

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "${#1}" -le 9 ] ;;
  esac
}

is_sha256() {
  case "$1" in
    *[!0-9a-f]*|'') return 1 ;;
    *) [ "${#1}" = 64 ] ;;
  esac
}

# A file name from a manifest: no separator, no leading dot (the rule of the manifest's own schema).
is_file_name() {
  case "$1" in
    ''|.*|*[!A-Za-z0-9._+-]*) return 1 ;;
    *) [ "${#1}" -le 128 ] ;;
  esac
}

# Every change goes through `act`: with --dry-run it is only said.
act() {
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: $*"
  else
    "$@"
  fi
}

file_sha256() { sha256sum "$1" | cut -d' ' -f1; }
file_size() { wc -c <"$1" | tr -d ' '; }

# The free space, in KiB, of the file system a path is (or would be) on: the nearest directory that exists.
free_kib() {
  probe="$1"
  while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
  df -Pk "$probe" | sed -n '2s/^[^ ]* *[0-9]* *[0-9]* *\([0-9]*\).*/\1/p'
}

nearest_dir() {
  probe="$1"
  while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
  printf '%s' "$probe"
}

# A small download from an https address only: no other scheme, and no redirect to one. A login for a protected
# release address is a curl configuration that only root can read (`--curl-config`).
fetch() { # fetch URL FILE MAXBYTES
  if [ -r "$CONF/download.curlrc" ]; then
    curl -K "$CONF/download.curlrc" --proto '=https' --proto-redir '=https' -fsSL --max-filesize "$3" -o "$2" "$1"
  elif [ -n "$CURL_CONFIG" ]; then
    curl -K "$CURL_CONFIG" --proto '=https' --proto-redir '=https' -fsSL --max-filesize "$3" -o "$2" "$1"
  else
    curl --proto '=https' --proto-redir '=https' -fsSL --max-filesize "$3" -o "$2" "$1"
  fi
}

as_service_user() { runuser -u "$SVC_USER" -- "$@"; }

user_exists() { getent passwd "$SVC_USER" >/dev/null 2>&1; }

state_value() { # state_value KEY: a value of install.state, empty without one
  [ -f "$CONF/install.state" ] || return 0
  sed -n "s/^$1=//p" "$CONF/install.state" | head -n 1
}

set_state() { # set_state KEY VALUE
  mkdir -p "$CONF"
  if [ -f "$CONF/install.state" ]; then
    grep -v "^$1=" "$CONF/install.state" >"$CONF/install.state.new" || true
  else
    : >"$CONF/install.state.new"
  fi
  printf '%s=%s\n' "$1" "$2" >>"$CONF/install.state.new"
  chmod 0644 "$CONF/install.state.new"
  mv "$CONF/install.state.new" "$CONF/install.state"
}

root_owned() { # root_owned PATH...: root's, nobody else's
  chown root:root "$@"
}

write_file() { # write_file PATH MODE  (content on stdin)
  target="$1"
  mode="$2"
  mkdir -p "$(dirname "$target")"
  cat >"$target.new"
  chmod "$mode" "$target.new"
  root_owned "$target.new"
  mv "$target.new" "$target"
}

# Points LINK at TARGET (a name relative to the link's directory) in one atomic step.
point_link() { # point_link TARGET LINK
  rm -f "$2.new"
  ln -s "$1" "$2.new"
  mv -T "$2.new" "$2"
}

link_release() { # link_release LINK: the release (the directory name) a link points at, empty without one
  [ -L "$1" ] || return 0
  basename "$(readlink "$1")"
}

installed_release() { # installed_release program|vm: 0 without one
  case "$1" in
    program) found="$(link_release "$OPT/current")" ;;
    vm) found="$(link_release "$STATE/artifacts")" ;;
  esac
  printf '%s' "${found:-0}"
}

rejected_release() { # rejected_release program|vm: the highest release a rollback left, 0 without one
  raw=""
  [ -f "$CONF/rejected-$1" ] && raw="$(head -c 12 "$CONF/rejected-$1" | tr -d ' \n')"
  if is_uint "$raw"; then printf '%s' "$raw"; else printf '0'; fi
}

pending_release() { # pending_release program|vm: the release waiting to be switched to, empty without one
  [ -f "$STATE/pending" ] || return 0
  sed -n "s/^$1=//p" "$STATE/pending" | head -n 1
}

# -- checks (nothing is changed) -------------------------------------------------------------------------------

preflight() {
  [ "$(uname -s)" = "Linux" ] || fail "Linux only (this is $(uname -s))"
  [ "$(uname -m)" = "x86_64" ] || fail "x86_64 only for now (this is $(uname -m)); macOS and arm64 come later"
  [ "$(id -u)" = 0 ] || fail "run as root: sudo sh install.sh"

  if [ ! -e "$KVM" ]; then
    say "install: this machine has no /dev/kvm, and the runner starts every job in a Firecracker VM that needs it." >&2
    say "  On a physical machine: enable virtualization (Intel VT-x / AMD-V) in the firmware, and load the kvm modules" >&2
    say "  (modprobe kvm_intel or kvm_amd). On a cloud VM: the provider must offer NESTED VIRTUALIZATION (a bare-metal" >&2
    say "  type, or a VM family that exposes /dev/kvm); many do not, and a container has no /dev/kvm either." >&2
    say "  Nothing was changed." >&2
    exit 1
  fi
  [ -r "$KVM" ] && [ -w "$KVM" ] || fail "/dev/kvm cannot be opened by root: check its permissions (nothing was changed)"
  if [ "$(stat -c %G "$KVM" 2>/dev/null || echo "$KVM_GROUP")" != "$KVM_GROUP" ]; then
    warn "warning: /dev/kvm does not belong to the group $KVM_GROUP: the service user is added to it and may still not be able to open the device (the check after the user is made says)"
  fi
  getent group "$KVM_GROUP" >/dev/null 2>&1 || fail "the group $KVM_GROUP does not exist: /dev/kvm is opened through it (a udev rule: KERNEL==\"kvm\", GROUP=\"kvm\", MODE=\"0660\")"

  [ -d "$ROOT/run/systemd/system" ] || fail "systemd is not the init of this machine (/run/systemd/system is missing)"
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is not available"
  version="$(systemctl --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p')"
  is_uint "$version" || fail "the version of systemd cannot be read"
  [ "$version" -ge "$MIN_SYSTEMD" ] || fail "systemd $version is too old: the unit needs $MIN_SYSTEMD or newer (cgroup delegation and the sandboxing options)"
  [ -f "$ROOT/sys/fs/cgroup/cgroup.controllers" ] || fail "cgroup v2 is not mounted at /sys/fs/cgroup (unified hierarchy): the limits of a VM need it"

  for tool in nft ip curl openssl sha256sum base64 jq zstd tar flock runuser useradd userdel getent resize2fs e2fsck; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed ($(tool_hint "$tool")): nothing was changed"
  done

  # A second dispatcher on one machine: the launcher takes a lock on its state directory, so two would reap each
  # other's VMs. What the installer did not make is never reused.
  if [ -f "$CONF/install.state" ]; then
    if [ "$REFRESH" != 1 ]; then
      fail "the runner is installed on this machine already (see 'factory-runner status'): update it with 'sudo factory-runner update', change a setting with 'factory-runner config set', run the installer over it with --refresh, or remove it with --uninstall"
    fi
  else
    [ ! -e "$UNIT_DIR/$SERVICE.service" ] || fail "a unit $SERVICE.service exists that this installer did not make (an older, Docker-based install?): remove it first, there is no migration"
    user_exists && fail "the user $SVC_USER exists and was not made by this installer: the service user must own nothing else (nothing was changed)"
    if [ -d "$STATE" ] && [ -n "$(ls -A "$STATE" 2>/dev/null)" ]; then
      fail "$STATE_PATH exists and is not empty: it is the state directory of the runner (nothing was changed)"
    fi
    [ ! -e "$OPT" ] || fail "$OPT_PATH exists and was not made by this installer (nothing was changed)"
    nft list table inet "$WALL_TABLE" >/dev/null 2>&1 && fail "the nft table $WALL_TABLE is loaded and was not made by this installer (nothing was changed)"
    if [ -n "$(ip -o link show 2>/dev/null | grep ': fctap[0-9]*:' || true)" ]; then
      fail "TAP devices named fctapN exist and were not made by this installer (nothing was changed)"
    fi
  fi
  probe_reflink
}

tool_hint() {
  case "$1" in
    nft) printf 'package nftables' ;;
    ip) printf 'package iproute2' ;;
    zstd) printf 'package zstd' ;;
    jq) printf 'package jq' ;;
    resize2fs|e2fsck) printf 'package e2fsprogs' ;;
    runuser|flock) printf 'package util-linux' ;;
    useradd|userdel) printf 'package passwd / shadow-utils' ;;
    *) printf 'it is needed by the installer' ;;
  esac
}

# Whether the state directory's file system can make a copy-on-write copy of a file: a job's disk is a copy of the 6 GiB
# base disk, 34 ms with a reflink (XFS with reflink=1, btrfs) and seconds of disk with a plain copy.
probe_reflink() {
  probe="$(nearest_dir "$STATE")"
  one="$(mktemp -p "$probe" .reflink-probe.XXXXXX 2>/dev/null)" || return 0
  if cp --reflink=always "$one" "$one.copy" >/dev/null 2>&1; then
    rm -f "$one" "$one.copy"
    return 0
  fi
  rm -f "$one" "$one.copy"
  warn "warning: $STATE_PATH is not on a file system with reflinks (XFS with reflink=1, or btrfs): every job copies the base disk in full (several GiB and seconds per job) instead of 34 ms. Put the directory on such a volume to make jobs start fast."
}

# -- release channels and manifests ----------------------------------------------------------------------------

# Reads a channel: CH_BASE (https, with a trailing slash), CH_MANIFEST, CH_SIGNATURE, CH_KEY. Returns 1 for a channel
# the owner has not filled in yet.
read_channel() { # read_channel FILE
  jq -e . "$1" >/dev/null 2>&1 || fail "the release channel $1 is not valid JSON"
  CH_BASE="$(jq -r '.baseUrl // ""' "$1")"
  CH_MANIFEST="$(jq -r '.manifestAsset // ""' "$1")"
  CH_SIGNATURE="$(jq -r '.signatureAsset // ""' "$1")"
  CH_KEY="$(jq -r '.publicKey // ""' "$1")"
  if [ -z "$CH_BASE" ] || [ -z "$CH_KEY" ]; then
    return 1
  fi
  case "$CH_BASE" in https://*) ;; *) fail "the release channel must name an https address (baseUrl)" ;; esac
  case "$CH_BASE" in */) ;; *) CH_BASE="$CH_BASE/" ;; esac
  if ! is_file_name "$CH_MANIFEST" || ! is_file_name "$CH_SIGNATURE"; then
    fail "the release channel names a manifest or a signature that is not a file name"
  fi
}

# The signature over the exact bytes of the manifest, by the channel's key, which must be ECDSA over P-256.
verify_signature() { # verify_signature MANIFEST SIGNATURE KEY_BASE64 DIR
  case "$3" in ''|*[!A-Za-z0-9+/=]*) fail "the public key of the release channel is not base64" ;; esac
  printf '%s' "$3" | base64 -d >"$4/key.der" 2>/dev/null || fail "the public key of the release channel cannot be read"
  openssl pkey -pubin -inform DER -in "$4/key.der" -out "$4/key.pem" >/dev/null 2>&1 \
    || fail "the public key of the release channel cannot be read"
  openssl pkey -pubin -in "$4/key.pem" -noout -text 2>/dev/null | grep -Eq 'prime256v1|P-256' \
    || fail "the public key of the release channel is not an ECDSA P-256 key"
  openssl dgst -sha256 -verify "$4/key.pem" -signature "$2" "$1" >/dev/null 2>&1 \
    || fail "the signature of the $COMP release manifest is not valid: this is not our release, nothing was installed"
}

channel_file() { # channel_file program|vm: the channel of this component (the stored copy once installed)
  case "$1" in
    program) given="$PROGRAM_CHANNEL_FILE"; url="$PROGRAM_CHANNEL_URL" ;;
    vm) given="$VM_CHANNEL_FILE"; url="$VM_CHANNEL_URL" ;;
  esac
  if [ -n "$given" ]; then
    CHANNEL_FILE_USED="$given"
  elif [ -f "$CONF/channel-$1.json" ] && [ "$CMD" != install ]; then
    CHANNEL_FILE_USED="$CONF/channel-$1.json"
  else
    CHANNEL_FILE_USED="$WORK/channel-$1.json"
    fetch "$url" "$CHANNEL_FILE_USED" 65536 || fail "the release channel of the $1 could not be downloaded"
  fi
  [ -r "$CHANNEL_FILE_USED" ] || fail "the release channel file of the $1 cannot be read"
}

# Fetches the signed manifest of a component and proves it: WORK/COMP.manifest.json, M_RELEASE. Returns 1 for a channel
# that is empty (nothing is published yet).
fetch_manifest() { # fetch_manifest program|vm
  COMP="$1"
  channel_file "$1"
  read_channel "$CHANNEL_FILE_USED" || return 1
  case "$1" in program) max=$MAX_PROGRAM_MANIFEST ;; vm) max=$MAX_VM_MANIFEST ;; esac
  base="$CH_BASE"
  fetch "$base$CH_MANIFEST" "$WORK/$1.manifest.json" "$max" || fail "the release manifest of the $1 could not be downloaded"
  fetch "$base$CH_SIGNATURE" "$WORK/$1.manifest.sig" 4096 || fail "the signature of the $1 manifest could not be downloaded"
  verify_signature "$WORK/$1.manifest.json" "$WORK/$1.manifest.sig" "$CH_KEY" "$WORK"
  M_RELEASE="$(jq -r 'if (.release|type)=="number" and .release>=1 and .release==(.release|floor) then .release else empty end' "$WORK/$1.manifest.json" 2>/dev/null)"
  is_uint "$M_RELEASE" || fail "the $1 manifest has no release number"
  [ "$(jq -r '.arch // ""' "$WORK/$1.manifest.json")" = "x86_64" ] || fail "the $1 manifest is not for x86_64"
  CH_BASE_OF_MANIFEST="$base"
  case "$1" in
    program)
      jq -e '.version==1 and (.file.name|type)=="string" and (.file.size|type)=="number" and (.file.sha256|type)=="string"' \
        "$WORK/program.manifest.json" >/dev/null 2>&1 || fail "the program manifest is not a manifest of this installer"
      ;;
    vm)
      jq -e '.version==1 and (.files.kernel.name|type)=="string" and (.files.rootfs.uncompressed.sha256|type)=="string" and (.files.dockerData.uncompressed.sha256|type)=="string" and (.images.worker.id|type)=="string"' \
        "$WORK/vm.manifest.json" >/dev/null 2>&1 || fail "the VM artifacts manifest is not a manifest of this installer"
      ;;
  esac
}

# -- staging: download, verify, unpack, then move into place ---------------------------------------------------

lock_switch() { # one holder at a time of the files that say what is current, previous and pending
  [ "$SWITCH_LOCKED" = 1 ] && return 0
  mkdir -p "$STATE"
  exec 8>"$STATE/switch.lock"
  flock -w 600 8 || fail "another update, rollback or start is switching releases"
  SWITCH_LOCKED=1
}

unlock_switch() {
  exec 8>&-
  SWITCH_LOCKED=0
}

write_pending() { # write_pending program|vm RELEASE: keeps the other component's line
  lock_switch
  if [ -f "$STATE/pending" ]; then
    grep -v "^$1=" "$STATE/pending" >"$STATE/pending.new" || true
  else
    : >"$STATE/pending.new"
  fi
  printf '%s=%s\n' "$1" "$2" >>"$STATE/pending.new"
  chmod 0644 "$STATE/pending.new"
  root_owned "$STATE/pending.new"
  mv "$STATE/pending.new" "$STATE/pending"
}

drop_pending() { # drop_pending program|vm
  [ -f "$STATE/pending" ] || return 0
  grep -v "^$1=" "$STATE/pending" >"$STATE/pending.new" || true
  if [ -s "$STATE/pending.new" ]; then
    mv "$STATE/pending.new" "$STATE/pending"
  else
    rm -f "$STATE/pending.new" "$STATE/pending"
  fi
}

stage_program() {
  manifest="$WORK/program.manifest.json"
  name="$(jq -r .file.name "$manifest")"
  size="$(jq -r .file.size "$manifest")"
  digest="$(jq -r .file.sha256 "$manifest")"
  if ! is_file_name "$name" || ! is_uint "$size" || ! is_sha256 "$digest"; then
    fail "the program manifest names a file in a form this installer does not accept"
  fi
  STAGING_ROOT="$STATE/staging"
  stage="$STAGING_ROOT/program-$M_RELEASE"
  rm -rf "$stage"
  mkdir -p "$stage/tree"
  say "downloading the program, release $M_RELEASE"
  fetch "$CH_BASE_OF_MANIFEST$name" "$stage/bundle.tar.zst" "$size" || fail "the program could not be downloaded"
  [ "$(file_size "$stage/bundle.tar.zst")" = "$size" ] || fail "the program is not the size its manifest names: nothing was installed"
  [ "$(file_sha256 "$stage/bundle.tar.zst")" = "$digest" ] || fail "the program does not match the digest in its manifest: nothing was installed"

  # What is unpacked: names of the bundle's own tree only (no absolute path, no `..`, no odd character), no device.
  zstd -dcq "$stage/bundle.tar.zst" | tar -tf - >"$stage/names" 2>/dev/null || fail "the program is not a tar archive in zstd"
  if grep -Eq '(^/|(^|/)\.\.(/|$)|[^A-Za-z0-9._+/@=-])' "$stage/names"; then
    fail "the program holds a path outside its own tree or an odd name: nothing was installed"
  fi
  zstd -dcq "$stage/bundle.tar.zst" | tar -xf - -C "$stage/tree" --no-same-owner --no-same-permissions 2>/dev/null \
    || fail "the program could not be unpacked"
  rm -f "$stage/bundle.tar.zst" "$stage/names"
  if [ -n "$(find "$stage/tree" \( -type b -o -type c -o -type p -o -type s \) 2>/dev/null)" ]; then
    fail "the program holds a device or a socket: nothing was installed"
  fi
  # A link may only point inside the tree.
  find "$stage/tree" -type l >"$stage/links" 2>/dev/null || true
  while IFS= read -r link; do
    case "$(readlink -f "$link" 2>/dev/null || true)" in
      "$stage/tree"/*) ;;
      *) fail "the program holds a link that points out of its tree: nothing was installed" ;;
    esac
  done <"$stage/links"
  rm -f "$stage/links"
  for part in bin/factory-runner bin/firecracker libexec/host.sh share/outer-wall.nft; do
    [ -f "$stage/tree/$part" ] || fail "the program has no $part: it is not a runner release"
  done
  chmod -R go-w "$stage/tree"
  chmod 0755 "$stage/tree/bin/factory-runner" "$stage/tree/bin/firecracker" "$stage/tree/libexec/host.sh"
  chmod 0644 "$stage/tree/share/outer-wall.nft"
  # A kernel without the netfilter modules of the table is found now, not when the service starts.
  nft -c -f "$stage/tree/share/outer-wall.nft" >/dev/null 2>&1 \
    || fail "the nft table of this release does not load on this kernel (nft -c -f failed: are the nft_fib modules there?)"
  root_owned "$stage/tree"
  chown -R root:root "$stage/tree"
  lock_switch
  mkdir -p "$OPT/releases"
  rm -rf "$OPT/releases/$M_RELEASE"
  mv "$stage/tree" "$OPT/releases/$M_RELEASE"
  rm -rf "$stage"
}

# One file of the VM release: downloaded by its name, its size and its sha256 checked, and, if it is packed, the
# unpacked file's size and sha256 too (the rule of dispatcher/src/vm-artifacts/verify.ts).
fetch_artifact() { # fetch_artifact DIR ROLE FILENAME-EXPECTED UNPACKED-NAME
  role="$2"
  jq_file=".files.$role"
  name="$(jq -r "$jq_file.name" "$WORK/vm.manifest.json")"
  size="$(jq -r "$jq_file.size" "$WORK/vm.manifest.json")"
  digest="$(jq -r "$jq_file.sha256" "$WORK/vm.manifest.json")"
  [ "$name" = "$3" ] || fail "the VM manifest names $role as a file this installer does not expect"
  if ! is_file_name "$name" || ! is_uint "$size" || ! is_sha256 "$digest"; then
    fail "the VM manifest names $role in a form this installer does not accept"
  fi
  fetch "$CH_BASE_OF_MANIFEST$name" "$1/$name" "$size" || fail "the $role file could not be downloaded"
  [ "$(file_size "$1/$name")" = "$size" ] || fail "the $role file is not the size its manifest names: nothing was installed"
  [ "$(file_sha256 "$1/$name")" = "$digest" ] || fail "the $role file does not match the digest in its manifest: nothing was installed"
  if [ "$name" != "$4" ]; then
    usize="$(jq -r "$jq_file.uncompressed.size" "$WORK/vm.manifest.json")"
    udigest="$(jq -r "$jq_file.uncompressed.sha256" "$WORK/vm.manifest.json")"
    if ! is_uint "$usize" || ! is_sha256 "$udigest"; then
      fail "the VM manifest gives no size and digest for what $role unpacks to"
    fi
    zstd -dq --no-progress "$1/$name" -o "$1/$4" || fail "the $role file could not be unpacked"
    rm -f "$1/$name"
    [ "$(file_size "$1/$4")" = "$usize" ] || fail "the unpacked $role file is not the size its manifest names: nothing was installed"
    [ "$(file_sha256 "$1/$4")" = "$udigest" ] || fail "the unpacked $role file does not match the digest in its manifest: nothing was installed"
  fi
}

# Space for the downloads and the unpacked files at once (the compressed ones go as soon as they are unpacked), with a tenth over.
check_space() {
  needed="$(jq -r '[.files.kernel.size, .files.rootfs.size, .files.rootfs.uncompressed.size, .files.dockerData.size, .files.dockerData.uncompressed.size] | add' "$WORK/vm.manifest.json")"
  is_uint "$needed" || fail "the VM manifest has no sizes"
  needed_kib=$(( needed * 11 / 10 / 1024 + 1 ))
  free="$(free_kib "$STATE")"
  if [ "${free:-0}" -lt "$needed_kib" ]; then
    fail "not enough free space in $STATE_PATH: this release needs $(( needed_kib / 1048576 + 1 )) GiB for its download and its files, the file system has $(( ${free:-0} / 1048576 )) GiB"
  fi
}

stage_vm() {
  manifest="$WORK/vm.manifest.json"
  image_id="$(jq -r .images.worker.id "$manifest")"
  case "$image_id" in sha256:*) is_sha256 "${image_id#sha256:}" || fail "the VM manifest has no Worker image id" ;; *) fail "the VM manifest has no Worker image id" ;; esac
  check_space
  STAGING_ROOT="$STATE/staging"
  stage="$STAGING_ROOT/vm-$M_RELEASE"
  rm -rf "$stage"
  mkdir -p "$stage"
  say "downloading the VM artifacts, release $M_RELEASE"
  fetch_artifact "$stage" kernel vmlinux vmlinux
  fetch_artifact "$stage" rootfs rootfs.ext4.zst rootfs.ext4
  fetch_artifact "$stage" dockerData dockerdata.ext4.zst dockerdata.ext4
  cp "$WORK/vm.manifest.json" "$stage/vm-artifacts-manifest.json"
  cp "$WORK/vm.manifest.sig" "$stage/vm-artifacts-manifest.sig"
  printf 'FACTORY_RUNNER_VM_IMAGE_ID=%s\n' "$image_id" >"$stage/vm.env"
  # What was verified is all there is (the verifier's --exact-dir).
  found="$(cd "$stage" && find . -mindepth 1 -maxdepth 1 | LC_ALL=C sort | tr '\n' ' ')"
  [ "$found" = "./dockerdata.ext4 ./rootfs.ext4 ./vm-artifacts-manifest.json ./vm-artifacts-manifest.sig ./vm.env ./vmlinux " ] \
    || fail "the staged VM artifacts hold something the manifest does not name"
  # Root's and read-only for the service: a VMM that escaped must not be able to change what every later VM boots from.
  chmod 0755 "$stage"
  chmod 0644 "$stage"/*
  chown -R root:root "$stage"
  lock_switch
  mkdir -p "$STATE/artifact-releases"
  rm -rf "$STATE/artifact-releases/$M_RELEASE"
  mv "$stage" "$STATE/artifact-releases/$M_RELEASE"
}

# Looks for the newest release of one component and stages it when it is newer than what is installed, staged, and
# the release a rollback left. Returns 0 either way; STAGED_ANY is set when something was staged.
update_component() { # update_component program|vm
  comp="$1"
  if ! fetch_manifest "$comp"; then
    say "the $comp release channel is empty: nothing is published yet"
    return 0
  fi
  installed="$(installed_release "$comp")"
  waiting="$(pending_release "$comp")"
  rejected="$(rejected_release "$comp")"
  newest="$installed"
  if [ -n "$waiting" ] && [ "$waiting" -gt "$newest" ]; then newest="$waiting"; fi
  if [ "$M_RELEASE" -le "$newest" ]; then
    say "the $comp is at release $installed${waiting:+ (release $waiting is staged)}; the channel announces $M_RELEASE: nothing to do"
    return 0
  fi
  if [ "$M_RELEASE" -le "$rejected" ]; then
    say "the $comp release $M_RELEASE was rolled back on this machine: waiting for a higher one"
    return 0
  fi
  release="$M_RELEASE"
  case "$comp" in program) stage_program ;; vm) stage_vm ;; esac
  write_pending "$comp" "$release"
  STAGED_ANY=1
  say "staged the $comp release $release (verified)"
}

# -- the switch: current <- pending, between two starts of the service ------------------------------------------

# Smoke test of a program release as the service user: the command runs and says its version; and the release
# carries the script that is installed from it.
smoke_program() { # smoke_program DIR
  [ -f "$1/libexec/host.sh" ] && sh -n "$1/libexec/host.sh" 2>/dev/null || return 1
  as_service_user "$1/bin/factory-runner" --version >/dev/null 2>&1 </dev/null || return 1
  as_service_user "$1/bin/firecracker" --version >/dev/null 2>&1 </dev/null || return 1
}

prune_releases() { # prune_releases DIR: only the current, the previous and the waiting release stay
  dir="$1"
  [ -d "$dir" ] || return 0
  for each in "$dir"/*; do
    [ -d "$each" ] || continue
    release="${each##*/}"
    case "$1" in
      "$OPT"/*) keep_a="$(link_release "$OPT/current")"; keep_b="$(link_release "$OPT/previous")"; keep_c="$(pending_release program)" ;;
      *) keep_a="$(link_release "$STATE/artifacts")"; keep_b="$(link_release "$STATE/artifacts-previous")"; keep_c="$(pending_release vm)" ;;
    esac
    if [ "$release" != "$keep_a" ] && [ "$release" != "$keep_b" ] && [ "$release" != "$keep_c" ]; then
      rm -rf "$each"
    fi
  done
}

# Makes what is pending current: the program (smoke-tested first) and the VM artifacts, each in one atomic step, the
# release before kept as `previous`. A release that fails its smoke test is dropped and remembered as rejected.
apply_pending() {
  lock_switch
  [ -f "$STATE/pending" ] || return 0
  target="$(pending_release program)"
  if [ -n "$target" ]; then
    if [ "$target" = "$(link_release "$OPT/current")" ]; then
      drop_pending program
    elif [ ! -d "$OPT/releases/$target" ]; then
      warn "the staged program release $target is gone: it is dropped"
      drop_pending program
    elif ! smoke_program "$OPT/releases/$target"; then
      warn "the program release $target does not run on this machine: it is dropped and not taken again; the current release stays"
      reject_release program "$target"
      drop_pending program
    else
      old="$(link_release "$OPT/current")"
      if [ -n "$old" ] && [ "$target" -lt "$old" ]; then
        # Going back: the release left is rejected and is not kept as `previous`, so a second rollback does not go forward.
        rm -f "$OPT/previous"
        say "the program is back at release $target (release $old is not taken again)"
      elif [ -n "$old" ]; then
        point_link "releases/$old" "$OPT/previous"
        say "the program is now release $target (the release before, $old, is kept for 'factory-runner rollback')"
      else
        say "the program is release $target"
      fi
      point_link "releases/$target" "$OPT/current"
      drop_pending program
    fi
  fi
  target="$(pending_release vm)"
  if [ -n "$target" ]; then
    if [ "$target" = "$(link_release "$STATE/artifacts")" ]; then
      drop_pending vm
    elif [ ! -f "$STATE/artifact-releases/$target/vm.env" ]; then
      warn "the staged VM artifacts release $target is gone: it is dropped"
      drop_pending vm
    else
      old="$(link_release "$STATE/artifacts")"
      if [ -n "$old" ] && [ "$target" -lt "$old" ]; then
        rm -f "$STATE/artifacts-previous"
        say "the VM artifacts are back at release $target (release $old is not taken again)"
      elif [ -n "$old" ]; then
        point_link "artifact-releases/$old" "$STATE/artifacts-previous"
        say "the VM artifacts are now release $target (the release before, $old, is kept for rollback)"
      else
        say "the VM artifacts are release $target"
      fi
      point_link "artifact-releases/$target" "$STATE/artifacts"
      drop_pending vm
    fi
  fi
  prune_releases "$OPT/releases"
  prune_releases "$STATE/artifact-releases"
}

reject_release() { # reject_release program|vm RELEASE: never taken again, nor any below it
  lock_switch
  current_rejected="$(rejected_release "$1")"
  [ "$2" -gt "$current_rejected" ] || return 0
  mkdir -p "$CONF"
  printf '%s\n' "$2" >"$CONF/rejected-$1.new"
  chmod 0644 "$CONF/rejected-$1.new"
  mv "$CONF/rejected-$1.new" "$CONF/rejected-$1"
}

# -- the machine: TAP devices, the nft table ---------------------------------------------------------------------

tap_address() { # tap_address N: the host's side of slot N's /30 (the launcher's slots.py derives the same)
  first=$(( $1 * 4 + 1 ))
  printf '172.31.%s.%s' $(( first / 256 )) $(( first % 256 ))
}

slots() { # the number of slots of this machine
  count="$(sed -n 's/^FACTORY_RUNNER_PARALLEL_RUNS=//p' "$CONF/runner.env" 2>/dev/null | head -n 1)"
  if is_uint "$count" && [ "$count" -ge 1 ]; then printf '%s' "$count"; else printf '1'; fi
}

ensure_taps() {
  total="$(slots)"
  n=0
  while [ "$n" -lt "$total" ]; do
    tap="fctap$n"
    if ! ip link show "$tap" >/dev/null 2>&1; then
      ip tuntap add dev "$tap" mode tap user "$SVC_USER" group "$SVC_USER" || fail "the TAP device $tap could not be made"
    fi
    ip addr replace "$(tap_address "$n")/30" dev "$tap"
    ip link set "$tap" up
    n=$(( n + 1 ))
  done
  # A smaller number of slots than before: the devices above it are ours to remove.
  made="$(state_value taps)"
  if is_uint "$made"; then
    while [ "$n" -lt "$made" ]; do
      ip link delete "fctap$n" >/dev/null 2>&1 || true
      n=$(( n + 1 ))
    done
  fi
  set_state taps "$total"
}

# Loads the table and proves it with a second command. The service cannot read nft state, so this is the only check.
load_wall() {
  table="$OPT/current/share/outer-wall.nft"
  [ -f "$table" ] || fail "the program has no nft table to load"
  nft -f "$table" || fail "the nft table could not be loaded"
  verify_wall
}

verify_wall() {
  nft list table inet "$WALL_TABLE" >/dev/null 2>&1 \
    || fail "the nft table $WALL_TABLE is not loaded (nft list table inet $WALL_TABLE failed): the outer wall of the VMs is missing, so the service does not start"
}

# -- the units, the command, the settings --------------------------------------------------------------------------

write_runner_env() {
  total="$1"
  {
    echo "# Written by the installer of the Factory-Runner. Settings, no secret; the credential is in $HOME_PATH."
    echo "FACTORY_RUNNER_HOME=$HOME_PATH"
    echo "FACTORY_RUNNER_VM_STATE_DIR=$STATE_PATH"
    echo "FACTORY_RUNNER_FIRECRACKER=$OPT_PATH/current/bin/firecracker"
    echo "FACTORY_RUNNER_PARALLEL_RUNS=$total"
    echo "FACTORY_RUNNER_PENDING_FILE=$STATE_PATH/pending"
  } | write_file "$CONF/runner.env" 0644
}

write_units() {
  total="$1"
  nofile=$(( 8192 + total * 64 ))
  tasks=$(( total * 300 + 256 ))
  # `FACTORY_RUNNER_OUTER_WALL=proxy` is here because the table was loaded and listed again: this function is only
  # called after `verify_wall`. The service's own start checks it again (`prestart`).
  write_file "$UNIT_DIR/$SERVICE.service" 0644 <<EOF
[Unit]
Description=Factory-Runner (Code Reviewer): the local Dispatcher
Documentation=https://github.com/Itegro-GmbH/code-reviewer/blob/main/docs/runner.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
SupplementaryGroups=$KVM_GROUP
# The service's cgroup subtree is its own: one cgroup per VM (cpu, memory, pids), made without root.
Delegate=yes
EnvironmentFile=$CONF_PATH/runner.env
Environment=FACTORY_RUNNER_SANDBOX=firecracker
Environment=FACTORY_RUNNER_OUTER_WALL=proxy
# As root (the +): switches to a staged release, makes the TAP devices that are missing (after a restart of the machine),
# loads the nft table and fails the start unless 'nft list table inet $WALL_TABLE' answers.
ExecStartPre=+$OPT_PATH/current/libexec/host.sh prestart
ExecStart=$OPT_PATH/current/libexec/host.sh run-service
# 10: it ended between two jobs because a release is staged; the start above switches to it. 4 (revoked), 6
# (configuration) and 9 (another dispatcher holds the lock of this machine) are not made better by a restart.
Restart=always
RestartSec=10
RestartPreventExitStatus=4 6 9
# A VM is killed at once on a stop and its claim given back: nothing waits for a job.
TimeoutStopSec=60
# Sockets of 8192 plus 64 per slot: the proxy's 256 connections (two descriptors each), 2 listeners of 4 connections per
# VM, the VMs' files and the app's connections, with room. Tasks: Firecracker's threads of every VM (pids.max 256 each).
LimitNOFILE=$nofile
TasksMax=$tasks
# What the service may touch. The VM artifacts and the program are root's and read-only for it; it owns vms/, its lock and
# its configuration.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$STATE_PATH/vms $STATE_PATH/dispatcher.lock $HOME_PATH
ProtectHome=yes
PrivateTmp=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
# Only the devices a VM needs: KVM, and /dev/net/tun to attach to the TAP device it owns.
DevicePolicy=closed
DeviceAllow=/dev/kvm rw
DeviceAllow=/dev/net/tun rw
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  write_file "$UNIT_DIR/$SERVICE-update.service" 0644 <<EOF
[Unit]
Description=Factory-Runner (Code Reviewer): look for a signed update
Documentation=https://github.com/Itegro-GmbH/code-reviewer/blob/main/docs/runner.md
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Stages the newest signed release (a download, its signature and digests checked). It switches nothing: the service ends
# between two jobs when one is staged and the start switches to it. Never started by the app.
ExecStart=$OPT_PATH/current/libexec/host.sh update --scheduled
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
EOF
  write_file "$UNIT_DIR/$SERVICE-update.timer" 0644 <<EOF
[Unit]
Description=Factory-Runner (Code Reviewer): look for a signed update every six hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
EOF
}

# The command: update, rollback, status and uninstall are root's (this script); everything else is the service user's.
write_command() {
  write_file "$COMMAND" 0755 <<'EOF'
#!/bin/sh
# The command of the Factory-Runner. Written by install.sh.
R="${FACTORY_RUNNER_ROOT:-}"
current="$R/opt/code-reviewer/current"
[ -x "$current/bin/factory-runner" ] || { echo "factory-runner: not installed (no program release is current)" >&2; exit 1; }
case "${1:-}" in
  update|rollback|status|uninstall) exec sh "$current/libexec/host.sh" "$@" ;;
esac
set -a
# shellcheck disable=SC1091
. "$R/etc/code-reviewer/runner.env"
set +a
user=factory-runner
if [ "$(id -u)" = 0 ]; then
  exec runuser -u "$user" -- "$current/bin/factory-runner" "$@"
fi
if [ "$(id -un)" = "$user" ]; then
  exec "$current/bin/factory-runner" "$@"
fi
echo "factory-runner: run it with sudo (the configuration and the credential belong to the user $user)" >&2
exit 1
EOF
}

# -- registration ------------------------------------------------------------------------------------------------

service_cli() { # service_cli ARGS...: the command as the service user, with the settings of the machine
  (
    set -a
    # shellcheck disable=SC1091
    . "$CONF/runner.env"
    set +a
    FACTORY_RUNNER_HOME="$HOME_PATH"
    FACTORY_RUNNER_SANDBOX=firecracker
    export FACTORY_RUNNER_HOME FACTORY_RUNNER_SANDBOX
    as_service_user "$OPT/current/bin/factory-runner" "$@"
  )
}

is_registered() {
  service_cli credential show </dev/null 2>/dev/null | grep -q '^credential: set'
}

# A terminal to ask on. `[ -r /dev/tty ]` is true without one (the file exists); only opening it tells.
have_tty() { (exec </dev/tty) 2>/dev/null; }

read_token() { # prints the token, or nothing
  if [ -n "$TOKEN_FILE" ]; then
    if [ "$TOKEN_FILE" = "-" ]; then cat; else cat "$TOKEN_FILE"; fi
  elif [ -n "${FACTORY_RUNNER_TOKEN:-}" ]; then
    warn "warning: the token came from FACTORY_RUNNER_TOKEN: it is in your shell history, in the log of sudo and was in the process list. Prefer the prompt or --token-file."
    printf '%s' "$FACTORY_RUNNER_TOKEN"
  fi
}

# Asked on the terminal, without echo; sets TOKEN_TYPED. Not in a command substitution: the signal traps must belong to
# the shell that gets the signal. dash runs no EXIT trap on a signal, so Ctrl-C at the prompt would leave the terminal
# without echo; `exit` in the trap does run the EXIT trap (the temporary files go).
ask_for_token() {
  printf 'Registration token (from the app: Runners, "Add a runner"; input is hidden): ' >/dev/tty
  trap 'stty echo </dev/tty 2>/dev/null || true; printf "\n" >/dev/tty 2>/dev/null || true; exit 130' INT
  trap 'stty echo </dev/tty 2>/dev/null || true; printf "\n" >/dev/tty 2>/dev/null || true; exit 143' TERM
  trap 'stty echo </dev/tty 2>/dev/null || true; printf "\n" >/dev/tty 2>/dev/null || true; exit 131' QUIT
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r TOKEN_TYPED </dev/tty || TOKEN_TYPED=""
  stty echo </dev/tty 2>/dev/null || true
  trap - INT TERM QUIT
  printf '\n' >/dev/tty
}

register_or_configure() {
  # The settings as arguments, one word each (a name may hold a space).
  set --
  if [ -n "$RUNNER_NAME" ]; then set -- "$@" --name "$RUNNER_NAME"; fi
  if [ -n "$RUNNER_LABELS" ]; then set -- "$@" --labels "$RUNNER_LABELS"; fi
  if [ -n "$RUNNER_CPUS" ]; then set -- "$@" --cpus "$RUNNER_CPUS"; fi
  if [ -n "$RUNNER_MEMORY" ]; then set -- "$@" --memory-mb "$RUNNER_MEMORY"; fi
  if [ -n "$RUNNER_DISK" ]; then set -- "$@" --disk-gb "$RUNNER_DISK"; fi
  if is_registered; then
    say "this machine is registered already: the token (if any) is not used"
    if [ $# -gt 0 ]; then
      service_cli config set "$@" </dev/null
      say "the settings are saved; the running service reads them when it starts"
    fi
    return 0
  fi
  # The file and the variable are read in a subshell; the prompt is not (see `ask_for_token`).
  token="$(read_token || true)"
  if [ -z "$token" ] && [ -z "$TOKEN_FILE" ] && [ -z "${FACTORY_RUNNER_TOKEN:-}" ] && have_tty; then
    ask_for_token
    token="$TOKEN_TYPED"
  fi
  if [ -z "$token" ]; then
    say "no registration token: the service is installed but not started."
    say "register it with a file that holds the token, then start it:"
    say "  sudo factory-runner register --token-file - < /path/to/token-file  &&  sudo systemctl enable --now $SERVICE"
    say "(add --name, --labels, --disk-gb ... as above)"
    NO_TOKEN=1
    return 0
  fi
  if ! printf '%s' "$token" | grep -Eq '^crt_[A-Za-z0-9_-]{43}$'; then
    warn "the registration token does not have the form of a token (crt_...)"
    return 1
  fi
  if [ -n "$RUNNER_URL" ]; then set -- "$@" --url "$RUNNER_URL"; fi
  # The token goes in on the standard input: no argument, no environment.
  printf '%s' "$token" | service_cli register --token-file - "$@"
}

# -- install -------------------------------------------------------------------------------------------------------

ensure_user() {
  if user_exists; then
    return 0
  fi
  shell="$(command -v nologin 2>/dev/null || echo /usr/sbin/nologin)"
  useradd --system --user-group --home-dir "$HOME_PATH" --no-create-home --shell "$shell" \
    --groups "$KVM_GROUP" --comment "Factory-Runner (Code Reviewer)" "$SVC_USER" || fail "the user $SVC_USER could not be made"
  set_state user_created 1
}

ensure_directories() {
  mkdir -p "$OPT" "$STATE" "$CONF" "$HOME_DIR" "$STATE/vms"
  chmod 0755 "$OPT" "$STATE" "$CONF"
  root_owned "$OPT" "$STATE" "$CONF"
  # The service's own: the credential and the configuration, the VMs' directories, the lock it takes.
  chmod 0700 "$HOME_DIR" "$STATE/vms"
  chown "$SVC_USER:$SVC_USER" "$HOME_DIR" "$STATE/vms"
  [ -e "$STATE/dispatcher.lock" ] || : >"$STATE/dispatcher.lock"
  chmod 0600 "$STATE/dispatcher.lock"
  chown "$SVC_USER:$SVC_USER" "$STATE/dispatcher.lock"
  if [ -n "$CURL_CONFIG" ]; then
    cp "$CURL_CONFIG" "$CONF/download.curlrc"
    chmod 0600 "$CONF/download.curlrc"
    root_owned "$CONF/download.curlrc"
  fi
}

# The service user must be able to open /dev/kvm: the proof is a try, as that user.
check_kvm_access() {
  # shellcheck disable=SC2016 # the quotes are for the shell of the service user
  as_service_user sh -c 'test -r "$1" && test -w "$1"' sh "$KVM" </dev/null 2>/dev/null \
    || fail "the user $SVC_USER cannot open /dev/kvm (the device belongs to a group other than $KVM_GROUP, or its mode does not allow the group): fix the udev rule (KERNEL==\"kvm\", GROUP=\"kvm\", MODE=\"0660\") and run the installer again"
}

dry_run_plan() {
  say "dry run: nothing is changed. The install would:"
  say "  - make the user $SVC_USER (a member of $KVM_GROUP), $OPT_PATH, $STATE_PATH, $CONF_PATH and $HOME_PATH"
  say "  - download and verify the program and the VM artifacts (signed manifests, sha256 of every file) into root-owned, read-only directories"
  say "  - make ${PARALLEL:-1} TAP device(s) fctap0... owned by $SVC_USER, load and verify the nft table $WALL_TABLE"
  say "  - write $UNIT_DIR_PATH/$SERVICE.service, $SERVICE-update.service and .timer, and $COMMAND_PATH"
  say "  - register the machine with a token and start the service"
  say "install: done"
}

do_install() {
  if [ -z "$PARALLEL" ] && [ "$REFRESH" = 1 ]; then PARALLEL="$(slots)"; fi
  preflight
  make_tmpdir
  WORK="$TMPDIR_MADE"
  if [ "$DRY_RUN" = 1 ]; then
    dry_run_plan
    return 0
  fi
  # The two manifests are fetched and proven, and the space is counted, before the first change.
  if ! fetch_manifest program; then no_release_yet program; fi
  if ! fetch_manifest vm; then no_release_yet vm; fi
  check_space
  if [ "$REFRESH" != 1 ]; then FRESH=1; fi
  set_state version 1
  ensure_user
  check_kvm_access
  ensure_directories
  for comp in program vm; do
    cp "$(channel_file_of "$comp")" "$CONF/channel-$comp.json"
    chmod 0644 "$CONF/channel-$comp.json"
    root_owned "$CONF/channel-$comp.json"
  done
  total="${PARALLEL:-1}"
  write_runner_env "$total"
  STAGED_ANY=0
  update_component program
  update_component vm
  rm -rf "$STATE/staging"
  running=0
  if [ "$REFRESH" = 1 ] && systemctl is-active --quiet "$SERVICE" </dev/null 2>/dev/null; then running=1; fi
  if [ "$running" = 0 ]; then
    apply_pending
  fi
  if [ ! -L "$OPT/current" ] || [ ! -L "$STATE/artifacts" ]; then fail "no release is installed (the channels announced none that could be taken)"; fi
  ensure_taps
  load_wall
  write_units "$total"
  write_command
  # The machine is installed: what follows (the token) never removes it.
  FRESH=0
  systemctl daemon-reload </dev/null
  systemctl enable "$SERVICE-update.timer" >/dev/null 2>&1 </dev/null || true
  systemctl start "$SERVICE-update.timer" >/dev/null 2>&1 </dev/null || true
  registered=1
  if ! register_or_configure; then
    registered=0
    NO_TOKEN=1
    warn "the machine is installed, but the registration did not succeed: register it with 'sudo factory-runner register --token-file - < FILE'"
  fi
  if [ "$NO_TOKEN" = 1 ]; then
    systemctl enable "$SERVICE" >/dev/null 2>&1 </dev/null || true
  elif [ "$running" = 1 ]; then
    say "the service runs: it is not restarted (it switches to a staged release between two jobs, and reads a changed setting when it next starts)"
  else
    systemctl enable "$SERVICE" >/dev/null 2>&1 </dev/null
    systemctl start "$SERVICE" </dev/null
    say "the service is started: journalctl -u $SERVICE -f"
  fi
  say "Next: sudo factory-runner status"
  if [ "$registered" = 0 ]; then exit 1; fi
  say "install: done"
}

channel_file_of() { # the file a channel was read from, for the copy kept for updates
  case "$1" in
    program) if [ -n "$PROGRAM_CHANNEL_FILE" ]; then printf '%s' "$PROGRAM_CHANNEL_FILE"; else printf '%s' "$WORK/channel-program.json"; fi ;;
    vm) if [ -n "$VM_CHANNEL_FILE" ]; then printf '%s' "$VM_CHANNEL_FILE"; else printf '%s' "$WORK/channel-vm.json"; fi ;;
  esac
}

no_release_yet() { # no_release_yet program|vm
  fail "no $1 release is published yet: its release channel is empty until the owner fills it. Nothing was changed."
}

# -- update, rollback, status ---------------------------------------------------------------------------------------

require_root() { [ "$(id -u)" = 0 ] || fail "run as root: sudo factory-runner $CMD"; }

require_installed() { [ -f "$CONF/install.state" ] || fail "the runner is not installed on this machine"; }

# Whether the scheduled run may look: `factory-runner config set --auto-update off` stops it (an update by hand still works).
auto_update_allowed() {
  config="$HOME_DIR/config.json"
  [ -f "$config" ] || return 0
  [ "$(jq -r 'if .autoUpdate == false then "off" else "on" end' "$config" 2>/dev/null || echo on)" = on ]
}

do_update() {
  require_root
  require_installed
  if [ "$SCHEDULED" = 1 ] && ! auto_update_allowed; then
    say "automatic updates are off (factory-runner config set --auto-update on): nothing was looked for"
    return 0
  fi
  make_tmpdir
  WORK="$TMPDIR_MADE"
  mkdir -p "$STATE"
  exec 9>"$STATE/update.lock"
  flock -n 9 || fail "another update is running"
  rm -rf "$STATE/staging"
  STAGED_ANY=0
  update_component program
  update_component vm
  rm -rf "$STATE/staging"
  if [ "$STAGED_ANY" = 1 ]; then
    say "the service switches to it between two jobs (it ends, and the start switches); 'systemctl restart $SERVICE' switches now and gives a running job back to the queue"
  fi
  say "update: done"
}

do_rollback() {
  require_root
  require_installed
  lock_switch
  program_waiting="$(pending_release program)"
  vm_waiting="$(pending_release vm)"
  if [ -n "$program_waiting" ] || [ -n "$vm_waiting" ]; then
    # A staged release that was not taken yet: going back is not taking it.
    if [ -n "$program_waiting" ]; then
      reject_release program "$program_waiting"
      drop_pending program
      say "the staged program release $program_waiting is cancelled and will not be taken again"
    fi
    if [ -n "$vm_waiting" ]; then
      reject_release vm "$vm_waiting"
      drop_pending vm
      say "the staged VM artifacts release $vm_waiting is cancelled and will not be taken again"
    fi
    prune_releases "$OPT/releases"
    prune_releases "$STATE/artifact-releases"
    say "rollback: done"
    return 0
  fi
  went=0
  for comp in program vm; do
    case "$comp" in
      program) previous="$(link_release "$OPT/previous")"; current="$(link_release "$OPT/current")" ;;
      vm) previous="$(link_release "$STATE/artifacts-previous")"; current="$(link_release "$STATE/artifacts")" ;;
    esac
    if [ -z "$previous" ] || [ -z "$current" ] || [ "$previous" = "$current" ]; then continue; fi
    reject_release "$comp" "$current"
    write_pending "$comp" "$previous"
    say "the $comp goes back from release $current to release $previous (release $current is not taken again, nor any below it)"
    went=1
  done
  [ "$went" = 1 ] || fail "there is no earlier release to go back to"
  if [ "$NOW" = 1 ]; then
    systemctl restart "$SERVICE" </dev/null
    say "the service is restarted"
  else
    say "the service goes back between two jobs; 'sudo factory-runner rollback --now' restarts it at once and gives a running job back to the queue"
  fi
  say "rollback: done"
}

do_status() {
  require_installed
  for comp in program vm; do
    case "$comp" in
      program) previous="$(link_release "$OPT/previous")" ;;
      vm) previous="$(link_release "$STATE/artifacts-previous")" ;;
    esac
    say "$comp: current $(installed_release "$comp"), previous ${previous:-none}, staged $(pending_release "$comp" | grep . || echo none), rejected up to $(rejected_release "$comp")"
  done
  say "slots: $(slots), state: $STATE_PATH"
}

# -- what the unit runs ---------------------------------------------------------------------------------------------

# As root, before every start of the service: switch to a staged release, make the TAP devices a restart of the machine took,
# load the table and prove it. A service must never run without its outer wall.
do_prestart() {
  require_root
  require_installed
  apply_pending
  ensure_taps
  load_wall
  chown "$SVC_USER:$SVC_USER" "$STATE/vms" "$STATE/dispatcher.lock" 2>/dev/null || true
}

do_run_service() {
  dir="$(readlink -f "$OPT/current")"
  vm_env="$STATE/artifacts/vm.env"
  [ -r "$vm_env" ] || { warn "no VM artifacts are installed ($vm_env is missing)"; exit 6; }
  set -a
  # shellcheck disable=SC1090
  . "$vm_env"
  set +a
  FACTORY_RUNNER_RELEASE="${dir##*/}"
  export FACTORY_RUNNER_RELEASE
  exec "$dir/bin/factory-runner" run
}

# -- uninstall -------------------------------------------------------------------------------------------------------

remove_tree() { # remove_tree DIR: the contents and the directory, unless it is a mount point (then the contents only)
  [ -e "$1" ] || [ -L "$1" ] || return 0
  find "$1" -mindepth 1 -xdev -delete 2>/dev/null || rm -rf --one-file-system "$1"
  rmdir "$1" 2>/dev/null || true
}

remove_everything() {
  [ -f "$CONF/install.state" ] || [ -e "$OPT" ] || [ -e "$STATE" ] || return 0
  made_user="$(state_value user_created)"
  total="$(state_value taps)"
  systemctl disable --now "$SERVICE-update.timer" </dev/null >/dev/null 2>&1 || true
  systemctl disable --now "$SERVICE" </dev/null >/dev/null 2>&1 || true
  nft delete table inet "$WALL_TABLE" >/dev/null 2>&1 || true
  if is_uint "$total"; then
    n=0
    while [ "$n" -lt "$total" ]; do
      ip link delete "fctap$n" >/dev/null 2>&1 || true
      n=$(( n + 1 ))
    done
  fi
  rm -f "$UNIT_DIR/$SERVICE.service" "$UNIT_DIR/$SERVICE-update.service" "$UNIT_DIR/$SERVICE-update.timer" "$COMMAND"
  systemctl daemon-reload </dev/null >/dev/null 2>&1 || true
  systemctl reset-failed "$SERVICE" "$SERVICE-update.service" </dev/null >/dev/null 2>&1 || true
  remove_tree "$OPT"
  remove_tree "$STATE"
  remove_tree "$HOME_DIR"
  remove_tree "$CONF"
  if [ "$made_user" = 1 ]; then
    userdel "$SVC_USER" >/dev/null 2>&1 || true
  fi
}

do_uninstall() {
  require_root
  if [ ! -f "$CONF/install.state" ] && [ ! -e "$OPT" ] && [ ! -e "$STATE" ]; then
    say "the runner is not installed on this machine: nothing to remove"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "would remove: the service and its update timer, the nft table $WALL_TABLE, the TAP devices fctap0..$(( $(state_value taps) - 1 )), the user $SVC_USER (only if the installer made it),"
    say "  $OPT_PATH, $STATE_PATH (the VM artifacts), $HOME_PATH (the configuration and the credential), $CONF_PATH, the units and $COMMAND_PATH"
    return 0
  fi
  say "removing the service, the nft table, the TAP devices, the user, the units and the files of the runner"
  remove_everything
  say "revoke this runner in the app (Runners) so that its credential stops working"
  say "install: done"
}

# -- main ----------------------------------------------------------------------------------------------------------------

main() {
  parse_args "$@"
  case "$CMD" in
    install) do_install ;;
    update) do_update ;;
    rollback) do_rollback ;;
    status) do_status ;;
    uninstall) do_uninstall ;;
    switch) require_root; require_installed; apply_pending ;;
    prestart) do_prestart ;;
    run-service) do_run_service ;;
  esac
}

# In braces: a download cut off anywhere in this line is a syntax error, so nothing runs, not even `main` without its arguments.
{ main "$@"; }
