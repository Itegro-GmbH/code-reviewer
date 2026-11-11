# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer job in a real Firecracker VM with the outer wall's nft table loaded (#999,
the KVM lane; the follow-up of #994).

What is real: KVM, Firecracker, the kernel, vm-init, dockerd, Sysbox, the Worker image (the lane's
copy, see below), the vsock, the TAP, the **nft table** (the workflow loads the installer's
rendering for the slots' network), the launcher's **proxy wall** (`FACTORY_RUNNER_OUTER_WALL=proxy`)
and the product's own clients, doors and containers: Control's calls to the app, the clone and the
push of the git workspace, the reader, the Setup container under its own table, the real `narrow`
over vsock with the VM's token, the network door and the model door under theirs, OpenCode in the
agent's container.

What is a double, and why it is not a weaker test of the wall:

* **The internet.** The fake App, the git endpoint, the provider and a plain files host listen on
  the host's loopback behind **public-looking names** below `lane.example.com`. The proxy refuses
  every private address by design and has no test network, so `ProxyOuterWall` gets a resolver and
  a connector of the lane (`lane_internet.py`, the seams its unit tests use): the decision stays
  real (the rule lists the name first, the address is public, only 80 and 443) and only the last
  TCP connect is redirected. A name or port no fake stands behind is refused.
* **A certificate the Worker image trusts.** The Worker clones over https only and its model door
  checks the provider's certificate, so the git endpoint and the provider answer with certificates
  of a CA made in this run (`lane_pki.py`, restricted to `lane.example.com`). The CA is trusted
  **only by a lane-only copy of the Worker image** that the workflow derives from the release's
  (the CA appended to its bundle) and loads into a data disk of its own; the release's image, disk
  and manifest never see it (`docs/runner.md`, "A whole job in the lane").
* **The model** is the scripted fake of `fakes/wire` on the provider's name.

The nft table's drop counters are read by the workflow around this file (`wall_counters.py`): a
client that went round the proxy and was dropped would still pass here, and shows there."""

import asyncio
import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest
from kvm_support import Machine, need
from lane_internet import APP_HOST, FILES_HOST, GIT_HOST, MODEL_HOST, SETUP_ONLY_HOST
from lane_pki import load_ca
from whole_job_support import (
    AGENT_COPY,
    BRANCH,
    CLOSING,
    MODEL_KEY,
    SETUP_COPY,
    LaneFakes,
    RecordingProxyWall,
    job_document,
    lane_fakes,
)

from code_reviewer_runner.factory_runner.app_client import AppClient
from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart
from git_support import raw

pytestmark = pytest.mark.kvm

JOB = "00000000-0000-4000-8000-0000000000e1"
REFUSED_JOB = "00000000-0000-4000-8000-0000000000e2"
RUNNER_CREDENTIAL = "crc_" + "K" * 43


@dataclasses.dataclass
class Ran:
    outcome: WorkerOutcome
    fakes: LaneFakes
    wall: RecordingProxyWall
    log: dict[str, Any]
    seconds: float


def run_job(machine: Machine, tmp_path: Path, job_id: str, *, with_git: bool) -> Ran:
    """One job, claimed from the fake App over the runner API as the local dispatcher claims it and
    started in a VM by the launcher with the proxy wall; the proxy's own record of what it decided
    is read before the sandbox is closed (it is kept until then)."""
    ca = load_ca(Path(need("KVM_LANE_PKI")))
    with lane_fakes(tmp_path, ca, with_git=with_git) as fakes:
        wall = RecordingProxyWall(
            1, resolver=fakes.internet.resolve, connector=fakes.internet.connect
        )
        settings = dataclasses.replace(
            machine.settings,
            outer_wall=OuterWallMode.PROXY,
            slots=1,
            job_timeout_seconds=3900,
            # The Worker image of the lane (the CA) is the one the settings name: its id is the
            # lane disk's, which the workflow gave as KVM_VM_IMAGES.
        )
        sandbox = FirecrackerSandbox(settings, wall=wall)
        fakes.app.credentials[RUNNER_CREDENTIAL] = "runner-kvm"
        fakes.app.queue_job(job_id, job_document())
        claim = AppClient(fakes.app.url, credential=RUNNER_CREDENTIAL).claim()
        assert claim is not None and claim.job_id == job_id
        # The Worker's address of the App is a name on port 80: the proxy dials nothing else.
        start = WorkerStart(f"http://{APP_HOST}", claim.job_id, claim.credential)
        logs: list[dict[str, Any]] = []

        async def scenario() -> tuple[WorkerOutcome, float]:
            await sandbox.setup()
            try:
                began = asyncio.get_running_loop().time()
                worker = await sandbox.start(start)
                outcome = await worker.wait()
                logs.append(wall.log_of(Slot(0)))
                return outcome, asyncio.get_running_loop().time() - began
            finally:
                await sandbox.close()

        outcome, seconds = asyncio.run(scenario())
        print(f"\nexit {outcome.exit_code} after {seconds:.0f} s")
        print(outcome.log_tail[-3000:])
        for each in fakes.app.completions:
            print(f"delivered: {json.dumps(each)[:6000]}")
        print(f"the proxy decided: {logs[0]['connections']}")
        print(f"dialled: {fakes.internet.dialled}")
        return Ran(outcome, fakes, wall, logs[0], seconds)


@pytest.fixture(scope="module")
def whole(machine: Machine, tmp_path_factory: pytest.TempPathFactory) -> Ran:
    return run_job(machine, tmp_path_factory.mktemp("whole"), JOB, with_git=True)


def explain(ran: Ran) -> str:
    done = [
        (c.get("ok"), c.get("errorCode"), str(c.get("errorMessage"))[:300])
        for c in ran.fakes.app.completions
    ]
    return f"delivered {done}, tail {ran.outcome.log_tail[-1500:]}"


def decided(ran: Ran) -> set[tuple[str, int, str, str | None]]:
    return {
        (each["host"], each["port"], each["outcome"], each["reason"])
        for each in ran.log["connections"]
    }


# #999-T01
def test_a_whole_job_runs_in_the_vm_with_the_table_loaded_and_pushes_to_the_lane_git_endpoint(
    whole: Ran,
) -> None:
    assert whole.outcome.exit_code == 0, explain(whole)
    [result] = whole.fakes.app.completions
    assert result["ok"] is True, explain(whole)
    implementer = result["implementer"]
    assert implementer["pushed"] is True and implementer["headCommit"], explain(whole)
    origin = whole.fakes.origin
    # The job's branch is on the lane's git endpoint with the commit the agent made: the Worker
    # pushed it over https, through the proxy, with its token.
    assert origin.tip(BRANCH) == implementer["headCommit"]
    tree = raw("ls-tree", "--name-only", BRANCH, cwd=origin.path, git="git").split()
    assert SETUP_COPY in tree and AGENT_COPY in tree, tree
    assert implementer["summary"] == CLOSING or CLOSING in str(implementer["summary"])
    assert not whole.fakes.app.violations
    assert whole.fakes.app.job(JOB).status == "succeeded"


# #999-T02
def test_the_setup_reached_a_public_looking_host_and_the_agent_got_what_the_setup_left(
    whole: Ran,
) -> None:
    origin = whole.fakes.origin
    from_setup = raw("show", f"{BRANCH}:{SETUP_COPY}", cwd=origin.path, git="git")
    from_agent = raw("show", f"{BRANCH}:{AGENT_COPY}", cwd=origin.path, git="git")

    # The setup's fetch (the wide rule, through the proxy) is in the commit, and so is what the
    # agent fetched through its network door, chained to the proxy, after the narrowing.
    assert from_setup.strip() == whole.fakes.files.SETUP_BODY.decode().strip()
    assert from_agent.strip() == whole.fakes.files.AGENT_BODY.decode().strip()
    fetched = {each.path: each for each in whole.fakes.files.requests}
    assert set(fetched) >= {"/setup", "/agent"}, [each.path for each in whole.fakes.files.requests]
    assert whole.wall.narrowed_at is not None
    # The setup asked before the narrowing was acknowledged and the agent after it.
    assert fetched["/setup"].at < whole.wall.narrowed_at < fetched["/agent"].at


# #999-T03
def test_the_real_narrow_carried_the_jobs_rule_and_the_provider_and_the_setup_only_host_closed(
    whole: Ran,
) -> None:
    [narrow] = whole.wall.narrows
    assert narrow.model_host == MODEL_HOST
    assert set(narrow.rule.hosts) == {GIT_HOST, FILES_HOST}
    entries = decided(whole)
    # Before it, the wide rule let the setup reach the host only the setup may reach.
    assert (SETUP_ONLY_HOST, 80, "allowed", None) in entries, entries
    # The whole job's traffic is by name, on 80 and 443, and nothing was refused for what the job
    # needs: the app, the git host (the clone and the push), the provider, the files host.
    for host, port in ((APP_HOST, 80), (GIT_HOST, 443), (MODEL_HOST, 443), (FILES_HOST, 80)):
        assert (host, port, "allowed", None) in entries, entries
    for host, port, outcome, reason in entries:
        assert port in (80, 443) and reason != "ip_literal", (host, port, outcome, reason)
    # The report the Worker made of the agent's door says the VM's policy was narrowed.
    [result] = whole.fakes.app.completions
    network = result["implementer"]["network"]
    assert network["vmPolicy"] == "narrowed", network


# #999-T04
def test_the_model_provider_got_the_key_and_the_scripted_turns_through_the_door_and_the_proxy(
    whole: Ran,
) -> None:
    records = whole.fakes.model.records
    assert records, "the provider was never called"
    # The door swapped the engine's dummy key for the real one (the provider is strict about it),
    # and the call reached the lane's provider over TLS through the tunnel: the proxy logged it.
    assert all(
        f"Bearer {MODEL_KEY}" in record.headers.get("authorization", "") for record in records
    )
    assert any(
        address == whole.fakes.internet.names[MODEL_HOST]
        for address, _, _ in whole.fakes.internet.dialled
    )


# #999-T05 (the Worker ends the job with a stable code when the proxy refuses the clone)
def test_when_the_proxy_cannot_clone_for_the_job_it_ends_with_a_stable_code_and_pushes_nothing(
    machine: Machine, tmp_path: Path
) -> None:
    refused = run_job(machine, tmp_path, REFUSED_JOB, with_git=False)

    [result] = refused.fakes.app.completions
    assert result["ok"] is False, explain(refused)
    assert result["errorCode"] == "clone_failed", explain(refused)
    assert refused.fakes.origin.tip(BRANCH) is None
    # The clone was asked for by name, refused for want of an address, and nothing else was dialled
    # for the job (not the provider, not the files host: the job never got that far).
    assert not refused.fakes.model.records
    assert all(host != MODEL_HOST for host, _, _, _ in decided(refused))
    assert GIT_HOST not in {
        host for host, _, outcome, _ in decided(refused) if outcome == "allowed"
    }
