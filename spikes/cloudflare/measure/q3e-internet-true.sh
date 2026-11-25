# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: enableInternet=true with the same wildcard intercepts. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
c() { local label="$1"; shift; local out; out=$("$@" 2>&1 | tr '\n' ' ' | cut -c1-200); echo "  $label -> $out"; }
[ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ] && cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cf-ca.crt && update-ca-certificates >/dev/null 2>&1
echo "ip: $(ip -br a | grep cfeth0)"; ip r | head -2; grep nameserver /etc/resolv.conf | tr '\n' ' '; echo
c "dns example.com" getent hosts example.com
c "dns github.com" getent ahostsv4 github.com
c "dig @1.1.1.1 example.com" sh -c 'dig +time=3 +tries=1 @1.1.1.1 example.com | grep -E "^example|status"'
c "http example.com (intercepted?)" curl -sS -m 8 -o /dev/null -w "%{http_code} remote=%{remote_ip}\n" http://example.com
c "https example.com (CA of the door?)" sh -c "echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | grep -E 'issuer=' | head -1"
c "https www.facebook.com (not on list)" curl -sS -m 8 -o /dev/null -w "%{http_code} remote=%{remote_ip}\n" https://www.facebook.com
c "tcp github.com:22" timeout 6 nc -vz github.com 22
c "ssh banner github.com:22" sh -c 'timeout 5 nc github.com 22 </dev/null | head -c 40'
c "tcp 8.8.8.8:853" timeout 6 nc -vz 8.8.8.8 853
c "http example.com:8080 (other HTTP port)" curl -sS -m 6 -o /dev/null -w "%{http_code} remote=%{remote_ip}\n" http://example.com:8080/
c "https on 8443" curl -sS -m 6 -o /dev/null -w "%{http_code} remote=%{remote_ip}\n" https://example.com:8443/
c "icmp 1.1.1.1" ping -c1 -W3 1.1.1.1
c "metadata 169.254.169.254" curl -sS -m 4 -o /dev/null -w "%{http_code}\n" http://169.254.169.254/
c "private 10.0.0.2 HTTP" curl -sS -m 4 -o /dev/null -w "%{http_code}\n" http://10.0.0.2/
c "gateway ping 10.0.0.254" ping -c1 -W2 10.0.0.254
c "egress IP" curl -sS -m 6 https://api.ipify.org
