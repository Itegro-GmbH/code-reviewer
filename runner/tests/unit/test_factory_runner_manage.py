# SPDX-License-Identifier: LicenseRef-Proprietary

"""`factory-runner config set`, `credential` and `update` (#855, R2): the settings of a runner live
in its file and are changed on the device, the credential is renewed there and never shown, and an
update is only ever staged: verified, and never during a job."""

import io
import json
import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.app_client import ApiError, Revoked
from code_reviewer_runner.factory_runner.base import (
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_USAGE,
)
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.factory_runner.config import (
    Limits,
    RunnerConfig,
    load_config,
    save_config,
)
from code_reviewer_runner.factory_runner.update import (
    CURRENT_REFERENCE,
    PREVIOUS_REFERENCE,
    RELEASE_LABEL,
    REPOSITORY,
    UpdateError,
)
from code_reviewer_runner.implementer.docker_api import DockerError

pytestmark = pytest.mark.unit

CREDENTIAL = "crc_" + "A" * 43
RENEWED = "crc_" + "B" * 43
DIGEST = "sha256:" + "a" * 64


class Client:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.renewals = 0

    def renew(self) -> str:
        self.renewals += 1
        if self.error is not None:
            raise self.error
        return RENEWED


class Daemon:
    """The images of a daemon, by reference, and the calls made about them."""

    def __init__(self, *, release: int, offered: int | None) -> None:
        self.images: dict[str, dict[str, Any]] = {
            "own-image": {"Config": {"Labels": {RELEASE_LABEL: str(release)}}}
        }
        self.offered = offered
        self.calls: list[tuple[str, str]] = []

    def inspect_container(self, name: str) -> dict[str, Any]:
        return {"Image": "own-image"}

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        self.calls.append((method, path))
        if path.startswith("/images/create"):
            if self.offered is not None:
                image = {
                    "RepoDigests": [f"{REPOSITORY}@{DIGEST}"],
                    "Config": {"Labels": {RELEASE_LABEL: str(self.offered)}},
                }
                self.images[f"{REPOSITORY}:stable"] = image
                self.images[f"{REPOSITORY}@{DIGEST}"] = image
            return None
        if method == "POST" and "/tag?" in path:
            source = path.split("/images/")[1].split("/tag?")[0]
            target = path.split("repo=")[1].replace("&tag=", ":")
            if source not in self.images:
                raise DockerError(404, "no such image")
            self.images[target] = self.images[source]
        if method == "DELETE":
            self.images.pop(path.split("/images/")[1], None)
        return None


def invoke(
    tmp_path: Path,
    *argv: str,
    client: Client | None = None,
    daemon: Daemon | None = None,
    verify: Any = None,
    **env: str,
) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    seams = CliSeams(
        client=lambda _url, _credential: client or Client(),  # type: ignore[arg-type,return-value]
        now=lambda: 10 * 86400.0,
        hostname=lambda: "box",
        docker=lambda: daemon,  # type: ignore[arg-type,return-value]
        verify=verify,
    )
    code = main(
        list(argv),
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home"), **env},
        seams=seams,
        out=out,
        err=err,
        stdin=io.StringIO(),
    )
    return code, out.getvalue(), err.getvalue()


def register(tmp_path: Path, **changes: Any) -> dict[str, str]:
    environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home")}
    save_config(
        RunnerConfig(
            url="https://app.example",
            name="box",
            labels=("linux",),
            credential=CREDENTIAL,
            runner_id="r1",
            credential_renewed_at=3 * 86400.0,
            limits=Limits(cpus=2),
            **changes,
        ),
        environment,
    )
    return environment


# -- config set --------------------------------------------------------------------------------


def test_config_set_changes_labels_limits_and_parallelism_and_keeps_the_rest(
    tmp_path: Path,
) -> None:
    environment = register(tmp_path)

    code, out, _ = invoke(
        tmp_path,
        "config", "set",
        "--labels", "Linux,GPU",
        "--memory-mb", "8192",
        "--disk-gb", "40",
        "--parallel", "1",
    )  # fmt: skip

    assert code == EXIT_OK
    config = load_config(environment)
    assert config.labels == ("linux", "gpu")
    assert config.limits == Limits(cpus=2, memory_mb=8192, disk_gb=40, parallel_runs=1)
    assert (config.credential, config.runner_id, config.name) == (CREDENTIAL, "r1", "box")
    assert "restart" in out
    path = tmp_path / "home" / "config.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_limit_is_removed_with_none_and_a_wrong_value_changes_nothing(tmp_path: Path) -> None:
    environment = register(tmp_path)
    path = tmp_path / "home" / "config.json"
    before = path.read_text()

    code, _, err = invoke(tmp_path, "config", "set", "--cpus", "none")
    assert code == EXIT_OK
    assert load_config(environment).limits.cpus is None

    path.write_text(before)
    code, _, err = invoke(tmp_path, "config", "set", "--labels", "ok", "--memory-mb", "lots")
    assert code == EXIT_CONFIG
    assert "memoryMb" in err
    assert path.read_text() == before  # the label was not saved either


