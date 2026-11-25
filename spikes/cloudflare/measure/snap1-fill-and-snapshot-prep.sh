# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: fill the disk, preload path (docker save | load), stop dockerd. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "   [$(python3 -c "import time;print(round(time.time()-$s,2))") s rc=$rc] $*" | cut -c1-170; }
D=public.ecr.aws/docker/library/docker:29.1.3-dind
t docker pull -q $D
t sh -c 'dd if=/dev/urandom of=/root/blob.bin bs=1M count=600 status=none'
echo "inner images: $(docker image ls --format '{{.Repository}}:{{.Tag}}' | tr '\n' ' ')"
df -BM / | awk 'NR==2{print "root used "$3" avail "$4}'
echo "--- docker save | load of the 511 MB dind image into a Sysbox inner daemon (the preload path):"
docker rm -f agent >/dev/null 2>&1; docker run -d --name agent --runtime=sysbox-runc $D >/dev/null
for i in $(seq 1 100); do docker exec agent docker info >/dev/null 2>&1 && break; sleep 0.2; done
t sh -c "docker save $D | docker exec -i agent docker load | tail -1"
docker rm -f agent >/dev/null 2>&1
echo "--- plain tar of the image (pigz):"; t sh -c "docker save $D | pigz -1 > /root/dind.tgz"; ls -lh /root/dind.tgz | awk '{print $5}'
pkill -x dockerd; sleep 2; sync
