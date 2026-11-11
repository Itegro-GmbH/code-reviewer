# SPDX-License-Identifier: LicenseRef-Proprietary

"""The outer wall on a customer's machine, with a real VM (#979, the KVM lane): the static nft table
(`docker/vm/host/outer-wall.nft`), the dispatcher's proxy on the slot's TAP address, vm-init, and a
real `narrow` over vsock carrying the VM's token.

What runs in the VM is the lane's probe (`wall_probe.py`) in Control's own container (same flags,
the Worker image's interpreter as entry point): a job clones its repository over https before it
narrows the network, and a lane has no https git host, so no job gets as far as `narrow`. The probe
sends the Worker's own client's `narrow` with the token vm-init handed it, so the host's real
session, the token check and the real wall are what answer. The workflow runs this file twice:

* **control** (`-k control`): NAT on the host, **no table**. Every probe of T01 must *reach* its
  target (and the host's listeners must see the connection arrive): a probe that is "blocked"
  proves nothing unless the same probe reached its target without the wall (the golden snapshot's
  proof and the spike #970 learned this).
* **wall** (`-k "not control"`): the table loaded. T01: the host's address, RFC1918, link-local,
  the metadata address, the internet and IPv6 are unreachable from the VM, and the host's listeners
  saw nothing. T02: a setup-only host is reachable through the proxy before `narrow` and refused
  after.

IPv6 has no control: the VM's containers have IPv6 switched off (Control's flags) and the guest has
no IPv6 route, so an IPv6 probe is unreachable with or without the table. The table's own IPv6
rules are checked as a file (`nft -c`, `tests/unit/test_firecracker_nft_table.py`) and by its
counters; that is what the lane can say."""

import asyncio
import dataclasses
import json
import os
import socket
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
import wall_probe
from kvm_support import Machine

from code_reviewer_runner.factory_runner.firecracker.control_run import load_template
from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import ProxyOuterWall
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart

pytestmark = pytest.mark.kvm

JOB = "00000000-0000-4000-8000-0000000000c1"
CREDENTIAL = "crj_" + "W" * 43
# The app is named by a host name (the proxy never serves an address); the probe never calls it.
APP_URL = "https://app.example.test"
ENTRY_POINT = "--entrypoint=/opt/venv/bin/python"


class Targets:
    """The host's side of T01: a listener on every address of the host, noting the address each
    connection was made to. A connection that arrives is a connection the VM could make."""

    def __init__(self) -> None:
        self.arrived: list[str] = []
        self._listener = socket.socket()
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("0.0.0.0", wall_probe.DIRECT_PORT))
        self._listener.listen(32)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            self.arrived.append(str(connection.getsockname()[0]))
            connection.close()

    def close(self) -> None:
        self._listener.close()


@dataclass
class Run:
    phase: str
    outcome: WorkerOutcome
    report: dict[str, bool] | None
    arrived: list[str]
    log: dict[str, Any]


def phase_of() -> str:
    phase = os.environ.get("KVM_WALL_PHASE", "")
    if phase not in ("control", "wall"):
        pytest.fail("the lane sets KVM_WALL_PHASE to control or wall", pytrace=False)
    return phase


def probe_arguments(source: str) -> tuple[str, ...]:
    """Control's own `docker run` arguments with the probe as the program: the image's interpreter
    as entry point and the probe as its script (the flags, the token on stdin, the seccomp profile
    that allows AF_VSOCK are Control's)."""
    arguments = list(load_template().arguments)
    image = arguments.index("{image}")
    assert arguments[image + 1 :] == ["worker-once"]
    return (*arguments[:image], ENTRY_POINT, "{image}", "-c", source)


