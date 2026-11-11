# SPDX-License-Identifier: LicenseRef-Proprietary

"""The disk budget of a runner's job (#855, R2): what is measured, what happens when it is passed,
and that the next job starts clean."""

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import pytest
from loop_support import Harness, make_claim, run, settle

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import FakeDockerEngine, FakeExec

from code_reviewer_runner.factory_runner import disk_budget
from code_reviewer_runner.factory_runner.config import Limits
from code_reviewer_runner.factory_runner.disk_budget import (
    GIB,
    budget_bytes,
    exceeded_message,
    guard_for,
    tree_bytes,
    used_bytes,
)
from code_reviewer_runner.factory_runner.housekeeping import (
    ENVIRONMENT_IMAGE,
    remove_environment_image,
)
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.role_labels import ROLE_LABEL

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _no_inner_size_from_another_test() -> None:
    disk_budget._last_inner_bytes.clear()  # pyright: ignore[reportPrivateUsage]


def test_the_budget_is_the_disk_limit_in_bytes_or_none() -> None:
    assert budget_bytes(Limits(disk_gb=40)) == 40 * GIB
    assert budget_bytes(Limits()) is None


def test_a_folder_is_measured_by_what_it_holds_on_disk_links_not_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "big").write_bytes(b"x" * 1_000_000)
    tree = tmp_path / "repo"
    (tree / "sub").mkdir(parents=True)
    (tree / "a").write_bytes(b"x" * 100_000)
    (tree / "sub" / "b").write_bytes(b"x" * 100_000)
    os.link(tree / "a", tree / "sub" / "a-again")  # one file, two names
    (tree / "out").symlink_to(outside)  # the agent may link out of the volume

    size = tree_bytes(tree)

    assert 200_000 <= size < 400_000  # not the million of `outside`, the linked file once
    assert tree_bytes(tmp_path / "missing") == 0


AGENT_IMAGE = "code-reviewer-agent:golden"


class Daemon:
    def __init__(
        self,
        *,
        sizes: dict[str, int | None],
        image: int | None = None,
        base: int | None = 0,
        roles: dict[str, str] | None = None,
    ) -> None:
        self.sizes = sizes
        # The size of the environment image (None: there is none) and of the agent image it was
        # committed from (None: the daemon does not know it).
        self.image = image
        self.base = base
        self.roles = roles or {}
        self.unlistable = False
        self.removed: list[str] = []
        # The runtime a container was made with (default: `runc`, as a lane without Sysbox).
        self.runtimes: dict[str, str] = {}
        self.inspected: list[str] = []

    def inspect_container(self, ref: str) -> dict[str, Any]:
        self.inspected.append(ref)
        return {"HostConfig": {"Runtime": self.runtimes.get(ref, "runc")}}

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        assert method == "GET" and path.startswith("/containers/json")
        if self.unlistable:
            raise DockerError(500, "no")
        return [
            {"Id": identifier, "Labels": {ROLE_LABEL: self.roles.get(identifier, "agent")}}
            for identifier in self.sizes
        ] + [{"Names": ["no id"]}]

    def container_rw_bytes(self, ref: str, *, timeout: float) -> int | None:
        value = self.sizes[ref]
        if value is None:
            raise DockerError(404, "gone")
        return value

    def inspect_image(self, reference: str) -> dict[str, Any]:
        size = {ENVIRONMENT_IMAGE: self.image, AGENT_IMAGE: self.base}[reference]
        if size is None:
            raise DockerError(404, "no such image")
        return {"Size": size}

    def remove_image(self, reference: str) -> None:
        self.removed.append(reference)


def test_what_the_job_holds_is_its_work_folders_and_its_containers(tmp_path: Path) -> None:
    (tmp_path / "repo").mkdir()
    (tmp_path / "repo" / "f").write_bytes(b"x" * 50_000)
    (tmp_path / "unrelated").mkdir()
    (tmp_path / "unrelated" / "f").write_bytes(b"x" * 9_000_000)  # not the job's
    daemon = Daemon(sizes={"a" * 64: 1_000, "b" * 64: 2_000, "c" * 64: None})

    total = used_bytes(daemon, tmp_path, "r1")  # type: ignore[arg-type]

    assert 53_000 <= total < 100_000


