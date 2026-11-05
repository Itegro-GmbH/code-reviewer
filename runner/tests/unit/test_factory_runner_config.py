# SPDX-License-Identifier: LicenseRef-Proprietary

"""The configuration of the Factory-Runner (#854, R1b): the file, the environment over it, the
checks, and that the secret never shows."""

import json
import os
import stat
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.config import (
    ConfigError,
    Limits,
    RunnerConfig,
    check_labels,
    check_limits,
    check_url,
    load_config,
    redacted,
    runner_identity,
    save_config,
    update_credential,
)

pytestmark = pytest.mark.unit

CREDENTIAL = "crc_" + "A" * 43
OTHER = "crc_" + "B" * 43


def home(tmp_path: Path, **extra: str) -> dict[str, str]:
    return {"FACTORY_RUNNER_HOME": str(tmp_path / "home"), **extra}


def config(**changes: object) -> RunnerConfig:
    base = RunnerConfig(url="https://app.example", name="box", labels=("linux",))
    return RunnerConfig(**{**base.__dict__, **changes})  # type: ignore[arg-type]


def test_the_file_is_private_from_its_first_byte(tmp_path: Path) -> None:
    environment = home(tmp_path)

    path = save_config(config(credential=CREDENTIAL, runner_id="r1"), environment)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert list(path.parent.iterdir()) == [path]  # no temporary file is left


def test_what_is_saved_is_what_is_loaded(tmp_path: Path) -> None:
    environment = home(tmp_path)
    saved = config(
        credential=CREDENTIAL,
        runner_id="r1",
        limits=Limits(cpus=2, memory_mb=4096, disk_gb=50),
        agent_image="ghcr.io/itegro/agent:1.0",
        credential_renewed_at=12.0,
    )
    save_config(saved, environment)

    assert load_config(environment) == saved


def test_the_environment_wins_over_the_file(tmp_path: Path) -> None:
    environment = home(tmp_path)
    save_config(config(credential=CREDENTIAL, limits=Limits(cpus=2)), environment)

    loaded = load_config(
        {
            **environment,
            "FACTORY_RUNNER_URL": "https://other.example/",
            "FACTORY_RUNNER_CREDENTIAL": OTHER,
            "FACTORY_RUNNER_LABELS": "Gpu, linux,gpu",
            "FACTORY_RUNNER_CPUS": "8",
        }
    )

    assert loaded.url == "https://other.example"
    assert loaded.credential == OTHER
    assert loaded.labels == ("gpu", "linux")
    assert loaded.limits.cpus == 8


def test_a_vm_needs_no_file_only_the_environment(tmp_path: Path) -> None:
    loaded = load_config(
        home(
            tmp_path, FACTORY_RUNNER_URL="https://app.example", FACTORY_RUNNER_CREDENTIAL=CREDENTIAL
        )
    )

    assert loaded.credential == CREDENTIAL
    assert loaded.runner_id is None


def test_the_secret_is_never_in_the_redacted_view_or_the_repr(tmp_path: Path) -> None:
    secret_config = config(credential=CREDENTIAL)

    assert CREDENTIAL not in json.dumps(redacted(secret_config))
    assert redacted(secret_config)["credential"] == "set"
    assert CREDENTIAL not in repr(secret_config)
    assert redacted(config())["credential"] == "not set"


@pytest.mark.parametrize(
    "url",
    ["", "ftp://x.example", "https://u:p@x.example", "https://x.example/?q=1", "http://x.example"],
)
def test_an_app_address_must_be_a_plain_https_address(url: str) -> None:
    with pytest.raises(ConfigError):
        check_url(url)


def test_plain_http_is_for_the_loopback_or_an_explicit_switch() -> None:
    assert check_url("http://127.0.0.1:3000/") == "http://127.0.0.1:3000"
    assert check_url("http://box.test:3000", allow_http=True) == "http://box.test:3000"


def test_labels_follow_the_contract_pattern() -> None:
    assert check_labels("Linux,gpu,linux") == ("linux", "gpu")
    for bad in ("-lead", "a" * 41, "has space", "ünï"):
        with pytest.raises(ConfigError):
            check_labels(bad)
    with pytest.raises(ConfigError):
        check_labels([f"l{n}" for n in range(21)])


def test_this_runner_takes_one_job_at_a_time() -> None:
    assert check_limits({"parallelRuns": 1}).parallel_runs == 1
    with pytest.raises(ConfigError, match="one job at a time"):
        check_limits({"parallelRuns": 2})


@pytest.mark.parametrize("raw", ["0", "-1", "x", "1000001", True])
def test_a_limit_is_a_whole_number_in_the_contracts_range(raw: object) -> None:
    with pytest.raises(ConfigError):
        check_limits({"cpus": raw})


