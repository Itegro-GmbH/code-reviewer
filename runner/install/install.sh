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
#   1. preflight: Linux, x86_64, root, systemd, cgroup v2, /dev/kvm, /dev/net/tun, nft, tools, no other install, nothing
#      of ours in the way (the directories, the units, the command), the network of the slots (the first candidate that
#      overlaps no address and no route of this machine), free space;
#   2. the two release channels (runner/release-channel.json and docker/vm/release-channel.json, or the files you
#      name): the program and the VM artifacts, each a signed manifest that is verified with `openssl`; the program is
#      downloaded, verified and unpacked, and its nft table is checked on this kernel (`nft -c`). The program names the
#      VM artifacts release it needs (`share/release.json`, `vmArtifacts`, an exact number, signed with the program): that
#      release is the one that is installed with it, not the newest one, and a program whose VM release is not there or does
#      not verify is not taken;
#   3. the service user (a member of `kvm`), the directories, the VM artifacts downloaded by their digest and verified
#      (the artifacts are owned by root and read-only for the service), the TAP devices of `--parallel-runs` slots
#      owned by the user, the static nft table rendered for the slots' network, loaded AND listed again, the units;
#   4. registers the machine with the token and starts the service.
# The service runs `FACTORY_RUNNER_SANDBOX=firecracker`; `FACTORY_RUNNER_OUTER_WALL=proxy` is in its unit only because
# `nft list table inet code_reviewer_wall` succeeded, and the service checks it again before every start.
#
# The installed copy of this script is the one inside the program release (`libexec/host.sh`): `factory-runner update`,
# `rollback` and `uninstall` and the units run it, so an update of the program also updates the updater, and all of it
# is signed. Commands (the installed one is `/usr/local/bin/factory-runner update|rollback|status|uninstall`):
#   install (the default)  --refresh runs it again over an install that exists (nothing is restarted)
#   update [--scheduled]   stage the newest signed program with the VM artifacts release it names; the service switches to
#                          it between two jobs (VM artifacts alone are never taken: only a program that names them brings them)
#   rollback [--now]       go back to the release before, or cancel a staged one; the release left is never taken again
#   status                 the releases that are current, previous and waiting
#   uninstall              remove everything this installer made, and nothing else
#   prestart | run-service | switch | check-wall   what the units run
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
# Nothing a release names is bigger than this when it is unpacked, whatever its manifest says (a hard limit for the process
# that writes it, see `capped`).
MAX_UNPACKED=34359738368
MAX_PROGRAM_FILE=1073741824
MIN_SYSTEMD=247
# The network of the slots (a /24 holds 64 slots of 4 addresses): the first of these that overlaps no address and no route of the
# machine. Ranges that cloud networks and VPNs rarely use, never 100.64.0.0/10 (Tailscale) and never 172.16.0.0/12 (Docker's pools, the
# default VPC of AWS is 172.31.0.0/16).
SLOT_CANDIDATES="10.250.0.0 10.251.0.0 10.252.0.0 10.253.0.0 10.254.0.0 10.255.0.0 10.240.0.0 10.241.0.0 10.242.0.0 10.243.0.0 10.244.0.0 10.245.0.0 10.246.0.0 10.247.0.0 10.248.0.0 10.249.0.0 192.168.250.0 192.168.251.0 192.168.252.0 192.168.253.0 192.168.254.0"

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
SLOT_NETWORK_GIVEN=""

# -- bookkeeping -----------------------------------------------------------------------------------------------
TMPDIRS=""
WORK=""
# The directories this run staged downloads in (removed when the script ends, however it ends).
STAGING_ROOTS=""
# Set once an install changed the machine for the first time; a failure after that removes what was made.
FRESH=0
UNDOING=0
NO_TOKEN=0
SWITCH_LOCKED=0
# The network of the slots (a /24): chosen by the preflight of a new install, read from the state afterwards.
SLOT_NETWORK=""
# Where this run stages the program (the work directory of an install, so that nothing but the work directory is
# touched before the checks have passed; the directory of the releases for an update) and the VM artifacts.
PROGRAM_STAGE_BASE=""
VM_STAGE_BASE=""
PROGRAM_RELEASE=""
PROGRAM_BASE_URL=""
VM_RELEASE=""
VM_BASE_URL=""
# The VM artifacts release the staged program names (the pair), and the one of it that has to be fetched (empty: the one installed or
# staged already is it).
PAIR_NEED=""
VM_WANTED=""
# The directories of what was staged and verified, waiting to be moved into place.
STAGED_program=""
STAGED_vm=""
STAGED_ANY=0

cleanup() {
  unset IFS
  # shellcheck disable=SC2086 # the paths hold no space
  for dir in $STAGING_ROOTS $TMPDIRS; do
    rm -rf -- "$dir"
  done
}
trap cleanup EXIT

# A signal ends the script like a failure does: what an install made is removed, the work directory goes (`exit` runs the EXIT trap;
# dash runs none on a signal itself).
# shellcheck disable=SC2317 # run by the traps below
on_signal() { # on_signal STATUS
  trap '' INT HUP TERM
  printf 'install: interrupted\n' >&2
  if [ "$FRESH" = 1 ] && [ "$UNDOING" = 0 ]; then
    UNDOING=1
    warn "removing what this install made, so that nothing is left behind"
    remove_everything >/dev/null 2>&1 || warn "the removal did not finish: run this script with --uninstall"
  fi
  exit "$1"
}
set_signal_traps() {
  trap 'on_signal 130' INT
  trap 'on_signal 129' HUP
  trap 'on_signal 143' TERM
}
set_signal_traps

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

