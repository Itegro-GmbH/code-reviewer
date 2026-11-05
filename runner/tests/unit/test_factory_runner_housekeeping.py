# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the runner cleans up between jobs (#854, R1b): the folders of a turn in the work volume and
the labelled containers and networks in the daemon."""

import errno
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from code_reviewer_runner.factory_runner import housekeeping
from code_reviewer_runner.factory_runner.housekeeping import (
    LOCK_CONTAINER,
    LOCK_LABEL,
    NO_IDENTITY,
    TidySeams,
    clear_work,
    foreign_object,
    release_lock,
    remove_leftovers,
    take_lock,
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
        # Labels by id; what has none is this runner's ("r1"), as a turn of it makes it.
        self.labels: dict[str, dict[str, str]] = {}
        self.names: dict[str, str] = {}
        self.stopped: set[str] = set()
        # The labels of the lock container, if there is one.
        self.lock: dict[str, str] | None = None
        self.lock_refused = False

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        self.calls.append(f"{method} {path}")
        kind = "containers" if path.startswith("/containers") else "networks"
        if kind in self.unlistable:
            raise DockerError(500, "no")
        query = parse_qs(urlsplit(path).query)
        wanted: list[str] = json.loads(query["filters"][0]).get("label", [])
        everything = query.get("all") == ["1"] or kind == "networks"
        found: list[Any] = []
        for identifier in getattr(self, kind):
            labels = self.labels.get(identifier, {ROLE_LABEL: "agent", RUNNER_LABEL: "r1"})
            has = all(
                (key in labels and labels[key] == value) if sep else key in labels
                for key, sep, value in (entry.partition("=") for entry in wanted)
            )
            if has and (everything or identifier not in self.stopped):
                name = self.names.get(identifier, "code-reviewer-agent")
                found.append(
                    {"Id": identifier, "Labels": labels}
                    | ({"Names": [f"/{name}"]} if kind == "containers" else {"Name": name})
                )
        return [*found, {"Names": ["no id"]}, {"Id": "../etc"}, "junk"]

    def remove_container(self, container: str, **_kwargs: Any) -> None:
        if container == LOCK_CONTAINER:
            self.lock = None
            self.calls.append("remove lock")
            return
        if container in self.refuse:
            raise DockerError(409, "busy")
        self.containers.remove(container)
        self.calls.append(f"remove container {container[:1]}")

    def remove_network(self, network: str) -> None:
        if network in self.refuse:
            raise DockerError(403, "has endpoints")
        self.networks.remove(network)
        self.calls.append(f"remove network {network[:1]}")

    def remove_image(self, reference: str) -> None:
        self.calls.append(f"remove image {reference}")

    def create_container(self, document: dict[str, Any], name: str) -> str:
        assert name == LOCK_CONTAINER
        if self.lock_refused:
            raise DockerError(404, "no such image")
        if self.lock is not None:
            raise DockerError(409, "name in use")
        self.lock = document["Labels"]
        return "d" * 64

    def inspect_container(self, name: str) -> dict[str, Any]:
        assert name == LOCK_CONTAINER
        if self.lock is None:
            raise DockerError(404, "no such container")
        return {"Config": {"Labels": self.lock}}


# #854-S1
def test_only_what_carries_the_role_label_is_asked_for_and_removed_containers_first() -> None:
    daemon = Daemon()

    assert remove_leftovers(daemon, "r1") == []  # type: ignore[arg-type]

    assert daemon.containers == [] and daemon.networks == []
    listings = [call for call in daemon.calls if call.startswith("GET")]
    assert len(listings) == 2 and all(ROLE_LABEL in call for call in listings)
    removals = [call for call in daemon.calls if call.startswith("remove")]
    assert removals == ["remove container a", "remove container b", "remove network c"]


# #854-S1
def test_an_entry_without_a_proper_id_is_ignored_and_a_refusal_does_not_stop_the_rest() -> None:
    daemon = Daemon()
    daemon.refuse = {"a" * 64}

    problems = remove_leftovers(daemon, "r1")  # type: ignore[arg-type]

    assert problems == ["a container cannot be removed (409)"]
    assert daemon.containers == ["a" * 64] and daemon.networks == []  # b and the network went


# #854-S1
def test_a_daemon_that_cannot_list_is_a_problem_not_an_exception() -> None:
    daemon = Daemon()
    daemon.unlistable = {"containers", "networks"}

    problems = remove_leftovers(daemon, "r1")  # type: ignore[arg-type]

    assert problems == [
        "the containers cannot be listed (500)",
        "the networks cannot be listed (500)",
    ]


# #854-S1
def test_tidy_cleans_the_daemon_and_the_volume(tmp_path: Path) -> None:
    daemon = Daemon()
    a_turn_in(tmp_path)

    assert tidy(TidySeams(api=lambda: daemon, work_dir=tmp_path, runner_id="r1")) == []  # type: ignore[arg-type,return-value]

    assert daemon.containers == [] and list(tmp_path.iterdir()) == []


# #854-R2
def test_the_volume_is_left_alone_when_the_daemon_could_not_be_cleaned(tmp_path: Path) -> None:
    daemon = Daemon()
    daemon.refuse = {"a" * 64}  # a container that stays may still have the volume mounted
    a_turn_in(tmp_path)

    problems = tidy(TidySeams(api=lambda: daemon, work_dir=tmp_path, runner_id="r1"))  # type: ignore[arg-type,return-value]

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
def test_another_runners_container_is_found_and_so_is_one_without_an_id() -> None:
    daemon = Daemon()
    two_runners(daemon)

    assert foreign_object(daemon, "r1") is not None  # type: ignore[arg-type]
    daemon.containers = ["a" * 64]
    daemon.networks = ["c" * 64]
    assert foreign_object(daemon, "r1") is None  # type: ignore[arg-type]
    daemon.containers = ["e" * 64]  # a hosted-style container with the role label alone
    assert foreign_object(daemon, "r1") is not None  # type: ignore[arg-type]


# #854-S4
def test_the_first_hit_is_named_with_its_name_its_role_and_its_runner_or_none() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.names = {"b" * 64: "code-reviewer-door", "e" * 64: "code-reviewer-reader"}
    daemon.containers = ["e" * 64, "b" * 64]

    assert foreign_object(daemon, "r1") == (  # type: ignore[arg-type]
        "container code-reviewer-reader (role reader, runner none)"
    )
    daemon.containers = ["b" * 64]
    assert foreign_object(daemon, "r1") == (  # type: ignore[arg-type]
        "container code-reviewer-door (role model-door, runner r2)"
    )


# #854-S5
@pytest.mark.parametrize("state", ["running", "exited", "paused", "restarting", "created"])
def test_a_container_of_another_runner_counts_in_every_state(state: str) -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.containers = ["b" * 64]
    daemon.networks = []
    if state != "running":
        daemon.stopped = {"b" * 64}  # the fake lists it only for `all=1`, as the daemon does

    assert foreign_object(daemon, "r1") is not None  # type: ignore[arg-type]
    assert "all=1" in daemon.calls[0]


# #854-S5
def test_a_network_of_another_runner_or_without_an_id_counts_too() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.containers = []
    daemon.networks = ["f" * 64]
    daemon.names = {"f" * 64: "code-reviewer-model"}

    assert foreign_object(daemon, "r1") == (  # type: ignore[arg-type]
        "network code-reviewer-model (role model-network, runner r2)"
    )
    daemon.labels["f" * 64] = {ROLE_LABEL: "model-network"}
    assert foreign_object(daemon, "r1") == (  # type: ignore[arg-type]
        "network code-reviewer-model (role model-network, runner none)"
    )


# #854-S5
def test_what_is_the_runners_own_is_no_foreign_object_even_when_it_is_stopped() -> None:
    daemon = Daemon()
    daemon.stopped = {"a" * 64}  # exited, own: the sweep removes it

    assert foreign_object(daemon, "r1") is None  # type: ignore[arg-type]


# #854-S5
def test_a_stopped_leftover_of_this_runner_is_swept_and_one_of_another_is_not() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.stopped = {"a" * 64, "b" * 64}

    assert remove_leftovers(daemon, "r1") == []  # type: ignore[arg-type]

    assert daemon.containers == ["b" * 64, "e" * 64]
    assert daemon.networks == ["f" * 64]


# #854-S4
def test_what_the_daemon_says_is_shortened_and_stripped_of_control_characters() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.names = {"b" * 64: "x\n\x1b[31m" + "y" * 200}
    daemon.containers = ["b" * 64]

    found = foreign_object(daemon, "r1")  # type: ignore[arg-type]

    assert found is not None and "\n" not in found and "\x1b" not in found and len(found) < 200


# #854-R1
def test_a_daemon_that_cannot_list_has_no_foreign_object_the_tidy_reports_it() -> None:
    daemon = Daemon()
    two_runners(daemon)
    daemon.unlistable = {"containers", "networks"}

    assert foreign_object(daemon, "r1") is None  # type: ignore[arg-type]


# #854-N4
def test_without_an_identity_nothing_is_swept_by_the_role_label_alone() -> None:
    daemon = Daemon()

    assert remove_leftovers(daemon, "") == [NO_IDENTITY]  # type: ignore[arg-type]

    assert daemon.calls == [] and len(daemon.containers) == 2 and len(daemon.networks) == 1
    assert tidy(TidySeams(api=lambda: daemon)) == [f"docker: {NO_IDENTITY}"]  # type: ignore[arg-type,return-value]
    assert daemon.calls == []


# -- the lock (S1) ---------------------------------------------------------------------------------


# #854-S1
def test_the_first_runner_takes_the_lock_and_a_second_one_is_told_who_has_it() -> None:
    daemon = Daemon()

    assert take_lock(daemon, "r1", "image") is None  # type: ignore[arg-type]
    assert daemon.lock == {LOCK_LABEL: "r1"}

    held = take_lock(daemon, "r2", "image")  # type: ignore[arg-type]
    assert held == f"container {LOCK_CONTAINER} (held by runner r1)"


# #854-S1
def test_a_lock_left_by_the_same_runner_is_its_own_again() -> None:
    daemon = Daemon()
    daemon.lock = {LOCK_LABEL: "r1"}

    assert take_lock(daemon, "r1", "image") is None  # type: ignore[arg-type]


# #854-S1
def test_a_daemon_that_refuses_for_another_reason_holds_no_other_runner() -> None:
    daemon = Daemon()
    daemon.lock_refused = True

    assert take_lock(daemon, "r1", "image") is None  # type: ignore[arg-type]


# #854-S1
def test_release_removes_the_lock_of_this_runner_and_never_another_runners() -> None:
    daemon = Daemon()
    daemon.lock = {LOCK_LABEL: "r2"}

    release_lock(daemon, "r1")  # type: ignore[arg-type]
    assert daemon.lock == {LOCK_LABEL: "r2"}

    release_lock(daemon, "r2")  # type: ignore[arg-type]
    assert daemon.lock is None
    release_lock(daemon, "r2")  # type: ignore[arg-type]  # and none at all is fine


# #854-S1
def test_the_lock_is_no_leftover_of_a_turn_and_no_sweep_takes_it() -> None:
    daemon = Daemon()
    take_lock(daemon, "r1", "image")  # type: ignore[arg-type]

    assert remove_leftovers(daemon, "r1") == []  # type: ignore[arg-type]

    assert daemon.lock == {LOCK_LABEL: "r1"}


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

    problems = tidy(TidySeams(api=Daemon, work_dir=tmp_path, runner_id="r1"))  # type: ignore[arg-type,return-value]

    assert problems == ["work volume: repo (a mount point is below it)"]


# -- a folder the owner may not enter (S2, N1) -----------------------------------------------------

not_root = pytest.mark.skipif(os.geteuid() == 0, reason="root enters a folder of mode 000")


def locked_turn(work: Path) -> Path:
    """A turn whose tree holds folders of mode 000, nested and at the top; the deepest one."""
    a_turn_in(work)
    deep = work / "repo" / "sub" / "deep"
    deep.mkdir(parents=True)
    (deep / "file").write_text("z")
    deep.chmod(0o000)
    deep.parent.chmod(0o000)
    (work / "result").chmod(0o000)
    return deep


# #854-S2
@not_root
def test_folders_of_mode_000_do_not_keep_the_runner_from_cleaning(tmp_path: Path) -> None:
    locked_turn(tmp_path)

    assert clear_work(tmp_path) == []

    assert list(tmp_path.iterdir()) == []


# #854-S2
@not_root
def test_the_next_turn_can_start_after_a_job_locked_its_folders(tmp_path: Path) -> None:
    locked_turn(tmp_path)

    assert tidy(TidySeams(api=Daemon, work_dir=tmp_path, runner_id="r1")) == []  # type: ignore[arg-type,return-value]

    a_turn_in(tmp_path)  # the second job on the same volume


# #854-S2
@not_root
def test_without_a_chmod_that_refuses_links_the_folder_is_held_and_changed_by_its_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    locked_turn(tmp_path)
    real = os.chmod

    def chmod(
        path: Any, mode: int, *, dir_fd: int | None = None, follow_symlinks: bool = True
    ) -> None:
        if dir_fd is not None:
            raise NotImplementedError("chmod: follow_symlinks unavailable on this platform")
        real(path, mode)

    monkeypatch.setattr(os, "chmod", chmod)

    assert clear_work(tmp_path) == []

    assert list(tmp_path.iterdir()) == []


# #854-S2
@not_root
def test_a_chmod_that_the_file_system_refuses_is_the_same_as_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    locked_turn(tmp_path)
    real = os.chmod

    def chmod(
        path: Any, mode: int, *, dir_fd: int | None = None, follow_symlinks: bool = True
    ) -> None:
        if dir_fd is not None:
            raise OSError(errno.ENOTSUP, "not supported")
        real(path, mode)

    monkeypatch.setattr(os, "chmod", chmod)

    assert clear_work(tmp_path) == []


# #854-S2
@not_root
def test_a_link_to_a_folder_of_mode_000_is_unlinked_and_the_folder_is_left_as_it_is(
    tmp_path: Path,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    a_turn_in(work, outside=outside)
    outside.chmod(0o000)
    try:
        shutil.rmtree(work / "result")
        (work / "result").symlink_to(outside)  # a link in the place of a folder of the turn

        assert clear_work(work) == []

        assert outside.stat().st_mode & 0o777 == 0
        assert not (work / "repo").exists() and not (work / "result").is_symlink()
    finally:
        outside.chmod(0o700)


# #854-N1
def test_a_folder_whose_status_cannot_be_read_is_closed_not_leaked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    a_turn_in(tmp_path)
    (tmp_path / "repo" / "sub").mkdir()

    def broken(_descriptor: int) -> Any:
        raise OSError(errno.EIO, "no status")

    before = len(os.listdir("/proc/self/fd"))
    monkeypatch.setattr(housekeeping.os, "fstat", broken)

    problems = clear_work(tmp_path)

    monkeypatch.undo()
    assert len(os.listdir("/proc/self/fd")) == before
    assert any(problem.startswith("repo") for problem in problems)
