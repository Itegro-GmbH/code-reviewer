#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The golden Incus image of the local runner (#1020, Runner v2, epic #969): Ubuntu 24.04 + Docker (the static bundle of the golden snapshot's
# version, whose dockerd starts and manages its own containerd) + buildx + iproute2 + nft, with the Worker image and the agent's golden image loaded
# into that Docker, published as the Incus image alias the launcher expects (`code-reviewer-golden`, FACTORY_RUNNER_INCUS_IMAGE).
#
#   docker/incus/build-golden.sh [--alias NAME] [--pool POOL] [--prefix PREFIX] [--network-cidr CIDR] [--base IMAGE]
#                                [--worker TAG] [--agent TAG] [--worker-command CMD] [--agent-command CMD] [--cache-dir DIR] [--replace]
#
# What it needs: an `incus` the caller may use (a member of `incus-admin`: run it as that user, or put a command such as `sg incus-admin -c` around
# the whole script), a storage pool (the jobs' own pool, btrfs), a Docker on the caller's side that holds the two images (built from
# runner/Dockerfile, targets `sandbox` and `agent`, tagged as below; or, instead of a stored image, `--worker-command` / `--agent-command`: a shell
# command whose standard output is the image's archive, for a machine that has no room for the image twice, e.g. `docker buildx build --target sandbox
# --output type=docker,dest=- .`; the tag is then the one the archive carries) and internet for the base image, the Ubuntu archive and the two downloads.
# The build instance itself has no way out but a small forward proxy of this directory (build-proxy.py, started on the host's address of the build
# bridge and allowed to reach the Ubuntu archive only): on the DevBox, whose Docker belongs to other users, a NATed Incus bridge does not reach the
# internet, and a build that needs a router's help would not be a build any machine can repeat.
# Nothing else is touched: it makes and removes only objects of its prefix (`<prefix>-bld`: one NAT bridge for the build, one instance), never the
# `default` pool or profile, `incusbr0`, or the host's Docker images other than reading the two it is told to load. Root is not needed.
#
# What it does, in order (any failure stops it and removes what it made; `--keep` leaves the build instance for a look):
#   1. downloads Docker and buildx (docker/incus/pins.env, sha256-checked) into the cache directory;
#   2. makes the build network (a bridge with DHCP, no NAT, no routing; only the build uses it), the proxy on it and the build instance from the base
#      image on the pool, no profile;
#   3. installs the packages, the two binaries, docker.service (docker/incus/docker.service) and daemon.json, starts Docker;
#   4. streams `docker save` of the two images into the instance's `docker load` (no archive on any disk) and records both ids;
#   5. RESTARTS the instance and checks that both images are still there with the same ids: dockerd and containerd must keep the images across a
#      boot (an image that is gone after a reboot is the failure of two Docker units that disagree on who owns the store);
#   6. removes the build network's DHCP file and the caches (an instance of the image has addresses from files the launcher pushes), publishes the
#      image, deletes the build instance and network, and starts one throwaway instance from the alias so that the first job does not pay the unpack
#      of the image into the pool (the installer, #1011, does the same).
# It prints `FACTORY_RUNNER_VM_IMAGE_ID=<the Worker image's id>`: the value the launcher checks in instance A.
#
# After it, `docker rmi` of the two host-side images is up to the caller.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$HERE/pins.env"

INCUS="${INCUS:-incus}"
ALIAS="code-reviewer-golden"
POOL=""
PREFIX="cr"
BASE="images:ubuntu/24.04"
CIDR="10.97.77.1/24"
WORKER="code-reviewer-worker:golden"
AGENT="code-reviewer-agent:golden"
WORKER_COMMAND=""
AGENT_COMMAND=""
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/code-reviewer/incus-golden"
REPLACE=0
KEEP=0

usage() { sed -n '4,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --alias) ALIAS="$2"; shift 2 ;;
    --pool) POOL="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --network-cidr) CIDR="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --worker) WORKER="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --worker-command) WORKER_COMMAND="$2"; shift 2 ;;
    --agent-command) AGENT_COMMAND="$2"; shift 2 ;;
    --cache-dir) CACHE="$2"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h | --help) usage 0 ;;
    *) echo "build-golden: unknown argument $1" >&2; usage ;;
  esac
done
[ -n "$POOL" ] || { echo "build-golden: --pool is required (the jobs' storage pool)" >&2; exit 2; }
# A network name is an interface name (15 characters).
BUILD="$PREFIX-bld"
[ "${#BUILD}" -le 15 ] || { echo "build-golden: the prefix is too long for an interface name" >&2; exit 2; }
case "$PREFIX" in default | incusbr0 | "") echo "build-golden: refusing the prefix '$PREFIX'" >&2; exit 2 ;; esac

