# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: a Sysbox agent container with the door's CA mounted. Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
P=public.ecr.aws/docker/library/python:3.13-alpine
docker pull -q $P >/dev/null
cat > /tmp/t.py <<'PY'
import urllib.request, urllib.error, os
def get(u, h=None):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=h or {}), timeout=6); return r.status, r.read(120)
    except urllib.error.HTTPError as e: return e.code, e.read(80)
    except Exception as e: return "ERR", repr(e)[:90]
for u in ["https://example.com/", "https://www.facebook.com/", "http://model.door/v1/chat", "https://model.door/v1/chat"]:
    print(u, get(u))
print("forged Authorization to model door:", get("http://model.door/v1/x", {"Authorization": "Bearer forged"})[1][:110])
PY
echo "--- Sysbox agent container, CA mounted + SSL_CERT_FILE (as the network door's trust files are today)"
docker run --rm --runtime=sysbox-runc -v /etc/cloudflare/certs:/cf:ro -v /tmp/t.py:/t.py:ro -e SSL_CERT_FILE=/cf/cloudflare-containers-ca.crt $P python3 /t.py
echo "--- same without the CA: TLS fails, so HTTPS needs the CA file in the agent's container"
docker run --rm --runtime=sysbox-runc -v /tmp/t.py:/t.py:ro $P python3 /t.py 2>&1 | head -3
