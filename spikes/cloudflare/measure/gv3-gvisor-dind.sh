# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: dockerd inside gVisor. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
D=public.ecr.aws/docker/library/docker:29.1.3-dind
docker image inspect $D >/dev/null 2>&1 || docker pull -q $D >/dev/null
# default runsc platform in daemon.json is kvm now (last loop iteration)
docker rm -f g >/dev/null 2>&1
docker run -d --name g --runtime=runsc --privileged $D >/dev/null 2>&1; echo "run rc=$?"
for i in $(seq 1 40); do docker exec g docker info >/dev/null 2>&1 && { echo "inner dockerd ready after $((i/2))s"; break; }; sleep 0.5; done
docker exec g docker info 2>&1 | grep -E 'Storage Driver|Cgroup|Server Version' | head -3
echo "--- inner log:"; docker logs g 2>&1 | grep -iE 'level=(error|fatal|warning)|failed|cannot|operation not' | head -6 | cut -c1-260
docker rm -f g >/dev/null 2>&1
