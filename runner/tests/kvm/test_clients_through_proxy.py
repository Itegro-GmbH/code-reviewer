# SPDX-License-Identifier: LicenseRef-Proprietary

"""Every client in the VM goes through the outer wall's proxy (#994, the KVM lane): the static nft
table is loaded, the launcher runs with `FACTORY_RUNNER_OUTER_WALL=proxy` (its `PROXY` setting),
and a real VM runs the lane's probe (`clients_probe.py`) in Control's own container.

What is real: KVM, Firecracker, the kernel, vm-init, dockerd, Sysbox, the Worker image, the vsock,
the TAP, the nft table, the dispatcher's proxy on the slot's address, the real `narrow` over vsock
with the VM's token, and the product's own clients, the ones the Worker image holds: Control's
calls to the app (`job_loop/http.py`), `git` as the Implementer's workspace runs it, the model
door's upstream and the network door chained to the proxy. The proxy address is the one the
launcher put in the start and vm-init wrote into Control's stdin; the probe reads it from there.
The targets are public hosts of the internet (the lane runs on a runner that has one, as the outer
wall's own lane does): `example.com` is the app, `github.com` the git host, `api.anthropic.com`
the model provider.

**What this lane does not do** (a follow-up of #994, listed in the pull request): it does not run a
whole job. A job clones its repository over https, runs a Setup container and an agent in
Sysbox containers whose doors have their own firewalls in the guest, and calls an app that has to
be on a public name and port 80 or 443; a lane that does all of that needs a git host over https
that the Worker image trusts and an app on a public-looking name, which the lane does not have
(`docs/runner.md`, "The outer wall", "Not done here"). What is proved here is the part that was
missing: the clients, in the image, with the table loaded, reach what the wide rule and then the
job's rule let through, through the proxy and nothing else, and fail when it refuses."""

import asyncio
import dataclasses
import json
from typing import Any

import clients_probe
import pytest
from kvm_support import Machine

from code_reviewer_runner.factory_runner.firecracker.control_run import load_template
from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import PROXY_PORT, ProxyOuterWall
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart

pytestmark = pytest.mark.kvm

JOB = "00000000-0000-4000-8000-0000000000d1"
CREDENTIAL = "crj_" + "C" * 43
# The app is a public name on port 80: the proxy dials 80 and 443 for every name.
APP_URL = "http://example.com"
ENTRY_POINT = "--entrypoint=/opt/venv/bin/python"


def probe_arguments(source: str) -> tuple[str, ...]:
    """Control's own `docker run` arguments with the probe as the program: the image's interpreter
    as entry point and the probe as its script (the flags, the start's stdin, the seccomp profile
    that allows AF_VSOCK are Control's)."""
    arguments = list(load_template().arguments)
    image = arguments.index("{image}")
    assert arguments[image + 1 :] == ["worker-once"]
    return (*arguments[:image], ENTRY_POINT, "{image}", "-c", source)


@pytest.fixture(scope="module")
def probe_run(machine: Machine) -> dict[str, Any]:
    settings = dataclasses.replace(
        machine.settings, outer_wall=OuterWallMode.PROXY, slots=1, job_timeout_seconds=300
    )
    sandbox = FirecrackerSandbox(settings)
    assert isinstance(sandbox.wall, ProxyOuterWall)
    wall = sandbox.wall
    config = clients_probe.lane_config(Slot(0).host_address, PROXY_PORT)
    sandbox.template = dataclasses.replace(
        sandbox.template, arguments=probe_arguments(clients_probe.render(config))
    )
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

    outcome = asyncio.run(scenario())
    log = logs[0]
    report = next(
        (found for each in log["connections"] if (found := clients_probe.decode(each["host"]))),
        None,
    )
    print(f"\nexit {outcome.exit_code}")
    print(outcome.log_tail[-2000:])
    print(f"the report: {json.dumps(report)}")
    print(f"the proxy's log: {json.dumps(log['connections'], indent=1)}")
    return {"outcome": outcome, "report": report, "log": log}


def explain(run: dict[str, Any]) -> str:
    return f"report {run['report']}, tail {run['outcome'].log_tail[-800:]}"


# #994-T01 (with the nft table loaded: the lane's step loads it before this file runs)
def test_every_client_reaches_its_target_through_the_proxy_and_nothing_directly(
    probe_run: dict[str, Any],
) -> None:
    assert probe_run["outcome"].exit_code == 0, explain(probe_run)
    report = probe_run["report"]
    assert report is not None, explain(probe_run)
    # The proxy's address came from the start (the launcher, vm-init, Control's stdin); the VM
    # reached nothing directly, before the narrowing or after it; the app, GitHub's git, the model
    # provider and the chained network door reached their hosts through the proxy.
    assert report == clients_probe.EXPECTED, explain(probe_run)


# #994-T02
def test_after_the_real_narrow_only_the_jobs_rule_decides_and_the_door_is_chained_through_it(
    probe_run: dict[str, Any],
) -> None:
    entries = {
        (each["host"], each["port"], each["outcome"], each["reason"])
        for each in probe_run["log"]["connections"]
    }
    # The setup's wide rule let the host that is no part of the job's rule through once, and the
    # job's rule refused it after the `narrow`, at the proxy (the opener) and through the chained
    # network door (which the door's own rule listed).
    assert ("example.org", 80, "allowed", None) in entries, entries
    assert ("example.org", 80, "refused", "not_listed") in entries, entries
    assert ("example.org", 443, "refused", "not_listed") in entries, entries
    # The app, GitHub and the model provider: asked for by name, through the proxy.
    for host, port in (("example.com", 80), ("example.com", 443), ("github.com", 443)):
        assert (host, port, "allowed", None) in entries, entries
    assert (clients_probe.MODEL_HOST, 443, "allowed", None) in entries, entries


# #994-T04
def test_the_host_saw_no_connection_to_an_address_and_none_to_a_port_other_than_80_and_443(
    probe_run: dict[str, Any],
) -> None:
    for each in probe_run["log"]["connections"]:
        assert each["port"] in (80, 443), each
        assert each["reason"] != "ip_literal", each
