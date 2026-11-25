# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: throughput and latency through the outbound handler. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
[ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ] && cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cf-ca.crt && update-ca-certificates >/dev/null 2>&1
for mb in 10 100 300; do
 curl -sS -m 120 -o /dev/null -w "download ${mb} MB through the door: %{http_code} %{size_download}B in %{time_total}s = %{speed_download} B/s\n" "https://speed.cloudflare.com/__down?bytes=$((mb*1000000))"
done
echo "upload 50 MB (POST body through the handler):"
head -c 50000000 /dev/zero | curl -sS -m 120 -o /dev/null -w "upload: %{http_code} in %{time_total}s = %{speed_upload} B/s\n" --data-binary @- -H 'content-type: application/octet-stream' https://speed.cloudflare.com/__up
echo "many small requests: 100 sequential GETs of example.com:"
s=$(date +%s.%N); for i in $(seq 1 100); do curl -s -o /dev/null https://example.com/; done; python3 -c "import time;print('100 requests: %.1f s -> %.0f ms per request (new TLS handshake each)'%(time.time()-$s,(time.time()-$s)*10))"
