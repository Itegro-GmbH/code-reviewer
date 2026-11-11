#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The Incus/Docker bench (#1013): why does `docker run busybox true` take about 2 s inside an Incus instance (Incus 7.6, btrfs pool, AppArmor on, containerd
# image store) when it took 0.8 s in the first spike? Run on a quiet, disposable host, which is what GitHub's ubuntu-24.04 runner is
# (.github/workflows/incus-docker-bench.yml). It installs Incus, makes the pools, builds a golden image with Docker, and times one `docker run`
# and its parts in a set of variants that each take one suspect away (see docs/runner.md, "Incus: the cost of a docker run"). NEVER run it on a shared
# development server: it installs a package, changes the firewall and starts Incus. It refuses to run outside GitHub Actions.
# usage: bench.sh   (as root)      env: BENCH_N (repetitions, default 12), BENCH_DIR (default /mnt/incus-bench)
set -uo pipefail
export LC_ALL=C
HERE=$(cd "$(dirname "$0")" && pwd)

# Pins. The sha256 of the three downloads were taken from the files themselves when the bench was written.
INCUS_VERSION='1:7.6-ubuntu24.04-202611072126'
ZABBLY_KEY_FPR='4EFC590696CB15B87C73A3AD82CC8797C838DCFD'
DOCKER_URL='https://download.docker.com/linux/static/stable/x86_64/docker-29.1.3.tgz'
DOCKER_SHA='c019c608ba2bb009dd673f3230e4d743f36a78d36166c6c2444c05d0aa9ff0d9'
BUILDX_URL='https://github.com/docker/buildx/releases/download/v0.30.1/buildx-v0.30.1.linux-amd64'
BUILDX_SHA='c37114fcd034025ec68e224657c8a5a850df472ded3ddcbca75ad3a7ebb9710d'
COMPOSE_URL='https://github.com/docker/compose/releases/download/v5.7.1/docker-compose-linux-x86_64'
COMPOSE_SHA='af426722a8af5de812fcee30cc1c39f0639f5f723cbadefb25e5d4db054064cf'
BUSYBOX_REF='public.ecr.aws/docker/library/busybox:1.37'
HELLO_REF='public.ecr.aws/docker/library/hello-world:latest'

N=${BENCH_N:-12}
DIR=${BENCH_DIR:-/mnt/incus-bench}
BOOTS_BTRFS=5
BOOTS_DIR=3
BENCH_OUT=$DIR/samples.tsv
FACTS=$DIR/facts.txt
export BENCH_OUT
BENCH_VARIANT=setup

say() { printf '\n=== %s\n' "$*"; }
die() { echo "bench: $*" >&2; exit 1; }
must() { "$@" >/dev/null || die "failed: $*"; }

[ "${GITHUB_ACTIONS:-}" = true ] || [ "${BENCH_I_KNOW_THIS_INSTALLS_INCUS:-}" = yes ] || die "refusing to run outside GitHub Actions: this installs Incus and changes the firewall"
[ "$(id -u)" = 0 ] || die "run as root"
mkdir -p "$DIR"
: >"$BENCH_OUT"
: >"$FACTS"
# shellcheck source=tools/incus-docker-bench/lib.sh
. "$HERE/lib.sh"

finish() {
  local status=$?
  say "summary"
  if [ -s "$BENCH_OUT" ]; then
    python3 -I "$HERE/summarize.py" "$BENCH_OUT" >"$DIR/summary.md"
    local rc=$?
    cat "$DIR/summary.md"
    { echo "## Incus / Docker bench (#1013)"; echo; echo '```'; cat "$FACTS"; echo '```'; echo; cat "$DIR/summary.md"; } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
    [ "$status" = 0 ] && status=$rc
  else
    status=1
  fi
  exit "$status"
}
trap finish EXIT

fact() { printf '%s\n' "$*" | tee -a "$FACTS"; }

# --- the host: Incus from Zabbly (the pin of the DevBox re-measure), two pools, the firewall Docker leaves behind
install_incus() {
  say "install Incus $INCUS_VERSION"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL --retry 3 --max-time 60 https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc || die "no Zabbly key"
  local fpr
  fpr=$(gpg --show-keys --with-colons /etc/apt/keyrings/zabbly.asc | awk -F: '/^fpr/ { print $10; exit }')
  [ "$fpr" = "$ZABBLY_KEY_FPR" ] || die "Zabbly key fingerprint is $fpr"
  cat >/etc/apt/sources.list.d/zabbly-incus-stable.sources <<SRC
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: noble
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/zabbly.asc
SRC
  apt-get update -qq || die "apt update"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "incus=$INCUS_VERSION" "incus-base=$INCUS_VERSION" "incus-client=$INCUS_VERSION" btrfs-progs || die "apt install incus"
  incus admin waitready --timeout 60 || die "incus did not come up"
  [ "$(dpkg-query -W -f '${Version}' incus)" = "$INCUS_VERSION" ] || die "wrong incus package"
  grep -qw btrfs /proc/filesystems || modprobe btrfs || die "no btrfs in this kernel"
}

