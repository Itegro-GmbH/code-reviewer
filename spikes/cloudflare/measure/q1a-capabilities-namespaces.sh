# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: capabilities, user namespaces, seccomp, filesystems. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
capsh --decode=00000000abac35fb
echo --- missing caps from full:; capsh --print | grep -i bounding | tr ',' '\n' | wc -l
echo "--- namespaces/idmap/seccomp:"; unshare -U -r id 2>&1; grep -E 'Seccomp|NoNewPrivs' /proc/self/status
cat /sys/fs/cgroup/cgroup.procs | head; ls /sys/fs/cgroup | head -20
echo "--- kernel modules/fs:"; grep -E 'overlay|fuse|btrfs|xfs|ext4|tmpfs' /proc/filesystems | tr '\n' ' '; echo
ls /sys/module | grep -E 'br_netfilter|overlay|veth|nf_tables|nft|ip_tables|xt_|iptable|nf_nat|bridge' | tr '\n' ' '; echo
ls /lib/modules 2>&1 | head -2
uname -r; (command -v nft && nft list ruleset | head -20)
sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables 2>&1