def test_more_than_one_job_at_a_time_is_refused_with_the_reason(tmp_path: Path) -> None:
    register(tmp_path)

    code, _, err = invoke(tmp_path, "config", "set", "--parallel", "3")

    assert code == EXIT_CONFIG
    assert "one job at a time" in err


def test_auto_update_is_a_switch_and_config_show_has_it(tmp_path: Path) -> None:
    register(tmp_path)

    assert invoke(tmp_path, "config", "set", "--auto-update", "off")[0] == EXIT_OK
    _, out, _ = invoke(tmp_path, "config", "show")

    assert json.loads(out)["autoUpdate"] is False
    assert invoke(tmp_path, "config", "set", "--auto-update", "maybe")[0] == EXIT_CONFIG


def test_config_set_without_a_setting_is_a_usage_error_and_needs_a_registration(
    tmp_path: Path,
) -> None:
    code, _, err = invoke(tmp_path, "config", "set", "--cpus", "2")
    assert code == EXIT_CONFIG
    assert "register" in err

    register(tmp_path)
    assert invoke(tmp_path, "config", "set")[0] == EXIT_USAGE


def test_config_set_says_when_the_environment_wins_over_the_file(tmp_path: Path) -> None:
    register(tmp_path)

    _, _, err = invoke(tmp_path, "config", "set", "--labels", "a", FACTORY_RUNNER_LABELS="b")

    assert "FACTORY_RUNNER_LABELS" in err


# -- credential --------------------------------------------------------------------------------


def test_credential_show_says_set_and_its_age_but_never_the_value(tmp_path: Path) -> None:
    register(tmp_path)

    code, out, err = invoke(tmp_path, "credential", "show")

    assert code == EXIT_OK
    assert "set (from the file)" in out
    assert "7 days ago" in out
    assert CREDENTIAL not in out + err


def test_credential_show_without_one_says_not_set(tmp_path: Path) -> None:
    assert invoke(tmp_path, "credential", "show")[1] == "credential: not set\n"


def test_credential_renew_saves_the_new_one_before_anything_uses_it(tmp_path: Path) -> None:
    environment = register(tmp_path)
    client = Client()

    code, out, err = invoke(tmp_path, "credential", "renew", client=client)

    assert code == EXIT_OK
    config = load_config(environment)
    assert config.credential == RENEWED
    assert config.credential_renewed_at == 10 * 86400.0
    assert client.renewals == 1
    assert RENEWED not in out + err


@pytest.mark.parametrize(
    ("error", "code"),
    [(Revoked("no", 401), EXIT_REVOKED), (ApiError("down"), EXIT_FAILED)],
)
def test_a_renewal_that_fails_leaves_the_credential_alone(
    tmp_path: Path, error: Exception, code: int
) -> None:
    environment = register(tmp_path)

    assert invoke(tmp_path, "credential", "renew", client=Client(error=error))[0] == code
    assert load_config(environment).credential == CREDENTIAL


def test_a_credential_from_the_environment_is_not_renewed_here(tmp_path: Path) -> None:
    register(tmp_path)
    client = Client()

    code, _, _ = invoke(
        tmp_path, "credential", "renew", client=client, FACTORY_RUNNER_CREDENTIAL=RENEWED
    )

    assert code == EXIT_CONFIG
    assert client.renewals == 0


# -- update ------------------------------------------------------------------------------------


def trusted(_reference: str) -> None:
    return None


def test_update_stages_a_newer_verified_release_and_keeps_the_one_before(tmp_path: Path) -> None:
    daemon = Daemon(release=4, offered=7)
    daemon.images[CURRENT_REFERENCE] = {"Id": "old"}
    checked: list[str] = []

    def record(reference: str) -> None:
        checked.append(reference)

    code, out, _ = invoke(tmp_path, "update", daemon=daemon, verify=record)

    assert code == EXIT_OK
    assert checked == [f"{REPOSITORY}@{DIGEST}"]  # the digest is verified, not the tag
    assert daemon.images[CURRENT_REFERENCE] is daemon.images[f"{REPOSITORY}@{DIGEST}"]
    assert daemon.images[PREVIOUS_REFERENCE] == {"Id": "old"}
    assert "release 7" in out and "after the job" in out