# #855-F1 (S5), #1009: nothing is committed any more, so the one container the script and the agent
# share is measured by its own layer, once, whatever images an earlier version left on the daemon
def test_the_container_the_script_ran_in_is_counted_by_its_layer_and_no_image_is_added(
    tmp_path: Path,
) -> None:
    agent = "a" * 64
    daemon = Daemon(sizes={agent: 700_000}, image=GIB + 700_000, base=GIB)

    assert used_bytes(daemon, tmp_path, "r1") == 700_000  # type: ignore[arg-type]


# #1009-T36: under Sysbox the inner Docker's data (`/var/lib/docker` of the container) is a mount
# the runtime manages, not the container's writable layer, so the layer says nothing of what the
# script pulled or built there: the inner data directory is measured by an exec and counted besides
def test_the_inner_docker_of_a_sysbox_container_is_counted_beside_its_layer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = "a" * 64
    daemon = Daemon(sizes={agent: 700_000})
    daemon.runtimes[agent] = "sysbox-runc"
    asked: list[tuple[str, list[str]]] = []

    def run_exec(api: Any, container: str, argv: list[str], **options: Any) -> Outcome:
        asked.append((container, argv))
        return Outcome(0, f"{3 * GIB}\t/var/lib/docker\n", "")

    monkeypatch.setattr(disk_budget, "run_exec", run_exec)

    assert used_bytes(daemon, tmp_path, "r1") == 700_000 + 3 * GIB  # type: ignore[arg-type]
    # One fixed command, a constant path, one file system (the inner containers' own mounts are
    # other file systems and counted once, as the data they come from).
    assert asked == [
        (
            agent,
            [
                "/usr/bin/timeout",
                "-s",
                "KILL",
                "50",
                "/usr/bin/du",
                "-sx",
                "-B1",
                "/var/lib/docker",
            ],
        )
    ]


# #1009-T37
def test_a_container_of_another_runtime_has_no_inner_docker_to_measure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = "a" * 64
    daemon = Daemon(sizes={agent: 700_000})

    def run_exec(*args: Any, **options: Any) -> Outcome:
        raise AssertionError("a runc container's /var/lib/docker is in its layer already")

    monkeypatch.setattr(disk_budget, "run_exec", run_exec)

    assert used_bytes(daemon, tmp_path, "r1") == 700_000  # type: ignore[arg-type]


# #1009-T38
@pytest.mark.parametrize(
    "answer",
    [
        Outcome(255, "", "timed out", unanswered=True),  # a frozen container is no exec target
        Outcome(1, "", "du: cannot access"),
        Outcome(0, "not a number\t/var/lib/docker\n", ""),
        Outcome(0, "", ""),
    ],
)
def test_an_inner_size_the_daemon_cannot_say_counts_for_nothing_and_the_layer_still_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer: Outcome
) -> None:
    agent = "a" * 64
    daemon = Daemon(sizes={agent: 700_000})
    daemon.runtimes[agent] = "sysbox-runc"

    def run_exec(*args: Any, **options: Any) -> Outcome:
        return answer

    monkeypatch.setattr(disk_budget, "run_exec", run_exec)

    assert used_bytes(daemon, tmp_path, "r1") == 700_000  # type: ignore[arg-type]


# #1009-T50: a `du` that does not answer in time (a huge inner store is where it is slowest)
# must not make the budget blind when the store is largest: the last size that was measured
# counts until a new one is, and the `du` is bounded in the container below the exec's own
# timeout, so slow ones do not pile up from one measure to the next.
def test_an_inner_size_that_times_out_keeps_the_last_measured_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = "b" * 64
    daemon = Daemon(sizes={agent: 700_000})
    daemon.runtimes[agent] = "sysbox-runc"
    answers = [
        Outcome(0, f"{3 * GIB}\t/var/lib/docker\n", ""),
        Outcome(255, "", "timed out", unanswered=True),
        Outcome(137, "", ""),
    ]
    budgets: list[float] = []

    def run_exec(*args: Any, **options: Any) -> Outcome:
        budgets.append(options["timeout"])
        return answers.pop(0)

    monkeypatch.setattr(disk_budget, "run_exec", run_exec)

    for _ in range(3):
        assert used_bytes(daemon, tmp_path, "r1") == 700_000 + 3 * GIB  # type: ignore[arg-type]
    assert all(budget > 50 for budget in budgets)


