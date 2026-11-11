#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: one whole "job set" with Incus, from nothing to nothing, with timings.
#   A  = Control + doors (own dockerd, runc), outer NIC to the host proxy + inner NIC to B
#   B  = setup + agent (own dockerd; the agent is a privileged DinD container confined to B), inner NIC; the outer NIC is hot-plugged for the setup and unplugged for `narrow`
# Needs (made by setup.sh): pool `spike`, networks `spkout` and `spkin`, profile `spike`, image `spike-docker`, the host proxy on 10.99.0.1:3128.
# usage: jobset.sh <job-id> <slot 1..>     (slot picks the addresses: A 10.99.0.<10+slot>, B 10.99.0.<110+slot>)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
job=$1; slot=${2:-1}
A=spk-a-$job; B=spk-b-$job; AO=10.99.0.$((10 + slot)); BO=10.99.0.$((110 + slot))
ix() { sg incus-admin -c "incus $(printf '%q ' "$@") </dev/null" 2>&1 | tr '\r' '\n' | grep -v -E '^(Retrieving|Pushing|Pulling)|^ *$'; return "${PIPESTATUS[0]}"; }
ixs() { local i=$1; sg incus-admin -c "incus exec $i -- bash -s" 2>&1 | tr '\r' '\n'; return "${PIPESTATUS[0]}"; }
T0=$(date +%s.%N); mark() { printf '%-34s %6.2f s\n' "$1" "$(awk -v a=$T0 -v b=$(date +%s.%N) 'BEGIN{print b-a}')"; }

# 1. create both instances (marked with the job and the dispatcher's pid, which is what the reaper reads)
ix init spike-docker "$A" -p spike -c user.cr.job="$job" -c user.cr.owner=$$ >/dev/null
ix config device add "$A" eth0 nic network=spkout name=eth0 ipv4.address=$AO security.ipv4_filtering=true security.mac_filtering=true security.port_isolation=true >/dev/null
ix config device add "$A" eth1 nic network=spkin name=eth1 security.mac_filtering=true >/dev/null
ix config device add "$A" ctl proxy listen=unix:/run/ctl.sock connect=unix:/home/luca/incus-spike-pool-parent/ctl.sock bind=instance mode=0600 >/dev/null
ix init spike-docker "$B" -p spike -c user.cr.job="$job" -c user.cr.owner=$$ >/dev/null
ix config device add "$B" eth0 nic network=spkin name=eth0 security.mac_filtering=true >/dev/null
mark "both instances created"

# 2. start, give them their addresses (a real launcher pushes a file before the start), load A's inner wall
ix start "$A" "$B" >/dev/null
ixs "$A" <<EOF >/dev/null
ip addr add $AO/24 dev eth0; ip route replace default via 10.99.0.1 dev eth0; ip addr add 10.98.0.2/24 dev eth1
EOF
ixs "$B" <<EOF >/dev/null
ip addr add 10.98.0.3/24 dev eth0
EOF
ix file push "$HERE/inner-wall.nft" "$A/root/inner-wall.nft" >/dev/null
ixs "$A" <<'EOF' >/dev/null
nft -f /root/inner-wall.nft
EOF
ix file push "$HERE/proxy.py" "$A/root/proxy.py" >/dev/null
ixs "$A" <<'EOF2' >/dev/null
mkdir -p /run/control /run/modeldoor; echo FAKE-GIT-TOKEN > /run/control/git-token; echo FAKE-MODEL-KEY > /run/control/model-key; echo model-door-ok > /run/modeldoor/index.html
(cd /run/control && setsid nohup python3 -m http.server 9000 --bind 0.0.0.0 >/dev/null 2>&1 &)
(cd /run/control && setsid nohup python3 -m http.server 2375 --bind 0.0.0.0 >/dev/null 2>&1 &)
(cd /run/modeldoor && setsid nohup python3 -m http.server 8081 --bind 10.98.0.2 >/dev/null 2>&1 &)
setsid nohup python3 -I /root/proxy.py --listen 10.98.0.2 --port 8080 --upstream 10.99.0.1:3128 >/dev/null 2>&1 &
EOF2
until sg incus-admin -c "incus exec $A -- docker info" >/dev/null 2>&1; do sleep 0.05; done; mark "A: dockerd answers"
until sg incus-admin -c "incus exec $B -- docker info" >/dev/null 2>&1; do sleep 0.05; done; mark "B: dockerd answers"

# 3. setup phase: B gets its outer NIC (the proxy's wide rule), the setup starts Postgres in B's own Docker
ix config device add "$B" eth1 nic network=spkout name=eth1 ipv4.address=$BO security.ipv4_filtering=true security.mac_filtering=true security.port_isolation=true >/dev/null
ixs "$B" <<EOF >/dev/null
ip link set eth1 up; ip addr add $BO/24 dev eth1; ip route replace default via 10.99.0.1 dev eth1
EOF
mark "B: outer NIC for the setup"
ixs "$B" <<'EOF'
export HTTPS_PROXY=http://10.99.0.1:3128 NO_PROXY=localhost,127.0.0.1
docker run -d --name agent --privileged -e HTTPS_PROXY -e NO_PROXY --entrypoint dockerd docker:29.1.3-dind --host=unix:///var/run/docker.sock >/dev/null
for i in $(seq 1 300); do docker exec agent docker info >/dev/null 2>&1 && break; sleep 0.1; done
docker exec agent docker pull -q postgres:17-alpine >/dev/null
docker exec agent docker run -d --name pg -e POSTGRES_PASSWORD=x --network host postgres:17-alpine >/dev/null
for i in $(seq 1 100); do docker exec agent docker exec pg pg_isready -q && break; sleep 0.2; done
EOF
mark "B: setup done (dind + postgres up)"

# 4. narrow: unplug B's outer NIC (host proxy no longer reachable from B), then the agent's view
s=$(date +%s.%N); ix config device remove "$B" eth1 >/dev/null; e=$(date +%s.%N); printf '%-34s %6.3f s\n' "narrow (hot-unplug)" "$(awk -v a=$s -v b=$e 'BEGIN{print b-a}')"
ix file push "$HERE/probe.sh" "$B/root/probe.sh" >/dev/null
ixs "$B" <<'EOF'
/root/probe.sh 10.99.0.1:3128 10.98.0.2:8080 10.98.0.2:9000 10.98.0.2:2375
echo "--- from inside the agent's privileged DinD container (own netns, NAT through B):"
docker exec agent sh -c 'for t in 10.98.0.2:8080 10.98.0.2:8081 10.98.0.2:9000 10.98.0.2:2375 10.99.0.1:3128; do if nc -z -w2 ${t%:*} ${t#*:}; then echo "$t REACHED"; else echo "$t BLOCKED"; fi; done'
docker exec agent docker exec pg psql -U postgres -tAc 'select 6*7'
docker exec agent docker stop pg >/dev/null && echo "agent stopped the setup's postgres"
EOF
mark "agent phase done"

if [ -n "${KEEP:-}" ]; then echo "KEEP set: instances $A $B left running"; exit 0; fi
# 5. end of the job: delete both, the pool and the host are as before
ix delete -f "$A" "$B" >/dev/null
mark "both instances deleted"
