# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: dockerd as root in the container: start time, storage driver, cgroup, iptables. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
set -u
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cf-ca.crt && update-ca-certificates 2>&1 | tail -1
date +%s.%N > /tmp/t_dockerd_start
nohup dockerd > /var/log/dockerd.log 2>&1 &
for i in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 0.2; done
echo "dockerd ready after $(echo "$(date +%s.%N) - $(cat /tmp/t_dockerd_start)" | bc 2>/dev/null || python3 -c "import time;print(time.time()-float(open('/tmp/t_dockerd_start').read()))") s"
docker info 2>&1 | grep -E 'Server Version|Storage Driver|driver-type|Cgroup|Runtimes|Default Runtime|Security Options|Kernel|Operating|CPUs|Total Memory|rootless|Warning' 
tail -5 /var/log/dockerd.log | cut -c1-250
echo "--- iptables:"; iptables --version; iptables -t nat -S | head -10; iptables -S FORWARD | head -5
ip -br a | head -10; sysctl net.ipv4.ip_forward
