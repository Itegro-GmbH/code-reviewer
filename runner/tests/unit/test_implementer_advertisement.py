# SPDX-License-Identifier: LicenseRef-Proprietary

"""When a runner advertises `implementer` (#765): only after the start-up self-check proved the
engine's prerequisites, each missing one with a reason of its own, and never for a runner that is
not an Implementer container."""

import logging
import os
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.capabilities import (
    ALL_ENGINES,
    ENGINE_DIFF,
    ENGINE_DYNAMIC,
    ENGINE_IMPLEMENTER,
    ENGINES_VARIABLE,
    engines_from_environment,
)
from code_reviewer_runner.dynamic_review.netguard import EgressMode
from code_reviewer_runner.dynamic_review.self_check import SelfCheckFailed, SelfCheckReason
from code_reviewer_runner.dynamic_review.static_isolation import (
    EgressSetup,
    ImplementerNetwork,
    SlotPorts,
)
from code_reviewer_runner.implementer import startup
from code_reviewer_runner.implementer.startup import (
    ImplementerSeams,
    check_implementer_runner,
    prepare_work_dir,
    runs_scripts_as,
)
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.service import decide_implementer
from code_reviewer_runner.job_loop.settings import (
    SettingsError,
    WorkerSettings,
    worker_settings_from_environment,
)
from code_reviewer_runner.verdict import Verdict

WORK = Path("/work")
USER = (10101, 10101)
PORTS = SlotPorts(10180, 10181, 10182)
CONTAINER = {
    "RUNNER_DIFF_JOB_USER": "10001:10001",
    "RUNNER_IMPLEMENTER_WORK_DIR": "/work",
    "RUNNER_IMPLEMENTER_NETWORK": "registries",
    "RUNNER_IMPLEMENTER_EGRESS_PORT": "10182",
}


def which_everything(name: str, path: str) -> str | None:
    return f"/usr/bin/{name}"


def which_without(tool: str) -> Callable[[str, str], str | None]:
    def which(name: str, path: str) -> str | None:
        return None if name == tool else f"/usr/bin/{name}"

    return which


def prepared(directory: Path, uid: int, gid: int) -> None:
    return None


def runs_scripts(directory: Path, uid: int, gid: int) -> bool:
    return True


def refuses_scripts(directory: Path, uid: int, gid: int) -> bool:
    return False


def is_a_directory(path: Path) -> bool:
    return True


def is_no_directory(path: Path) -> bool:
    return False


def seams(**changes: Any) -> ImplementerSeams:
    """Every prerequisite holds, except what the test changes."""
    base: dict[str, Any] = {
        "which": which_everything,
        "prepare_work_dir": prepared,
        "runs_scripts_as": runs_scripts,
        "is_directory": is_a_directory,
    }
    return ImplementerSeams(**{**base, **changes})


def check(
    *,
    network: ImplementerNetwork = ImplementerNetwork.REGISTRIES,
    ports: SlotPorts | None = PORTS,
    user: tuple[int, int] | None = USER,
    **changes: Any,
) -> None:
    check_implementer_runner(
        work_dir=WORK, user=user, ports=ports, network=network, seams=seams(**changes)
    )


def refused(**changes: Any) -> SelfCheckReason:
    with pytest.raises(SelfCheckFailed) as failure:
        check(**changes)
    return failure.value.reason


# #765-T02
def test_with_every_prerequisite_the_check_passes() -> None:
    check()
    check(network=ImplementerNetwork.NONE, ports=SlotPorts(10180, 10181))


# #765-T02
@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"which": which_without("git")}, "git_missing"),
        ({"which": which_without("setpriv")}, "setpriv_missing"),
        ({"ports": SlotPorts(10180, 10181)}, "egress_rules_missing"),
        ({"ports": None}, "egress_rules_missing"),
        ({"is_directory": is_no_directory}, "work_dir_missing"),
        ({"runs_scripts_as": refuses_scripts}, "work_dir_not_exec"),
    ],
)
def test_each_missing_prerequisite_has_a_reason_of_its_own(
    changes: dict[str, Any], reason: str
) -> None:
    assert refused(**changes).value == f"implementer_{reason}"


# #765-T02
def test_a_work_directory_that_cannot_be_prepared_is_a_reason_of_its_own() -> None:
    def broken(directory: Path, uid: int, gid: int) -> None:
        raise PermissionError

    assert refused(prepare_work_dir=broken) is SelfCheckReason.IMPLEMENTER_WORK_DIR_NOT_PREPARED


# #765-T02
def test_without_an_engine_user_there_is_nothing_to_prepare() -> None:
    assert refused(user=None) is SelfCheckReason.NOT_A_DYNAMIC_RUNNER