# `incus init` and `launch` read an instance configuration from stdin when it is not a terminal and hang on a pipe that never closes (spike #1005):
# stdin is closed for everything that has no input.
ix() { "$INCUS" "$@" </dev/null; }
say() { echo "build-golden: $*" >&2; }
made_network=0
made_instance=0
proxy_pid=
cleanup() {
  local status=$?
  if [ "$KEEP" = 1 ] && [ "$status" -ne 0 ]; then
    say "failed; the build instance $BUILD and its network are left for a look (--keep)"
    return
  fi
  [ -z "$proxy_pid" ] || kill "$proxy_pid" 2>/dev/null || true
  [ "$made_instance" = 1 ] && ix delete --force "$BUILD" >/dev/null 2>&1 || true
  [ "$made_network" = 1 ] && ix network delete "$BUILD" >/dev/null 2>&1 || true
}
trap cleanup EXIT

exe() { ix exec "$BUILD" -- "$@"; }
script() { "$INCUS" exec "$BUILD" -- bash -s; }

# -- 0. what it is told to load ---------------------------------------------------------------------------------------------------------------------
for pair in "$WORKER:$WORKER_COMMAND" "$AGENT:$AGENT_COMMAND"; do
  [ -z "${pair#*:}" ] || continue
  docker image inspect --format '{{.Id}}' "${pair%%:*}" >/dev/null 2>&1 \
    || { say "the image ${pair%%:*} is not in the caller's Docker (build runner/Dockerfile, targets sandbox and agent)"; exit 1; }
done
if ix image alias list --format csv 2>/dev/null | cut -d, -f1 | grep -qx "$ALIAS"; then
  [ "$REPLACE" = 1 ] || { say "the image alias $ALIAS exists (--replace to replace it)"; exit 1; }
fi
ix storage show "$POOL" >/dev/null || { say "no storage pool $POOL"; exit 1; }
for object in "$BUILD"; do
  ix info "$object" >/dev/null 2>&1 && { say "an instance $object exists: not touching it"; exit 1; }
  ix network show "$object" >/dev/null 2>&1 && { say "a network $object exists: not touching it"; exit 1; }
done

# -- 1. downloads -----------------------------------------------------------------------------------------------------------------------------------
mkdir -p "$CACHE"
fetch() { # <url> <sha256> <file>
  local file="$CACHE/$3"
  if [ -f "$file" ] && echo "$2  $file" | sha256sum -c --status; then return; fi
  say "downloading $3"
  curl -fsSL --max-time 600 -o "$file.part" "$1"
  echo "$2  $file.part" | sha256sum -c --status || { rm -f "$file.part"; say "$3 does not have the pinned checksum"; exit 1; }
  mv "$file.part" "$file"
}
fetch "$DOCKER_URL" "$DOCKER_SHA256" "docker-$DOCKER_VERSION.tgz"
fetch "$BUILDX_URL" "$BUILDX_SHA256" "buildx-$BUILDX_VERSION"

# -- 2. the build instance ----------------------------------------------------------------------------------------------------------------------------
say "network $BUILD ($CIDR, no NAT), the archive proxy and instance $BUILD from $BASE"
ix network create "$BUILD" "ipv4.address=$CIDR" ipv4.nat=false ipv4.routing=false ipv6.address=none >/dev/null
made_network=1
HOST_ADDRESS="${CIDR%/*}"
PROXY_PORT=3128
proxy_log="$CACHE/build-proxy.log"
python3 "$HERE/build-proxy.py" "$HOST_ADDRESS" "$PROXY_PORT" archive.ubuntu.com security.ubuntu.com >"$proxy_log" 2>&1 &
proxy_pid=$!
for _ in $(seq 1 50); do
  grep -q ready "$proxy_log" && break
  sleep 0.1
done
grep -q ready "$proxy_log" || { say "the build proxy did not start: $(cat "$proxy_log")"; exit 1; }
# No profile, like every instance of the launcher; nesting for Docker. The pool is the jobs' own, so the unpack of the base image is the pool's.
ix init "$BASE" "$BUILD" --no-profiles --storage "$POOL" --network "$BUILD" \
  --config security.nesting=true --config security.privileged=false --config boot.autostart=false >/dev/null
made_instance=1
ix start "$BUILD"
for _ in $(seq 1 60); do
  exe true >/dev/null 2>&1 && break
  sleep 1
done
# The address of the proxy: the bridge's own, reached over the instance's DHCP lease.
for _ in $(seq 1 60); do
  exe ip -4 -o addr show dev eth0 2>/dev/null | grep -q inet && break
  sleep 1
done
ix exec "$BUILD" -- mkdir -p /etc/apt/apt.conf.d
printf 'Acquire::http::Proxy "http://%s:%s";\nAcquire::https::Proxy "http://%s:%s";\nAcquire::ForceIPv4 "true";\n' \
  "$HOST_ADDRESS" "$PROXY_PORT" "$HOST_ADDRESS" "$PROXY_PORT" \
  | "$INCUS" file push - "$BUILD/etc/apt/apt.conf.d/99-build-proxy"

