# SPDX-License-Identifier: LicenseRef-Proprietary

"""The configuration of the Factory-Runner (#854, R1b): the file, the environment over it, the
checks, and that the secret never shows."""

import json
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
    save_config,
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
