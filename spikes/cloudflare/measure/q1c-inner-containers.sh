# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: inner containers: pulls through the door, bridge, user bridge, internal network, host network. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-160; }
echo "--- pull through the door (enableInternet=false, HTTPS interception):"
t docker pull public.ecr.aws/docker/library/busybox:1.37
t docker pull public.ecr.aws/docker/library/alpine:3.21
echo "--- run on default bridge (own netns, veth, NAT):"
t docker run --rm public.ecr.aws/docker/library/busybox:1.37 sh -c 'ip -br a; ip r; echo hello-from-inner'
echo "--- inner container reaches the internet via NAT? (HTTP port 80, door should answer)"
t docker run --rm public.ecr.aws/docker/library/busybox:1.37 wget -q -O- -T 8 http://example.com | head -c 120; echo
echo "--- inner container HTTPS (no CA in busybox, expect cert error or door answer):"
t docker run --rm public.ecr.aws/docker/library/alpine:3.21 sh -c 'apk add --no-cache ca-certificates curl >/dev/null 2>&1; echo apk rc=$?; curl -sS -m 8 -o /dev/null -w "https example.com: %{http_code} verify=%{ssl_verify_result}\n" https://example.com'
echo "--- user-defined bridge network, two inner containers talk to each other:"
docker network create spk-net >/dev/null
docker run -d --rm --name srv --network spk-net public.ecr.aws/docker/library/busybox:1.37 sh -c 'echo ok > /tmp/i; httpd -f -p 8080 -h /tmp' >/dev/null
sleep 1
t docker run --rm --network spk-net public.ecr.aws/docker/library/busybox:1.37 wget -q -O- -T 4 http://srv:8080/i
echo "--- --internal network (no exit)"
docker network create --internal spk-int >/dev/null
t docker run --rm --network spk-int public.ecr.aws/docker/library/busybox:1.37 wget -q -O- -T 4 http://example.com
t docker run --rm --network spk-int public.ecr.aws/docker/library/busybox:1.37 sh -c 'ping -c1 -W2 10.0.0.254 || echo no-route-to-gateway'
echo "--- host network"
t docker run --rm --network host public.ecr.aws/docker/library/busybox:1.37 sh -c 'ip -br a | head -4'
docker rm -f srv >/dev/null 2>&1
iptables -t nat -S | tail -4
