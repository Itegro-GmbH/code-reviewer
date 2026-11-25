#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149: the boot steps the hosted VM does (docker/sandbox/vm-prepare.sh + sysbox-prepare.sh), adapted to the Cloudflare microVM,
# with a timing line for every step. Run as root inside the container. Idempotent enough for a spike.
set -u
now() { python3 -c 'import time;print(time.time())'; }
T0=$(now)
step() { echo "boot: $1 at +$(python3 -c "import time;print(round(time.time()-$T0,2))") s"; }

# 0. trust the door's CA (only exists when an HTTPS intercept was registered before start())
if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cf-ca.crt && update-ca-certificates >/dev/null 2>&1
  step "ca-installed"
fi

# 1. cgroup root: same fix as vm-prepare.sh (the root is "domain threaded" and holds tasks)
cd /sys/fs/cgroup || exit 20
rmdir docker/* docker 2>/dev/null
echo "-cpuset -cpu -pids" > cgroup.subtree_control 2>/dev/null
mkdir -p vm.slice
for p in $(cat cgroup.procs); do echo "$p" > vm.slice/cgroup.procs 2>/dev/null; done
echo "+memory +io +cpu +cpuset +pids" > cgroup.subtree_control || { echo "boot: cgroup_failed"; exit 21; }
cd /
step "cgroup-ready ($(cat /sys/fs/cgroup/cgroup.type) [$(cat /sys/fs/cgroup/cgroup.subtree_control)])"

# 2. Sysbox: sysbox-mgr refuses to start without /proc/modules (this kernel has CONFIG_MODULES=n). A byte-for-byte same-length
#    path swap in a COPY of the binary points that one check at an empty file. Spike-only; not a way to run it in production.
if [ "${SYSBOX:-1}" = 1 ]; then
  chmod 666 /dev/net/tun
  sysctl -q -e -p /lib/sysctl.d/99-sysbox-sysctl.conf >/dev/null 2>&1
  mkdir -p /run/sysbox /var/lib/sysbox; : > /tmp/modules
  python3 - <<'PY'
d = open('/usr/bin/sysbox-mgr', 'rb').read()
assert d.count(b'/proc/modules') == 1
open('/tmp/sysbox-mgr-patched', 'wb').write(d.replace(b'/proc/modules', b'/tmp//modules'))
PY
  chmod +x /tmp/sysbox-mgr-patched
  nohup /tmp/sysbox-mgr-patched > /var/log/sysbox-mgr.log 2>&1 &
  for i in $(seq 1 100); do [ -S /run/sysbox/sysmgr.sock ] && break; sleep 0.1; done
  nohup sysbox-fs > /var/log/sysbox-fs.log 2>&1 &
  for i in $(seq 1 100); do [ -S /run/sysbox/sysfs.sock ] && break; sleep 0.1; done
  step "sysbox-up"
  echo '{"ipv6":false,"ip6tables":false,"live-restore":false,"runtimes":{"sysbox-runc":{"path":"/usr/bin/sysbox-runc"}}}' > /etc/docker/daemon.json
fi

# 3. dockerd
nohup dockerd > /var/log/dockerd.log 2>&1 &
for i in $(seq 1 150); do docker info >/dev/null 2>&1 && break; sleep 0.1; done
step "dockerd-ready"
docker info 2>&1 | grep -E 'Runtimes'