# A staging directory of this run: removed when the script ends.
make_stage_root() { # make_stage_root DIR
  rm -rf "$1"
  mkdir -p "$1"
  STAGING_ROOTS="$STAGING_ROOTS $1"
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
                           kept for updates in a file only root can read; a new one replaces the kept one. While one is in
                           use a redirect is followed only within the same host (the headers are never sent anywhere else)
  --slot-network CIDR      the network of the VMs' TAP devices, a /24 inside 10/8 or 192.168/16 (default: the first free one of
                           a list, 10.250.0.0/24 first); it must overlap no address and no route of the machine
  --refresh                run the install again over one that exists (never restarts a running service)
  --now                    rollback: restart the service at once instead of waiting for it to be between two jobs
  --dry-run                say what would be done, change nothing
  --uninstall              remove everything this installer made, and nothing else
EOF
}

parse_args() {
  if [ $# -gt 0 ]; then
    case "$1" in
      install|update|rollback|status|uninstall|switch|prestart|run-service|check-wall) CMD="$1"; shift ;;
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
      --slot-network) [ $# -ge 2 ] || fail "--slot-network needs a network"; SLOT_NETWORK_GIVEN="$2"; shift 2 ;;
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
    if ! is_uint "$PARALLEL" || [ "$PARALLEL" -lt 1 ] || [ "$PARALLEL" -gt 64 ]; then
      fail "--parallel-runs is a whole number from 1 to 64"
    fi
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

# What a process may write: a limit (`ulimit -S -f`, 512-byte blocks) on top of the size the manifest names, so a server that sends
# more than it said (no Content-Length, an endless body, a compression bomb) cannot fill the disk. `curl --max-filesize` alone trusts a
# header. The process dies of SIGXFSZ at the limit.
capped() { # capped BYTES COMMAND...
  limit="$1"
  shift
  # shellcheck disable=SC3045 # dash, bash and busybox all take -S: a limit the process cannot raise (curl, zstd and tar do not try)
  ( ulimit -S -f $(( limit / 512 + 2 )) || exit 1; "$@" )
}

# A download from an https address only: no other scheme, and no redirect to one, at most MAXBYTES (as a hard limit, see `capped`). A
# login for a protected release address is a curl configuration that only root can read (`--curl-config`; a new one wins over the kept
# one). Custom headers of such a configuration would be sent to wherever a redirect points, so with one in use a redirect is followed
# only within the same host (`fetch_same_host`); without one, redirects (a release asset on a CDN) are followed.
fetch() { # fetch URL FILE MAXBYTES
  config=""
  if [ -n "$CURL_CONFIG" ]; then
    config="$CURL_CONFIG"
  elif [ -r "$CONF/download.curlrc" ]; then
    config="$CONF/download.curlrc"
  fi
  if [ -z "$config" ]; then
    capped "$3" curl --proto '=https' --proto-redir '=https' -fsSL --max-filesize "$3" -o "$2" "$1"
  else
    capped "$3" fetch_same_host "$config" "$1" "$2" "$3"
  fi
}

# shellcheck disable=SC2317 # run by `capped`, which only sees its name
fetch_same_host() { # fetch_same_host CONFIG URL FILE MAXBYTES
  url="$2"
  origin="${url#https://}"
  origin="${origin%%/*}"
  headers="$3.headers"
  hops=0
  while :; do
    code="$(curl -K "$1" --proto '=https' -sS --max-filesize "$4" -o "$3" -D "$headers" -w '%{http_code}' "$url")" || return 1
    case "$code" in
      200) rm -f "$headers"; return 0 ;;
      301|302|303|307|308)
        hops=$(( hops + 1 ))
        [ "$hops" -le 5 ] || return 1
        location="$(sed -n 's/^[Ll]ocation: *//p' "$headers" | tail -n 1 | tr -d '\r')"
        rm -f "$headers" "$3"
        case "$location" in
          https://"$origin"/*) url="$location" ;;
          /*) url="https://$origin$location" ;;
          *) warn "a redirect to another host is not followed while a curl configuration is in use (its headers would be sent there)"; return 1 ;;
        esac ;;
      *) rm -f "$headers"; return 1 ;;
    esac
  done
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

# -- the network of the slots -----------------------------------------------------------------------------------

ip_to_int() { # ip_to_int A.B.C.D
  IFS=. read -r o1 o2 o3 o4 <<EOF
$1
EOF
  unset IFS
  printf '%s' $(( o1 * 16777216 + o2 * 65536 + o3 * 256 + o4 ))
}

int_to_ip() { # int_to_ip N
  printf '%s.%s.%s.%s' $(( ($1 >> 24) & 255 )) $(( ($1 >> 16) & 255 )) $(( ($1 >> 8) & 255 )) $(( $1 & 255 ))
}

# Whether two networks share an address: they do when they agree on the bits of the shorter prefix.
networks_overlap() { # networks_overlap A_INT A_PREFIX B_INT B_PREFIX
  shortest="$2"
  [ "$4" -lt "$shortest" ] && shortest="$4"
  bits=$(( 32 - shortest ))
  [ $(( $1 >> bits )) -eq $(( $3 >> bits )) ]
}

# Every network this machine has an address in or a route to, one `A.B.C.D/P` per line (a host address is a /32; the default route
# overlaps everything and says nothing). `ip` answers for every routing table, so a VPN's or a Docker network's routes are in.
used_networks() {
  { ip -4 -o addr show 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "inet") print $(i + 1)}'
    ip -4 route show table all 2>/dev/null | awk '$1 == "default" { next }
      { d = $1; if (d ~ /^(local|broadcast|unreachable|blackhole|prohibit|throw|anycast|multicast|unicast)$/) d = $2
        if (d ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?$/ && d != "0.0.0.0/0") print d }'
  } | sort -u
}

# Whether the /24 at A.B.C.0 overlaps nothing the machine has.
network_is_free() { # network_is_free A.B.C.0
  wanted_int="$(ip_to_int "$1")"
  while IFS= read -r used; do
    [ -n "$used" ] || continue
    case "$used" in
      */*) used_address="${used%/*}"; used_prefix="${used#*/}" ;;
      *) used_address="$used"; used_prefix=32 ;;
    esac
    is_uint "$used_prefix" || continue
    if networks_overlap "$wanted_int" 24 "$(ip_to_int "$used_address")" "$used_prefix"; then
      return 1
    fi
  done <<EOF
