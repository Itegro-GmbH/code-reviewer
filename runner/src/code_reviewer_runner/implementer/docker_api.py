# SPDX-License-Identifier: LicenseRef-Proprietary

"""A small client of the Docker Engine API on the VM's Unix socket (#745, step 3).

The Control container starts the model door through the VM's Docker. It does so over the Engine
API, not through a `docker` command: a request is a JSON document, so a value that comes from a
job, from the agent or from the repository has no way to become an option of a command line, and
the image needs no client binary. The calls here are the few Control needs: look at its own
container, make a network, make a container, attach to it, start it, remove things.

**Control is effectively root on the VM** the moment it can reach this socket: the Engine API can
start a privileged container. That is accepted because the agent never reaches it (the socket is
root's in the container, the agent is another user, and in step 4 another container), and it is why
nothing of a job or of the agent's output is ever put into a request body here: every body is made
from constants of the runner and from the identifiers Docker itself answered with
(`door_launcher.py`).
"""

import contextlib
import http.client
import json
import socket
from collections.abc import Iterator
from typing import Any, Final

from code_reviewer_runner.job_loop.jsonvalues import as_object

DOCKER_SOCKET: Final = "/run/docker.sock"
DEFAULT_TIMEOUT_SECONDS: Final = 30.0
_MAX_BODY_BYTES: Final = 4 * 1024 * 1024
_STDOUT: Final = 1
_STDERR: Final = 2
_FRAME_HEADER: Final = 8
_MAX_FRAME_BYTES: Final = 8 * 1024 * 1024


class DockerError(Exception):
    """A call the daemon refused or could not answer. `status` is the HTTP status (0: no answer).
    The message is the daemon's own sentence, which names things of ours, never a key: nothing
    secret is ever in a request."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"docker {status}: {message}")
        self.status = status
        self.message = message


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("docker", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self._path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


class AttachedStreams:
    """The attached standard streams of one container: lines of its stdout to read, bytes of its
    stdin to write. One reader, any number of writers."""

    def __init__(self, sock: socket.socket, buffered: bytes) -> None:
        self._sock = sock
        self._pending = buffered
        self._stderr = bytearray()
        self._write_closed = False

    def write(self, data: bytes) -> None:
        self._sock.sendall(data)

    def close_write(self) -> None:
        """End the container's stdin (it reads the end of its input)."""
        if self._write_closed:
            return
        self._write_closed = True
        with contextlib.suppress(OSError):
            self._sock.shutdown(socket.SHUT_WR)

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self._sock.close()

    @property
    def stderr_tail(self) -> bytes:
        return bytes(self._stderr[-4096:])

    def _read(self, count: int) -> bytes | None:
        while len(self._pending) < count:
            try:
                chunk = self._sock.recv(65536)
            except (OSError, TimeoutError):
                return None
            if not chunk:
                return None
            self._pending += chunk
        data, self._pending = self._pending[:count], self._pending[count:]
        return data

    def lines(self) -> Iterator[bytes]:
        """The lines of the container's stdout, without their end, until the container's streams
        end (it exited or the connection broke). Its stderr is kept (`stderr_tail`)."""
        carry = b""
        while True:
            header = self._read(_FRAME_HEADER)
            if header is None:
                break
            kind, size = header[0], int.from_bytes(header[4:8], "big")
            if size > _MAX_FRAME_BYTES:
                break
            payload = self._read(size) if size else b""
            if payload is None:
                break
            if kind == _STDERR:
                self._stderr += payload
                del self._stderr[:-4096]
                continue
            if kind != _STDOUT:
                continue
            carry += payload
            while (end := carry.find(b"\n")) >= 0:
                line, carry = carry[:end], carry[end + 1 :]
                yield line
            if len(carry) > _MAX_FRAME_BYTES:
                break


