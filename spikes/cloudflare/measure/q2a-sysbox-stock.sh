# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: stock sysbox-mgr and sysbox-fs: sysbox-mgr dies on /proc/modules. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
which sysbox-runc sysbox-mgr sysbox-fs; sysbox-runc --version 2>&1 | head -3
grep -E ' /proc/(kcore|keys) ' /proc/self/mountinfo | head
ls /lib/sysctl.d/ | grep -i sysbox; sysctl -q -e -p /lib/sysctl.d/99-sysbox-sysctl.conf 2>&1 | head -5
chmod 666 /dev/net/tun
mkdir -p /run/sysbox /var/lib/sysbox
date +%s.%N > /tmp/t_sysbox
nohup sysbox-mgr > /var/log/sysbox-mgr.log 2>&1 &
for i in $(seq 1 100); do [ -S /run/sysbox/sysmgr.sock ] && break; sleep 0.3; done
nohup sysbox-fs > /var/log/sysbox-fs.log 2>&1 &
for i in $(seq 1 100); do [ -S /run/sysbox/sysfs.sock ] && break; sleep 0.3; done
echo "sysbox daemons up after $(python3 -c "import time;print(round(time.time()-float(open('/tmp/t_sysbox').read()),2))") s"
pgrep -a sysbox | cut -c1-120
echo "--- mgr log:"; tail -25 /var/log/sysbox-mgr.log | cut -c1-260
echo "--- fs log:"; tail -15 /var/log/sysbox-fs.log | cut -c1-260