init_incus() {
  say "pools, bridge, profiles"
  # the loop file of the btrfs pool and the dir pool go on /mnt (the runner's second, larger disk), as sparse files / directories
  install -d /mnt/incus-disks /var/lib/incus/disks /mnt/incus-dirpool
  mount --bind /mnt/incus-disks /var/lib/incus/disks
  incus admin init --preseed <<'YAML' || die "incus admin init"
config:
  images.compression_algorithm: none
networks:
- name: incusbr0
  type: bridge
  config:
    ipv4.address: 10.206.108.1/24
    ipv4.nat: "true"
    ipv6.address: none
storage_pools:
- name: crpool
  driver: btrfs
  config:
    size: 12GiB
profiles:
- name: default
  devices:
    eth0:
      name: eth0
      network: incusbr0
      type: nic
    root:
      path: /
      pool: crpool
      type: disk
YAML
  incus storage create dirpool dir source=/mnt/incus-dirpool || die "dir pool"
  # the spike's profile, split in two so that a variant can leave the limits out
  must incus profile create bench-base
  must incus profile set bench-base security.nesting=true security.privileged=false security.idmap.isolated=true
  must incus profile create bench-limits
  must incus profile set bench-limits limits.cpu=2 limits.memory=2GiB limits.processes=4096
  # Docker (preinstalled on the runner) sets the FORWARD policy to DROP; its own chains do not know the bridge. This is what Incus' documentation says to do.
  must iptables -I FORWARD -i incusbr0 -j ACCEPT
  must iptables -I FORWARD -o incusbr0 -j ACCEPT
  fact "incus: $(incus --version) ($(dpkg-query -W -f '${Version}' incus)); firewall driver: $(incus info | awk '/firewall:/ { print $2 }')"
  fact "kernel: $(uname -r); cpu: $(awk -F': ' '/model name/ { print $2; exit }' /proc/cpuinfo) x$(nproc); mem: $(awk '/MemTotal/ { print int($2 / 1024) " MiB" }' /proc/meminfo)"
  fact "host docker: $(docker --version); storage: $(docker info --format '{{.Driver}} {{.DriverStatus}}')"
  fact "apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
  fact "loadavg at the start: $(cut -d' ' -f1-3 /proc/loadavg)"
}

download() { # download <url> <sha256> <file>
  curl -fsSL --retry 3 --max-time 300 -o "$3" "$1" || die "download of $1"
  echo "$2  $3" | sha256sum -c --quiet - || die "checksum of $1"
}

build_golden() {
  say "golden image"
  local dl=$DIR/dl
  mkdir -p "$dl"
  download "$DOCKER_URL" "$DOCKER_SHA" "$dl/docker.tgz"
  download "$BUILDX_URL" "$BUILDX_SHA" "$dl/docker-buildx"
  download "$COMPOSE_URL" "$COMPOSE_SHA" "$dl/docker-compose"
  local try
  for try in 1 2 3; do
    incus launch images:ubuntu/24.04 bench-gold -p default -p bench-base </dev/null && break
    incus delete -f bench-gold >/dev/null 2>&1; [ "$try" = 3 ] && die "could not launch images:ubuntu/24.04"; sleep 10
  done
  # the instance must reach the internet through the bridge for apt and the pulls
  local ok=0
  for _ in $(seq 1 60); do incus exec bench-gold -- getent hosts archive.ubuntu.com >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  if [ "$ok" != 1 ]; then
    incus exec bench-gold -- ip -br addr; incus exec bench-gold -- ip route; iptables -S FORWARD | head -20; nft list ruleset | head -60
    die "the golden instance has no network"
  fi
  incus file push "$dl/docker.tgz" "$dl/docker-buildx" "$dl/docker-compose" "$HERE/prep-golden.sh" bench-gold/root/ || die "push"
  incus exec bench-gold --env BUSYBOX_REF="$BUSYBOX_REF" --env HELLO_REF="$HELLO_REF" -- bash /root/prep-golden.sh </dev/null || die "prep-golden.sh failed"
  must incus stop bench-gold
  must incus publish bench-gold --alias bench-docker </dev/null
  must incus delete bench-gold
  rm -rf "$dl"
  incus image list bench-docker -c lfsd | tee -a "$FACTS"
}

