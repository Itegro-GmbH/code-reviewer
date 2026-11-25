# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: CPU seconds (cgroup cpu.stat) of boot, pull, DinD start, clone, busy core. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
u() { awk '/usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat; }
mark() { echo "$1: cpu_s=$(python3 -c "print(round(($(u)-$U0)/1e6,2))") wall_s=$(python3 -c "import time;print(round(time.time()-$T0,1))") mem_used_mb=$(free -m | awk '/Mem:/{print $3}')"; }
U0=$(u); T0=$(date +%s.%N)
bash /opt/probes/boot.sh >/dev/null 2>&1; mark "boot (CA, cgroup, sysbox, dockerd)"
D=public.ecr.aws/docker/library/docker:29.1.3-dind; docker pull -q $D >/dev/null; mark "pull 511MB dind image through the door"
docker run -d --name agent --runtime=sysbox-runc $D >/dev/null
for i in $(seq 1 100); do docker exec agent docker info >/dev/null 2>&1 && break; sleep 0.2; done; mark "Sysbox DinD container with its own dockerd ready"
git clone -q --depth 1 https://github.com/octocat/Hello-World.git /tmp/hw; mark "git clone"
python3 -c "
import hashlib,time
t=time.time(); h=b''
while time.time()-t<20: h=hashlib.sha256(h+b'x'*1000).digest()
"; mark "+20 s of one busy core (a stand-in for a test run)"
