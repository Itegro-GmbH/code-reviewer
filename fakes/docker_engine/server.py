# SPDX-License-Identifier: LicenseRef-Proprietary

"""A fake Docker Engine on a Unix socket (#745, step 3).

It speaks the part of the Engine API that the Implementer's Control container uses to start the
model door (`runner/src/code_reviewer_runner/implementer/docker_api.py`): ping, inspect, networks,
create, attach (the connection upgrade and the multiplexed frames), start and remove. The runner's
client runs against it unchanged. A "container" is a function: it gets the container's stdin (a
binary stream, `readline` until the end) and writes lines to its stdout, and the code it returns is
the exit code. Tests make it the real door (`run_door`, in a thread) or anything that misbehaves.

Step 4 of the sandbox plan adds what Control needs for the agent's container and the reader:
`kill`, `GET /info` (the runtimes), `GET /images/<ref>/json`, `POST /containers/<id>/wait` that
blocks until the container is gone, and exec: create, start (detached, or attached with the
connection upgrade and the multiplexed frames) and inspect. An exec is a function too
(`exec_behaviour`): it gets the command, its environment and directory, its stdin as a binary
stream and a writer for its stdout, and returns the exit code.

What it records, for the tests: every request (`calls`: method, path, JSON body), the containers
with the document they were made from, the networks and who joined them and the execs. Nothing here
talks to a real daemon, a real network or a real model.
"""

import contextlib
import json
import os
import select
import socket
import socketserver
import struct
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

# The roles of the helpers that run once and end (door rules, Setup rules, a bridge's IPv6).
ONE_SHOT_ROLES = frozenset({"model-door-rules", "setup-rules", "setup-rules-check", "bridge-ipv6"})
IMAGE_ID = "sha256:" + "ab" * 32
AGENT_IMAGE_ID = "sha256:" + "cd" * 32
WORK_VOLUME = "code-reviewer-work-job-1"
OWN_ID = "c0ffee" + "0" * 58
HOSTNAME = OWN_ID[:12]


class _Stdout:
    """What a container writes its stdout to."""

    def __init__(self, descriptor: int) -> None:
        self._descriptor = descriptor

    def write(self, text: str) -> int:
        with contextlib.suppress(OSError):
            os.write(self._descriptor, text.encode())
        return len(text)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        with contextlib.suppress(OSError):
            os.close(self._descriptor)


# A container: (stdin, stdout, stderr writer) -> exit code.
Behaviour = Callable[[BinaryIO, _Stdout, Callable[[str], None]], int]


@dataclass
class FakeExec:
    identifier: str
    container: str
    document: dict[str, Any]
    running: bool = False
    exit_code: int | None = None
    # Set when its container is killed or stopped: a behaviour that waits should wait on this.
    killed: threading.Event = field(default_factory=threading.Event)


# An exec: (the exec, its stdin, its stdout) -> exit code.
ExecBehaviour = Callable[[FakeExec, BinaryIO, "_Stdout"], int]


@dataclass
class FakeContainer:
    identifier: str
    name: str
    document: dict[str, Any]
    networks: dict[str, dict[str, Any]] = field(default_factory=lambda: {})
    running: bool = False
    exit_code: int | None = None
    oom_killed: bool = False
    removed: bool = False
    stdin_read: int = -1
    stdin_write: int = -1
    stdout_read: int = -1
    stdout_write: int = -1
    stderr_text: list[str] = field(default_factory=lambda: [])
    # Everything that came on the container's stdin through the attached connection.
    stdin_received: bytearray = field(default_factory=lambda: bytearray())