$(used_networks)
EOF
  return 0
}

# A network the operator named: a /24 of 10/8 or 192.168/16 with no host bits.
check_given_network() { # check_given_network A.B.C.0/24
  usage_hint="--slot-network is a /24 inside 10.0.0.0/8 or 192.168.0.0/16, such as 10.250.0.0/24"
  case "$1" in
    10.*.*.0/24|192.168.*.0/24) ;;
    *) fail "$usage_hint" ;;
  esac
  IFS=. read -r a b c _ <<EOF
${1%/24}
EOF
  unset IFS
  for each in "$a" "$b" "$c"; do
    { is_uint "$each" && [ "$each" -le 255 ]; } || fail "$usage_hint"
  done
}

# Chooses the network of the slots of a new install, or keeps the one an install made: SLOT_NETWORK, `A.B.C.0/24`. Refuses when every
# candidate (or the network named) overlaps an address or a route of the machine: the VMs would be unreachable from the host, or a
# network of the host's unreachable from it.
choose_slot_network() {
  kept="$(state_value slot_network)"
  if [ -n "$kept" ]; then
    SLOT_NETWORK="$kept"
    return 0
  fi
  if [ -n "$SLOT_NETWORK_GIVEN" ]; then
    check_given_network "$SLOT_NETWORK_GIVEN"
    network_is_free "${SLOT_NETWORK_GIVEN%/24}" || fail "the network $SLOT_NETWORK_GIVEN overlaps an address or a route of this machine (see 'ip route show table all'; nothing was changed)"
    SLOT_NETWORK="$SLOT_NETWORK_GIVEN"
    return 0
  fi
  for candidate in $SLOT_CANDIDATES; do
    if network_is_free "$candidate"; then
      SLOT_NETWORK="$candidate/24"
      return 0
    fi
  done
  fail "no network is free for the VMs: every candidate ($SLOT_CANDIDATES, each a /24) overlaps an address or a route of this machine. Name another with --slot-network, a /24 inside 10.0.0.0/8 or 192.168.0.0/16 that nothing else uses (nothing was changed)"
}

slot_network() { # the network of the slots: chosen by this run, or kept by the install
  if [ -n "$SLOT_NETWORK" ]; then printf '%s' "$SLOT_NETWORK"; else state_value slot_network; fi
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
  if [ ! -r "$KVM" ] || [ ! -w "$KVM" ]; then
    fail "/dev/kvm cannot be opened by root: check its permissions (nothing was changed)"
  fi
  if [ "$(stat -c %G "$KVM" 2>/dev/null || echo "$KVM_GROUP")" != "$KVM_GROUP" ]; then
    warn "warning: /dev/kvm does not belong to the group $KVM_GROUP: the service user is added to it and may still not be able to open the device (the check after the user is made says)"
  fi
  getent group "$KVM_GROUP" >/dev/null 2>&1 || fail "the group $KVM_GROUP does not exist: /dev/kvm is opened through it (a udev rule: KERNEL==\"kvm\", GROUP=\"kvm\", MODE=\"0660\")"

  [ -e "$ROOT/dev/net/tun" ] || fail "/dev/net/tun is missing: the TAP devices of the VMs need it (modprobe tun; nothing was changed)"

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
    for unit in "$SERVICE-update.service" "$SERVICE-update.timer" "$SERVICE-wall.service" "$SERVICE-wall.timer"; do
      [ ! -e "$UNIT_DIR/$unit" ] || fail "$UNIT_DIR_PATH/$unit exists and was not made by this installer (nothing was changed)"
    done
    { [ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ]; } || fail "$COMMAND_PATH exists and was not made by this installer (nothing was changed)"
    user_exists && fail "the user $SVC_USER exists and was not made by this installer: the service user must own nothing else (nothing was changed)"
    # What an install makes is removed again by the uninstall and by a failed install: so none of it may exist before. The state
    # directory may be an empty directory (a volume of its own, with a lost+found); it stays, its contents go.
    if [ -d "$STATE" ] && [ -n "$(find "$STATE" -mindepth 1 -maxdepth 1 ! -name 'lost+found' 2>/dev/null | head -n 1)" ]; then
      fail "$STATE_PATH exists and is not empty: it is the state directory of the runner (nothing was changed)"
    fi
    { [ ! -e "$OPT" ] && [ ! -L "$OPT" ]; } || fail "$OPT_PATH exists and was not made by this installer (nothing was changed)"
    { [ ! -e "$CONF" ] && [ ! -L "$CONF" ]; } || fail "$CONF_PATH exists and was not made by this installer (nothing was changed)"
    { [ ! -e "$HOME_DIR" ] && [ ! -L "$HOME_DIR" ]; } || fail "$HOME_PATH exists and was not made by this installer (nothing was changed)"
    nft list table inet "$WALL_TABLE" >/dev/null 2>&1 && fail "the nft table $WALL_TABLE is loaded and was not made by this installer (nothing was changed)"
    if [ -n "$(ip -o link show 2>/dev/null | grep ': fctap[0-9]*:' || true)" ]; then
      fail "TAP devices named fctapN exist and were not made by this installer (nothing was changed)"
    fi
  fi
  choose_slot_network
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
    [ -f "$CHANNEL_FILE_USED" ] || fetch "$url" "$CHANNEL_FILE_USED" 65536 || fail "the release channel of the $1 could not be downloaded"
  fi
  [ -r "$CHANNEL_FILE_USED" ] || fail "the release channel file of the $1 cannot be read"
}

