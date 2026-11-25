# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: gVisor runsc install (release tarball). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
cd /tmp
command -v bzip2 >/dev/null || t sh -c 'apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq bzip2 >/dev/null 2>&1'
t curl -fsSL -o gv.tar.bz2 https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/gvisor.tar.bz2
mkdir -p gv && tar -xjf gv.tar.bz2 -C gv && ls -R gv | head; 
F=$(find gv -name runsc -type f | head -1); S=$(find gv -name 'containerd-shim-runsc-v1' -type f | head -1)
cp $F $S /usr/local/bin/; chmod +x /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; runsc --version | head -2
for plat in systrap kvm; do
  echo "--- platform $plat"
  pkill -x dockerd; sleep 2
  echo '{"ipv6":false,"ip6tables":false,"runtimes":{"sysbox-runc":{"path":"/usr/bin/sysbox-runc"},"runsc":{"path":"/usr/local/bin/runsc","runtimeArgs":["--platform='$plat'","--network=sandbox"]}}}' > /etc/docker/daemon.json
  nohup dockerd > /var/log/dockerd.log 2>&1 &
  for i in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
  B=public.ecr.aws/docker/library/busybox:1.37
  docker image inspect $B >/dev/null 2>&1 || docker pull -q $B >/dev/null
  t docker run --rm --runtime=runsc $B sh -c 'uname -a; id; cat /proc/self/status | grep -E "Cap(Eff)"; ip -br a; wget -q -O- -T 4 http://example.com | head -c 40; echo'
  docker run --rm --runtime=runsc $B dmesg 2>&1 | head -3
done
