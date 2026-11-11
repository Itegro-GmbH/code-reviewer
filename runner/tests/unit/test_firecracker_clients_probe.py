# SPDX-License-Identifier: LicenseRef-Proprietary

"""The probe of the clients lane (#994), run here against loopback stand-ins: the lane cannot run on
this machine (no KVM, no nft), and a mistake in the probe costs a half-hour run of CI, so the
program that runs in the VM runs here first, as a process, against the real proxy wall, the real
host session and the product's own clients (the Worker API's opener, the model door's upstream, the
network door chained to the proxy, the Worker's environment-control client), with a TCP connection
where the VM has vsock and loopback addresses where it has the host's. What it cannot run here is
TLS to a real host and `git` against GitHub: the lane does."""

import asyncio
import json
import subprocess
import sys
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from netdoor_support import PUBLIC, Lookups, Origin
from test_firecracker_wall_probe import TOKEN, TcpHost, closed_port

from code_reviewer_runner.factory_runner.firecracker.outer_wall import VmIdentity
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import (
    ProxyOuterWall,
    SlotAddresses,
)
from code_reviewer_runner.factory_runner.firecracker.session import VmSession
from code_reviewer_runner.factory_runner.firecracker.slots import Slot

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kvm"))
import clients_probe

pytestmark = [
    pytest.mark.integration,
    pytest.mark.allow_hosts(["127.0.0.1", "127.0.1.1"]),
]

# The proxy listens on HOST; the probe connects from 127.0.0.1, which is the guest the wall serves.
HOST, GUEST = "127.0.1.1", "127.0.0.1"
APP = "app.example.test"
OTHER = "other.example.test"
MODEL_PUBLIC = "151.101.1.1"


class Setup:
    def __init__(self) -> None:
        self.app_origin = Origin(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        self.model_origin = Origin(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n"
            b"Content-Length: 2\r\n\r\n{}"
        )
        self.lookups = Lookups()
        self.lookups.servers[PUBLIC] = self.app_origin.port
        self.lookups.servers[MODEL_PUBLIC] = self.model_origin.port
        for name in (APP, OTHER, "github.com", "api.github.com"):
            self.lookups.table[name] = [PUBLIC]
        self.lookups.table[clients_probe.MODEL_HOST] = [MODEL_PUBLIC]
        self.wall = ProxyOuterWall(
            1,
            port=0,
            addresses=lambda _slot: SlotAddresses(HOST, GUEST),
            resolver=self.lookups.resolve,
            connector=self.lookups.connect,
        )
        asyncio.run(self.wall.start())
        self.vm = VmIdentity("vm-0-clients", Slot(0), APP)
        asyncio.run(self.wall.admit(self.vm))
        self.session = VmSession(self.vm, self.wall, TOKEN, start_acked=True)
        self.control = TcpHost(self.session)

    def config(self) -> dict[str, Any]:
        config = clients_probe.lane_config(HOST, self.wall.port_of(Slot(0)))
        config.update(
            checks=list(clients_probe.PLAIN_CHECKS),
            dead_port=closed_port(),
            direct=["127.0.0.1", closed_port()],
            other_url=f"http://{OTHER}/",
            door_listed=[OTHER, "github.com"],
            door_target="github.com:443",
            door_refused_target=f"{OTHER}:443",
            tls=False,
            slot_network="127.0.1.0/24",
            connect_seconds=1.0,
            control={"kind": "tcp", "host": "127.0.0.1", "port": self.control.port},
        )
        return config

    def run_probe(self, **stdin: Any) -> subprocess.CompletedProcess[bytes]:
        config = self.config()
        job: dict[str, Any] = {
            "appUrl": f"http://{APP}",
            "controlToken": TOKEN,
            "outerProxy": {"host": HOST, "port": self.wall.port_of(Slot(0))},
        }
        job.update(stdin)
        return subprocess.run(
            [sys.executable, "-c", clients_probe.render(config)],
            input=(json.dumps(job) + "\n").encode(),
            capture_output=True,
            timeout=180,
            check=False,
        )

    def report(self) -> dict[str, bool] | None:
        for entry in self.wall.log_of(Slot(0))["connections"]:
            found = clients_probe.decode(entry["host"], clients_probe.PLAIN_CHECKS)
            if found is not None:
                return found
        return None

    def close(self) -> None:
        self.control.stop()
        asyncio.run(self.wall.close())
        self.app_origin.close()
        self.model_origin.close()


@pytest.fixture
def rig() -> Generator[Setup]:
    rig = Setup()
    try:
        yield rig
    finally:
        rig.close()


# #994-T01 (the lane's probe, before the lane runs it)
def test_the_probe_reports_what_each_product_client_reached_through_the_proxy(rig: Setup) -> None:
    done = rig.run_probe()

    assert done.returncode == 0, done.stderr.decode()
    report = rig.report()
    assert report is not None, rig.wall.log_of(Slot(0))["connections"]
    assert report == {name: clients_probe.EXPECTED[name] for name in clients_probe.PLAIN_CHECKS}
    # The host's own record: the wide rule let the app, the other host and GitHub through before the
    # narrowing; the job's rule refused the other host after it (as a name the rule does not list).
    entries = {
        (e["host"], e["outcome"], e["reason"]) for e in rig.wall.log_of(Slot(0))["connections"]
    }
    assert (OTHER, "allowed", None) in entries and (OTHER, "refused", "not_listed") in entries
    assert (APP, "allowed", None) in entries and ("github.com", "allowed", None) in entries


# #994-T04
def test_a_start_that_names_another_proxy_than_the_slots_gateway_is_reported_as_wrong(
    rig: Setup,
) -> None:
    config = rig.config()
    config["gateway"] = "127.0.1.9"  # what the launcher would have to give; the start says HOST

    done = subprocess.run(
        [sys.executable, "-c", clients_probe.render(config)],
        input=(
            json.dumps(
                {
                    "appUrl": f"http://{APP}",
                    "controlToken": TOKEN,
                    "outerProxy": {"host": HOST, "port": rig.wall.port_of(Slot(0))},
                }
            )
            + "\n"
        ).encode(),
        capture_output=True,
        timeout=180,
        check=False,
    )

    assert done.returncode == 0, done.stderr.decode()
    report = rig.report()
    assert report is not None and report["proxy_from_start"] is False


# #994-T03
def test_the_probe_program_is_valid_python_and_decodes_what_it_encodes() -> None:
    config = clients_probe.lane_config("172.31.0.1")
    rendered = clients_probe.render(config)
    compile(rendered, "<probe>", "exec")
    # One argument of Control's `docker run`: vm-init refuses a longer one, and the lane's first run
    # found that out.
    assert len(rendered) <= clients_probe.MAX_ARGUMENT_CHARACTERS, len(rendered)
    bits = "".join(
        "1" if clients_probe.EXPECTED[name] else "0" for name in clients_probe.LANE_CHECKS
    )

    assert clients_probe.decode(f"r{bits}.report.invalid") == clients_probe.EXPECTED
    assert clients_probe.decode("github.com") is None
    assert clients_probe.decode(f"r{bits[:-1]}.report.invalid") is None
    assert len(f"r{bits}") <= 63, "a host name label"
    assert set(clients_probe.PLAIN_CHECKS) < set(clients_probe.LANE_CHECKS)
    assert set(clients_probe.EXPECTED) == set(clients_probe.LANE_CHECKS)
