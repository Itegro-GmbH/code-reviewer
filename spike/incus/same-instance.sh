#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005, second run (Incus 7.6, btrfs): ONE job set where setup and agent run in the SAME instance (owner decision: what the setup starts keeps running for the agent),
# with the walls checked on the way, each probe with its control:
#   A  = Control + doors (secrets on :9000, a Docker API stand-in on :2375, doors :8080/:8081), outer NIC + inner NIC, the inner wall (nft) loaded inside it
#   B  = setup, then agent: B's own dockerd runs the setup's Postgres and a service; the agent is a privileged DinD container started AFTER `narrow`, in the same instance
# Needs setup.sh's objects (SPIKE_POOL=crpool), the image `spike-docker`, the host proxy on 10.99.0.1:3128, a decoy listener of the host (decoy.py 9999), ctl-echo.py on the control socket.
# usage: same-instance.sh <job-id> <slot>      env: HOST_V4, HOST_V6 (the machine's own addresses, for the outer probes; never written to a file of the repository)
set -u
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/lib.sh"
job=$1; slot=${2:-1}
A=spk-a-$job; B=spk-b-$job; AO=10.99.0.$((10 + slot)); BO=10.99.0.$((110 + slot))
T0=$(date +%s.%N); mark() { printf '%-52s %6.2f s\n' "$1" "$(awk -v a=$T0 -v b=$(date +%s.%N) 'BEGIN{print b-a}')"; }
say() { printf '\n=== %s\n' "$1"; }
outer_probe() { # outer_probe <instance>: the targets of outer-targets.txt with the machine's addresses filled in
  sed "s/@HOST_V4@/${HOST_V4:-192.0.2.1}/; s/@HOST_V6@/${HOST_V6:-2001:db8::1}/" "$HERE/outer-targets.txt" | tr '\n' ' ' > /tmp/spk-targets.$$
  ix file push /tmp/spk-targets.$$ "$1/root/targets" >/dev/null; rm -f /tmp/spk-targets.$$
  ixs "$1" <<<'/root/probe.sh $(cat /root/targets)'
}

say "1. create both instances (marked with the job)"
ix init spike-docker "$A" -p spike -c user.cr.job="$job" -c user.cr.owner=$$ >/dev/null
ix config device add "$A" eth0 nic network=spkout name=eth0 ipv4.address=$AO security.ipv4_filtering=true security.mac_filtering=true security.port_isolation=true >/dev/null
ix config device add "$A" eth1 nic network=spkin name=eth1 security.mac_filtering=true >/dev/null
ix config device add "$A" ctl proxy listen=unix:/ctl.sock connect=unix:/home/luca/incus-spike-pool-parent/ctl.sock bind=instance mode=0600 >/dev/null
ix init spike-docker "$B" -p spike -c user.cr.job="$job" -c user.cr.owner=$$ >/dev/null
ix config device add "$B" eth0 nic network=spkin name=eth0 security.mac_filtering=true >/dev/null
mark "both instances created (init x2 + devices)"
ix start "$A" "$B" >/dev/null
ixs "$A" <<EOF >/dev/null
ip addr add $AO/24 dev eth0; ip route replace default via 10.99.0.1 dev eth0; ip addr add 10.98.0.2/24 dev eth1
EOF
ixs "$B" <<EOF >/dev/null
ip addr add 10.98.0.3/24 dev eth0
EOF
ix file push "$HERE/inner-wall.nft" "$A/root/inner-wall.nft" "$HERE/proxy.py" "$A/root/" >/dev/null
ix file push "$HERE/probe.sh" "$HERE/ctl-client.py" "$HERE/srcprobe.py" "$A/root/" >/dev/null
ix file push "$HERE/probe.sh" "$HERE/srcprobe.py" "$B/root/" >/dev/null
ixs "$A" <<'EOF2' >/dev/null
mkdir -p /run/control /run/modeldoor; echo FAKE-GIT-TOKEN > /run/control/git-token; echo FAKE-MODEL-KEY > /run/control/model-key; echo model-door-ok > /run/modeldoor/index.html
(cd /run/control && setsid nohup python3 -m http.server 9000 --bind 0.0.0.0 >/dev/null 2>&1 &)
(cd /run/control && setsid nohup python3 -m http.server 2375 --bind 0.0.0.0 >/dev/null 2>&1 &)
(cd /run/modeldoor && setsid nohup python3 -m http.server 8081 --bind 10.98.0.2 >/dev/null 2>&1 &)
setsid nohup python3 -I /root/proxy.py --listen 10.98.0.2 --port 8080 --upstream 10.99.0.1:3128 >/dev/null 2>&1 &
EOF2
until sg incus-admin -c "incus exec $A -- docker info" >/dev/null 2>&1 </dev/null; do sleep 0.05; done; mark "A: dockerd answers"
until sg incus-admin -c "incus exec $B -- docker info" >/dev/null 2>&1 </dev/null; do sleep 0.05; done; mark "B: dockerd answers"

