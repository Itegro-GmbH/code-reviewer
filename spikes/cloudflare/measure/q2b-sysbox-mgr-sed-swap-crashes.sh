# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: a first swap with sed and a string ONE BYTE LONGER: the copy of sysbox-mgr segfaults (kept as the record of that mistake; q2c is the working one). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
echo "--- is /proc/modules really absent, and does a bind mount onto it work?"
ls -l /proc/modules 2>&1; grep -c . /proc/filesystems; zgrep -c MODULES /proc/config.gz 2>&1 | head -1; touch /tmp/empty.f; mount --bind /tmp/empty.f /proc/modules 2>&1 | head -2
echo "--- patched COPY of sysbox-mgr (same-length path swap, throwaway, spike only)"
cp /usr/bin/sysbox-mgr /tmp/sysbox-mgr-patched
grep -c '/proc/modules' /tmp/sysbox-mgr-patched
sed -i 's#/proc/modules#/tmp/modules.x#g' /tmp/sysbox-mgr-patched
: > /tmp/modules.x
grep -c '/proc/modules' /tmp/sysbox-mgr-patched
pkill sysbox-fs; sleep 1; rm -f /run/sysbox/*.sock
nohup /tmp/sysbox-mgr-patched > /var/log/sysbox-mgr.log 2>&1 &
for i in $(seq 1 60); do [ -S /run/sysbox/sysmgr.sock ] && break; sleep 0.3; done
nohup sysbox-fs > /var/log/sysbox-fs.log 2>&1 &
for i in $(seq 1 60); do [ -S /run/sysbox/sysfs.sock ] && break; sleep 0.3; done
pgrep -a sysbox | cut -c1-100
tail -12 /var/log/sysbox-mgr.log | cut -c1-300
