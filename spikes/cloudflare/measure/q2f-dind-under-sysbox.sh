# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: the agent container's shape: docker:dind under sysbox-runc, inner dockerd, nested network. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
B=public.ecr.aws/docker/library/busybox:1.37
D=public.ecr.aws/docker/library/docker:29.1.3-dind
t docker pull -q $D
docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' | head
echo "--- DinD under Sysbox (the agent container's shape: sysbox-runc, own dockerd inside):"
docker rm -f agent >/dev/null 2>&1
s=$(date +%s.%N)
docker run -d --name agent --runtime=sysbox-runc $D >/dev/null
for i in $(seq 1 100); do docker exec agent docker info >/dev/null 2>&1 && break; sleep 0.2; done
echo "   inner dockerd ready $(python3 -c "import time;print(round(time.time()-$s,2))") s after docker run"
docker exec agent docker info 2>&1 | grep -E 'Storage Driver|driver-type|Cgroup|Runtimes|Server Version|rootless'
docker exec agent cat /proc/self/uid_map
echo "--- hand busybox to the inner daemon (docker save | load), run an inner container with its own network:"
t sh -c "docker save $B | docker exec -i agent docker load"
t docker exec agent docker run --rm $B sh -c 'ip -br a; ip r; echo inner-inner-ok'
t docker exec agent sh -c "docker network create inner-net >/dev/null; docker run -d --rm --name x --network inner-net $B sh -c 'echo ok >/tmp/i; httpd -f -p 8080 -h /tmp' >/dev/null; sleep 1; docker run --rm --network inner-net $B wget -q -O- -T 4 http://x:8080/i"
echo "--- inner container -> internet over two NAT layers (HTTP:80 to the door):"
t docker exec agent docker run --rm $B wget -q -O- -T 8 http://example.com | head -c 80; echo
docker exec agent sh -c 'iptables --version; iptables -t nat -S | head -5'
