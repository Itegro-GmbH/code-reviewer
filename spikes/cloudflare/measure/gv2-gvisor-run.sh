# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: gVisor runsc as a Docker runtime, systrap and kvm platforms. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
cp -r /tmp/gv/gvisor-bin /usr/local/bin/ ; chmod -R +x /usr/local/bin/gvisor-bin
B=public.ecr.aws/docker/library/busybox:1.37
for plat in systrap kvm; do
  echo "--- platform $plat"
  pkill -x dockerd; sleep 2
  echo '{"ipv6":false,"ip6tables":false,"runtimes":{"sysbox-runc":{"path":"/usr/bin/sysbox-runc"},"runsc":{"path":"/usr/local/bin/runsc","runtimeArgs":["--platform='$plat'","--network=sandbox"]}}}' > /etc/docker/daemon.json
  nohup dockerd > /var/log/dockerd.log 2>&1 &
  for i in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
  t docker run --rm --runtime=runsc $B sh -c 'uname -srv; id; grep CapEff /proc/self/status; ip -br a | head -3; wget -q -O- -T 4 http://example.com | head -c 40; echo'
done
