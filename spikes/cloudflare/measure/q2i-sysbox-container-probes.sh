# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: the same probes from inside a Sysbox container (no vsock, no /dev/vda, no mount). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
P=public.ecr.aws/docker/library/python:3.13-alpine
docker pull -q $P >/dev/null
echo "--- the agent's shape: Sysbox container (root = uid 165536 of the VM-container), probes from INSIDE it"
docker run --rm --runtime=sysbox-runc $P sh -c '
echo "uid_map: $(cat /proc/self/uid_map | tr -s " ")"
echo "devices: $(ls /dev | tr "\n" " " | cut -c1-200)"
mkdir -p /mnt/x; mount /dev/vda /mnt/x 2>&1 | head -1; mount -t tmpfs none /mnt/x 2>&1 | head -1 && echo "(tmpfs mount allowed inside own ns)"
python3 - <<PY
import socket
try:
    s=socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); s.settimeout(2); print("AF_VSOCK socket created (seccomp does not stop it)")
    try: s.connect((2, 9)); print("vsock connect to CID 2 port 9: connected")
    except Exception as e: print("vsock connect:", repr(e))
except Exception as e: print("AF_VSOCK:", repr(e))
PY
echo "net: $(ip -br a 2>/dev/null | tr "\n" ";")"
wget -q -O- -T 4 http://10.0.0.254/ 2>&1 | head -c 60; echo "(gateway:80 -> $?)"
'
echo "--- the same probe in a plain runc container (no Sysbox), for contrast:"
docker run --rm $P sh -c 'python3 -c "
import socket
try:
    s=socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); print(\"AF_VSOCK socket created\")
except Exception as e: print(\"AF_VSOCK:\", repr(e))"; ls /dev | tr "\n" " " | cut -c1-120; echo'
