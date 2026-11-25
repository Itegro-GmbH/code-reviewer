# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: the hosted vm-prepare cgroup fix, then a Sysbox container. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
cd /sys/fs/cgroup
echo "root: type=$(cat cgroup.type) subtree=[$(cat cgroup.subtree_control)] procs=$(cat cgroup.procs | tr '\n' ' ')"
pkill -x dockerd; sleep 1
rmdir docker/* docker 2>/dev/null
echo "-cpuset -cpu -pids" > cgroup.subtree_control 2>&1 | head -2
mkdir -p vm.slice
for p in $(cat cgroup.procs); do echo $p > vm.slice/cgroup.procs 2>/dev/null; done
echo "+memory +io +cpu +cpuset +pids" > cgroup.subtree_control 2>&1 | head -3
echo "after: type=$(cat cgroup.type) subtree=[$(cat cgroup.subtree_control)]"
cd /
nohup dockerd > /var/log/dockerd.log 2>&1 &
for i in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
I=public.ecr.aws/docker/library/busybox:1.37
echo "--- sysbox container, plain:"
t docker run --rm --runtime=sysbox-runc $I sh -c 'id; cat /proc/self/uid_map; grep -E "Cap(Eff)" /proc/self/status'
tail -3 /var/log/dockerd.log | cut -c1-400