# --- one instance: create, start, wait for dockerd, first container; every step timed and checked
ready() { # ready <instance>: dockerd answers
  local deadline=$((SECONDS + 90))
  until incus exec "$1" -- docker info >/dev/null 2>&1; do
    sleep 0.05
    [ "$SECONDS" -lt "$deadline" ] || return 1
  done
}

boot() { # boot <rep> <instance> <incus init arguments...>: 0 when the instance runs a container
  local rep=$1 n=$2 t0 waited parts=''
  shift 2
  timed init.create "$rep" -- incus init bench-docker "$n" "$@" || return 1
  parts=$TIMED_SECS
  timed init.start "$rep" -- incus start "$n" || return 1
  parts="$parts $TIMED_SECS"
  t0=$EPOCHREALTIME
  if ! ready "$n"; then record start.docker-ready "$rep" FAILED "dockerd did not answer in 90 s"; return 1; fi
  waited=$(elapsed "$t0" "$EPOCHREALTIME")
  record start.docker-ready "$rep" "$waited"
  parts="$parts $waited"
  timed start.first-run "$rep" -- incus exec "$n" -- docker run --rm --pull=never busybox true || return 1
  parts="$parts $TIMED_SECS"
  # shellcheck disable=SC2086 # the parts are separate words
  record start.nothing-to-first-container "$rep" "$(sum $parts)"
}

startup_series() { # startup_series <variant> <reps> [incus init arguments...]: reps 0..N, rep 0 is the first instance of the image in the pool (cold)
  local v=$1 reps=$2 rep
  shift 2
  BENCH_VARIANT=$v
  say "startup series $v"
  for rep in $(seq 0 "$reps"); do
    boot "$rep" bench-boot -p default -p bench-base -p bench-limits "$@"
    timed init.delete "$rep" -- incus delete -f bench-boot
    incus delete -f bench-boot >/dev/null 2>&1
  done
  for m in init.create init.start start.docker-ready start.first-run start.nothing-to-first-container; do expect_samples "$m" "$reps"; done
}

in_instance() { incus exec "$1" -- bash -c "$2" </dev/null; }

facts_of() { # facts_of <instance>: what the variant really is
  local n=$1 pid
  pid=$(incus info "$n" | awk '/^PID:/ { print $2 }')
  fact "--- $BENCH_VARIANT"
  fact "instance init, as the host sees its AppArmor profile: $(cat "/proc/$pid/attr/current" 2>&1)"
  # shellcheck disable=SC2016 # the script is for the instance's shell, not this one
  in_instance "$n" 'docker info --format "docker {{.ServerVersion}}; driver {{.Driver}} {{.DriverStatus}}; cgroup {{.CgroupDriver}} v{{.CgroupVersion}}; security {{.SecurityOptions}}; root {{.DockerRootDir}}"; echo "uid_map: $(head -1 /proc/self/uid_map | tr -s " ")"; echo "pids.max: $(cat /sys/fs/cgroup/pids.max 2>&1); memory.max: $(cat /sys/fs/cgroup/memory.max 2>&1); cpus: $(nproc); docker root fs: $(findmnt -no FSTYPE -T "$(docker info --format "{{.DockerRootDir}}")")"' | sed 's/^/  /' | tee -a "$FACTS"
}

assert_variant() { # assert_variant <variant> <instance> <kind...>: the variant is what its name says, or its numbers are not measured
  local v=$1 n=$2 pid attr info; shift 2
  pid=$(incus info "$n" | awk '/^PID:/ { print $2 }')
  attr=$(cat "/proc/$pid/attr/current" 2>/dev/null)
  info=$(in_instance "$n" 'docker info --format "{{.Driver}}|{{.DriverStatus}}|{{.DockerRootDir}}"; head -1 /proc/self/uid_map | tr -s " "; cat /sys/fs/cgroup/pids.max 2>/dev/null')
  local k bad=''
  for k in "$@"; do
    case $k in
      apparmor-on) grep -Eq 'incus-.*enforce' <<<"$attr" || bad="$bad apparmor-on(attr='$attr')" ;;
      apparmor-off) [ "$attr" = unconfined ] || bad="$bad apparmor-off(attr='$attr')" ;;
      userns) grep -q '^ *0 *0 *4294967295' <<<"$info" && bad="$bad userns(uid_map is the host's)" ;;
      privileged) grep -q '^ *0 *0 *4294967295' <<<"$info" || bad="$bad privileged(uid_map is not the host's)" ;;
      containerd-store) grep -q 'io.containerd.snapshotter.v1' <<<"$info" || bad="$bad containerd-store" ;;
      classic-store) { grep -q '^overlay2|' <<<"$info" && ! grep -q 'io.containerd.snapshotter.v1' <<<"$info"; } || bad="$bad classic-store" ;;
      limits) grep -qx 4096 <<<"$info" || bad="$bad limits(pids.max not 4096)" ;;
      nolimits) grep -qx max <<<"$info" || bad="$bad nolimits(pids.max not max)" ;;
      tmpfs-root) [ "$(in_instance "$n" 'findmnt -no FSTYPE -T /mnt/dd')" = tmpfs ] && grep -q '/mnt/dd' <<<"$info" || bad="$bad tmpfs-root" ;;
    esac
  done
  if [ -n "$bad" ]; then record "assert.$v" 0 FAILED "the variant is not what it claims:$bad"; return 1; fi
}