# #765-T02
def test_the_work_directory_is_prepared_before_the_exec_check_and_for_the_engine_user() -> None:
    calls: list[tuple[str, int, int]] = []

    def prepare(directory: Path, uid: int, gid: int) -> None:
        calls.append(("prepare", uid, gid))

    def execute(directory: Path, uid: int, gid: int) -> bool:
        calls.append(("exec", uid, gid))
        return True

    check(prepare_work_dir=prepare, runs_scripts_as=execute)
    assert calls == [("prepare", 10101, 10101), ("exec", 10101, 10101)]


# #765-T02: the exec-capable check is a real execution, not a look at a flag.
def test_a_script_in_the_work_directory_is_really_run(tmp_path: Path) -> None:
    (tmp_path / "tmp").mkdir()
    (tmp_path / "home").mkdir()

    assert runs_scripts_as(tmp_path, os.geteuid(), os.getegid())
    assert not (tmp_path / "tmp" / ".exec-probe.sh").exists()


# #765-T02
def test_a_work_directory_that_refuses_to_run_scripts_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "tmp").mkdir()
    (tmp_path / "home").mkdir()

    def noexec(*args: Any, **options: Any) -> None:
        raise PermissionError(13, "Permission denied")  # what a `noexec` mount answers

    monkeypatch.setattr(startup.subprocess, "run", noexec)

    assert not runs_scripts_as(tmp_path, os.geteuid(), os.getegid())
    assert not (tmp_path / "tmp" / ".exec-probe.sh").exists()


# #765-T02: the chown the container profile expects of the Worker.
def test_the_home_and_the_temporary_directory_of_the_engine_user_are_made_in_the_work_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    owners: list[tuple[str, int, int]] = []
    real = os.fchown

    def record(descriptor: int, uid: int, gid: int) -> None:
        owners.append((os.readlink(f"/proc/self/fd/{descriptor}"), uid, gid))

    monkeypatch.setattr(os, "fchown", record)

    prepare_work_dir(tmp_path, 10101, 10102)
    prepare_work_dir(tmp_path, 10101, 10102)  # idempotent

    monkeypatch.setattr(os, "fchown", real)
    assert sorted(owners) == sorted(
        [(str(tmp_path / "home"), 10101, 10102), (str(tmp_path / "tmp"), 10101, 10102)] * 2
    )
    assert (tmp_path / "home").stat().st_mode & 0o777 == 0o700


# #765-T02
def test_a_link_in_the_place_of_a_directory_is_refused(tmp_path: Path) -> None:
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "home").symlink_to(tmp_path / "elsewhere")

    with pytest.raises(OSError):
        prepare_work_dir(tmp_path, os.geteuid(), os.getegid())


# -- the settings and the startup ------------------------------------------------------------------


def settings_of(environment: dict[str, str]) -> WorkerSettings:
    return worker_settings_from_environment(environment)


def advertised_dynamic(settings: WorkerSettings) -> WorkerSettings:
    return replace(settings, engines=ALL_ENGINES)


# #765-T02
def test_the_container_profile_is_read_from_its_variables() -> None:
    settings = settings_of(CONTAINER)

    assert settings.implementer_work_dir == WORK
    assert settings.implementer_network is ImplementerNetwork.REGISTRIES
    assert settings.dynamic_ports == PORTS


# #765-T02
@pytest.mark.parametrize("value", ["work", "/", "/work/../etc", "../work"])
def test_a_work_directory_that_is_not_an_absolute_directory_is_refused(value: str) -> None:
    with pytest.raises(SettingsError) as refused_value:
        settings_of({**CONTAINER, "RUNNER_IMPLEMENTER_WORK_DIR": value})

    assert "RUNNER_IMPLEMENTER_WORK_DIR" in str(refused_value.value)


# #765-T02
def test_a_default_diff_runner_and_a_dynamic_runner_never_advertise_it() -> None:
    calls: list[object] = []

    def recording(**facts: Any) -> None:
        calls.append(facts)

    for environment in ({}, {"RUNNER_DIFF_JOB_USER": "10001:10001"}):
        settings = advertised_dynamic(settings_of(environment))
        decided, reason = decide_implementer(settings, check=recording)
        assert decided == settings
        assert reason is None
        assert ENGINE_IMPLEMENTER not in decided.engines
    assert calls == []