def run_probe(machine: Machine) -> Run:
    settings = dataclasses.replace(
        machine.settings, outer_wall=OuterWallMode.PROXY, slots=1, job_timeout_seconds=300
    )
    sandbox = FirecrackerSandbox(settings)
    assert isinstance(sandbox.wall, ProxyOuterWall)
    wall = sandbox.wall
    config = wall_probe.lane_config(Slot(0).host_address)
    sandbox.template = dataclasses.replace(
        sandbox.template, arguments=probe_arguments(wall_probe.render(config))
    )
    targets = Targets()
    logs: list[dict[str, Any]] = []

    async def scenario() -> WorkerOutcome:
        await sandbox.setup()
        try:
            worker = await sandbox.start(WorkerStart(APP_URL, JOB, CREDENTIAL))
            outcome = await worker.wait()
            # The slot's record of what the proxy decided stays after the VM, until `close`.
            logs.append(wall.log_of(Slot(0)))
            return outcome
        finally:
            await sandbox.close()

    try:
        outcome = asyncio.run(scenario())
    finally:
        targets.close()
    log = logs[0]
    report = next(
        (found for each in log["connections"] if (found := wall_probe.decode(each["host"]))), None
    )
    return Run(phase_of(), outcome, report, sorted(set(targets.arrived)), log)


@pytest.fixture(scope="module")
def probe_run(machine: Machine) -> Iterator[Run]:
    run = run_probe(machine)
    print(f"\nphase {run.phase}: exit {run.outcome.exit_code}")
    print(run.outcome.log_tail[-2000:])
    print(f"the host's listeners saw connections to: {run.arrived}")
    print(f"the report: {json.dumps(run.report)}")
    print(f"the proxy's log: {json.dumps(run.log['connections'], indent=1)}")
    yield run


def explain(run: Run) -> str:
    return f"report {run.report}, arrived {run.arrived}, tail {run.outcome.log_tail[-800:]}"


# What the probe sees through the proxy: the same with and without the table, because the proxy is
# the same.
PROXY_AS_DESIGNED = {
    "setup_host_before": True,
    "tokenless_narrow_refused": True,
    "narrow_acked": True,
    "setup_host_after": False,
    "github_after": True,
    "metadata_literal_after": False,
}
# Host-side addresses the probes aim at, as the host's listeners see them.
HOST_TARGETS = {Slot(0).host_address, "10.77.0.2", "172.16.77.2", "192.168.77.2", "169.254.169.253"}


# #979-T01 (the control: the same probes, no table)
def test_control_without_the_table_every_target_of_t01_is_reached(probe_run: Run) -> None:
    assert probe_run.phase == "control"
    assert probe_run.outcome.exit_code == 0, explain(probe_run)
    report = probe_run.report
    assert report is not None, explain(probe_run)
    direct = {name: report[name] for name in wall_probe.DIRECT}
    # Everything but IPv6 reaches its target: the probes can say "reachable".
    assert direct == {**dict.fromkeys(wall_probe.DIRECT, True), "ipv6": False}, explain(probe_run)
    # And the host saw the connections arrive: its view agrees with the VM's.
    assert set(probe_run.arrived) == HOST_TARGETS, explain(probe_run)


# #979-T01
def test_with_the_table_the_host_the_lan_the_metadata_address_and_ipv6_are_unreachable(
    probe_run: Run,
) -> None:
    assert probe_run.phase == "wall"
    assert probe_run.outcome.exit_code == 0, explain(probe_run)
    report = probe_run.report
    assert report is not None, explain(probe_run)
    assert {name: report[name] for name in wall_probe.DIRECT} == dict.fromkeys(
        wall_probe.DIRECT, False
    ), explain(probe_run)
    assert probe_run.arrived == [], f"the host's listeners were reached: {explain(probe_run)}"


# #979-T02 (with the wall; the proxy is the same in the control, so it must say the same there)
def test_a_setup_only_host_is_reachable_before_a_real_narrow_and_refused_after(
    probe_run: Run,
) -> None:
    assert probe_run.outcome.exit_code == 0, explain(probe_run)
    report = probe_run.report
    assert report is not None, explain(probe_run)
    assert {name: report[name] for name in wall_probe.PROXY} == PROXY_AS_DESIGNED, explain(
        probe_run
    )
    # The host's own record: the setup-only host let through once, refused once; GitHub let through;
    # the metadata address refused as an address.
    entries = {
        (each["host"], each["outcome"], each["reason"]) for each in probe_run.log["connections"]
    }
    setup = wall_probe.SETUP_ONLY_HOST
    assert (setup, "allowed", None) in entries, entries
    assert (setup, "refused", "not_listed") in entries, entries
    assert ("github.com", "allowed", None) in entries, entries
    assert ("169.254.169.254", "refused", "ip_literal") in entries, entries
