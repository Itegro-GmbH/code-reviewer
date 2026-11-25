# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: the Worker-only model door, Host header vs TLS SNI, raw ports. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
c() { local label="$1"; shift; local out; out=$("$@" 2>&1 | tr '\n' ' ' | cut -c1-230); echo "  $label -> $out"; }
echo "--- the model door (hostname only in the Worker; key lives in the Worker)"
c "http model.door" curl -sS -m 8 -X POST -d '{"messages":[]}' http://model.door/v1/chat
c "http model.door + forged Authorization" curl -sS -m 8 -H 'authorization: Bearer container-made-up' http://model.door/v1/x
c "https model.door" curl -sS -m 8 https://model.door/v1/x
c "container env/files mention the key?" sh -c 'grep -rIl "FAKE-MODEL-KEY" /proc/*/environ /etc /root /tmp /opt /run 2>/dev/null | head -3; echo scan-done'
echo "--- dig details (UDP :53 to 1.1.1.1 with enableInternet=false)"
dig +time=3 +tries=1 @1.1.1.1 example.com | grep -E 'status|ANSWER SECTION|^example|SERVER'
dig +time=3 +tries=1 @8.8.8.8 anything.invalid AAAA | grep -E 'status|ANSWER SECTION|SERVER|^anything'
c "tcp 1.1.1.1:443 then raw bytes (not TLS)" sh -c 'printf "GET / HTTP/1.0\r\n\r\n" | timeout 5 nc 1.1.1.1 443 | head -c 100'
c "tcp 1.1.1.1:80 raw HTTP" sh -c 'printf "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n" | timeout 5 nc 1.1.1.1 80 | head -c 60'
c "ssh-like tcp 22 to 140.82.112.3 (github)" timeout 6 nc -vz 140.82.112.3 22
c "tcp 8.8.8.8:853" timeout 6 nc -vz 8.8.8.8 853
echo "--- Host header vs TLS SNI: ask for example.com on the wire but send Host: www.facebook.com (docs: URL comes from Host!)"
c "https example.com, Host: www.facebook.com" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" -H 'Host: www.facebook.com' https://example.com/
c "http example.com, Host: www.facebook.com" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" -H 'Host: www.facebook.com' http://example.com/
c "https example.com, SNI example.com, Host: github.com" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" -H 'Host: github.com' https://example.com/
c "--connect-to: SNI www.facebook.com to the placeholder of example.com" curl -sS -m 8 -o /dev/null -w "%{http_code}\n" --connect-to www.facebook.com:443:example.com:443 https://www.facebook.com/
