# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: a COPY of sysbox-mgr with the one /proc/modules string swapped for a path of the same length: reaches Ready. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
: > /tmp/modules; cp /usr/bin/sysbox-mgr /tmp/sysbox-mgr-p2
python3 - <<'PY'
d=open('/tmp/sysbox-mgr-p2','rb').read()
n=d.count(b'/proc/modules'); print('occurrences',n, 'size', len(d))
d=d.replace(b'/proc/modules', b'/tmp//modules')
open('/tmp/sysbox-mgr-p2','wb').write(d)
PY
chmod +x /tmp/sysbox-mgr-p2; ls -l /usr/bin/sysbox-mgr /tmp/sysbox-mgr-p2 | awk '{print $5, $9}'
/usr/bin/sysbox-mgr --version 2>&1 | head -2
pkill sysbox-fs; pkill sysbox-mgr; sleep 1; rm -f /run/sysbox/*.sock
nohup /tmp/sysbox-mgr-p2 > /var/log/sysbox-mgr.log 2>&1 &
for i in $(seq 1 60); do [ -S /run/sysbox/sysmgr.sock ] && break; sleep 0.3; done
nohup sysbox-fs > /var/log/sysbox-fs.log 2>&1 &
for i in $(seq 1 60); do [ -S /run/sysbox/sysfs.sock ] && break; sleep 0.3; done
pgrep -a sysbox | cut -c1-100
tail -14 /var/log/sysbox-mgr.log | cut -c1-300
