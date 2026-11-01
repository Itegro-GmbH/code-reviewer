# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network setting of an Implementer container and the engine's environment (#763).

`RUNNER_IMPLEMENTER_NETWORK` and `RUNNER_IMPLEMENTER_EGRESS_PORT` come from the Dispatcher's
container spec (#746); nothing else configures the egress boundary. The allowlist is not a setting
at all: it lives in the runner's code.
"""

import dataclasses
import json
import socket
from pathlib import Path

import pytest

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.dynamic_review.static_isolation import (
    EGRESS_PORT_VARIABLE,
    NETWORK_VARIABLE,
    ImplementerNetwork,
)
from code_reviewer_runner.implementer import egress_config, egress_policy, egress_proxy
from code_reviewer_runner.implementer.egress_config import (
    EgressConfigError,
    EgressSettings,
    apply_egress_environment,
    egress_environment,
    egress_settings_from_environment,
    start_egress,
)
from code_reviewer_runner.implementer.egress_policy import DEFAULT_ALLOWLIST

ROOT = Path(__file__).resolve().parents[3]
PROXY_VARIABLES = {
    "HTTPS_PROXY",
    "https_proxy",
    "npm_config_proxy",
    "npm_config_https_proxy",
    "PIP_PROXY",
}


def registries(port: int = 10182) -> EgressSettings:
    return EgressSettings(ImplementerNetwork.REGISTRIES, port)


def free_port() -> int:
    """A free loopback port below the ephemeral range, where the settings allow ports to be."""
    for port in range(31000, 32000):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise AssertionError("no free port")


def test_the_variable_names_are_the_ones_of_the_contract() -> None:
    assert EGRESS_PORT_VARIABLE == runner_job.IMPLEMENTER_EGRESS_PORT_VARIABLE
    assert NETWORK_VARIABLE == runner_job.IMPLEMENTER_NETWORK_VARIABLE
    assert tuple(mode.value for mode in ImplementerNetwork) == runner_job.IMPLEMENTER_NETWORK_MODES


# #763-T05
def test_registries_puts_exactly_the_proxy_variables_in_the_engine_environment() -> None:
    environment = egress_environment(registries(10182))

    assert set(environment) == PROXY_VARIABLES
    assert set(environment.values()) == {"http://127.0.0.1:10182"}
    assert not any("no_proxy" in name.lower() for name in environment)


# #763-T05
def test_none_sets_nothing() -> None:
    assert egress_environment(EgressSettings(ImplementerNetwork.NONE, None)) == {}


# #763-T05
def test_the_engine_environment_loses_every_other_proxy_name_and_keeps_the_rest() -> None:
    inherited = {
        "PATH": "/usr/bin",
        "HOME": "/home/engine",
        "HTTP_PROXY": "http://corporate.example:3128",
        "http_proxy": "http://corporate.example:3128",
        "HTTPS_PROXY": "http://corporate.example:3128",
        "ALL_PROXY": "socks5://corporate.example:1080",
        "all_proxy": "socks5://corporate.example:1080",
        "NO_PROXY": "169.254.169.254,registry.example",
        "no_proxy": "localhost,10.0.0.0/8",
        "npm_config_noproxy": "*",
        "npm_config_http_proxy": "http://corporate.example:3128",
        "YARN_HTTPS_PROXY": "http://corporate.example:3128",
        "PIP_PROXY": "http://corporate.example:3128",
    }

    environment = apply_egress_environment(inherited, registries(10182))

    assert set(environment) == {"PATH", "HOME"} | PROXY_VARIABLES
    assert environment["PATH"] == "/usr/bin" and environment["HOME"] == "/home/engine"
    assert {environment[name] for name in PROXY_VARIABLES} == {"http://127.0.0.1:10182"}


# #763-T05
def test_none_also_removes_inherited_proxy_names() -> None:
    inherited = {
        "PATH": "/usr/bin",
        "HTTPS_PROXY": "http://corporate.example:3128",
        "NO_PROXY": "*",
    }

    assert apply_egress_environment(inherited, EgressSettings(ImplementerNetwork.NONE, None)) == {
        "PATH": "/usr/bin"
    }


# #763-T05
def test_none_starts_no_proxy() -> None:
    assert start_egress(EgressSettings(ImplementerNetwork.NONE, None)) is None


# #763-T05
def test_registries_starts_a_proxy_on_the_loopback_port_and_stop_releases_it() -> None:
    port = free_port()

    proxy = start_egress(registries(port))

    assert proxy is not None
    try:
        assert proxy.port == port
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass
    finally:
        proxy.stop()
    with pytest.raises(OSError), socket.create_connection(("127.0.0.1", port), timeout=1):
        pass


# #763-T05
@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        ({}, EgressSettings(ImplementerNetwork.NONE, None)),  # not an Implementer container
        ({NETWORK_VARIABLE: "none"}, EgressSettings(ImplementerNetwork.NONE, None)),
        (
            {NETWORK_VARIABLE: "none", EGRESS_PORT_VARIABLE: "10182"},
            EgressSettings(ImplementerNetwork.NONE, None),
        ),
        ({NETWORK_VARIABLE: "registries"}, registries(10182)),
        ({NETWORK_VARIABLE: "registries", EGRESS_PORT_VARIABLE: "20002"}, registries(20002)),
        ({EGRESS_PORT_VARIABLE: "20002"}, registries(20002)),
        ({NETWORK_VARIABLE: " registries ", EGRESS_PORT_VARIABLE: " 20002 "}, registries(20002)),
    ],
)
def test_the_setting_follows_the_two_variables(
    environment: dict[str, str], expected: EgressSettings
) -> None:
    assert egress_settings_from_environment(environment) == expected


# #763-T05
@pytest.mark.parametrize(
    "environment",
    [
        {NETWORK_VARIABLE: "all"},
        {NETWORK_VARIABLE: "Registries"},
        {NETWORK_VARIABLE: "registries,github"},
        {EGRESS_PORT_VARIABLE: "proxy"},
        {EGRESS_PORT_VARIABLE: "80"},
        {EGRESS_PORT_VARIABLE: "40000"},  # inside the ephemeral range
        {EGRESS_PORT_VARIABLE: "0x2800"},
        {EGRESS_PORT_VARIABLE: "10180"},  # the model proxy's default port
        {EGRESS_PORT_VARIABLE: "10181"},  # the engine's default port
    ],
)
def test_an_unusable_setting_is_refused_and_names_the_variable_not_the_value(
    environment: dict[str, str],
) -> None:
    with pytest.raises(EgressConfigError) as refused:
        egress_settings_from_environment(environment)
    message = str(refused.value)
    assert "RUNNER_IMPLEMENTER_" in message or "RUNNER_DYNAMIC_" in message
    assert not any(value.strip() in message for value in environment.values() if len(value) > 3)


# #763-T07
def test_the_settings_have_no_allowlist_and_the_environment_cannot_add_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert {field.name for field in dataclasses.fields(EgressSettings)} == {"network", "port"}
    hostile = {
        "RUNNER_IMPLEMENTER_EGRESS_ALLOWLIST": "github.com,*.github.com",
        "RUNNER_IMPLEMENTER_ALLOWED_HOSTS": "github.com",
        "EGRESS_ALLOWLIST": "*",
        "ALLOWED_HOSTS": "*",
        "NO_PROXY": "*",
        "npm_config_registry": "https://github.com/",
        NETWORK_VARIABLE: "registries",
        EGRESS_PORT_VARIABLE: str(free_port()),
    }
    for name, value in hostile.items():
        monkeypatch.setenv(name, value)

    settings = egress_settings_from_environment(hostile)
    proxy = start_egress(settings)

    assert proxy is not None
    try:
        assert proxy.allowlist is DEFAULT_ALLOWLIST
        assert "github.com" not in "".join(proxy.allowlist.entries)
    finally:
        proxy.stop()


# #763-T07
def test_the_modules_of_the_proxy_read_neither_the_environment_nor_files() -> None:
    for module in (egress_config, egress_policy, egress_proxy):
        source = Path(module.__file__ or "").read_text(encoding="utf-8")
        for forbidden in ("os.environ", "getenv", "read_text", "read_bytes", "open("):
            assert forbidden not in source, f"{module.__name__} uses {forbidden}"


# #763-T07
def test_a_job_cannot_bring_its_own_hosts() -> None:
    document = json.loads(
        (ROOT / "contracts/examples/implementer/RunnerJobInput.json").read_text(encoding="utf-8")
    )
    runner_job.parse_implementer_input(json.dumps(document))
    for name in ("allowedHosts", "egress", "allowlist", "network", "proxy"):
        for where in (document, document["implementer"], document["implementer"]["limits"]):
            attempt = json.loads(json.dumps(document))
            target = (
                attempt
                if where is document
                else (
                    attempt["implementer"]
                    if where is document["implementer"]
                    else attempt["implementer"]["limits"]
                )
            )
            target[name] = ["github.com"]
            with pytest.raises(runner_job.JobError):
                runner_job.parse_implementer_input(json.dumps(attempt))
