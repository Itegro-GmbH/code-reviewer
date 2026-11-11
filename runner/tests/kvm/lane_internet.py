# SPDX-License-Identifier: LicenseRef-Proprietary

"""The internet of the whole-job lane (#999; not a test file): public-looking names for the lane's
fakes, and the two seams that make the real outer-wall proxy reach them.

The proxy refuses every private address by design and has no test network
(`NETDOOR_TEST_PUBLIC_CIDR` is not used), and the lane's fakes are on the host's loopback.
`ProxyOuterWall` takes a resolver and a connector (the seams its unit tests use): **the decision stays real** (the rule lists the name
before anything is looked up, the address must be public, the connection goes to the address that
was checked, ports 80 and 443 only), and only the last step is the lane's: the name resolves to a
public-looking address (`151.101.1.x`, in no refused range), and a connection to that address and
port is made to the fake's port on the loopback. An address or a port that no fake stands behind is
**refused** (`OSError`, which the proxy answers as unreachable): nothing here reaches a real host.

The names are below `lane.example.com`, the one domain the lane's test CA signs for
(`lane_pki.py`)."""

import socket
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Final

from lane_pki import LANE_DOMAIN

GIT_HOST: Final = f"git.{LANE_DOMAIN}"
MODEL_HOST: Final = f"models.{LANE_DOMAIN}"
APP_HOST: Final = f"app.{LANE_DOMAIN}"
# The host the setup script and the agent fetch from: plain http, port 80.
FILES_HOST: Final = f"files.{LANE_DOMAIN}"
# A host the setup script may reach (the setup's rule is wide) and the job's rule does not list.
SETUP_ONLY_HOST: Final = f"mirror.{LANE_DOMAIN}"


@dataclass
class LaneInternet:
    """Names, public-looking addresses and where each fake listens."""

    names: dict[str, str] = field(default_factory=dict[str, str])
    routes: dict[tuple[str, int], int] = field(default_factory=dict[tuple[str, int], int])
    # Every connection the proxy made, in order: (address, port, the loopback port it went to).
    dialled: list[tuple[str, int, int]] = field(default_factory=list[tuple[str, int, int]])
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def expose(self, name: str, port: int, local_port: int) -> None:
        """`name` on `port` is the fake that listens on the loopback at `local_port`."""
        address = self.names.setdefault(name, f"151.101.1.{10 + len(self.names)}")
        self.routes[(address, port)] = local_port

    def resolve(self, name: str, port: int) -> list[str]:
        """The proxy's resolver: the address of a lane name; an error for any other (no DNS)."""
        _ = port
        address = self.names.get(name)
        if address is None:
            raise OSError(f"{name} is not a name of the lane")
        return [address]

    def connect(self, address: str, port: int, timeout: float) -> socket.socket:
        """The proxy's connector: the loopback port behind an address and port, or a refusal."""
        local = self.routes.get((address, port))
        if local is None:
            raise OSError(f"nothing of the lane stands behind {address}:{port}")
        with self._lock:
            self.dialled.append((address, port, local))
        return socket.create_connection(("127.0.0.1", local), timeout)


@dataclass
class Fetched:
    path: str
    host: str
    at: float


class FilesHost:
    """A plain http host with two files, and a note of who asked for what and when: the setup
    script fetches `/setup`, the agent (through its door) fetches `/agent`."""

    SETUP_BODY: Final = b"the setup reached a public-looking host through the proxy\n"
    AGENT_BODY: Final = b"the agent reached it through the network door and the proxy\n"

    def __init__(self) -> None:
        self.requests: list[Fetched] = []
        files = {"/setup": self.SETUP_BODY, "/agent": self.AGENT_BODY}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                return

            def do_GET(self) -> None:
                outer.requests.append(
                    Fetched(self.path, self.headers.get("Host", ""), time.monotonic())
                )
                body = files.get(self.path)
                self.send_response(200 if body is not None else 404)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body or b"")))
                self.end_headers()
                self.wfile.write(body or b"")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    def __enter__(self) -> "FilesHost":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._server.shutdown()
        self._server.server_close()
