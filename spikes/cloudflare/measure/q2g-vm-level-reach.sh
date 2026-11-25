# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: what root of the container sees of the microVM (proc mount, namespaces, vsock device). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
echo "--- what the VM-level mounts show (the agent is root with CAP_SYS_ADMIN in this container)"
ls -ld /run/cloudchamber /run/cloudchamber/proc /run/cloudchamber/sys 2>&1
for p in $(ls /run/cloudchamber/proc | grep -E '^[0-9]+$' | head -40); do printf "%s %s\n" "$p" "$(tr '\0' ' ' < /run/cloudchamber/proc/$p/cmdline 2>/dev/null | cut -c1-110)"; done
echo "--- own pid ns vs VM pid ns"
readlink /proc/self/ns/pid /run/cloudchamber/proc/1/ns/pid /run/cloudchamber/proc/1/ns/mnt /proc/self/ns/mnt /proc/self/ns/net /run/cloudchamber/proc/1/ns/net /proc/self/ns/cgroup 2>&1
echo "--- listening sockets in the VM/container"
ss -ltnp 2>/dev/null | head -12; ss -lxp 2>/dev/null | head -8
echo "--- vsock?"; ls -l /dev/vsock /dev/vhost-vsock 2>&1 | head; ls /sys/class/net; 
echo "--- can the container read the VM's root fs / host files?"
cat /run/cloudchamber/proc/1/cmdline | tr '\0' ' '; echo; ls /run/cloudchamber/proc/1/root 2>&1 | head -5
ls /run/cloudchamber/proc/1/root/etc 2>&1 | head -3
