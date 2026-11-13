# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer job in two real Incus instances made from the golden image (#1020, the
follow-up of #1007, #1009 and #1017; the Incus twin of the KVM lane's `test_whole_job.py`, #999).

What is real: Incus (the btrfs pool, the two bridges and the ACL of the lane's slot), the golden
image (`docker/incus/build-golden.sh`: Ubuntu 24.04, Docker 29, the Worker image and the agent's
image loaded), the launcher's own client, **instance A** (the Worker image's Control, the model
door, the network door, the inner wall as a real nft table), **instance B** (the setup, then
OpenCode in the agent's container, both in B's own Docker), the unix-socket control through the
proxy device,
the real `narrow` (the outer wall's rule held and B's outer NIC unplugged), the launcher's **proxy
wall** (`FACTORY_RUNNER_OUTER_WALL=proxy`), and the product's own clients and doors: Control's calls
to the app, the clone and the push of the git workspace, the readers, the hand-over from B's
daemon, the end report and the clean-up of both instances.

What is a double, and why it is not a weaker test of the wall: the same as in the KVM lane
(`runner/tests/kvm/test_whole_job.py`): the internet is the lane's fakes behind public-looking
names (`lane_internet.py`; the proxy's decision is real and only its last TCP connect is
redirected), a certificate of a test CA that **only the lane's own copy of the Worker image trusts**
(`build-lane-image.sh` derives that copy and the golden image `crlane-golden` from it), and the
model is the scripted fake of `fakes/wire`.

What it does not prove: the host's static nft table (#1008, the host's port 53, drop counters: the
spike's measurement stands), and the real hardening flags of a customer machine's installer.

