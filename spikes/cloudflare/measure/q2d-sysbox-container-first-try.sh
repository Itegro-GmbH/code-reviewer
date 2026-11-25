# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: first docker run with sysbox-runc: fails on cgroup.procs until the cgroup fix of q2e. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
echo '{"ipv6":false,"ip6tables":false,"live-restore":false,"runtimes":{"sysbox-runc":{"path":"/usr/bin/sysbox-runc"}}}' > /etc/docker/daemon.json
pkill -x dockerd; for i in $(seq 1 50); do pgrep -x dockerd >/dev/null || break; sleep 0.2; done
nohup dockerd > /var/log/dockerd.log 2>&1 &
for i in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
docker info 2>&1 | grep -E 'Runtimes'
I=public.ecr.aws/docker/library/busybox:1.37
echo "--- sysbox container, plain:"
t docker run --rm --runtime=sysbox-runc $I sh -c 'id; cat /proc/self/uid_map; grep -E "Cap(Eff)" /proc/self/status'
echo "--- sysbox-fs log tail:"; tail -5 /var/log/sysbox-fs.log | cut -c1-300
echo "--- sysbox-mgr log tail:"; tail -5 /var/log/sysbox-mgr.log | cut -c1-300
