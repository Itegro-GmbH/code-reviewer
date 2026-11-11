# SPDX-License-Identifier: LicenseRef-Proprietary

"""The probe of the outer-wall lane (#979), run here against loopback stand-ins: the lane cannot run
on this machine (no KVM, no nft), and a mistake in the probe costs a half-hour run of CI, so the
program that runs in the VM runs here first, as a process, against the real proxy wall, the real
host session (token check, narrow guard) and the Worker's own environment-control client, with a TCP
connection where the VM has vsock and loopback addresses where it has the host's."""

import asyncio
import json
import socket
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from netdoor_support import PUBLIC, Lookups, Origin

from code_reviewer_runner.factory_runner.firecracker.outer_wall import VmIdentity
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import (
    ProxyOuterWall,
    SlotAddresses,
)
from code_reviewer_runner.factory_runner.firecracker.session import VmSession
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.firecracker.tokens import generate_control_token
from code_reviewer_runner.factory_runner.firecracker.wire import (
    MAX_CONTROL_FRAME_BYTES,
    encode_frame,
    read_frame,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kvm"))
import wall_probe

pytestmark = [
    pytest.mark.integration,
    pytest.mark.allow_hosts(["127.0.0.1", "127.0.1.1", "127.0.1.2"]),
]

HOST, GUEST = "127.0.1.1", "127.0.1.2"
TOKEN = generate_control_token()
APP = "app.example.test"


def closed_port() -> int:
    holder = socket.socket()
    holder.bind(("127.0.0.1", 0))
    port = int(holder.getsockname()[1])
    holder.close()
    return port


class TcpHost:
    """What the host's port 5100 is on vsock, on loopback TCP: one frame in, the session's answer
    out."""

    def __init__(self, session: VmSession) -> None:
        self.session = session
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.port = 0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.ready.wait(10)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        server = self.loop.run_until_complete(
            asyncio.start_server(self._serve, "127.0.0.1", 0)  # pyright: ignore[reportUnknownArgumentType]
        )
        self.port = int(server.sockets[0].getsockname()[1])
        self.ready.set()
        self.loop.run_forever()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            document = await read_frame(reader, max_bytes=MAX_CONTROL_FRAME_BYTES)
            reply = await self.session.control(document)
            if reply is not None:
                writer.write(encode_frame(reply))
                await writer.drain()
        finally:
            writer.close()

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)


class Setup:
    def __init__(self) -> None:
        self.origin = Origin()
        self.lookups = Lookups()
        self.lookups.servers[PUBLIC] = self.origin.port
        for name in (
            "setup-only.example.com",
            "github.com",
            "api.github.com",
            wall_probe.MODEL_HOST,
            APP,
        ):
            self.lookups.table[name] = [PUBLIC]
        self.wall = ProxyOuterWall(
            1,
            port=0,
            addresses=lambda _slot: SlotAddresses(HOST, GUEST),
            resolver=self.lookups.resolve,
            connector=self.lookups.connect,
        )
        asyncio.run(self.wall.start())
        self.vm = VmIdentity("vm-0-probe", Slot(0), APP)
        asyncio.run(self.wall.admit(self.vm))
        self.session = VmSession(self.vm, self.wall, TOKEN, start_acked=True)
        self.control = TcpHost(self.session)
        self.open_target = socket.socket()
        self.open_target.bind(("127.0.0.1", 0))
        self.open_target.listen(8)

    def config(self) -> dict[str, Any]:
        config = wall_probe.lane_config(HOST)
        config["proxy_port"] = self.wall.port_of(Slot(0))
        config["source"] = GUEST
        config["setup_host"] = "setup-only.example.com"
        config["connect_seconds"] = 1.0
        config["control"] = {"kind": "tcp", "host": "127.0.0.1", "port": self.control.port}
        # Loopback stand-ins for the host's addresses: one answers, the others are closed ports.
        open_port = int(self.open_target.getsockname()[1])
        config["direct"] = {
            name: ["127.0.0.1", open_port if name == "rfc1918_10" else closed_port()]
            for name in wall_probe.DIRECT
            if name != "ipv6"
        }
        config["ipv6"] = ["::1", closed_port()]
        return config

    def run_probe(self) -> subprocess.CompletedProcess[bytes]:
        job = json.dumps({"appUrl": f"https://{APP}", "controlToken": TOKEN}) + "\n"
        return subprocess.run(
            [sys.executable, "-c", wall_probe.render(self.config())],
            input=job.encode(),
            capture_output=True,
            timeout=120,
            check=False,
        )

    def report(self) -> dict[str, bool] | None:
        for entry in self.wall.log_of(Slot(0))["connections"]:
            found = wall_probe.decode(entry["host"])
            if found is not None:
                return found
        return None

    def close(self) -> None:
        self.control.stop()
        self.open_target.close()
        asyncio.run(self.wall.close())
        self.origin.close()


@pytest.fixture
def rig() -> Iterator[Setup]:
    rig = Setup()
    try:
        yield rig
    finally:
        rig.close()


# #979 (the lane's probe, before the lane runs it)
def test_the_probe_reports_what_it_reached_through_the_proxy_and_what_it_did_not(
    rig: Setup,
) -> None:
    done = rig.run_probe()

    assert done.returncode == 0, done.stderr.decode()
    report = rig.report()
    assert report is not None, rig.wall.log_of(Slot(0))["connections"]
    assert report == {
        # Directly: the one target that answers is reached, nothing else is.
        "host_tap": False,
        "rfc1918_10": True,
        "rfc1918_172": False,
        "rfc1918_192": False,
        "link_local": False,
        "metadata": False,
        "internet": False,
        "ipv6": False,
        # Through the proxy: the setup's host before the narrowing, not after it; GitHub both
        # times; the metadata address never; a narrow without the token is refused and the real
        # one is acknowledged.
        "setup_host_before": True,
        "tokenless_narrow_refused": True,
        "narrow_acked": True,
        "setup_host_after": False,
        "github_after": True,
        "metadata_literal_after": False,
    }


# #979
def test_the_hosts_view_of_the_probe_is_the_proxys_log(rig: Setup) -> None:
    rig.run_probe()

    entries = {
        (each["host"], each["outcome"], each["reason"])
        for each in rig.wall.log_of(Slot(0))["connections"]
    }
    assert ("setup-only.example.com", "allowed", None) in entries
    assert ("setup-only.example.com", "refused", "not_listed") in entries
    assert ("github.com", "allowed", None) in entries
    assert ("169.254.169.254", "refused", "ip_literal") in entries
    assert rig.session.narrowed is True


def test_the_report_is_what_the_probe_names_and_nothing_else_is_a_report() -> None:
    bits = "10" * (len(wall_probe.RESULTS) // 2)
    host = f"r{bits}.{wall_probe.REPORT_DOMAIN}"

    found = wall_probe.decode(host)

    assert found is not None and list(found) == list(wall_probe.RESULTS)
    assert wall_probe.decode("example.com") is None
    assert wall_probe.decode(f"r101.{wall_probe.REPORT_DOMAIN}") is None
    assert wall_probe.decode(f"r{'2' * len(wall_probe.RESULTS)}.{wall_probe.REPORT_DOMAIN}") is None