class DockerApi:
    """The Engine API of one daemon, at one socket."""

    def __init__(
        self, socket_path: str = DOCKER_SOCKET, *, timeout: float = DEFAULT_TIMEOUT_SECONDS
    ) -> None:
        self._path = socket_path
        self._timeout = timeout

    # -- plain calls ----------------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        body: object | None = None,
        *,
        ok: tuple[int, ...] = (200, 201, 204),
        timeout: float | None = None,
    ) -> Any:
        """One call; the JSON answer, or None for an empty one. `DockerError` for any other
        status and for a daemon that cannot be reached."""
        connection = _UnixConnection(self._path, self._timeout if timeout is None else timeout)
        payload = None if body is None else json.dumps(body).encode()
        headers = {} if payload is None else {"Content-Type": "application/json"}
        try:
            connection.request(method, path, payload, headers)
            response = connection.getresponse()
            data = response.read(_MAX_BODY_BYTES + 1)
        except (OSError, http.client.HTTPException) as error:
            raise DockerError(0, f"the daemon did not answer ({type(error).__name__})") from None
        finally:
            connection.close()
        if response.status not in ok:
            raise DockerError(response.status, _message_of(data))
        if not data or len(data) > _MAX_BODY_BYTES:
            return None
        try:
            return json.loads(data)
        except ValueError:
            return None

    def ping(self) -> bool:
        try:
            self.request("GET", "/_ping", ok=(200,))
        except DockerError:
            return False
        return True

    def inspect_container(self, ref: str) -> dict[str, Any]:
        answer = as_object(self.request("GET", f"/containers/{ref}/json"))
        if answer is None:
            raise DockerError(0, "the daemon's answer is not a container")
        return answer

    def create_network(self, document: dict[str, Any]) -> str:
        return _identifier(self.request("POST", "/networks/create", document))

    def connect_network(self, network: str, document: dict[str, Any]) -> None:
        self.request("POST", f"/networks/{network}/connect", document)

    def disconnect_network(self, network: str, container: str) -> None:
        self.request(
            "POST", f"/networks/{network}/disconnect", {"Container": container, "Force": True}
        )

    def remove_network(self, network: str) -> None:
        self.request("DELETE", f"/networks/{network}", ok=(200, 204, 404))

    def create_container(self, document: dict[str, Any], name: str) -> str:
        return _identifier(self.request("POST", f"/containers/create?name={name}", document))

    def start_container(self, container: str) -> None:
        self.request("POST", f"/containers/{container}/start", ok=(204, 304))

    def remove_container(self, container: str) -> None:
        self.request("DELETE", f"/containers/{container}?force=1&v=1", ok=(200, 204, 404))

    # -- the standard streams -------------------------------------------------------------------

    def attach(self, container: str) -> AttachedStreams:
        """Attach to the standard streams of a container that was created (and may not have been
        started yet): the connection is upgraded to a raw stream of frames."""
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self._timeout)
        try:
            sock.connect(self._path)
            sock.sendall(
                (
                    f"POST /containers/{container}/attach?stream=1&stdin=1&stdout=1&stderr=1 "
                    "HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n"
                    "Content-Length: 0\r\n\r\n"
                ).encode()
            )
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk or len(head) > 16384:
                    raise DockerError(0, "the daemon did not upgrade the connection")
                head += chunk
        except OSError:
            sock.close()
            raise DockerError(0, "the daemon could not be reached to attach") from None
        except DockerError:
            sock.close()
            raise
        status_line, _, rest = head.partition(b"\r\n")
        status = int(status_line.split(b" ")[1]) if status_line.count(b" ") >= 1 else 0
        _, _, body = rest.partition(b"\r\n\r\n")
        if status not in (101, 200):
            sock.close()
            raise DockerError(status, "the daemon refused to attach")
        sock.settimeout(None)
        return AttachedStreams(sock, body)


def _message_of(data: bytes) -> str:
    try:
        document: Any = json.loads(data)
    except ValueError:
        return "no message"
    given = as_object(document)
    message: Any = None if given is None else given.get("message")
    return message[:300] if isinstance(message, str) else "no message"


def _identifier(answer: Any) -> str:
    given = as_object(answer)
    identifier: Any = None if given is None else given.get("Id")
    if not isinstance(identifier, str) or not identifier or not identifier.isalnum():
        raise DockerError(0, "the daemon's answer has no identifier")
    return identifier
