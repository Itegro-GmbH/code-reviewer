# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: private and link-local addresses through a handler that ALLOWS them, and a 90 MB download. Sent with measure/cf.sh <box> run <file>.
[ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ] && cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cf-ca.crt && update-ca-certificates >/dev/null 2>&1
for u in http://10.0.0.2/ http://10.0.0.254/ http://169.254.169.254/ http://127.0.0.1/ http://192.168.1.1/ http://localhost/ http://100.64.0.1/; do
  printf "%s -> " $u; curl -sS -m 8 -o /dev/null -w "%{http_code}\n" $u 2>&1 | tail -1
done
curl -sS -m 120 -o /dev/null -w "download 90 MB through the door: %{http_code} %{size_download}B in %{time_total}s = %{speed_download} B/s\n" "https://speed.cloudflare.com/__down?bytes=90000000"