Run it with `-m incus --force-enable-socket` and the variables of `incus_lane.py`
(`load_job_machine`)."""

import asyncio
import dataclasses
import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kvm"))
from incus_lane import JobMachine
from lane_internet import APP_HOST, FILES_HOST, GIT_HOST, MODEL_HOST, SETUP_ONLY_HOST
from lane_pki import load_ca
from whole_job_support import (
    AGENT_COPY,
    BRANCH,
    CLOSED,
    CLOSED_NOTE,
    CLOSING,
    MODEL_KEY,
    SETUP_COPY,
    SETUP_SCRIPT,
    LaneFakes,
    RecordingProxyWall,
    Turn,
    job_document,
    lane_fakes,
)

from code_reviewer_runner.factory_runner.app_client import AppClient
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.incus.client import CliIncusClient
from code_reviewer_runner.factory_runner.incus.launcher import IncusSandbox
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.incus.walls import slot_addresses
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart
from git_support import raw

pytestmark = pytest.mark.incus

JOB = "00000000-0000-4000-8000-0000000010a1"
REFUSED_JOB = "00000000-0000-4000-8000-0000000010a2"
RUNNER_CREDENTIAL = "crc_" + "K" * 43


@dataclasses.dataclass
class Ran:
    outcome: WorkerOutcome
    fakes: LaneFakes
    wall: RecordingProxyWall
    log: dict[str, Any]
    seconds: float
    start_seconds: float
    left: list[str]


async def instances_of(client: CliIncusClient, settings: IncusSettings) -> list[str]:
    return sorted(
        instance.name
        for instance in await client.list_instances()
        if instance.name.startswith((f"{settings.name_prefix}-a-", f"{settings.name_prefix}-b-"))
    )


def run_job(
    machine: JobMachine,
    settings: IncusSettings,
    client: CliIncusClient,
    tmp_path: Path,
    job_id: str,
    *,
    with_git: bool,
    setup_script: str = SETUP_SCRIPT,
    script: list[Turn] | None = None,
) -> Ran:
    """One job, claimed from the fake App over the runner API as the local dispatcher claims it and
    started in two Incus instances by the launcher with the proxy wall; the proxy's own record of
    what it decided is read before the sandbox is closed (it is kept until then)."""
    ca = load_ca(machine.pki)
    with lane_fakes(tmp_path, ca, with_git=with_git, script=script) as fakes:
        wall = RecordingProxyWall(
            settings.slots,
            network=settings.slot_network,
            addresses=slot_addresses,
            resolver=fakes.internet.resolve,
            connector=fakes.internet.connect,
        )
        sandbox = IncusSandbox(settings, client, wall=wall)
        fakes.app.credentials[RUNNER_CREDENTIAL] = "runner-incus"
        fakes.app.queue_job(job_id, job_document(setup_script=setup_script))
        claim = AppClient(fakes.app.url, credential=RUNNER_CREDENTIAL).claim()
        assert claim is not None and claim.job_id == job_id
        # The Worker's address of the App is a name on port 80: the proxy dials nothing else.
        start = WorkerStart(f"http://{APP_HOST}", claim.job_id, claim.credential)
        logs: list[dict[str, Any]] = []

        async def scenario() -> tuple[WorkerOutcome, float, float]:
            await sandbox.setup()
            try:
                began = time.monotonic()
                worker = await sandbox.start(start)
                started = time.monotonic() - began
                outcome = await worker.wait()
                logs.append(wall.log_of(Slot(0)))
                return outcome, time.monotonic() - began, started
            finally:
                await sandbox.close()

        outcome, seconds, started = asyncio.run(scenario())
        left = asyncio.run(instances_of(client, settings))
        print(f"\nexit {outcome.exit_code} after {seconds:.0f} s (start() {started:.1f} s)")
        print(outcome.log_tail[-3000:])
        for each in fakes.app.completions:
            print(f"delivered: {json.dumps(each)[:6000]}")
        print(f"the proxy decided: {logs[0]['connections']}")
        print(f"dialled: {fakes.internet.dialled}")
        return Ran(outcome, fakes, wall, logs[0], seconds, started, left)


@pytest.fixture(scope="module")
def whole(
    job_machine: JobMachine,
    job_settings: IncusSettings,
    job_client: CliIncusClient,
    tmp_path_factory: pytest.TempPathFactory,
) -> Ran:
    return run_job(
        job_machine,
        job_settings,
        job_client,
        tmp_path_factory.mktemp("whole"),
        JOB,
        with_git=True,
    )


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


# #1020-T01
def test_a_whole_job_runs_in_two_incus_instances_and_pushes_to_the_lane_git_endpoint(
    whole: Ran,
) -> None:
    assert whole.outcome.exit_code == 0, explain(whole)
    [result] = whole.fakes.app.completions
    assert result["ok"] is True, explain(whole)
    implementer = result["implementer"]
    assert implementer["pushed"] is True and implementer["headCommit"], explain(whole)
    origin = whole.fakes.origin
    # The job's branch is on the lane's git endpoint with the commit the agent made in B: the Worker
    # in A pulled it back through the checked fetch and pushed it over https, through the proxy.
    assert origin.tip(BRANCH) == implementer["headCommit"]
    tree = raw("ls-tree", "--name-only", BRANCH, cwd=origin.path, git="git").split()
    assert SETUP_COPY in tree and AGENT_COPY in tree, tree
    assert implementer["summary"] == CLOSING or CLOSING in str(implementer["summary"])
    assert not whole.fakes.app.violations
    assert whole.fakes.app.job(JOB).status == "succeeded"


# #1020-T02
def test_the_setup_in_b_reached_a_public_looking_host_and_the_agent_got_what_it_left(
    whole: Ran,
) -> None:
    origin = whole.fakes.origin
    from_setup = raw("show", f"{BRANCH}:{SETUP_COPY}", cwd=origin.path, git="git")
    from_agent = raw("show", f"{BRANCH}:{AGENT_COPY}", cwd=origin.path, git="git")

    # The setup's fetch (the wide rule, through the proxy) is in the commit (the file it left in
    # the same container image layer of B's Docker reached the agent), and so is what the agent
    # fetched through its network door in A, chained to the proxy, after the narrowing.
    assert from_setup.strip() == whole.fakes.files.SETUP_BODY.decode().strip()
    assert from_agent.strip() == whole.fakes.files.AGENT_BODY.decode().strip()
    fetched = {each.path: each for each in whole.fakes.files.requests}
    assert set(fetched) >= {"/setup", "/agent"}, [each.path for each in whole.fakes.files.requests]
    assert whole.wall.narrowed_at is not None
    # The setup asked before the narrowing was acknowledged and the agent after it.
    assert fetched["/setup"].at < whole.wall.narrowed_at < fetched["/agent"].at


# #1020-T03
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
    # After it the agent asked for that host and was refused (it wrote what it met into the
    # commit), and the files host never saw a request for it after the narrowing.
    met = raw("show", f"{BRANCH}:{CLOSED_NOTE}", cwd=whole.fakes.origin.path, git="git")
    assert met.strip() == CLOSED, met
    assert whole.wall.narrowed_at is not None
    assert not [
        each
        for each in whole.fakes.files.requests
        if each.host == SETUP_ONLY_HOST and each.at > whole.wall.narrowed_at
    ]
    # The report the Worker made of the agent's door says the instance's policy was narrowed.
    [result] = whole.fakes.app.completions
    network = result["implementer"]["network"]
    assert network["vmPolicy"] == "narrowed", network


# #1020-T04
def test_the_model_provider_got_the_key_and_the_scripted_turns_through_the_door_and_the_proxy(
    whole: Ran,
) -> None:
    records = whole.fakes.model.records
    assert records, "the provider was never called"
    # The door in A swapped the engine's dummy key (the agent in B only ever has the dummy) for the
    # real one, and the call reached the lane's provider over TLS through the proxy.
    assert all(
        f"Bearer {MODEL_KEY}" in record.headers.get("authorization", "") for record in records
    )
    assert any(
        address == whole.fakes.internet.names[MODEL_HOST]
        for address, _, _ in whole.fakes.internet.dialled
    )


# #1020-T05
def test_both_instances_are_deleted_when_the_job_has_ended_and_the_start_fits_its_budget(
    whole: Ran,
) -> None:
    assert whole.left == [], whole.left
    # Measured on the DevBox (docs/runner.md, "A whole job on Incus"): two instances, boot, wall,
    # readiness, the image check and Control launched. A loose bound: a failure of the pool or the
    # image (a unpack on every start, a Docker that does not come up) is minutes, not seconds.
    assert whole.start_seconds < 90.0, whole.start_seconds


# #1020-T06 (the Worker ends the job with a stable code when the proxy refuses the clone)
def test_when_the_proxy_cannot_clone_for_the_job_it_ends_with_a_stable_code_and_pushes_nothing(
    job_machine: JobMachine,
    job_settings: IncusSettings,
    job_client: CliIncusClient,
    tmp_path: Path,
) -> None:
    refused = run_job(job_machine, job_settings, job_client, tmp_path, REFUSED_JOB, with_git=False)

    [result] = refused.fakes.app.completions
    assert result["ok"] is False, explain(refused)
    assert result["errorCode"] == "clone_failed", explain(refused)
    assert refused.fakes.origin.tip(BRANCH) is None
    # The clone was asked for by name, refused as unresolvable (no address), and nothing else was
    # dialled for the job (not the provider, not the files host: the job never got that far).
    assert not refused.fakes.model.records
    assert all(host != MODEL_HOST for host, _, _, _ in decided(refused))
    assert (GIT_HOST, 443, "refused", "unresolvable") in decided(refused), decided(refused)
    assert GIT_HOST not in {
        host for host, _, outcome, _ in decided(refused) if outcome == "allowed"
    }
    assert refused.left == []