def test_a_refusal_names_the_field_and_never_the_value(tmp_path: Path) -> None:
    secret = "crc_not-a-credential-" + "Z" * 30
    with pytest.raises(ConfigError) as caught:
        load_config(
            home(
                tmp_path,
                FACTORY_RUNNER_URL="https://app.example",
                FACTORY_RUNNER_CREDENTIAL=secret,
            )
        )

    assert secret not in str(caught.value)


def test_a_broken_file_is_a_configuration_error_without_its_content(tmp_path: Path) -> None:
    environment = home(tmp_path)
    path = Path(environment["FACTORY_RUNNER_HOME"]) / "config.json"
    path.parent.mkdir(parents=True)
    path.write_text("{ not json crc_" + "C" * 43)

    with pytest.raises(ConfigError) as caught:
        load_config(environment)

    assert "crc_" not in str(caught.value)


# #854-S2
def test_a_credential_is_from_the_file_unless_the_environment_names_one(tmp_path: Path) -> None:
    environment = home(tmp_path)
    save_config(config(credential=CREDENTIAL), environment)

    from_file = load_config(environment)
    from_environment = load_config({**environment, "FACTORY_RUNNER_CREDENTIAL": OTHER})

    assert (from_file.credential, from_file.credential_source) == (CREDENTIAL, "file")
    assert (from_environment.credential, from_environment.credential_source) == (
        OTHER,
        "environment",
    )


# #854-S2
def test_update_credential_changes_the_credential_and_its_time_and_nothing_else(
    tmp_path: Path,
) -> None:
    environment = home(tmp_path)
    save_config(
        config(credential=CREDENTIAL, limits=Limits(cpus=2), credential_renewed_at=1.0), environment
    )
    overriding = {
        **environment,
        "FACTORY_RUNNER_URL": "https://other.example",
        "FACTORY_RUNNER_LABELS": "env",
        "FACTORY_RUNNER_CPUS": "9",
    }

    path = update_credential(overriding, runner_id=None, renewed_at=5.0, credential=OTHER)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    stored = json.loads(path.read_text())
    assert (stored["credential"], stored["credentialRenewedAt"]) == (OTHER, 5.0)
    assert stored["url"] == "https://app.example" and stored["labels"] == ["linux"]
    assert stored["limits"]["cpus"] == 2


# #854-S2
def test_update_credential_with_only_a_time_keeps_the_credential(tmp_path: Path) -> None:
    environment = home(tmp_path)
    save_config(config(credential=CREDENTIAL), environment)

    update_credential(environment, runner_id=None, renewed_at=7.0)

    loaded = load_config(environment)
    assert (loaded.credential, loaded.credential_renewed_at) == (CREDENTIAL, 7.0)


# #854-S2
def test_update_credential_does_not_invent_a_file(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="gone"):
        update_credential(home(tmp_path), runner_id=None, renewed_at=1.0, credential=CREDENTIAL)

    assert not (tmp_path / "home" / "config.json").exists()


# #854-F6
def test_update_credential_leaves_the_file_of_another_runner_alone(tmp_path: Path) -> None:
    environment = home(tmp_path)
    path = save_config(config(credential=CREDENTIAL, runner_id="r2"), environment)
    before = path.read_text()

    with pytest.raises(ConfigError, match="another runner"):
        update_credential(environment, runner_id="r1", renewed_at=5.0, credential=OTHER)

    assert path.read_text() == before


# #854-F6
def test_update_credential_writes_the_file_and_its_directory_to_disk_around_the_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    environment = home(tmp_path)
    save_config(config(credential=CREDENTIAL, runner_id="r1"), environment)
    events: list[str] = []
    real_replace, real_fsync = os.replace, os.fsync

    def replace(source: str, target: Path) -> None:
        events.append("replace")
        real_replace(source, target)

    def fsync(descriptor: int) -> None:
        events.append("fsync")
        real_fsync(descriptor)

    monkeypatch.setattr(os, "replace", replace)
    monkeypatch.setattr(os, "fsync", fsync)

    update_credential(environment, runner_id="r1", renewed_at=5.0, credential=OTHER)

    assert events == ["fsync", "replace", "fsync"]  # the data, the rename, the rename's directory


def test_the_identity_is_the_runner_id_else_a_digest_that_hides_the_credential() -> None:
    assert runner_identity(config(runner_id="r1", credential=CREDENTIAL)) == "r1"
    digest = runner_identity(config(credential=CREDENTIAL))
    assert digest.startswith("credential-") and CREDENTIAL not in digest
    assert digest == runner_identity(config(credential=CREDENTIAL))
    assert digest != runner_identity(config(credential=OTHER))
    assert runner_identity(config()) == ""
