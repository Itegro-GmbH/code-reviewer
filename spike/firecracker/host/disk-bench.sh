#!/usr/bin/env bash
# Spike #970, question 3: the per-job writable disk = a copy of the prepared base image. Reflink (XFS, btrfs) against a plain copy:
# time, and what the file system really spends. The copies are made by the unprivileged user (fcuser); root only mounts the volumes.
# Usage: disk-bench.sh <out json>; the base is /srv/fc/base/base-disk.ext4 (disk-prep.sh); a 4 GiB random file stands for a bigger one.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
work=${SPIKE_WORK:-/srv/fc}
out=${1:?out json}
trials=${TRIALS:-5}
base="$work/base/base-disk.ext4"

# volumes: XFS = the work volume; btrfs = a second loop volume
if ! mountpoint -q /srv/fcb; then
  mkdir -p /srv/fcb
  truncate -s 24G /mnt/fc-btrfs.img
  mkfs.btrfs -q -f /mnt/fc-btrfs.img
  mount -o loop,noatime /mnt/fc-btrfs.img /srv/fcb
fi
chown fcuser:fcuser /srv/fcb
mkdir -p /srv/fcb/bench /srv/fc/bench
chown fcuser:fcuser /srv/fcb/bench /srv/fc/bench
as() { sudo -u fcuser -- "$@"; }

as cp --sparse=auto "$base" /srv/fcb/bench/base.ext4
as sh -c 'head -c 4294967296 /dev/urandom > /srv/fc/bench/big.img; cp /srv/fc/bench/big.img /srv/fcb/bench/big.img'
sync

used_bytes() { stat -f --format '%S %b %f' "$1" | awk '{print ($2 - $3) * $1}'; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

printf '[\n' > "$out"
first=1
emit() { # fs image mode trial ms ms_sync used_delta alloc
  [ "$first" = 1 ] || printf ',\n' >> "$out"; first=0
  printf '  {"fs":"%s","image":"%s","mode":"%s","trial":%s,"copy_ms":%s,"copy_sync_ms":%s,"fs_used_delta_bytes":%s,"allocated_bytes":%s}' "$@" >> "$out"
}
for fs in xfs btrfs; do
  dir=/srv/fc/bench; [ "$fs" = btrfs ] && dir=/srv/fcb/bench
  mnt=/srv/fc; [ "$fs" = btrfs ] && mnt=/srv/fcb
  for image in base big; do
    src="$dir/$image.ext4"; [ "$image" = big ] && src="$dir/big.img"
    [ "$image" = base ] && [ "$fs" = xfs ] && src="$base"
    for mode in reflink plain; do
      flag=--reflink=always; [ "$mode" = plain ] && flag=--reflink=never
      for t in $(seq 1 "$trials"); do
        dst="$dir/job-$mode-$t.img"
        sync; echo 3 > /proc/sys/vm/drop_caches
        before=$(used_bytes "$mnt")
        t0=$(date +%s%N); as cp --sparse=auto "$flag" "$src" "$dst"; copy=$(ms "$t0")
        sync; copy_sync=$(ms "$t0")
        after=$(used_bytes "$mnt")
        alloc=$(( $(stat -c %b "$dst") * 512 ))
        emit "$fs" "$image" "$mode" "$t" "$copy" "$copy_sync" "$((after - before))" "$alloc"
        as rm -f "$dst"; sync
      done
    done
  done
  # copy-on-write cost: overwrite 256 MiB inside a fresh copy (what a job's first writes do)
  for mode in reflink plain; do
    flag=--reflink=always; [ "$mode" = plain ] && flag=--reflink=never
    src="$dir/base.ext4"; [ "$fs" = xfs ] && src="$base"
    dst="$dir/job-cow.img"
    as cp --sparse=auto "$flag" "$src" "$dst"; sync
    before=$(used_bytes "$mnt")
    t0=$(date +%s%N); as dd if=/dev/zero of="$dst" bs=1M count=256 conv=notrunc,fsync status=none; w=$(ms "$t0")
    after=$(used_bytes "$mnt")
    emit "$fs" "base" "cow-overwrite-256MiB-$mode" 1 "$w" "$w" "$((after - before))" "$(( $(stat -c %b "$dst") * 512 ))"
    as rm -f "$dst"; sync
  done
done
printf '\n]\n' >> "$out"
echo "base disk: $(stat -c %s "$base") bytes apparent, $(( $(stat -c %b "$base") * 512 )) allocated"
python3 -I - "$out" <<'PY'
import json, statistics, sys
rows = json.load(open(sys.argv[1]))
groups = {}
for r in rows:
    groups.setdefault((r["fs"], r["image"], r["mode"]), []).append(r)
print(f'{"fs":6} {"image":5} {"mode":34} {"copy ms (med)":>13} {"+sync ms (med)":>14} {"fs used delta MiB":>18} {"allocated MiB":>14}')
for (fs, image, mode), g in sorted(groups.items()):
    med = lambda k: statistics.median(x[k] for x in g)
    print(f'{fs:6} {image:5} {mode:34} {med("copy_ms"):13.0f} {med("copy_sync_ms"):14.0f} {med("fs_used_delta_bytes")/2**20:18.1f} {med("allocated_bytes")/2**20:14.1f}')
PY
