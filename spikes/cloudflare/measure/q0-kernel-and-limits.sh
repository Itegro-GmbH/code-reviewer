# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: the guest kernel, capabilities, devices, mounts, cgroup layout and network of the microVM. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
uname -a; cat /proc/cmdline 2>/dev/null | cut -c1-300; nproc; free -m | head -2; df -h / | tail -1; id; grep -E 'Cap(Eff|Prm|Bnd)' /proc/self/status
ls /dev | head -50 | tr '\n' ' '; echo; ls -l /dev/fuse /dev/net/tun /dev/kvm 2>&1
cat /etc/os-release | head -2; mount | head -20
ls /proc/config.gz 2>&1; zcat /proc/config.gz 2>/dev/null | grep -E 'USER_NS|OVERLAY_FS=|CGROUP_BPF|SECCOMP_FILTER|RT_GROUP_SCHED|VETH|BRIDGE=|NF_TABLES=|NFT_MASQ|FUSE_FS|TUN=|NF_NAT|VSOCK|IP_NF_RAW|CGROUP_MISC|BLK_DEV_LOOP|XFS_FS|EXT4_FS=' 
cat /sys/fs/cgroup/cgroup.controllers; cat /sys/fs/cgroup/cgroup.type 2>/dev/null; cat /sys/fs/cgroup/cgroup.subtree_control
cat /proc/sys/net/ipv4/ip_forward; ip -br a; ip r
ls /etc/cloudflare/certs 2>&1
ps aux | head -15
