# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: what a restored snapshot has. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
ls -lh /root/blob.bin /root/dind.tgz 2>&1 | awk '{print $5, $9}'; df -BM / | awk 'NR==2{print "root used "$3" avail "$4}'
ps -eo pid,comm | head -5
bash /opt/probes/boot.sh | tail -2
docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}'