say "2. INNER WALL, control: the wall is not loaded yet; from B (a REACHED here proves the probe can reach)"
ixs "$B" <<<'/root/probe.sh 10.98.0.2:9000 10.98.0.2:2375 10.98.0.2:8080 10.98.0.2:8081 10.98.0.2:22; ping -c2 -W1 10.98.0.2 | tail -2 | head -1'
ix file push "$HERE/inner-wall.nft" "$A/root/inner-wall.nft" >/dev/null
ixs "$A" <<<'nft -f /root/inner-wall.nft && nft list tables'
say "2b. INNER WALL, loaded: from B"
ixs "$B" <<<'/root/probe.sh 10.98.0.2:9000 10.98.0.2:2375 10.98.0.2:8080 10.98.0.2:8081 10.98.0.2:22; ping -c2 -W1 10.98.0.2 | tail -2 | head -1; echo "--- through A as a router:"; ip route add default via 10.98.0.2 dev eth0 metric 5; /root/probe.sh 1.1.1.1:443 10.99.0.1:3128 10.99.0.'$((10 + slot))':9000; ip route del default via 10.98.0.2 dev eth0 metric 5'
mark "inner wall checked (control + wall)"

say "3. SETUP phase: B gets the outer NIC (wide rule), OUTER WALL probed from A and from B's setup NIC"
ix config device add "$B" eth1 nic network=spkout name=eth1 ipv4.address=$BO security.ipv4_filtering=true security.mac_filtering=true security.port_isolation=true >/dev/null
ixs "$B" <<EOF >/dev/null
ip link set eth1 up; ip addr add $BO/24 dev eth1; ip route replace default via 10.99.0.1 dev eth1
EOF
echo "--- outer wall, from A:"; outer_probe "$A"
echo "--- outer wall, from B (setup NIC):"; outer_probe "$B"
echo "--- second path: B (outer NIC) to A's outer address, secrets and Docker API (port isolation on both NICs):"
ixs "$B" <<<"/root/probe.sh $AO:9000 $AO:2375"
echo "--- source address check: B declares $BO, tries another slot's source:"
ixs "$B" <<<"ip addr add 10.99.0.$((200 + slot))/24 dev eth1; python3 /root/srcprobe.py $BO 10.99.0.1 3128; python3 /root/srcprobe.py 10.99.0.$((200 + slot)) 10.99.0.1 3128; ip addr del 10.99.0.$((200 + slot))/24 dev eth1"
mark "outer wall checked"
say "3b. OUTER WALL control: ACL off on the bridge, B's NIC re-plugged without isolation and filtering (REACHED here proves the probes can reach). A live change of security.* on a running NIC did not take effect on 7.6: re-plug"
plug() { # plug <with-security: yes|no>
  ix config device remove "$B" eth1 >/dev/null
  if [ "$1" = yes ]; then ix config device add "$B" eth1 nic network=spkout name=eth1 ipv4.address=$BO security.ipv4_filtering=true security.mac_filtering=true security.port_isolation=true >/dev/null
  else ix config device add "$B" eth1 nic network=spkout name=eth1 >/dev/null; fi   # no static address either: Incus refuses one without ipv4_filtering
  ixs "$B" <<EOF
ip link set eth1 up; ip addr add $BO/24 dev eth1; ip route replace default via 10.99.0.1 dev eth1
EOF
}
ix network unset spkout security.acls >/dev/null; plug no
echo "--- from B, no wall:"; outer_probe "$B"
echo "--- B to A's outer address, no isolation:"; ixs "$B" <<<"/root/probe.sh $AO:9000 $AO:2375"
echo "--- source address, no filtering:"; ixs "$B" <<<"ip addr add 10.99.0.$((200 + slot))/24 dev eth1; python3 /root/srcprobe.py 10.99.0.$((200 + slot)) 10.99.0.1 3128; ip addr del 10.99.0.$((200 + slot))/24 dev eth1"
ix network set spkout security.acls=spk-outer >/dev/null; plug yes
echo "--- wall restored (ACL, isolation, filtering), from B again:"; ixs "$B" <<<"/root/probe.sh 10.99.0.1:22 10.99.0.1:9999 10.99.0.1:3128 10.206.108.1:53 $AO:9000"
echo "--- what the host's decoy saw (sources of the connections that reached it):"; sort "${DECOY_LOG:-/dev/null}" | uniq -c
mark "outer wall control done, wall restored"

say "4. SETUP (in B, with B's own Docker): Postgres, a service, a file; the images the agent will need stay in B's Docker"
ixs "$B" <<'EOF'
export HTTPS_PROXY=http://10.99.0.1:3128 NO_PROXY=localhost,127.0.0.1
docker run -d --name pg --restart unless-stopped -e POSTGRES_PASSWORD=x -p 127.0.0.1:5432:5432 postgres:17-alpine >/dev/null
for i in $(seq 1 150); do docker exec pg pg_isready -q -h 127.0.0.1 && break; sleep 0.2; done   # TCP: the image's first, temporary server listens on the socket only
docker exec pg psql -U postgres -tAc "create table setup_made(v int); insert into setup_made values (7)" >/dev/null
systemd-run --quiet --unit=setup-service python3 -m http.server 7777 --bind 172.17.0.1
echo "setup wrote this" > /root/setup-file
docker ps --format 'setup started: {{.Names}} {{.Status}}'; systemctl is-active setup-service
EOF
mark "setup done (Postgres up, service up)"