# Fetches the signed manifest of a component and proves it: WORK/COMP.manifest.json, PROGRAM_RELEASE or VM_RELEASE and the address
# the files are under. Returns 1 for a channel that is empty (nothing is published yet). The program's is the channel's newest; the VM
# artifacts' is the release the program names (RELEASE): a channel whose baseUrl holds `{release}` has an address per release, one
# without holds a single release (the newest) and serves the program only if that is the one it names.
fetch_manifest() { # fetch_manifest program|vm [RELEASE]
  COMP="$1"
  channel_file "$1"
  read_channel "$CHANNEL_FILE_USED" || return 1
  case "$1" in program) max=$MAX_PROGRAM_MANIFEST ;; vm) max=$MAX_VM_MANIFEST ;; esac
  base="$CH_BASE"
  case "$1" in
    vm) base="$(printf '%s' "$base" | sed "s/{release}/$2/g")"; what="the VM artifacts release $2 (named by the program release $PROGRAM_RELEASE)" ;;
    program)
      case "$base" in *'{'*) fail "the program release channel has a placeholder in its address: only the VM artifacts' has one" ;; esac
      what="the program" ;;
  esac
  fetch "$base$CH_MANIFEST" "$WORK/$1.manifest.json" "$max" || fail "the release manifest of $what could not be downloaded: the program is not taken, nothing was installed"
  fetch "$base$CH_SIGNATURE" "$WORK/$1.manifest.sig" 4096 || fail "the signature of the $1 manifest could not be downloaded"
  verify_signature "$WORK/$1.manifest.json" "$WORK/$1.manifest.sig" "$CH_KEY" "$WORK"
  M_RELEASE="$(jq -r 'if (.release|type)=="number" and .release>=1 and .release==(.release|floor) then .release else empty end' "$WORK/$1.manifest.json" 2>/dev/null)"
  is_uint "$M_RELEASE" || fail "the $1 manifest has no release number"
  [ "$(jq -r '.arch // ""' "$WORK/$1.manifest.json")" = "x86_64" ] || fail "the $1 manifest is not for x86_64"
  if [ "$1" = vm ] && [ "$M_RELEASE" != "$2" ]; then
    fail "the VM artifacts at $base are release $M_RELEASE, and the program release $PROGRAM_RELEASE needs release $2 (an address without {release} holds one release at a time): the program is not taken, nothing was installed"
  fi
  case "$1" in
    program) PROGRAM_RELEASE="$M_RELEASE"; PROGRAM_BASE_URL="$base" ;;
    vm) VM_RELEASE="$M_RELEASE"; VM_BASE_URL="$base" ;;
  esac
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

# -- staging: download and verify with no lock held, then move into place in one short step ------------------------