# shellcheck disable=SC2016 # the hooks are scripts for the instance's shell
HOOK_CLASSIC='set -e; systemctl stop docker
printf "{\"features\":{\"containerd-snapshotter\":false}}\n" >/etc/docker/daemon.json
systemctl start docker; for _ in $(seq 1 150); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
docker pull -q '"$BUSYBOX_REF"' >/dev/null; docker tag '"$BUSYBOX_REF"' busybox
docker pull -q '"$HELLO_REF"' >/dev/null; docker tag '"$HELLO_REF"' hello-world'
# shellcheck disable=SC2016
HOOK_TMPFS='set -e; systemctl stop docker
mkdir -p /mnt/dd; mount -t tmpfs -o size=768m tmpfs /mnt/dd; cp -a /var/lib/docker/. /mnt/dd/
printf "{\"features\":{\"containerd-snapshotter\":true},\"data-root\":\"/mnt/dd\"}\n" >/etc/docker/daemon.json
systemctl start docker; for _ in $(seq 1 150); do docker info >/dev/null 2>&1 && break; sleep 0.2; done'

exec_series() { # the same work with `incus exec` around it, from the host (the client overhead)
  local n=$1 rep parts cid
  for rep in $(seq 0 "$N"); do
    timed exec.true "$rep" -- incus exec "$n" -- true
    timed exec.run "$rep" -- incus exec "$n" -- docker run --rm --pull=never busybox true
    if timed exec.split.create "$rep" -- incus exec "$n" -- docker create --pull=never busybox true; then
      cid=$TIMED_OUT; parts=$TIMED_SECS
      timed exec.split.start "$rep" -- incus exec "$n" -- docker start "$cid" && parts="$parts $TIMED_SECS"
      timed exec.split.wait "$rep" -- incus exec "$n" -- docker wait "$cid" && parts="$parts $TIMED_SECS"
      timed exec.split.rm "$rep" -- incus exec "$n" -- docker rm "$cid" && parts="$parts $TIMED_SECS"
      # shellcheck disable=SC2086 # the parts are separate words
      [ "$(wc -w <<<"$parts")" = 4 ] && record exec.split.total "$rep" "$(sum $parts)"
    fi
  done
  for m in exec.true exec.run exec.split.create exec.split.start exec.split.wait exec.split.rm exec.split.total; do expect_samples "$m" "$N"; done
}

variant() { # variant <name> <battery 0|1> <exec series 0|1> <hook|-> <asserts, space separated> <incus init arguments...>
  local v=$1 battery=$2 execs=$3 hook=$4 asserts=$5 n=bench-$1 rc=0
  shift 5
  BENCH_VARIANT=$v
  say "variant $v"
  if ! boot 0 "$n" "$@"; then incus delete -f "$n" >/dev/null 2>&1; return 1; fi
  if [ "$hook" != - ]; then in_instance "$n" "$hook" || { record "hook.$v" 0 FAILED "the hook failed"; incus delete -f "$n" >/dev/null 2>&1; return 1; }; fi
  # shellcheck disable=SC2086 # the asserts are separate words
  if ! assert_variant "$v" "$n" $asserts; then incus delete -f "$n" >/dev/null 2>&1; return 1; fi
  facts_of "$n"
  incus exec "$n" -- mkdir -p /root/bench </dev/null
  incus file push "$HERE/guest.sh" "$HERE/lib.sh" "$n/root/bench/" || return 1
  incus exec "$n" --env BENCH_N="$N" --env BENCH_BATTERY="$battery" -- bash /root/bench/guest.sh "$v" /root/out.tsv </dev/null || rc=$?
  incus file pull "$n/root/out.tsv" "$DIR/out-$v.tsv" && cat "$DIR/out-$v.tsv" >>"$BENCH_OUT"
  [ "$rc" = 0 ] || record "guest.$v" 0 FAILED "guest.sh exited $rc"
  [ "$execs" = 1 ] && exec_series "$n"
  incus delete -f "$n" >/dev/null 2>&1
  fact "loadavg after $v: $(cut -d' ' -f1-3 /proc/loadavg)"
}

