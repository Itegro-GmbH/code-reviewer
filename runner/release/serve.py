# SPDX-License-Identifier: LicenseRef-Proprietary

"""Serves a directory over https on the loopback with a throwaway certificate (the program lane,
#1002): the installer takes only https release addresses, so the lane brings its own certificate
authority and tells the installer's curl about it with `--curl-config` (`cacert = ...`), the way a
protected release address would be reached.

    serve.py DIRECTORY CERTIFICATE KEY PORT
"""

import functools
import http.server
import ssl
import sys
from pathlib import Path


def main() -> None:
    directory, certificate, key, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(Path(certificate), Path(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
