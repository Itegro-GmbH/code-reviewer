# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: a process that calls the door every 30 s (long run, box a). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
cat > /tmp/hb.sh <<'SH'
n=0
while true; do n=$((n+1)); curl -s -m 10 -o /dev/null "http://example.com/hb?n=$n&up=$(cut -d. -f1 /proc/uptime)"; sleep 30; done
SH
nohup bash /tmp/hb.sh >/dev/null 2>&1 &
# also a CPU-light memory-resident process, to see what survives
date +%s > /tmp/started_at
echo "hb started $(date)"
cat /sys/fs/cgroup/cpu.stat | head -3
