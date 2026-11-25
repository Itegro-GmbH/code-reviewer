# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: AF_VSOCK, sysctl, module loading, mounting the VM's block devices as root of the container. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
python3 - <<'PY'
import socket, fcntl, struct
try:
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    print("AF_VSOCK socket: created by root in the container")
    cid = socket.VMADDR_CID_ANY
    f = open('/dev/vsock','rb'); 
    r = fcntl.ioctl(f, 0x7b9, b'\0\0\0\0')   # IOCTL_VM_SOCKETS_GET_LOCAL_CID
    print("local CID:", struct.unpack('I', r)[0])
except Exception as e:
    print("vsock:", e)
PY
echo "--- sysctls/features the agent can change as root:"; sysctl -w net.ipv4.ip_forward=1 2>&1 | tail -1; sysctl vm.overcommit_memory 2>&1
echo "--- can root load a module / touch /sys/kernel / mount block devs:"; modprobe dummy 2>&1 | head -1; ls /dev/vd* 2>&1 | tr '\n' ' '; echo
mkdir -p /mnt/x && mount /dev/vda /mnt/x 2>&1 | head -1; mount -o ro /dev/vdb /mnt/x 2>&1 | head -1; ls /mnt/x 2>&1 | head -3
