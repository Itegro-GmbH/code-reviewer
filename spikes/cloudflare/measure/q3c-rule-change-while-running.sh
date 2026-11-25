# SPDX-License-Identifier: LicenseRef-Proprietary
#
# Spike #1149 probe: a rule change while a keep-alive HTTPS connection is open (the narrow step). Sent to the container with measure/cf.sh <box> run <file>; the raw answers are in ../results/.
cat > /tmp/loop.py <<'PY'
import http.client, ssl, time, json
out=[]
t0=time.time()
# one persistent HTTPS connection (keep-alive) AND fresh connections, polled every 0.25 s for 14 s
ctx=ssl.create_default_context()
conn=http.client.HTTPSConnection("example.com", context=ctx, timeout=10)
for i in range(56):
    t=time.time()-t0
    try:
        conn.request("GET","/"); r=conn.getresponse(); r.read(); keep=r.status
    except Exception as e:
        keep=f"ERR {type(e).__name__}"
        conn=http.client.HTTPSConnection("example.com", context=ctx, timeout=10)
    try:
        c2=http.client.HTTPSConnection("example.com", context=ctx, timeout=10); c2.request("GET","/"); r2=c2.getresponse(); r2.read(); fresh=r2.status; c2.close()
    except Exception as e: fresh=f"ERR {type(e).__name__}"
    out.append((round(t,2),keep,fresh)); time.sleep(0.2)
json.dump(out,open("/tmp/loop.json","w"))
PY
nohup python3 /tmp/loop.py >/tmp/loop.log 2>&1 &
echo started at $(date +%s.%N)