class FakeDockerEngine:
    def __init__(self, socket_path: Path, behaviour: Behaviour | None = None) -> None:
        self.socket_path = socket_path
        self.behaviour = behaviour
        self.calls: list[tuple[str, str, Any]] = []
        self.containers: dict[str, FakeContainer] = {}
        self.networks: dict[str, dict[str, Any]] = {}
        # A request whose path contains the key is answered with the status (and no effect).
        self.refuse: dict[str, int] = {}
        self.answers_ping = True
        # The runtimes the daemon lists, and the images it has (reference -> id).
        self.runtimes: dict[str, Any] = {"runc": {}, "sysbox-runc": {}}
        self.images: dict[str, str] = {
            "code-reviewer-agent:golden": AGENT_IMAGE_ID,
            AGENT_IMAGE_ID: AGENT_IMAGE_ID,
        }
        # What `inspect` of a container answers instead of what it was made with: name -> function.
        self.inspect_override: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}
        self.exec_behaviour: ExecBehaviour | None = None
        self.execs: dict[str, FakeExec] = {}
        # The exit code of the one-shot container that installs the door's network rules.
        self.rules_exit = 0
        self.ipv6_exit = 0
        # `docker stop` of a container: the exit status it ends with, and whether it never ends.
        self.stop_exit = 0
        self.stop_hangs = False
        self.commit_fails = False
        self.committed: list[tuple[str, dict[str, str], str]] = []
        self._lock = threading.Lock()
        self._count = 0
        engine = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                engine._serve(self.request, self.rfile)  # pyright: ignore[reportPrivateUsage]

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        self._server = Server(str(socket_path), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self) -> "FakeDockerEngine":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        for container in self.containers.values():
            self._close(container)

    # -- what a test does to the "daemon" -------------------------------------------------------

    def kill(self, name: str, *, exit_code: int = 137, oom: bool = False) -> None:
        """The container goes away by itself: its streams end and its state says how."""
        container = self._by_name(name)
        container.exit_code = exit_code
        container.oom_killed = oom
        container.running = False
        self._close(container)
        self._end_execs(container.name)

    def container(self, name: str) -> FakeContainer:
        return self._by_name(name)

    def _by_name(self, name: str) -> FakeContainer:
        """The newest container of that name: a removed one gives its name to the next."""
        return next(c for c in reversed(self.containers.values()) if c.name == name)

    def _close(self, container: FakeContainer) -> None:
        """Close the container's write ends, each once: a descriptor number closed twice would
        close whatever socket has been given it since."""
        with self._lock:
            for name in ("stdin_write", "stdout_write"):
                descriptor = getattr(container, name)
                if descriptor >= 0:
                    setattr(container, name, -1)
                    with contextlib.suppress(OSError):
                        os.close(descriptor)

    # -- the API --------------------------------------------------------------------------------

    def _next(self) -> str:
        with self._lock:
            self._count += 1
            return f"{self._count:064x}"

    def _serve(self, connection: socket.socket, reader: Any) -> None:
        line = reader.readline().decode().strip()
        if not line:
            return
        method, target, _ = line.split(" ", 2)
        headers: dict[str, str] = {}
        while (header := reader.readline().decode()) not in ("\r\n", "\n", ""):
            name, _, value = header.partition(":")
            headers[name.strip().lower()] = value.strip()
        length = int(headers.get("content-length", "0") or 0)
        raw = reader.read(length) if length else b""
        is_json = "json" in headers.get("content-type", "json")
        body = json.loads(raw) if raw and is_json else (raw or None)
        path = target.split("?", 1)[0]
        self.calls.append((method, target, body if is_json else "<bytes>"))
        for key, status in self.refuse.items():
            if key in target:
                self._reply(connection, status, {"message": f"refused {key}"})
                return
        self._route(connection, reader, method, path, target, body)

    def _reply(self, connection: socket.socket, status: int, document: Any = None) -> None:
        payload = b"" if document is None else json.dumps(document).encode()
        head = f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n"
        head += f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n"
        connection.sendall(head.encode() + payload)

    def _route(
        self,
        connection: socket.socket,
        reader: Any,
        method: str,
        path: str,
        target: str,
        body: Any,
    ) -> None:
        parts = path.strip("/").split("/")
        if path == "/_ping":
            self._reply(connection, 200 if self.answers_ping else 500)
        elif method == "GET" and parts[0] == "containers" and parts[-1] == "json":
            self._inspect(connection, parts[1])
        elif method == "POST" and path == "/networks/create":
            self._create_network(connection, body)
        elif method == "POST" and parts[0] == "networks" and parts[-1] in ("connect", "disconnect"):
            self._join(connection, parts[1], parts[2], body)
        elif method == "GET" and parts[0] == "networks" and len(parts) == 2:
            entry = self.networks.get(parts[1]) or next(
                (n for n in self.networks.values() if n["Name"] == parts[1]), None
            )
            if entry is None:
                self._reply(connection, 404, {"message": "no such network"})
            else:
                identifier = next(i for i, n in self.networks.items() if n is entry)
                self._reply(
                    connection,
                    200,
                    {
                        "Id": identifier,
                        "Name": entry["Name"],
                        "Options": entry["document"].get("Options") or {},
                    },
                )
        elif method == "DELETE" and parts[0] == "networks":
            self.networks.pop(parts[1], None)
            for identifier in [i for i, n in self.networks.items() if n["Name"] == parts[1]]:
                del self.networks[identifier]
            self._reply(connection, 204)
        elif method == "POST" and path == "/containers/create":
            self._create(connection, target, body)
        elif method == "POST" and parts[0] == "containers" and parts[-1] == "attach":
            self._attach(connection, reader, parts[1])
        elif method == "POST" and parts[0] == "containers" and parts[-1] == "wait":
            self._wait(connection, parts[1])
        elif method == "POST" and parts[0] == "containers" and parts[-1] == "kill":
            self._kill_request(connection, parts[1])
        elif method == "POST" and parts[0] == "containers" and parts[-1] == "stop":
            self._stop_request(connection, parts[1])
        elif method == "POST" and parts[0] == "commit":
            self._commit(connection, target)
        elif method == "GET" and path == "/info":
            self._reply(connection, 200, {"Runtimes": self.runtimes})
        elif method == "GET" and parts[0] == "images" and parts[-1] == "json":
            reference = "/".join(parts[1:-1])
            if reference in self.images:
                self._reply(
                    connection,
                    200,
                    {"Id": self.images[reference], "Size": 123_456_789, "Config": {"Env": []}},
                )
            else:
                self._reply(connection, 404, {"message": "no such image"})
        elif method == "POST" and parts[0] == "containers" and parts[-1] == "exec":
            self._create_exec(connection, parts[1], body)
        elif method == "POST" and parts[0] == "exec" and parts[-1] == "start":
            self._start_exec(connection, reader, parts[1], body)
        elif method == "GET" and parts[0] == "exec" and parts[-1] == "json":
            made = self.execs.get(parts[1])
            if made is None:
                self._reply(connection, 404, {"message": "no such exec"})
            else:
                self._reply(
                    connection,
                    200,
                    {"Running": made.running, "ExitCode": made.exit_code, "ID": made.identifier},
                )
        elif method == "POST" and parts[0] == "containers" and parts[-1] == "start":
            self._start(connection, parts[1])
        elif method == "DELETE" and parts[0] == "containers":
            container = self.containers.get(parts[1])
            if container is not None:
                container.removed = True
                self._close(container)
            self._reply(connection, 204)
        else:
            self._reply(connection, 404, {"message": "no such route"})

    def _inspect(self, connection: socket.socket, ref: str) -> None:
        if ref in (HOSTNAME, OWN_ID):
            self._reply(
                connection,
                200,
                {
                    "Id": OWN_ID,
                    "Image": IMAGE_ID,
                    "Name": "/control",
                    "Mounts": [
                        {
                            "Type": "volume",
                            "Name": WORK_VOLUME,
                            "Destination": "/work",
                            "Source": "/var/lib/docker/volumes/x/_data",
                        }
                    ],
                },
            )
            return
        container = self.containers.get(ref) or next(
            (c for c in self.containers.values() if c.name == ref), None
        )
        if container is None:
            self._reply(connection, 404, {"message": "no such container"})
            return
        state = {
            "Running": container.running,
            "ExitCode": container.exit_code if container.exit_code is not None else 0,
            "OOMKilled": container.oom_killed,
        }
        host = container.document.get("HostConfig", {})
        mode = host.get("NetworkMode", "bridge")
        networks: dict[str, dict[str, Any]] = {name: {} for name in container.networks} or {
            mode: {}
        }
        mounts = [
            {"Type": m.get("Type"), "Destination": m.get("Target"), "Name": m.get("Source")}
            for m in host.get("Mounts", [])
        ]
        answer: dict[str, Any] = {
            "Id": container.identifier,
            "State": state,
            "HostConfig": host,
            "Config": container.document,
            "NetworkSettings": {"Networks": networks},
            "Mounts": mounts,
        }
        override = self.inspect_override.get(container.name)
        self._reply(connection, 200, override(answer) if override else answer)

    def _create_network(self, connection: socket.socket, body: Any) -> None:
        name = body["Name"]
        if any(n["Name"] == name for n in self.networks.values()):
            self._reply(connection, 409, {"message": "network exists"})
            return
        identifier = self._next()
        self.networks[identifier] = {"Name": name, "document": body, "members": {}}
        self._reply(connection, 201, {"Id": identifier})

    def _join(self, connection: socket.socket, network: str, action: str, body: Any) -> None:
        entry = self.networks.get(network)
        if entry is None:
            self._reply(connection, 404, {"message": "no such network"})
            return
        member = body["Container"]
        if action == "connect":
            entry["members"][member] = body.get("EndpointConfig", {})
            container = self.containers.get(member)
            if container is not None:
                container.networks[network] = body.get("EndpointConfig", {})
        else:
            entry["members"].pop(member, None)
        self._reply(connection, 200)

    def _create(self, connection: socket.socket, target: str, body: Any) -> None:
        name = target.split("name=", 1)[1] if "name=" in target else self._next()[:12]
        if any(c.name == name and not c.removed for c in self.containers.values()):
            self._reply(connection, 409, {"message": "name in use"})
            return
        identifier = self._next()
        container = FakeContainer(identifier, name, body)
        container.stdin_read, container.stdin_write = os.pipe()
        container.stdout_read, container.stdout_write = os.pipe()
        self.containers[identifier] = container
        self._reply(connection, 201, {"Id": identifier})

    def _start(self, connection: socket.socket, ref: str) -> None:
        container = self.containers[ref]
        self._reply(connection, 204)
        labels: dict[str, str] = container.document.get("Labels") or {}
        role = labels.get("code-reviewer.role", "")
        if container.document.get("Entrypoint") == ["/usr/sbin/nft"] or role in ONE_SHOT_ROLES:
            # A one-shot container of the network rules or of the bridge's IPv6: it ends at once.
            container.exit_code = self.ipv6_exit if role == "bridge-ipv6" else self.rules_exit
            return
        container.running = True
        behaviour = self.behaviour
        if behaviour is None:
            return

        def run() -> None:
            stdin = os.fdopen(os.dup(container.stdin_read), "rb", buffering=0)
            stdout = _Stdout(os.dup(container.stdout_write))
            code = 0
            try:
                code = behaviour(stdin, stdout, container.stderr_text.append)
            finally:
                container.exit_code = container.exit_code if container.exit_code else code
                container.running = False
                stdout.close()
                stdin.close()
                self._close(container)

        threading.Thread(target=run, daemon=True).start()

    def _attach(self, connection: socket.socket, reader: Any, ref: str) -> None:
        container = self.containers[ref]
        connection.sendall(
            b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n"
            b"Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
        )

        def pump_in() -> None:
            while True:
                data = reader.read1(65536)
                if not data:
                    break
                container.stdin_received += data
                try:
                    os.write(container.stdin_write, data)
                except OSError:
                    return
            with self._lock:
                descriptor, container.stdin_write = container.stdin_write, -1
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)

        threading.Thread(target=pump_in, daemon=True).start()
        while True:
            # A killed container's door thread may still hold the pipe: the end is its state.
            ready, _, _ = select.select([container.stdout_read], [], [], 0.05)
            if not ready:
                if container.exit_code is not None and not container.running:
                    break
                continue
            try:
                data = os.read(container.stdout_read, 65536)
            except OSError:
                break
            if not data:
                break
            try:
                connection.sendall(struct.pack(">BxxxI", 1, len(data)) + data)
            except OSError:
                return
        with contextlib.suppress(OSError):
            connection.shutdown(socket.SHUT_RDWR)

    # -- step 4: kill, wait and exec ---------------------------------------------------------------

    def _kill_request(self, connection: socket.socket, ref: str) -> None:
        container = self.containers.get(ref) or next(
            (c for c in self.containers.values() if c.name == ref), None
        )
        if container is None:
            self._reply(connection, 404, {"message": "no such container"})
            return
        if not container.running:
            self._reply(connection, 409, {"message": "not running"})
            return
        container.exit_code = 137
        container.running = False
        self._close(container)
        self._end_execs(container.name)
        self._reply(connection, 204)

    def _stop_request(self, connection: socket.socket, ref: str) -> None:
        """A graceful stop: the container ends with status 0 (or, for a test, `stop_exit`)."""
        container = self.containers.get(ref) or next(
            (c for c in self.containers.values() if c.name == ref), None
        )
        if container is None:
            self._reply(connection, 404, {"message": "no such container"})
            return
        if not container.running:
            self._reply(connection, 304)
            return
        if self.stop_hangs:
            self._reply(connection, 204)
            return
        container.exit_code = self.stop_exit
        container.running = False
        self._close(container)
        self._end_execs(container.name)
        self._reply(connection, 204)

    def _end_execs(self, container: str) -> None:
        for made in list(self.execs.values()):
            if made.container == container:
                made.killed.set()

    def _commit(self, connection: socket.socket, target: str) -> None:
        """`docker commit`: an image id, remembered under `repo:tag`; the container must exist."""
        query = dict(
            part.split("=", 1) for part in target.split("?", 1)[-1].split("&") if "=" in part
        )
        ref = query.get("container", "")
        container = self.containers.get(ref) or next(
            (c for c in self.containers.values() if c.name == ref), None
        )
        if container is None:
            self._reply(connection, 404, {"message": "no such container"})
            return
        if self.commit_fails:
            self._reply(connection, 500, {"message": "no space left on device"})
            return
        identifier = "sha256:" + format(len(self.images) + 1, "064x")
        self.images[f"{query.get('repo')}:{query.get('tag')}"] = identifier
        self.images[identifier] = identifier
        self.committed.append((container.name, dict(query), identifier))
        self._reply(connection, 201, {"Id": identifier})

    def _wait(self, connection: socket.socket, ref: str) -> None:
        container = self.containers.get(ref) or next(
            (c for c in self.containers.values() if c.name == ref), None
        )
        if container is None:
            self._reply(connection, 404, {"message": "no such container"})
            return
        # A container that was started runs until something ends it; one that never was is gone.
        while container.running and not container.removed:
            threading.Event().wait(0.02)
        self._reply(connection, 200, {"StatusCode": container.exit_code or 0})

    def _create_exec(self, connection: socket.socket, ref: str, body: Any) -> None:
        container = self.containers.get(ref) or next(
            (c for c in self.containers.values() if c.name == ref), None
        )
        if container is None or not container.running:
            self._reply(connection, 409 if container else 404, {"message": "not running"})
            return
        identifier = self._next()
        self.execs[identifier] = FakeExec(identifier, container.name, body)
        self._reply(connection, 201, {"Id": identifier})

    def _run_exec(self, made: FakeExec, stdin: BinaryIO, stdout: "_Stdout") -> None:
        made.running = True
        try:
            behaviour = self.exec_behaviour
            made.exit_code = 0 if behaviour is None else behaviour(made, stdin, stdout)
        finally:
            made.running = False
            stdout.close()

    def _start_exec(self, connection: socket.socket, reader: Any, ref: str, body: Any) -> None:
        made = self.execs.get(ref)
        if made is None:
            self._reply(connection, 404, {"message": "no such exec"})
            return
        stdin_read, stdin_write = os.pipe()
        stdout_read, stdout_write = os.pipe()
        stdin = os.fdopen(stdin_read, "rb", buffering=0)
        stdout = _Stdout(stdout_write)
        detached = bool(body and body.get("Detach"))
        if detached:
            self._reply(connection, 200)
            threading.Thread(target=self._run_exec, args=(made, stdin, stdout), daemon=True).start()
            return
        connection.sendall(
            b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n"
            b"Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
        )

        def pump_in() -> None:
            try:
                while True:
                    data = reader.read1(65536)
                    if not data:
                        break
                    os.write(stdin_write, data)
            except OSError:
                pass
            finally:
                with contextlib.suppress(OSError):
                    os.close(stdin_write)

        threading.Thread(target=pump_in, daemon=True).start()
        runner = threading.Thread(target=self._run_exec, args=(made, stdin, stdout), daemon=True)
        runner.start()
        while True:
            try:
                data = os.read(stdout_read, 65536)
            except OSError:
                break
            if not data:
                break
            try:
                connection.sendall(struct.pack(">BxxxI", 1, len(data)) + data)
            except OSError:
                break
        runner.join(5)
        with contextlib.suppress(OSError):
            os.close(stdout_read)
        with contextlib.suppress(OSError):
            connection.shutdown(socket.SHUT_RDWR)