# #1009-T39
def test_the_inner_size_is_asked_of_a_real_daemon_by_an_exec_in_the_container(
    tmp_path: Path,
) -> None:
    """Against the fake Engine: the exec's document, and a `du` line read back."""
    from code_reviewer_runner.implementer.docker_api import DockerApi

    engine = FakeDockerEngine(tmp_path / "docker.sock").start()
    seen: list[list[str]] = []

    def behave(made: FakeExec, stdin: Any, stdout: Any) -> int:
        seen.append(made.document["Cmd"])
        stdout.write("123456789\t/var/lib/docker\n")
        return 0

    engine.exec_behaviour = behave
    api = DockerApi(str(tmp_path / "docker.sock"), timeout=5.0)
    try:
        identifier = api.create_container(
            {"Image": "x", "Labels": {}, "HostConfig": {"Runtime": "sysbox-runc"}}, "agent-b04"
        )
        api.start_container(identifier)
        assert disk_budget.inner_docker_bytes(api, identifier) == 123456789
    finally:
        engine.stop()
    assert seen == [
        ["/usr/bin/timeout", "-s", "KILL", "50", "/usr/bin/du", "-sx", "-B1", "/var/lib/docker"]
    ]


def test_a_daemon_that_cannot_answer_counts_for_nothing_and_ends_no_job(tmp_path: Path) -> None:
    daemon = Daemon(sizes={"a" * 64: 1_000})
    daemon.unlistable = True

    assert used_bytes(daemon, tmp_path, "r1") == 0  # type: ignore[arg-type]


def test_the_message_says_the_budget_the_use_and_the_way_out() -> None:
    message = exceeded_message(10 * GIB, int(12.5 * GIB))

    assert "10.0 GB" in message and "12.5 GB" in message and "config set --disk-gb" in message


# -- the guard --------------------------------------------------------------------------------


def test_the_guard_returns_when_the_budget_is_passed_and_only_then() -> None:
    async def scenario() -> None:
        uses = iter([1, 2, 30])
        watch = guard_for(10, lambda: next(uses), interval=0)

        message = await asyncio.wait_for(watch(), 5)

        assert "disk budget" in message

    run(scenario)


def test_a_measure_that_fails_does_not_end_the_job() -> None:
    async def scenario() -> None:
        calls = 0

        def measure() -> int:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise OSError("the volume is busy")
            return 99

        message = await asyncio.wait_for(guard_for(10, measure, interval=0)(), 5)

        assert calls == 3 and "disk budget" in message

    run(scenario)


# -- the host ends the job ----------------------------------------------------------------------


# #855: the lane test of the budget is `tests/lane/test_runner_disk_budget.py`; this is the host.
def test_a_job_that_passes_the_budget_is_ended_and_reported_as_failed_not_given_back() -> None:
    async def scenario() -> None:
        over = asyncio.Event()

        async def guard() -> str:
            await over.wait()
            return exceeded_message(GIB, 2 * GIB)

        harness = Harness(guard=guard)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = harness.launcher.processes[0]
        assert not process.terminated

        over.set()
        await settle()

        assert process.terminated
        (_, _, result) = harness.api.completions[0]
        assert (result["ok"], result["errorCode"]) == (False, "runner_error")
        assert result["errorReason"] == "disk_budget_exceeded"
        assert "disk budget of 1.0 GB" in result["errorMessage"]
        await harness.stop()

    run(scenario)


def test_a_job_within_its_budget_is_not_touched() -> None:
    async def scenario() -> None:
        async def guard() -> str:
            await asyncio.sleep(3600)
            return "never"

        harness = Harness(guard=guard)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        process = harness.launcher.processes[0]

        await settle()

        assert not process.terminated and not harness.api.completions
        await harness.stop()

    run(scenario)


# -- the cleaning ----------------------------------------------------------------------------------


def test_the_environment_image_is_removed_by_name_and_a_refusal_is_no_problem() -> None:
    daemon = Daemon(sizes={})
    remove_environment_image(daemon)  # type: ignore[arg-type]
    assert daemon.removed == [ENVIRONMENT_IMAGE]

    class Refusing(Daemon):
        def remove_image(self, reference: str) -> None:
            raise DockerError(500, "busy")

    remove_environment_image(Refusing(sizes={}))  # type: ignore[arg-type]