# The switch lock guards the files that say what is current, previous and pending (the links, `pending`, `rejected-*`). It is held for a
# few renames and one write, never for a download: a start of the service, a rollback and an update's own commit wait for each other for
# milliseconds. (`update.lock` is another lock: it only keeps two updaters from staging at once.)
lock_switch() {
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

# The lines of `pending` are `program=N`, `vm=M` and `pair=1` (the two were staged together by one update: they are switched together, and
# a program that does not run takes its VM artifacts with it). Writes the given lines and keeps the other component's, in one rename.
write_pending() { # write_pending LINE...  (KEY=VALUE; the lock is held)
  lock_switch
  : >"$STATE/pending.new"
  if [ -f "$STATE/pending" ]; then
    keep="$(for line in "$@"; do printf '%s\n' "${line%%=*}"; done)"
    while IFS= read -r old; do
      [ -n "$old" ] || continue
      if [ "${old%%=*}" = pair ] || printf '%s\n' "$keep" | grep -qx "${old%%=*}"; then continue; fi
      printf '%s\n' "$old" >>"$STATE/pending.new"
    done <"$STATE/pending"
  fi
  for line in "$@"; do printf '%s\n' "$line" >>"$STATE/pending.new"; done
  chmod 0644 "$STATE/pending.new"
  root_owned "$STATE/pending.new"
  mv "$STATE/pending.new" "$STATE/pending"
}

drop_pending() { # drop_pending program|vm|pair
  [ -f "$STATE/pending" ] || return 0
  grep -v "^$1=" "$STATE/pending" >"$STATE/pending.new" || true
  # A pair of which one is gone is no pair.
  if [ "$1" != pair ] && [ -s "$STATE/pending.new" ] && ! { grep -q '^program=' "$STATE/pending.new" && grep -q '^vm=' "$STATE/pending.new"; }; then
    grep -v '^pair=' "$STATE/pending.new" >"$STATE/pending.new2" || true
    mv "$STATE/pending.new2" "$STATE/pending.new"
  fi
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
  stage="$PROGRAM_STAGE_BASE/program-$PROGRAM_RELEASE"
  rm -rf "$stage"
  mkdir -p "$stage/tree"
  say "downloading the program, release $PROGRAM_RELEASE"
  fetch "$PROGRAM_BASE_URL$name" "$stage/bundle.tar.zst" "$size" || fail "the program could not be downloaded"
  [ "$(file_size "$stage/bundle.tar.zst")" = "$size" ] || fail "the program is not the size its manifest names: nothing was installed"
  [ "$(file_sha256 "$stage/bundle.tar.zst")" = "$digest" ] || fail "the program does not match the digest in its manifest: nothing was installed"

  # What is unpacked: names of the bundle's own tree only (no absolute path, no `..`, no odd character), no device.
  zstd -dcq "$stage/bundle.tar.zst" | tar -tf - >"$stage/names" 2>/dev/null || fail "the program is not a tar archive in zstd"
  if grep -Eq '(^/|(^|/)\.\.(/|$)|[^A-Za-z0-9._+/@=-])' "$stage/names"; then
    fail "the program holds a path outside its own tree or an odd name: nothing was installed"
  fi
  # shellcheck disable=SC2016 # the quotes are for the shell that `capped` starts
  capped "$MAX_PROGRAM_FILE" sh -c 'zstd -dcq "$1" | tar -xf - -C "$2" --no-same-owner --no-same-permissions' sh "$stage/bundle.tar.zst" "$stage/tree" 2>/dev/null \
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
  for part in bin/factory-runner bin/firecracker libexec/host.sh share/outer-wall.nft share/release.json; do
    [ -f "$stage/tree/$part" ] || fail "the program has no $part: it is not a runner release"
  done
  chmod -R go-w "$stage/tree"
  chmod 0755 "$stage/tree/bin/factory-runner" "$stage/tree/bin/firecracker" "$stage/tree/libexec/host.sh"
  chmod 0644 "$stage/tree/share/outer-wall.nft"
  # A kernel without the netfilter modules of the table is found now, not when the service starts: the table as it will be loaded,
  # for the network of this machine's slots.
  render_wall "$stage/tree/share/outer-wall.nft" "$stage/rendered.nft"
  nft -c -f "$stage/rendered.nft" >/dev/null 2>&1 \
    || fail "the nft table of this release does not load on this kernel (nft -c -f failed: are the nft_fib modules there?)"
  rm -f "$stage/rendered.nft"
  STAGED_program="$stage/tree"
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
  fetch "$VM_BASE_URL$name" "$1/$name" "$size" || fail "the $role file could not be downloaded"
  [ "$(file_size "$1/$name")" = "$size" ] || fail "the $role file is not the size its manifest names: nothing was installed"
  [ "$(file_sha256 "$1/$name")" = "$digest" ] || fail "the $role file does not match the digest in its manifest: nothing was installed"
  if [ "$name" != "$4" ]; then
    usize="$(jq -r "$jq_file.uncompressed.size" "$WORK/vm.manifest.json")"
    udigest="$(jq -r "$jq_file.uncompressed.sha256" "$WORK/vm.manifest.json")"
    if ! is_uint "$usize" || ! is_sha256 "$udigest" || [ "$usize" -gt "$MAX_UNPACKED" ]; then
      fail "the VM manifest gives no size and digest for what $role unpacks to"
    fi
    capped "$usize" zstd -dq --no-progress "$1/$name" -o "$1/$4" || fail "the $role file could not be unpacked"
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
  stage="$VM_STAGE_BASE/vm-$VM_RELEASE"
  rm -rf "$stage"
  mkdir -p "$stage"
  say "downloading the VM artifacts, release $VM_RELEASE"
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
  STAGED_vm="$stage"
}

# Whether the channel's release of the program is one to take: newer than what is installed, staged and the release a rollback left.
# Says why not when it is not. Reads the state without the lock: the commit asks again under it.
wanted() { # wanted program
  release="$PROGRAM_RELEASE"
  if [ -z "$release" ]; then
    say "the program release channel is empty: nothing is published yet"
    return 1
  fi
  installed="$(installed_release program)"
  waiting="$(pending_release program)"
  rejected="$(rejected_release program)"
  newest="$installed"
  if [ -n "$waiting" ] && [ "$waiting" -gt "$newest" ]; then newest="$waiting"; fi
  if [ "$release" -le "$newest" ]; then
    say "the program is at release $installed${waiting:+ (release $waiting is staged)}; the channel announces $release: nothing to do"
    return 1
  fi
  if [ "$release" -le "$rejected" ]; then
    say "the program release $release was rolled back on this machine: waiting for a higher one"
    return 1
  fi
  return 0
}

# The same question under the lock, once the download is over: a rollback or another start may have happened meanwhile.
still_wanted() { # still_wanted program RELEASE
  installed="$(installed_release "$1")"
  waiting="$(pending_release "$1")"
  [ "$2" -gt "$installed" ] || return 1
  [ "$2" -gt "$(rejected_release "$1")" ] || return 1
  # A rollback waits (a release below the installed one), or an equal or newer release is staged already.
  if [ -n "$waiting" ] && { [ "$waiting" -lt "$installed" ] || [ "$waiting" -ge "$2" ]; }; then return 1; fi
  return 0
}

# The VM artifacts release a program names: `share/release.json`, `vmArtifacts`, a whole number (empty without one).
program_vm_release() { # program_vm_release DIR
  jq -r 'if (.vmArtifacts|type)=="number" and .vmArtifacts>=1 and .vmArtifacts==(.vmArtifacts|floor) then .vmArtifacts else empty end' "$1/share/release.json" 2>/dev/null || true
}

# How a program gets the VM artifacts release it names (the exact release, not the newest): `installed` (they are the current ones),
# `pending` (they are staged already), `stage` (they have to be fetched) or why it cannot: `back` (older than the installed ones: that is
# a rollback, which an update never does) or `rejected` (a rollback left that release or a higher one). Reads the state: ask under the
# lock to commit.
pair_mode() { # pair_mode RELEASE
  have="$(installed_release vm)"
  waiting="$(pending_release vm)"
  if [ "$1" = "$have" ]; then printf installed
  elif [ -n "$waiting" ] && [ "$1" = "$waiting" ]; then printf pending
  elif [ "$1" -lt "$have" ]; then printf back
  elif [ "$1" -le "$(rejected_release vm)" ]; then printf rejected
  else printf stage
  fi
}

# The staged program becomes root's once the VM artifacts it names have passed too (the machine's users and files are not touched before
# every manifest has been proven).
seal_program() {
  chown -R root:root "$STAGED_program"
}

# The staged program (STAGED_program) and the VM artifacts it names: reads its `share/release.json`, and fetches and proves the manifest of
# that VM release when it is not in place (an address that does not answer, a signature that is wrong, another release there: the program is
# not taken, with nothing changed). Returns 1, after saying why, for a program that cannot be taken now; STAGED_program is then empty.
choose_pair() {
  VM_WANTED=""
  PAIR_NEED="$(program_vm_release "$STAGED_program")"
  [ -n "$PAIR_NEED" ] || fail "the program release $PROGRAM_RELEASE does not name the VM artifacts release it needs (share/release.json): it is not taken"
  case "$(pair_mode "$PAIR_NEED")" in
    installed|pending) return 0 ;;
    stage)
      fetch_manifest vm "$PAIR_NEED" || no_release_yet vm
      VM_WANTED="$PAIR_NEED"
      return 0 ;;
    back) say "the program release $PROGRAM_RELEASE needs the VM artifacts release $PAIR_NEED, and release $(installed_release vm) is installed: an update does not go back (that is 'factory-runner rollback'), so the program is not taken" ;;
    *) say "the program release $PROGRAM_RELEASE needs the VM artifacts release $PAIR_NEED, which was rolled back on this machine: waiting for a program that needs a higher one" ;;
  esac
  STAGED_program=""
  return 1
}

