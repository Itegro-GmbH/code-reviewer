# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: nproc, memory, disk, cpu.max for each instance type. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
echo "nproc=$(nproc) mem_total_mb=$(free -m | awk '/Mem:/{print $2}') root=$(df -BM / | awk 'NR==2{print $2" avail "$4}') cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null) memory.max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null) uptime_s=$(cut -d. -f1 /proc/uptime)"
