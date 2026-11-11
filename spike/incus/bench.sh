#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: three small benchmarks, run on the host and inside the Incus instance, 3 times each.
# cpu: sha256 of 1 GiB from /dev/zero; disk: 1 GiB write with fdatasync; build: a docker build with three RUN layers (busybox, no network).
dir=${1:-/tmp/spike-bench}; mkdir -p $dir/b; cd $dir
now() { date +%s.%N; }; el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
printf 'FROM busybox\nRUN dd if=/dev/urandom of=/a bs=1M count=150 2>/dev/null && gzip -k /a\nRUN cat /a /a.gz | md5sum > /sum && dd if=/dev/zero of=/z bs=1M count=200 2>/dev/null\nRUN tar cf /t.tar /a /z /sum && ls -la /t.tar\n' > b/Dockerfile
for i in 1 2 3; do
  t=$(now); dd if=/dev/zero bs=1M count=1024 2>/dev/null | sha256sum >/dev/null; c=$(el $t $(now))
  t=$(now); dd if=/dev/zero of=$dir/w bs=1M count=1024 conv=fdatasync 2>/dev/null; d=$(el $t $(now)); rm -f $dir/w
  t=$(now); docker build -q --no-cache -t spk-bench b >/dev/null 2>&1; bt=$(el $t $(now)); docker rmi spk-bench >/dev/null 2>&1
  echo "run $i: cpu(sha256 1GiB)=${c}s disk(write 1GiB fdatasync)=${d}s docker-build(3 layers)=${bt}s"
done