# Moves what was staged and verified into place and says so in `pending`, in one short step under the switch lock: the program, and the VM
# artifacts it names as a pair (`pair=1`: switched together, and a program that does not run takes them with it). Nothing is switched to
# before both parts are there: a failed download of the VM artifacts never leaves a new program waiting.
commit_staged() {
  [ -n "$STAGED_program" ] || return 0
  lock_switch
  program_to=""
  vm_to=""
  vm_kept=""
  if ! still_wanted program "$PROGRAM_RELEASE"; then
    say "the program release $PROGRAM_RELEASE is not taken any more (a rollback or another update came first)"
  else
    case "$(pair_mode "$PAIR_NEED")" in
      installed) program_to="$PROGRAM_RELEASE" ;;
      pending) program_to="$PROGRAM_RELEASE"; vm_kept="$PAIR_NEED" ;;
      stage)
        if [ -n "$STAGED_vm" ] && [ "$VM_WANTED" = "$PAIR_NEED" ]; then program_to="$PROGRAM_RELEASE"; vm_to="$PAIR_NEED"; fi ;;
    esac
    [ -n "$program_to" ] || say "the program release $PROGRAM_RELEASE is not taken any more: the VM artifacts release $PAIR_NEED it names cannot be taken now (a rollback or another update came first)"
  fi
  if [ -n "$program_to" ]; then
    mkdir -p "$OPT/releases"
    chmod 0755 "$OPT/releases"
    root_owned "$OPT/releases"
    rm -rf "$OPT/releases/$program_to"
    mv "$STAGED_program" "$OPT/releases/$program_to"
  fi
  if [ -n "$vm_to" ]; then
    mkdir -p "$STATE/artifact-releases"
    chmod 0755 "$STATE/artifact-releases"
    root_owned "$STATE/artifact-releases"
    rm -rf "$STATE/artifact-releases/$vm_to"
    mv "$STAGED_vm" "$STATE/artifact-releases/$vm_to"
  fi
  if [ -n "$vm_to" ]; then
    write_pending "program=$program_to" "vm=$vm_to" "pair=1"
  elif [ -n "$vm_kept" ]; then
    write_pending "program=$program_to" "vm=$vm_kept" "pair=1"
  elif [ -n "$program_to" ]; then
    # The VM artifacts it names are the installed ones: a pair staged before for another program is no longer wanted.
    drop_pending vm
    write_pending "program=$program_to"
  fi
  [ -z "$program_to" ] || STAGED_ANY=1
  [ -z "$program_to" ] || say "staged the program release $program_to (verified)"
  [ -z "$vm_to" ] || say "staged the VM artifacts release $vm_to it names (verified)"
}

# The newest program and the VM artifacts it names, downloaded and verified with no lock held (the program's manifest is fetched already),
# then committed.
stage_releases() {
  STAGED_ANY=0
  if wanted program; then
    stage_program
    if choose_pair; then
      seal_program
      if [ -n "$VM_WANTED" ]; then stage_vm; fi
      commit_staged
    fi
  fi
}

# -- the switch: current <- pending, between two starts of the service ------------------------------------------