host_variant() { # host_variant <name> <battery 0|1>: the same series with Docker on the runner itself, no Incus
  BENCH_VARIANT=$1
  say "variant $1"
  must docker pull -q "$BUSYBOX_REF"
  must docker tag "$BUSYBOX_REF" busybox
  must docker pull -q "$HELLO_REF"
  must docker tag "$HELLO_REF" hello-world
  fact "--- $1"
  fact "$(docker info --format 'docker {{.ServerVersion}}; driver {{.Driver}} {{.DriverStatus}}; cgroup {{.CgroupDriver}} v{{.CgroupVersion}}; security {{.SecurityOptions}}; root {{.DockerRootDir}}')"
  rm -f "$DIR/out-$1.tsv"
  BENCH_N=$N BENCH_BATTERY=$2 CTR_SOCK=/run/containerd/containerd.sock bash "$HERE/guest.sh" "$1" "$DIR/out-$1.tsv" || record "guest.$1" 0 FAILED "guest.sh failed"
  cat "$DIR/out-$1.tsv" >>"$BENCH_OUT" 2>/dev/null
  fact "loadavg after $1: $(cut -d' ' -f1-3 /proc/loadavg)"
}

# The hypothesis of the DevBox runs: the host was busy (load 5 to 20 on 4 vCPUs, other agents' builds and tests). The same series while the runner is kept busy with
# CPU (busy loops) and/or disk (writers that fsync on the disk the pool's loop file lives on), Docker on the host and Docker in an instance, fewer repetitions.
HOGS=()
start_hogs() { # start_hogs <busy loops> <fsync writers>
  local _
  for _ in $(seq 1 "$1"); do bash -c 'while :; do :; done' & HOGS+=("$!"); done
  for _ in $(seq 1 "$2"); do bash -c 'while :; do dd if=/dev/zero of=/mnt/incus-bench/hog.$$ bs=1M count=256 conv=fsync status=none; done' & HOGS+=("$!"); done
  sleep 20
}
stop_hogs() {
  [ "${#HOGS[@]}" -gt 0 ] && kill "${HOGS[@]}" 2>/dev/null
  wait "${HOGS[@]}" 2>/dev/null
  HOGS=()
  find /mnt/incus-bench -maxdepth 1 -name 'hog.*' -delete
}
loaded() { # loaded <name> <busy loops> <fsync writers> <repetitions>
  local saved=$N
  N=$4
  start_hogs "$2" "$3"
  host_variant "host-docker-$1" 0
  variant "btrfs-default-$1" 0 1 - 'apparmor-on userns containerd-store limits' "${base[@]}"
  stop_hogs
  N=$saved
}

install_incus
init_incus
build_golden
base=(-p default -p bench-base -p bench-limits)
startup_series startup-btrfs "$BOOTS_BTRFS"
host_variant host-docker 1
variant btrfs-default 1 1 - 'apparmor-on userns containerd-store limits' "${base[@]}"
variant apparmor-off 1 0 - 'apparmor-off userns containerd-store limits' "${base[@]}" -c raw.lxc=lxc.apparmor.profile=unconfined
variant privileged 0 0 - 'privileged containerd-store limits' "${base[@]}" -c security.privileged=true -c security.idmap.isolated=false
variant no-limits 0 0 - 'apparmor-on userns containerd-store nolimits' -p default -p bench-base
variant classic-overlay2 1 0 "$HOOK_CLASSIC" 'apparmor-on userns classic-store limits' "${base[@]}"
variant tmpfs-root 0 0 "$HOOK_TMPFS" 'apparmor-on userns containerd-store limits tmpfs-root' "${base[@]}"
variant btrfs-default-again 0 0 - 'apparmor-on userns containerd-store limits' "${base[@]}"
startup_series startup-dir "$BOOTS_DIR" -s dirpool
variant dir-pool 1 0 - 'apparmor-on userns containerd-store limits' "${base[@]}" -s dirpool
loaded load16 16 0 6
loaded io1 0 1 6
loaded io4 0 4 3
fact "loadavg at the end: $(cut -d' ' -f1-3 /proc/loadavg)"