# -- 3. packages, Docker ------------------------------------------------------------------------------------------------------------------------------
say "installing Docker $DOCKER_VERSION, buildx $BUILDX_VERSION and the packages"
ix file push "$CACHE/docker-$DOCKER_VERSION.tgz" "$BUILD/root/docker.tgz"
ix file push --mode 0755 "$CACHE/buildx-$BUILDX_VERSION" "$BUILD/root/docker-buildx"
ix file push "$HERE/docker.service" "$BUILD/etc/systemd/system/docker.service"
ix exec "$BUILD" -- mkdir -p /etc/docker
ix file push "$HERE/daemon.json" "$BUILD/etc/docker/daemon.json"
script <<'EOS'
set -euo pipefail
cd /root
tar xzf docker.tgz
cp docker/* /usr/local/bin/
mkdir -p /usr/local/lib/docker/cli-plugins
install -m 0755 docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
rm -rf docker docker.tgz docker-buildx
# iproute2: the launcher reads the addresses with `ip -4 -o addr show`; nftables: the inner wall; iptables: Docker's bridge networks; git and the
# rest: what a job's setup and the readers expect to find.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq -o APT::Update::Error-Mode=any
apt-get install -y -qq --no-install-recommends iptables nftables git xz-utils pigz procps iproute2 ca-certificates psmisc netcat-openbsd
getent group docker >/dev/null || groupadd --system docker
systemctl daemon-reload
systemctl enable docker
systemctl start docker
for _ in $(seq 1 150); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
docker info --format 'dockerd {{.ServerVersion}} store={{.DriverStatus}} cgroup={{.CgroupVersion}}'
EOS

# -- 4. the two images, streamed ----------------------------------------------------------------------------------------------------------------------
say "loading $WORKER and $AGENT (streamed, no archive)"
load_image() { # <tag> <command or empty>: the archive goes from the producer into the instance's `docker load`
  if [ -n "$2" ]; then bash -c "$2" | "$INCUS" exec "$BUILD" -- docker load >&2
  else docker save "$1" | "$INCUS" exec "$BUILD" -- docker load >&2; fi
}
load_image "$WORKER" "$WORKER_COMMAND"
load_image "$AGENT" "$AGENT_COMMAND"
id_of() { exe docker image inspect --format '{{.Id}}' "$1" | tr -d '\r\n'; }
worker_id="$(id_of "$WORKER")"
agent_id="$(id_of "$AGENT")"
[ -n "$worker_id" ] && [ -n "$agent_id" ] || { say "the images were not loaded"; exit 1; }
say "loaded: worker $worker_id, agent $agent_id"

# -- 5. a reboot of the build instance --------------------------------------------------------------------------------------------------------------
say "restarting the build instance: the images must survive a boot"
ix restart "$BUILD"
for _ in $(seq 1 100); do
  exe docker info >/dev/null 2>&1 && break
  sleep 0.5
done
exe docker info >/dev/null || { say "Docker does not answer after the restart"; exit 1; }
[ "$(id_of "$WORKER")" = "$worker_id" ] || { say "the Worker image is gone or changed after the restart"; exit 1; }
[ "$(id_of "$AGENT")" = "$agent_id" ] || { say "the agent image is gone or changed after the restart"; exit 1; }
say "both images are there after the restart with the same ids"

# -- 6. publish ---------------------------------------------------------------------------------------------------------------------------------------
say "cleaning and publishing as $ALIAS"
script <<'EOS'
set -euo pipefail
apt-get clean
rm -f /etc/apt/apt.conf.d/99-build-proxy
rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* /var/log/journal/* /var/log/apt/* /var/log/dockerd.log
# A job's addresses come from the files the launcher pushes (05-code-reviewer-*.network): the image's own DHCP of the build must not stay.
find /etc/systemd/network -type f ! -name '05-code-reviewer-*' -delete
find /etc/netplan -type f -delete 2>/dev/null || true
rm -f /etc/machine-id && touch /etc/machine-id
EOS
ix stop "$BUILD"
if [ "$REPLACE" = 1 ]; then
  ix image delete "$ALIAS" >/dev/null 2>&1 || true
fi
# zstd: the image file lives on the machine's system disk (the daemon's image store), which is the small one.
ix publish "$BUILD" --alias "$ALIAS" --compression zstd "description=code-reviewer golden image (Docker $DOCKER_VERSION; worker $worker_id)" >/dev/null
ix delete --force "$BUILD"
made_instance=0
ix network delete "$BUILD"
made_network=0

# One throwaway instance: the first start of an image in a pool unpacks it; the first job should not pay for that.
say "unpacking the image into the pool with one throwaway instance"
warm="$PREFIX-warm"
ix init "$ALIAS" "$warm" --no-profiles --storage "$POOL" >/dev/null
ix delete --force "$warm"

echo "FACTORY_RUNNER_INCUS_IMAGE=$ALIAS"
echo "FACTORY_RUNNER_VM_IMAGE_ID=$worker_id"
echo "agent image id: $agent_id"