# Smoke test of a program release as the service user: the command runs and says its version; and the release
# carries the script that is installed from it.
smoke_program() { # smoke_program DIR
  if [ ! -f "$1/libexec/host.sh" ] || ! sh -n "$1/libexec/host.sh" 2>/dev/null; then return 1; fi
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
  # A pair was staged together: when its program does not come, its VM artifacts do not either (they were made for it).
  paired="$(pending_release pair)"
  program_failed=0
  target="$(pending_release program)"
  if [ -n "$target" ]; then
    if [ "$target" = "$(link_release "$OPT/current")" ]; then
      drop_pending program
    elif [ ! -d "$OPT/releases/$target" ]; then
      warn "the staged program release $target is gone: it is dropped"
      program_failed=1
      drop_pending program
    elif ! smoke_program "$OPT/releases/$target"; then
      warn "the program release $target does not run on this machine: it is dropped and not taken again; the current release stays"
      reject_release program "$target"
      program_failed=1
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
    if [ "$program_failed" = 1 ] && [ "$paired" = 1 ]; then
      warn "the VM artifacts release $target came with the program release that was dropped: it is dropped with it"
      reject_release vm "$target"
      drop_pending vm
    elif [ "$target" = "$(link_release "$STATE/artifacts")" ]; then
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
  drop_pending pair
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

tap_address() { # tap_address N: the host's side of slot N's /30 (the launcher's slots.py derives the same: the first address of it)
  network="$(slot_network)"
  int_to_ip $(( $(ip_to_int "${network%/*}") + $1 * 4 + 1 ))
}

slots() { # the number of slots of this machine
  count="$(sed -n 's/^FACTORY_RUNNER_PARALLEL_RUNS=//p' "$CONF/runner.env" 2>/dev/null | head -n 1)"
  if is_uint "$count" && [ "$count" -ge 1 ]; then printf '%s' "$count"; else printf '1'; fi
}

# The TAP devices of the slots. The number is written to the state BEFORE the first one is made (the higher of the old and the new
# number), so an install that is interrupted, or fails, half way is undone by the same record: nothing made is left unnamed.
ensure_taps() {
  total="$(slots)"
  made="$(state_value taps)"
  is_uint "$made" || made=0
  if [ "$total" -gt "$made" ]; then set_state taps "$total"; fi
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
  while [ "$n" -lt "$made" ]; do
    ip link delete "fctap$n" >/dev/null 2>&1 || true
    n=$(( n + 1 ))
  done
  set_state taps "$total"
}

# The table is a template: the one thing in it that differs between machines is the network of the slots.
render_wall() { # render_wall TEMPLATE OUTPUT
  network="$(slot_network)"
  [ -n "$network" ] || fail "the network of the slots is not known"
  sed "s#@SLOT_NETWORK@#$network#g" "$1" >"$2"
}

# Loads the table and proves it with a second command. The service cannot read nft state, so this is the only check.
load_wall() {
  template="$OPT/current/share/outer-wall.nft"
  [ -f "$template" ] || fail "the program has no nft table to load"
  render_wall "$template" "$STATE/outer-wall.nft"
  chmod 0644 "$STATE/outer-wall.nft"
  root_owned "$STATE/outer-wall.nft"
  nft -f "$STATE/outer-wall.nft" || fail "the nft table could not be loaded"
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
    echo "FACTORY_RUNNER_SLOT_NETWORK=$(slot_network)"
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
After=network-online.target nftables.service
Wants=network-online.target
# Where the machine has nftables.service (a reload of the rules flushes ours with the rest): a restart of it restarts this service, and the
# start loads the table again before the service runs. A machine without that unit ignores both lines. A flush by anything else is what
# $SERVICE-wall.timer catches.
PartOf=nftables.service

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
  # The outer wall is checked while the service runs, as root (the service user cannot read nft): a flush of the rules by anything
  # (nftables.service, a firewall tool, a person) ends in a restart, whose start loads the table again or, when it cannot, does not start.
  write_file "$UNIT_DIR/$SERVICE-wall.service" 0644 <<EOF
[Unit]
Description=Factory-Runner (Code Reviewer): the outer wall of the VMs is still loaded
Documentation=https://github.com/Itegro-GmbH/code-reviewer/blob/main/docs/runner.md

[Service]
Type=oneshot
ExecStart=$OPT_PATH/current/libexec/host.sh check-wall
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
EOF
  write_file "$UNIT_DIR/$SERVICE-wall.timer" 0644 <<EOF
[Unit]
Description=Factory-Runner (Code Reviewer): look every ten seconds whether the outer wall is loaded

[Timer]
OnBootSec=30s
OnUnitActiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
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
  trap - QUIT
  set_signal_traps
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
  # An existing, empty state directory (a volume of its own) is the operator's: the uninstall empties it and leaves it.
  if [ -d "$STATE" ] && [ "$REFRESH" != 1 ]; then set_state state_existed 1; fi
  mkdir -p "$OPT" "$STATE" "$CONF" "$HOME_DIR" "$STATE/vms"
  # Explicit modes: a default ACL on a parent directory (some images have one on /opt) would otherwise be inherited.
  chmod 0755 "$OPT" "$STATE" "$CONF"
  root_owned "$OPT" "$STATE" "$CONF"
  # The service's own: the credential and the configuration, the VMs' directories, the lock it takes.
  chmod 0700 "$HOME_DIR" "$STATE/vms"
  chown "$SVC_USER:$SVC_USER" "$HOME_DIR" "$STATE/vms"
  [ -e "$STATE/dispatcher.lock" ] || : >"$STATE/dispatcher.lock"
  chmod 0600 "$STATE/dispatcher.lock"
  chown "$SVC_USER:$SVC_USER" "$STATE/dispatcher.lock"
  store_curl_config
}

# The curl configuration (a token, say) kept for the updates: made readable by root alone from its first byte, and a newly given one
# replaces the one kept.
store_curl_config() {
  [ -n "$CURL_CONFIG" ] || return 0
  mkdir -p "$CONF"
  ( umask 077; cat "$CURL_CONFIG" >"$CONF/download.curlrc.new" )
  chmod 0600 "$CONF/download.curlrc.new"
  root_owned "$CONF/download.curlrc.new"
  mv "$CONF/download.curlrc.new" "$CONF/download.curlrc"
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
  say "  - make ${PARALLEL:-1} TAP device(s) fctap0... owned by $SVC_USER in the network $SLOT_NETWORK (the first free one: it overlaps no address or route of this machine), load and verify the nft table $WALL_TABLE"
  say "  - write $UNIT_DIR_PATH/$SERVICE.service, $SERVICE-update.service and .timer, $SERVICE-wall.service and .timer, and $COMMAND_PATH"
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
  # Before the first change: the two manifests are fetched and proven, the program is downloaded, verified and unpacked and its nft
  # table is checked on this kernel, and the space for the VM artifacts is counted. Only the work directory is touched.
  if ! fetch_manifest program; then no_release_yet program; fi
  channel_file vm
  PROGRAM_STAGE_BASE="$WORK/stage"
  make_stage_root "$PROGRAM_STAGE_BASE"
  if wanted program; then
    stage_program
    choose_pair || fail "the program release $PROGRAM_RELEASE cannot be taken with the VM artifacts on this machine (nothing was changed)"
    seal_program
    if [ -n "$VM_WANTED" ]; then check_space; fi
  fi
  if [ "$REFRESH" != 1 ]; then FRESH=1; fi
  set_state version 1
  [ -n "$(state_value slot_network)" ] || set_state slot_network "$SLOT_NETWORK"
  ensure_user
  check_kvm_access
  ensure_directories
  # Another updater (the timer's) may be staging: this one waits for nobody and takes the staging directory only with its lock.
  exec 9>"$STATE/update.lock"
  flock -n 9 || fail "an update is running"
  VM_STAGE_BASE="$STATE/staging"
  make_stage_root "$VM_STAGE_BASE"
  for comp in program vm; do
    cp "$(channel_file_of "$comp")" "$CONF/channel-$comp.json"
    chmod 0644 "$CONF/channel-$comp.json"
    root_owned "$CONF/channel-$comp.json"
  done
  total="${PARALLEL:-1}"
  write_runner_env "$total"
  STAGED_ANY=0
  if [ -n "$STAGED_program" ]; then
    if [ -n "$VM_WANTED" ]; then stage_vm; fi
    commit_staged
  fi
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
  # The machine is installed: what follows (the token) never removes it. The lock goes before the service starts: its start
  # (`prestart`) takes the same lock.
  FRESH=0
  unlock_switch
  systemctl daemon-reload </dev/null
  for timer in "$SERVICE-update.timer" "$SERVICE-wall.timer"; do
    systemctl enable "$timer" >/dev/null 2>&1 </dev/null || true
    systemctl start "$timer" >/dev/null 2>&1 </dev/null || true
  done
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
  # `update.lock` keeps two updaters from staging at once. The switch lock is not held while anything is downloaded: a start of the
  # service and a rollback never wait for an update.
  exec 9>"$STATE/update.lock"
  flock -n 9 || fail "another update is running"
  PROGRAM_STAGE_BASE="$OPT/staging"
  VM_STAGE_BASE="$STATE/staging"
  make_stage_root "$PROGRAM_STAGE_BASE"
  make_stage_root "$VM_STAGE_BASE"
  fetch_manifest program || true
  # The manifests were proven by this configuration: it is the one kept for the next update.
  store_curl_config
  stage_releases
  unlock_switch
  rm -rf "$PROGRAM_STAGE_BASE" "$VM_STAGE_BASE"
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
    write_pending "$comp=$previous"
    say "the $comp goes back from release $current to release $previous (release $current is not taken again, nor any below it)"
    went=1
  done
  [ "$went" = 1 ] || fail "there is no earlier release to go back to"
  if [ "$NOW" = 1 ]; then
    unlock_switch
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

# Run by the wall timer as root: when the service runs and the table is gone, the service is restarted. The restart stops the VMs (their
# jobs go back to the queue) and its start loads the table again; when it cannot, the service does not start. Within one period of the
# timer (10 s) plus the time of a stop, a VM does not run without its wall.
do_check_wall() {
  require_root
  require_installed
  systemctl is-active --quiet "$SERVICE" </dev/null 2>/dev/null || return 0
  if nft list table inet "$WALL_TABLE" >/dev/null 2>&1; then
    return 0
  fi
  warn "the nft table $WALL_TABLE is gone while the service runs: restarting it (its start loads the table again, or fails without it)"
  systemctl restart "$SERVICE" </dev/null || warn "the service did not restart: it stays stopped until the table can be loaded"
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

remove_tree() { # remove_tree DIR [KEEP]: the contents and the directory, unless it is a mount point or KEEP is 1 (it was there before: the contents only)
  [ -e "$1" ] || [ -L "$1" ] || return 0
  find "$1" -mindepth 1 -xdev -delete 2>/dev/null || rm -rf --one-file-system "$1"
  [ "${2:-0}" = 1 ] || rmdir "$1" 2>/dev/null || true
}

# Removes what an install made and nothing else: the install refuses to start where any of it exists, and writes `install.state` before
# its first change, so the state is the record. A machine without it is not ours.
remove_everything() {
  [ -f "$CONF/install.state" ] || return 0
  made_user="$(state_value user_created)"
  state_kept="$(state_value state_existed)"
  total="$(state_value taps)"
  systemctl disable --now "$SERVICE-update.timer" "$SERVICE-wall.timer" </dev/null >/dev/null 2>&1 || true
  systemctl disable --now "$SERVICE" </dev/null >/dev/null 2>&1 || true
  nft delete table inet "$WALL_TABLE" >/dev/null 2>&1 || true
  if is_uint "$total"; then
    n=0
    while [ "$n" -lt "$total" ]; do
      ip link delete "fctap$n" >/dev/null 2>&1 || true
      n=$(( n + 1 ))
    done
  fi
  rm -f "$UNIT_DIR/$SERVICE.service" "$UNIT_DIR/$SERVICE-update.service" "$UNIT_DIR/$SERVICE-update.timer" \
    "$UNIT_DIR/$SERVICE-wall.service" "$UNIT_DIR/$SERVICE-wall.timer" "$COMMAND"
  systemctl daemon-reload </dev/null >/dev/null 2>&1 || true
  systemctl reset-failed "$SERVICE" "$SERVICE-update.service" "$SERVICE-wall.service" </dev/null >/dev/null 2>&1 || true
  remove_tree "$OPT"
  remove_tree "$STATE" "$state_kept"
  remove_tree "$HOME_DIR"
  remove_tree "$CONF"
  if [ "$made_user" = 1 ]; then
    userdel "$SVC_USER" >/dev/null 2>&1 || true
  fi
}

do_uninstall() {
  require_root
  if [ ! -f "$CONF/install.state" ]; then
    say "the runner is not installed on this machine by this installer ($CONF_PATH/install.state is missing): nothing to remove"
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
    check-wall) do_check_wall ;;
    run-service) do_run_service ;;
  esac
}

# In braces: a download cut off anywhere in this line is a syntax error, so nothing runs, not even `main` without its arguments.
{ main "$@"; }