# #765-T02
def test_all_prerequisites_true_advertises_the_engine_on_top_of_the_reviewer_engines(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[dict[str, Any]] = []

    def passing(**facts: Any) -> None:
        seen.append(facts)

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        decided, reason = decide_implementer(
            advertised_dynamic(settings_of(CONTAINER)), check=passing
        )

    assert decided.engines == (ENGINE_DIFF, ENGINE_DYNAMIC, ENGINE_IMPLEMENTER)
    assert reason is None
    assert seen == [
        {
            "work_dir": WORK,
            "user": USER,
            "ports": PORTS,
            "network": ImplementerNetwork.REGISTRIES,
        }
    ]
    assert "implementer is advertised" in caplog.text


# #765-T02
@pytest.mark.parametrize(
    "reason",
    [reason for reason in SelfCheckReason if reason.value.startswith("implementer_")],
)
def test_a_failed_check_leaves_the_engine_out_and_logs_the_reason(
    caplog: pytest.LogCaptureFixture, reason: SelfCheckReason
) -> None:
    def failing(**facts: Any) -> None:
        raise SelfCheckFailed(reason, "a property does not hold")

    settings = advertised_dynamic(settings_of(CONTAINER))
    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        decided, named = decide_implementer(settings, check=failing)

    assert decided.engines == ALL_ENGINES
    assert named == reason.value
    assert reason.value in caplog.text


# #765-T02
def test_an_unexpected_error_in_the_check_leaves_the_engine_out() -> None:
    def broken(**facts: Any) -> None:
        raise RuntimeError("anything")

    decided, named = decide_implementer(advertised_dynamic(settings_of(CONTAINER)), check=broken)

    assert ENGINE_IMPLEMENTER not in decided.engines
    assert named == "self_check_error"


# #765-T02
def test_without_the_dynamic_engine_the_implementer_is_not_even_asked() -> None:
    settings = replace(settings_of(CONTAINER), engines=(ENGINE_DIFF,))
    calls: list[object] = []

    def recording(**facts: Any) -> None:
        calls.append(facts)

    decided, named = decide_implementer(settings, check=recording)

    assert decided == settings
    assert named is None  # the Dynamic reason is the verdict's
    assert calls == []


# #765-T02
@pytest.mark.parametrize("dynamic_passes", [True, False])
def test_the_verdict_of_the_startup_names_the_engines_and_each_missing_reason(
    monkeypatch: pytest.MonkeyPatch, dynamic_passes: bool
) -> None:
    def prepare(settings: WorkerSettings) -> EgressSetup:
        return EgressSetup(True, EgressMode.FULL)

    def dynamic(**facts: Any) -> None:
        if not dynamic_passes:
            raise SelfCheckFailed(SelfCheckReason.NETWORK_RULES_NOT_INSTALLED, "not installed")

    def implementer(**facts: Any) -> None:
        raise SelfCheckFailed(SelfCheckReason.IMPLEMENTER_WORK_DIR_NOT_EXEC, "noexec")

    monkeypatch.setattr(service, "prepare_dynamic_runtime", prepare)
    monkeypatch.setattr(service, "check_dynamic_runner", dynamic)
    monkeypatch.setattr(service, "check_implementer_runner", implementer)
    written: list[Verdict] = []

    decided, verdict = service.run_startup(
        settings_of(CONTAINER),
        remove_verdict=lambda: None,
        write_verdict=lambda verdict: written.append(verdict),
    )

    assert written == [verdict]
    assert ENGINE_IMPLEMENTER not in decided.engines
    if dynamic_passes:
        assert verdict.engines == ALL_ENGINES
        assert verdict.reasons == ("implementer_work_dir_not_exec",)
    else:
        assert verdict.engines == (ENGINE_DIFF,)
        assert verdict.reasons == ("network_rules_not_installed",)


# #765-T02
def test_a_passing_startup_writes_all_three_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    def prepare(settings: WorkerSettings) -> EgressSetup:
        return EgressSetup(True, EgressMode.FULL)

    def passing(**facts: Any) -> None:
        return None

    monkeypatch.setattr(service, "prepare_dynamic_runtime", prepare)
    monkeypatch.setattr(service, "check_dynamic_runner", passing)
    monkeypatch.setattr(service, "check_implementer_runner", passing)

    decided, verdict = service.run_startup(
        settings_of(CONTAINER),
        remove_verdict=lambda: None,
        write_verdict=lambda verdict: None,
    )

    assert decided.engines == (ENGINE_DIFF, ENGINE_DYNAMIC, ENGINE_IMPLEMENTER)
    assert verdict == Verdict((ENGINE_DIFF, ENGINE_DYNAMIC, ENGINE_IMPLEMENTER), ())


# #765-T02
def test_the_engines_the_loop_names_to_the_job_process_include_the_implementer() -> None:
    names = f"{ENGINE_DIFF},{ENGINE_DYNAMIC},{ENGINE_IMPLEMENTER},nonsense"

    assert engines_from_environment({ENGINES_VARIABLE: names}) == (
        ENGINE_DIFF,
        ENGINE_DYNAMIC,
        ENGINE_IMPLEMENTER,
    )
    assert engines_from_environment({}) == ()


# The owner's git model: nothing in the repository is guarded, so no prerequisite exists only for a guard.
def test_the_reasons_that_only_the_guard_needed_are_gone() -> None:
    values = {reason.value for reason in SelfCheckReason}

    assert "implementer_git_too_old" not in values
    assert "implementer_guard_files_missing" not in values
    assert startup.__dict__.get("GUARD_FILES") is None
