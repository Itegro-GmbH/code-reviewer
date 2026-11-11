# SPDX-License-Identifier: LicenseRef-Proprietary
# Spike #1005: the Dispatcher's side of the environment-control channel: a unix socket on the host, one JSON line in, one JSON line out.
import json, os, socket, sys
path = sys.argv[1]
if os.path.exists(path): os.unlink(path)
s = socket.socket(socket.AF_UNIX); s.bind(path); os.chmod(path, 0o666); s.listen(8)
while True:
    c, _ = s.accept()
    data = c.makefile("rb").readline()
    c.sendall((json.dumps({"type": "ack", "echo": json.loads(data)["n"]}) + "\n").encode())
    c.close()