say "5. narrow: B's outer NIC is hot-unplugged; the instance keeps running with everything the setup started"
s=$(date +%s.%N); ix config device remove "$B" eth1 >/dev/null; e=$(date +%s.%N); printf 'narrow (hot-unplug)  %6.3f s\n' "$(awk -v a=$s -v b=$e 'BEGIN{print b-a}')"
ixs "$B" <<'EOF'
/root/probe.sh 10.99.0.1:3128
docker ps --format 'still running: {{.Names}} {{.Status}}'; systemctl is-active setup-service; cat /root/setup-file
EOF

say "6. AGENT phase (same instance B): privileged DinD container started now, images handed over from B's Docker (no network)"
ixs "$B" <<'EOF'
now() { date +%s.%N; }; el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f s", b-a}'; }
t=$(now); docker run -d --name agent --privileged -v /var/run/docker.sock:/var/run/outer.sock --entrypoint dockerd docker:29.1.3-dind --host=unix:///var/run/docker.sock >/dev/null
for i in $(seq 1 300); do docker exec agent docker info >/dev/null 2>&1 && break; sleep 0.1; done; echo "agent dind ready $(el $t $(now))"
t=$(now); docker save postgres:17-alpine busybox | docker exec -i agent docker load | tail -2; echo "images handed over (save|load) $(el $t $(now))"
PGIP=$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' pg); echo "pg of the setup is at $PGIP"
echo "--- the agent uses what the setup started (a client container of the agent's OWN Docker talks to the setup's Postgres):"
docker exec agent docker run --rm --network host -e PGPASSWORD=x postgres:17-alpine psql -h $PGIP -U postgres -tAc "select v from setup_made; insert into setup_made values (8); select count(*) from setup_made"
echo "--- the setup's service and file, seen from the agent:"
docker exec agent sh -c 'wget -qO- http://172.17.0.1:7777/ 2>&1 | head -c 80; echo' || true
echo "--- the agent's own Docker: run, build, nested default bridge:"
docker exec agent sh -c 'docker run --rm busybox echo agent-run-ok; mkdir -p /tmp/b && cd /tmp/b && printf "FROM busybox\nRUN echo built > /x\n" > Dockerfile && docker build -q -t agent-built . >/dev/null && docker run --rm agent-built cat /x'
echo "--- the agent stops the setup's Postgres (B's Docker through the mounted socket), starts it again, the row is still there:"
docker exec agent docker -H unix:///var/run/outer.sock stop pg >/dev/null && docker ps -a --format '{{.Names}} {{.Status}}' | grep pg
docker exec agent docker -H unix:///var/run/outer.sock start pg >/dev/null; for i in $(seq 1 150); do docker exec pg pg_isready -q -h 127.0.0.1 && break; sleep 0.2; done
docker exec pg psql -U postgres -tAc "select string_agg(v::text, ',' order by v) from setup_made"
EOF
mark "agent phase (same instance) done"

say "7. INNER WALL again, after narrow, from B and from the agent container (own netns) and a container of the agent's Docker (third level, default bridge)"
ixs "$B" <<'EOF'
echo "--- B:"; /root/probe.sh 10.98.0.2:8080 10.98.0.2:8081 10.98.0.2:9000 10.98.0.2:2375 10.99.0.1:3128
echo "--- agent container:"
docker exec agent sh -c 'for t in 10.98.0.2:8080 10.98.0.2:8081 10.98.0.2:9000 10.98.0.2:2375 10.99.0.1:3128; do if nc -z -w2 ${t%:*} ${t#*:}; then echo "$t REACHED"; else echo "$t BLOCKED"; fi; done'
echo "--- a container inside the agent (default bridge, NAT through two layers):"
docker exec agent docker run --rm busybox sh -c 'for t in 10.98.0.2:8080 10.98.0.2:8081 10.98.0.2:9000 10.98.0.2:2375 10.99.0.1:3128; do if nc -z -w2 ${t%:*} ${t#*:}; then echo "$t REACHED"; else echo "$t BLOCKED"; fi; done'
EOF
ixs "$B" <<<'curl -s -m3 -x http://10.98.0.2:8080 -o /dev/null -w "through the network door to the host proxy: HTTP %{http_code}\n" https://example.com/ || true; curl -s -m3 http://10.98.0.2:8081/'
echo "--- control channel (unix socket proxy device) from A:"; ixs "$A" <<<'python3 /root/ctl-client.py /ctl.sock'
mark "inner wall after narrow checked"
if [ -n "${KEEP:-}" ]; then echo "KEEP set: $A $B left running"; exit 0; fi
say "8. end of the job"
ix delete -f "$A" "$B" >/dev/null
mark "both instances deleted"
