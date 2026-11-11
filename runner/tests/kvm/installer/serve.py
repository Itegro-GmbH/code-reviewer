# SPDX-License-Identifier: LicenseRef-Proprietary

"""Serves a directory over https on the loopback with a throwaway certificate (the installer lane,
#982): the release addresses must be https, so the lane brings its own certificate authority and
tells the installer's curl about it with `--curl-config` (`cacert = ...`), the way a protected
release address would be reached."""

import functools
import http.server
import ssl
import sys
import time
from pathlib import Path


class Handler(http.server.SimpleHTTPRequestHandler):
    """A file for which `<name>.slow` exists in the directory is sent after that many seconds (the
    lane's slow download: the machine must go on meanwhile)."""

    def do_GET(self) -> None:
        marker = Path(self.directory) / (self.path.lstrip("/").split("?")[0] + ".slow")
        if marker.exists():
            time.sleep(float(marker.read_text().strip() or "0"))
        super().do_GET()


def main() -> None:
    directory, certificate, key, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    handler = functools.partial(Handler, directory=directory)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(Path(certificate), Path(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
