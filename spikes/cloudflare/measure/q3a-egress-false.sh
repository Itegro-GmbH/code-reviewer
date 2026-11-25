# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: enableInternet=false: DNS, HTTP(S) through the door, IP literals, ports, UDP, ICMP, neighbours. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
c() { local label="$1"; shift; local out; out=$("$@" 2>&1 | tr '\n' ' ' | cut -c1-170); echo "  $label -> $out"; }
echo "--- DNS (what does a name resolve to when enableInternet=false?)"
c "example.com (allowed host)" getent hosts example.com
c "github.com" getent hosts github.com
c "model.door (only exists in the Worker)" getent hosts model.door
c "not-intercepted-name.invalid" getent hosts nothing.example.invalid
c "resolv.conf" sh -c 'grep -v "^#" /etc/resolv.conf'
echo "--- HTTP/HTTPS through the door, allowed host"
c "http example.com" curl -sS -m 8 -o /dev/null -w "%{http_code} remote=%{remote_ip}:%{remote_port}\n" http://example.com
c "https example.com" curl -sS -m 8 -o /dev/null -w "%{http_code} verify=%{ssl_verify_result} remote=%{remote_ip}\n" https://example.com
c "https example.com issuer" sh -c "echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | grep -E 'issuer=|subject=' | head -2"
echo "--- host not on the list"
c "https github.com is on list; try facebook.com (not listed)" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" https://www.facebook.com
c "http facebook.com" curl -sS -m 8 -i http://www.facebook.com
echo "--- the model door (hostname that exists only in the Worker, key lives there)"
c "model.door" curl -sS -m 8 -X POST -d '{"messages":[]}' http://model.door/v1/chat
c "model.door with a fake Authorization from the container" curl -sS -m 8 -H 'authorization: Bearer container-made-up' http://model.door/v1/x
c "model.door over https (needs a handler for https model.door)" curl -sS -m 8 https://model.door/v1/x
echo "--- IP literals, other ports, other protocols (enableInternet=false)"
c "https://1.1.1.1/ (IP, no SNI of a listed name)" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" https://1.1.1.1/
c "http://1.1.1.1/" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" http://1.1.1.1/
c "http://example.com:8080/" curl -sS -m 6 -o /dev/null -w "%{http_code}\n" http://example.com:8080/
c "https://example.com:8443/" curl -sS -m 6 -o /dev/null -w "%{http_code}\n" https://example.com:8443/
c "tcp github.com:22 (ssh)" timeout 6 nc -vz github.com 22
c "tcp 1.1.1.1:443 raw" timeout 6 nc -vz 1.1.1.1 443
c "tcp 1.1.1.1:53 raw" timeout 6 nc -vz 1.1.1.1 53
c "udp 1.1.1.1:53 dig" dig +time=3 +tries=1 @1.1.1.1 example.com
c "icmp 1.1.1.1" ping -c1 -W3 1.1.1.1
c "icmp gateway 10.0.0.254" ping -c1 -W3 10.0.0.254
echo "--- the VM's own network"
ip -br a | grep cfeth0; ip r | head -3; arp -n 2>/dev/null | head -3; ip neigh | head -3
c "scan the /24 neighbours quick (1 port)" sh -c 'for h in 2 3 10 100 254; do timeout 1 nc -vz 10.0.0.$h 80 2>&1 | head -1; done'
c "metadata 169.254.169.254" curl -sS -m 4 http://169.254.169.254/
