#!/usr/bin/env bash
# Spike #970: the prepared base disk for the guest's Docker (read by every job through a reflink copy).
# An ext4 image whose /docker is a Docker data root with the images already loaded (what the recipe would ship: Worker image,
# agent image) and /seed with a tarball of hello-world for the offline inner-docker test. Run as root, once, after setup.sh.
# The data root is filled by the SAME pinned dockerd (static bundle) running on the host as a second daemon, no network of its own.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
work=${SPIKE_WORK:-/srv/fc}
img="$work/base/base-disk.ext4"
mnt=/mnt/fc-basemnt
run=/run/fc-prep
fetch_pinned "$DOCKER_URL" "$DOCKER_SHA256" /tmp/spike-dl/docker.tgz
mkdir -p /opt/docker-static "$mnt" "$run"
tar -xzf /tmp/spike-dl/docker.tgz -C /opt/docker-static --strip-components=1
export PATH=/opt/docker-static:$PATH

rm -f "$img"
truncate -s 12G "$img"
mkfs.ext4 -q -m 0 -L jobdisk "$img"
mount -o loop "$img" "$mnt"
mkdir -p "$mnt/docker" "$mnt/seed" "$mnt/sysbox" "$mnt/containerd" /var/lib/containerd
cat > "$run/daemon.json" <<'JSON'
{ "ipv6": false, "ip6tables": false, "live-restore": false, "features": { "containerd-snapshotter": false }, "log-opts": { "max-size": "10m", "max-file": "2" } }
JSON
# Docker 29's containerd snapshotter keeps images under containerd's root (/var/lib/containerd), not under the data root: in a private
# mount namespace that path is the base disk's /containerd, so the runner's own Docker is not touched. The guest does the same bind mount.
unshare --mount --propagation private bash -c '
  mount --bind "$1/containerd" /var/lib/containerd
  exec dockerd --config-file "$2/daemon.json" --data-root "$1/docker" --host "unix://$2/docker.sock" --pidfile "$2/docker.pid" \
    --exec-root "$2/exec" --bridge=none --iptables=false --ip-forward=false --ip-masq=false
' _ "$mnt" "$run" > "$run/dockerd.log" 2>&1 &
dpid=$!
D="docker -H unix://$run/docker.sock"
for _ in $(seq 1 100); do $D info >/dev/null 2>&1 && break; sleep 0.3; done
$D info --format 'storage={{.Driver}} {{.DriverStatus}} server={{.ServerVersion}}'
for pair in "$IMG_BUSYBOX busybox:spike" "$IMG_HELLO hello-world:spike" "$IMG_DIND docker:dind-spike"; do
  set -- $pair
  $D pull -q "$1" >/dev/null
  $D tag "$1" "$2"
done
$D save hello-world:spike -o "$mnt/seed/hello-world.tar"
$D images
# where did the data go? (Docker 29 with the containerd image store did not write it under the data root: 180 KiB there, 508 MiB pulled)
echo "--- diag: dockerd/containerd lines"; grep -iE 'containerd|snapshotter|storage' "$run/dockerd.log" | head -n 8 || true
echo "--- diag: processes"; ps -eo pid,args | grep -E '[c]ontainerd' | cut -c1-200 || true
kill -TERM "$dpid"; wait "$dpid" || true
for _ in $(seq 1 50); do pgrep -f "$run/docker.sock" >/dev/null || break; sleep 0.2; done
sync
du -sh "$mnt/docker" "$mnt/containerd"
umount "$mnt"
e2fsck -fy "$img" >/dev/null || true
resize2fs -M "$img" 2>&1 | tail -n 1
blocks=$(dumpe2fs -h "$img" 2>/dev/null | awk -F: '/^Block count/ {gsub(/ /,"",$2); print $2}')
bsize=$(dumpe2fs -h "$img" 2>/dev/null | awk -F: '/^Block size/ {gsub(/ /,"",$2); print $2}')
truncate -s "$((blocks * bsize))" "$img"
chown fcuser:fcuser "$img"
ls -ls "$img"
log "base disk ready: $(( blocks * bsize / 1024 / 1024 )) MiB filesystem"
