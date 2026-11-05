# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the runner cleans up between jobs (#854, R1b): the folders of a turn in the work volume and
the labelled containers and networks in the daemon."""

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from code_reviewer_runner.factory_runner import housekeeping
from code_reviewer_runner.factory_runner.housekeeping import (
    TidySeams,
    clear_work,
    foreign_runner,
    remove_leftovers,
    tidy,
)
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.implementer.git_workspace import (
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.result_channel import make_result_directory
from code_reviewer_runner.implementer.role_labels import ROLE_LABEL, RUNNER_LABEL
from code_reviewer_runner.job import JobError
from workspace_support import LocalAccess

pytestmark = pytest.mark.unit


def a_turn_in(work: Path, *, outside: Path | None = None) -> None:
    """What a turn leaves in the volume: the mirror with read-only objects, the agent's tree, the
    result directory, and optionally a link out of the volume."""
    objects = work / "reserve" / "mirror.git" / "objects"
    objects.mkdir(parents=True)
    (objects / "pack").write_text("x")
    (objects / "pack").chmod(0o444)
    objects.chmod(0o555)
    (work / "repo").mkdir()
    (work / "repo" / "file.txt").write_text("y")
    if outside is not None:
        (work / "repo" / "out").symlink_to(outside)
    make_result_directory(work)


# -- the work volume ------------------------------------------------------------------------------


# #854-B1
def test_the_folders_of_a_turn_are_emptied_including_read_only_ones(tmp_path: Path) -> None:
    a_turn_in(tmp_path)

    assert clear_work(tmp_path) == []

    assert list(tmp_path.iterdir()) == []


# #854-B1
def test_nothing_but_the_three_folders_is_touched_and_a_link_is_not_followed(
    tmp_path: Path,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    work = tmp_path / "work"
    work.mkdir()
    a_turn_in(work, outside=outside)
    (work / "lost+found").mkdir()
    (work / "other.txt").write_text("not ours")
    # `result` as a link to a folder elsewhere: the link goes, the folder stays.
    (work / "result").rmdir()
    (work / "result").symlink_to(outside)

    assert clear_work(work) == []

    assert sorted(path.name for path in work.iterdir()) == ["lost+found", "other.txt"]
    assert (outside / "keep.txt").read_text() == "keep"


# #854-B1
def test_a_folder_that_is_a_file_is_removed_too_and_a_missing_one_is_fine(tmp_path: Path) -> None:
    (tmp_path / "repo").write_text("a file where the repository goes")

    assert clear_work(tmp_path) == []

    assert list(tmp_path.iterdir()) == []


# #854-B1
@pytest.mark.skipif(os.geteuid() == 0, reason="root can remove from any folder")
def test_what_cannot_be_removed_is_named_not_raised(tmp_path: Path) -> None:
    a_turn_in(tmp_path)
    (tmp_path / "repo" / "file.txt").chmod(0o644)
    tmp_path.chmod(0o555)  # nothing can be unlinked from the volume's top
    try:
        problems = clear_work(tmp_path)
    finally:
        tmp_path.chmod(0o755)

    assert sorted(problem.split(" ")[0] for problem in problems) == ["repo", "reserve", "result"]


# #854-B1
def test_the_turn_s_own_directory_code_runs_twice_on_one_volume_after_the_cleaning(
    tmp_path: Path,
) -> None:
    """The code of a turn (`GitWorkspace._prepare_directories`, `make_result_directory`) refuses
    what an earlier turn left; with the cleaning between them the second turn is set up."""
    layout = WorkspaceLayout(work_dir=tmp_path / "work", run_dir=tmp_path / "run")
    workspace = GitWorkspace(
        WorkspaceSpec(
            clone_url="https://github.com/acme/widgets.git",
            token="ghs_token",
            base_branch="main",
            branch="implementer/a1",
        ),
        layout,
        GitIdentity("Implementer", "i@example.invalid"),
        LocalAccess(layout.work_dir / "repo", "git", tmp_path),
    )

    def turn() -> None:
        workspace._prepare_directories()  # pyright: ignore[reportPrivateUsage]
        workspace.mirror.mkdir(mode=0o700)
        workspace.repo.mkdir()
        make_result_directory(layout.work_dir)

    turn()
    with pytest.raises(JobError, match="exists already"):
        workspace._prepare_directories()  # pyright: ignore[reportPrivateUsage]

    assert clear_work(layout.work_dir) == []
    turn()  # the second job on the same volume


# -- the daemon ----------------------------------------------------------------------------------


class Daemon:
    def __init__(self) -> None:
        self.containers = ["a" * 64, "b" * 64]
        self.networks = ["c" * 64]
        self.calls: list[str] = []
        self.refuse: set[str] = set()
        self.unlistable: set[str] = set()
        # Labels by id; what has none carries the role label alone, as the hosted Control makes it.
        self.labels: dict[str, dict[str, str]] = {}
        self.stopped: set[str] = set()

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        self.calls.append(f"{method} {path}")
        kind = "containers" if path.startswith("/containers") else "networks"
        if kind in self.unlistable:
            raise DockerError(500, "no")
        filters = json.loads(parse_qs(urlsplit(path).query)["filters"][0])
        wanted: list[str] = filters.get("label", [])
        running = "running" in filters.get("status", ["running"])
        found: list[Any] = []
        for identifier in getattr(self, kind):
            labels = self.labels.get(identifier, {ROLE_LABEL: "agent"})
            has = all(
                (key in labels and labels[key] == value) if sep else key in labels
                for key, sep, value in (entry.partition("=") for entry in wanted)
            )
            if has and (identifier not in self.stopped or not running):
                found.append({"Id": identifier, "Labels": labels})
        return [*found, {"Names": ["no id"]}, {"Id": "../etc"}, "junk"]

    def remove_container(self, container: str, **_kwargs: Any) -> None:
        if container in self.refuse:
            raise DockerError(409, "busy")
        self.containers.remove(container)
        self.calls.append(f"remove container {container[:1]}")

    def remove_network(self, network: str) -> None:
        if network in self.refuse:
            raise DockerError(403, "has endpoints")
        self.networks.remove(network)
        self.calls.append(f"remove network {network[:1]}")


# #854-S1
def test_only_what_carries_the_role_label_is_asked_for_and_removed_containers_first() -> None:
    daemon = Daemon()

    assert remove_leftovers(daemon) == []  # type: ignore[arg-type]

    assert daemon.containers == [] and daemon.networks == []
    listings = [call for call in daemon.calls if call.startswith("GET")]
    assert len(listings) == 2 and all(ROLE_LABEL in call for call in listings)
    removals = [call for call in daemon.calls if call.startswith("remove")]
    assert removals == ["remove container a", "remove container b", "remove network c"]


# #854-S1
def test_an_entry_without_a_proper_id_is_ignored_and_a_refusal_does_not_stop_the_rest() -> None:
    daemon = Daemon()
    daemon.refuse = {"a" * 64}

    problems = remove_leftovers(daemon)  # type: ignore[arg-type]

    assert problems == ["a container cannot be removed (409)"]
    assert daemon.containers == ["a" * 64] and daemon.networks == []  # b and the network went


# #854-S1
def test_a_daemon_that_cannot_list_is_a_problem_not_an_exception() -> None:
    daemon = Daemon()
    daemon.unlistable = {"containers", "networks"}

    problems = remove_leftovers(daemon)  # type: ignore[arg-type]

    assert problems == [
        "the containers cannot be listed (500)",
        "the networks cannot be listed (500)",
    ]


# #854-S1
def test_tidy_cleans_the_daemon_and_the_volume(tmp_path: Path) -> None:
    daemon = Daemon()
    a_turn_in(tmp_path)

    assert tidy(TidySeams(api=lambda: daemon, work_dir=tmp_path)) == []  # type: ignore[arg-type,return-value]

    assert daemon.containers == [] and list(tmp_path.iterdir()) == []


# #854-R2
def test_the_volume_is_left_alone_when_the_daemon_could_not_be_cleaned(tmp_path: Path) -> None:
    daemon = Daemon()
    daemon.refuse = {"a" * 64}  # a container that stays may still have the volume mounted
    a_turn_in(tmp_path)

    problems = tidy(TidySeams(api=lambda: daemon, work_dir=tmp_path))  # type: ignore[arg-type,return-value]

    assert problems == ["docker: a container cannot be removed (409)"]
    assert sorted(path.name for path in tmp_path.iterdir()) == ["repo", "reserve", "result"]


# -- one runner per daemon (R1) -------------------------------------------------------------------


def two_runners(daemon: Daemon) -> None:
    daemon.containers = ["a" * 64, "b" * 64, "e" * 64]
    daemon.networks = ["c" * 64, "f" * 64]
    daemon.labels = {
        "a" * 64: {ROLE_LABEL: "agent", RUNNER_LABEL: "r1"},
        "b" * 64: {ROLE_LABEL: "model-door", RUNNER_LABEL: "r2"},
        "e" * 64: {ROLE_LABEL: "reader"},
        "c" * 64: {ROLE_LABEL: "model-network", RUNNER_LABEL: "r1"},
        "f" * 64: {ROLE_LABEL: "model-network", RUNNER_LABEL: "r2"},
    }


# #854-R1
def test_a_runner_removes_what_carries_its_own_id_and_nothing_of_another(tmp_path: Path) -> None:
    daemon = Daemon()
    two_runners(daemon)

    assert remove_leftovers(daemon, "r1") == []  # type: ignore[arg-type]

    assert daemon.containers == ["b" * 64, "e" * 64]  # the other runner's, and one with no id
    assert daemon.networks == ["f" * 64]


# #854-R1
def test_the_selector_of_the_sweep_names_both_labels() -> None:
    daemon = Daemon()

    remove_leftovers(daemon, "r1")  # type: ignore[arg-type]

    selectors = [
        json.loads(parse_qs(urlsplit(call.split(" ", 1)[1]).query)["filters"][0])
        for call in daemon.calls
        if call.startswith("GET")
    ]
    assert selectors == [{"label": [ROLE_LABEL, f"{RUNNER_LABEL}=r1"]}] * 2


# #854-R1
def test_another_runners_running_container_is_found_and_so_is_one_without_an_id() -> None:
    daemon = Daemon()
    two_runners(daemon)

    assert foreign_runner(daemon, "r1")  # type: ignore[arg-type]
    daemon.containers = ["a" * 64]
    assert not foreign_runner(daemon, "r1")  # type: ignore[arg-type]
    daemon.containers = ["e" * 64]  # a hosted-style container with the role label alone
    assert foreign_runner(daemon, "r1")  # type: ignore[arg-type]


# #854-R1
def test_a_stopped_container_of_another_runner_is_not_a_runner_that_works() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.containers = ["b" * 64]
    daemon.stopped = {"b" * 64}

    assert not foreign_runner(daemon, "r1")  # type: ignore[arg-type]


# #854-R1
def test_a_daemon_that_cannot_list_is_not_called_foreign_the_tidy_reports_it() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.unlistable = {"containers"}

    assert not foreign_runner(daemon, "r1")  # type: ignore[arg-type]


# -- the work volume, the finer points (R2, F5) --------------------------------------------------


# #854-R2
def test_no_right_is_changed_by_the_path_only_the_opened_folder_is(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("a path was changed, not an opened folder")

    a_turn_in(tmp_path)
    monkeypatch.setattr(os, "chmod", refuse)

    assert clear_work(tmp_path) == []

    assert list(tmp_path.iterdir()) == []


# #854-R2
def test_a_link_in_the_place_of_the_folder_changes_no_right_outside(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    (outside / "inner").mkdir(parents=True)
    outside.chmod(0o500)
    (outside / "inner").chmod(0o500)
    try:
        link = tmp_path / "swapped"
        link.symlink_to(outside)

        clean = housekeeping._make_removable(link, os.stat(tmp_path).st_dev)  # pyright: ignore[reportPrivateUsage]

        assert clean
        assert (outside.stat().st_mode & 0o777, (outside / "inner").stat().st_mode & 0o777) == (
            0o500,
            0o500,
        )
    finally:
        outside.chmod(0o700)
        (outside / "inner").chmod(0o700)


def on_other_device(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    """Folders called `name` are reported on a device of their own, as a mount point is."""
    real = os.fstat

    def fstat(descriptor: int) -> Any:
        status = real(descriptor)
        if os.readlink(f"/proc/self/fd/{descriptor}").endswith(f"/{name}"):
            return SimpleNamespace(st_dev=status.st_dev + 1)
        return status

    monkeypatch.setattr(housekeeping.os, "fstat", fstat)


# #854-F5
def test_a_mount_point_below_a_folder_is_reported_and_nothing_is_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    a_turn_in(tmp_path)
    (tmp_path / "repo" / "cache").mkdir()
    (tmp_path / "repo" / "cache" / "precious").write_text("on another device")
    on_other_device(monkeypatch, "cache")

    problems = clear_work(tmp_path)

    assert problems == ["repo (a mount point is below it)"]
    assert (tmp_path / "repo" / "cache" / "precious").read_text() == "on another device"
    assert (tmp_path / "repo" / "file.txt").exists()  # the folder is left whole, not half emptied
    assert not (tmp_path / "reserve").exists() and not (tmp_path / "result").exists()


# #854-F5
def test_a_mount_point_keeps_the_runner_from_claiming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    a_turn_in(tmp_path)
    (tmp_path / "repo" / "cache").mkdir()
    on_other_device(monkeypatch, "cache")

    problems = tidy(TidySeams(api=Daemon, work_dir=tmp_path))  # type: ignore[arg-type,return-value]

    assert problems == ["work volume: repo (a mount point is below it)"]