def test_update_with_nothing_newer_stages_nothing(tmp_path: Path) -> None:
    daemon = Daemon(release=7, offered=7)

    code, out, _ = invoke(tmp_path, "update", daemon=daemon, verify=trusted)

    assert code == EXIT_OK
    assert "up to date" in out
    assert CURRENT_REFERENCE not in daemon.images


def test_an_older_signed_release_is_no_way_back(tmp_path: Path) -> None:
    daemon = Daemon(release=7, offered=3)

    invoke(tmp_path, "update", daemon=daemon, verify=trusted)

    assert CURRENT_REFERENCE not in daemon.images


def test_an_image_that_does_not_verify_is_removed_and_never_named(tmp_path: Path) -> None:
    daemon = Daemon(release=1, offered=9)

    def refuse(_reference: str) -> None:
        raise UpdateError("the signature of the image could not be verified: not our release")

    code, _, err = invoke(tmp_path, "update", daemon=daemon, verify=refuse)

    assert code == EXIT_FAILED
    assert "not our release" in err
    assert CURRENT_REFERENCE not in daemon.images
    assert f"{REPOSITORY}:stable" not in daemon.images


def test_an_unreachable_registry_is_no_update_and_no_traceback(tmp_path: Path) -> None:
    daemon = Daemon(release=1, offered=None)

    code, _, err = invoke(tmp_path, "update", daemon=daemon, verify=trusted)

    assert code == EXIT_FAILED
    assert "no update" in err


def test_rollback_points_current_back_at_the_image_before(tmp_path: Path) -> None:
    daemon = Daemon(release=4, offered=None)
    daemon.images[PREVIOUS_REFERENCE] = {"Id": "old"}

    assert invoke(tmp_path, "update", "--rollback", daemon=daemon)[0] == EXIT_OK
    assert daemon.images[CURRENT_REFERENCE] == {"Id": "old"}

    assert invoke(tmp_path, "update", "--rollback", daemon=Daemon(release=1, offered=None))[0] == (
        EXIT_FAILED
    )


# -- the proof ---------------------------------------------------------------------------------


def Done(code: int) -> "subprocess.CompletedProcess[str]":
    return subprocess.CompletedProcess([], code, "", "")


def test_the_signature_must_be_the_release_workflows_of_this_repository() -> None:
    from code_reviewer_runner.factory_runner.update import (
        OIDC_ISSUER,
        SIGNER,
        cosign_verify,
        verify_command,
    )

    seen: list[tuple[list[str], dict[str, str]]] = []

    def run(command: list[str], **kwargs: Any) -> "subprocess.CompletedProcess[str]":
        seen.append((command, kwargs["env"]))
        return Done(0)

    cosign_verify(f"{REPOSITORY}@{DIGEST}", environment={"PATH": "/x", "SECRET": "s"}, run=run)

    command, env = seen[0]
    assert command == verify_command(f"{REPOSITORY}@{DIGEST}")
    assert command[command.index("--certificate-identity-regexp") + 1] == SIGNER
    assert command[command.index("--certificate-oidc-issuer") + 1] == OIDC_ISSUER
    assert "SECRET" not in env  # cosign gets a search path and a home, not the runner's environment
    assert "Itegro-GmbH/code-reviewer/.github/workflows/runner-image.yml" in SIGNER.replace(
        "\\", ""
    )


@pytest.mark.parametrize("code", [1, 2])
def test_a_signature_that_does_not_verify_is_an_error_without_cosigns_output(code: int) -> None:
    from code_reviewer_runner.factory_runner.update import cosign_verify

    with pytest.raises(UpdateError, match="not our release"):
        cosign_verify("x@y", environment={}, run=lambda *_a, **_k: Done(code))


def test_a_missing_cosign_is_said() -> None:
    from code_reviewer_runner.factory_runner.update import cosign_verify

    def missing(*_args: Any, **_kwargs: Any) -> "subprocess.CompletedProcess[str]":
        raise FileNotFoundError

    with pytest.raises(UpdateError, match="cosign is not installed"):
        cosign_verify("x@y", environment={}, run=missing)
