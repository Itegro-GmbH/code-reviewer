# SPDX-License-Identifier: LicenseRef-Proprietary

"""The client of the `incus` program (#1007) against a stand-in program (`fake_incus.py`): the
command lines it builds, the stdin it gives each call, the environment it passes, the limits of
time, and how it reads Incus's answers. No test needs Incus."""

import asyncio
import json
import os
import stat
import sys
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import pytest
from incus_support import short_directory

from code_reviewer_runner.factory_runner.incus.client import (
    CliIncusClient,
    IncusError,
    InstanceSpec,
    run_exec,
)

pytestmark = pytest.mark.unit

FAKE = Path(__file__).with_name("fake_incus.py")


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


class Rig:
    def __init__(self, root: Path, **behavior: Any) -> None:
        self.root = root
        self.record = root / "calls.jsonl"
        self.behavior_file = root / "behavior.json"
        self.set(**behavior)
        wrapper = root / "incus"
        wrapper.write_text(f'#!/bin/sh\nFAKE_INCUS_DIR={root} exec {sys.executable} {FAKE} "$@"\n')
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        self.client = CliIncusClient(str(wrapper), call_seconds=3.0, state_dir=root)

    def set(self, **behavior: Any) -> None:
        behavior.setdefault("record", str(self.record))
        self.behavior_file.write_text(json.dumps(behavior))

    def calls(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.record.read_text().splitlines()]


# #1007-T05
def test_incus_init_is_started_with_its_stdin_closed() -> None:
    """The regression for the hang: `incus init` reads an instance config from a stdin that is not a
    terminal and waits for its end. The stand-in does the same; the call must end by itself."""
    with short_directory() as root:
        rig = Rig(root, hang_on_stdin=True)
        spec = InstanceSpec("cr-a-0-aa", "golden", "crpool", {"limits.cpu": "2"}, disk_gib=8)

        go(lambda: rig.client.create(spec))

        (call,) = rig.calls()
        assert call["stdin"] == ""
        assert call["argv"][:5] == ["init", "golden", "cr-a-0-aa", "--no-profiles", "--storage"]


# #1007-T05
Operation = Callable[[CliIncusClient], Coroutine[Any, Any, Any]]
OPERATIONS: list[Operation] = [
    lambda c: c.start("x"),
    lambda c: c.delete("x"),
    lambda c: c.list_instances(),
    lambda c: c.add_device("x", "eth1", {"type": "nic"}),
    lambda c: c.remove_device("x", "eth1"),
    lambda c: c.create_network("n", {}),
]


@pytest.mark.parametrize("operation", OPERATIONS)
def test_no_call_without_input_ever_leaves_its_stdin_open(operation: Operation) -> None:
    with short_directory() as root:
        rig = Rig(root, hang_on_stdin=True, stdout="[]")

        go(lambda: operation(rig.client))

        assert [call["stdin"] for call in rig.calls()] == [""]


# #1007-T05
def test_init_uses_no_profile_and_names_the_pool_the_config_and_the_quota() -> None:
    with short_directory() as root:
        rig = Rig(root)
        spec = InstanceSpec(
            "cr-b-0-aa", "golden", "crpool", {"limits.cpu": "2", "user.cr.job": "j"}, disk_gib=16
        )

        go(lambda: rig.client.create(spec))

        (call,) = rig.calls()
        argv = call["argv"]
        assert "--no-profiles" in argv and argv[argv.index("--storage") + 1] == "crpool"
        assert argv[argv.index("--config") : argv.index("--config") + 2] == [
            "--config",
            "limits.cpu=2",
        ]
        assert "user.cr.job=j" in argv
        assert argv[argv.index("--device") + 1] == "root,size=16GiB"
        # Never the default profile, never a network of the owner's.
        assert "-p" not in argv and "--profile" not in argv and "--network" not in argv


def test_the_environment_of_incus_is_bare(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_RUNNER_TOKEN", "super-secret")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "another-secret")
    with short_directory() as root:
        rig = Rig(root)

        go(lambda: rig.client.start("x"))

        (call,) = rig.calls()
        assert not {"FACTORY_RUNNER_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"} & set(call["env"])
        assert "PATH" in call["env"]


# #1007-T05
def test_the_operators_own_incus_configuration_is_never_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A personal remote or a switched project in `~/.config/incus` must not point the launcher at
    another server or project: every call has a private configuration directory (no remote, so the
    local daemon) and the `default` project."""
    with short_directory() as root:
        home = root / "home"
        (home / ".config" / "incus").mkdir(parents=True)
        (home / ".config" / "incus" / "config.yml").write_text(
            "default-remote: elsewhere\nremotes:\n  elsewhere:\n    addr: https://10.0.0.9:8443\n"
        )
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.setenv("INCUS_CONF", str(home / ".config" / "incus"))
        monkeypatch.setenv("INCUS_PROJECT", "someone-elses")
        rig = Rig(root)

        go(lambda: rig.client.start("x"))

        (call,) = rig.calls()
        private = root / "incus-conf"
        assert call["conf"] == str(private) and call["project"] == "default"
        assert private.is_dir() and stat.S_IMODE(private.stat().st_mode) == 0o700
        assert list(private.iterdir()) == []
        assert "elsewhere" not in " ".join(call["argv"])


def test_a_client_configuration_directory_that_cannot_be_made_is_an_error_not_a_default() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.client = CliIncusClient(str(root / "incus"), state_dir=root / "missing" / "deeper")

        with pytest.raises(IncusError, match="client configuration directory"):
            go(lambda: rig.client.start("x"))

        assert not rig.record.exists()


def test_a_call_that_is_cancelled_kills_and_reaps_its_incus_process() -> None:
    with short_directory() as root:
        rig = Rig(root, sleep=30)

        async def scenario() -> int:
            task = asyncio.ensure_future(rig.client.start("x"))
            for _ in range(100):
                if rig.record.exists() and rig.record.read_text():
                    break
                await asyncio.sleep(0.05)
            pid = int(rig.calls()[0]["pid"])
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            return pid

        pid = go(scenario)

        # Killed and waited for: no such process, not even a zombie of ours.
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


def test_a_call_that_does_not_answer_in_time_is_killed_and_an_error() -> None:
    with short_directory() as root:
        rig = Rig(root, sleep=30)
        rig.client = CliIncusClient(str(root / "incus"), call_seconds=0.3, state_dir=root)

        with pytest.raises(IncusError, match="no answer"):
            go(lambda: rig.client.start("x"))


def test_a_failed_call_is_an_error_that_carries_the_last_line_of_what_incus_said() -> None:
    with short_directory() as root:
        rig = Rig(root, exit=1, stderr="Error: some detail\nError: Instance not found\n")

        with pytest.raises(IncusError) as caught:
            go(lambda: rig.client.start("x"))

        assert caught.value.not_found and "Instance not found" in caught.value.detail


# #1007-T01
def test_deleting_an_instance_that_is_not_there_is_fine_and_any_other_failure_is_not() -> None:
    with short_directory() as root:
        rig = Rig(root, exit=1, stderr="Error: Instance not found\n")
        go(lambda: rig.client.delete("x"))
        assert rig.calls()[-1]["argv"] == ["delete", "--force", "x"]

        rig.set(exit=1, stderr="Error: device busy\n")
        with pytest.raises(IncusError):
            go(lambda: rig.client.delete("x"))


def test_the_instances_are_read_from_the_json_list_with_their_config() -> None:
    with short_directory() as root:
        listing = [
            {"name": "cr-a-0-aa", "status": "Running", "config": {"user.cr.job": "j"}},
            {"name": "owner", "status": "Stopped"},
        ]
        rig = Rig(root, stdout=json.dumps(listing))

        found = go(lambda: rig.client.list_instances())

        assert [(i.name, i.status, dict(i.config)) for i in found] == [
            ("cr-a-0-aa", "Running", {"user.cr.job": "j"}),
            ("owner", "Stopped", {}),
        ]
        assert rig.calls()[0]["argv"] == ["list", "--format", "json"]


def test_an_answer_that_is_not_a_list_is_an_error() -> None:
    with short_directory() as root:
        rig = Rig(root, stdout="not json")

        with pytest.raises(IncusError, match="not a list"):
            go(lambda: rig.client.list_instances())


def test_a_file_is_pushed_through_stdin_with_the_mode_and_the_instance_path() -> None:
    with short_directory() as root:
        rig = Rig(root, hang_on_stdin=True)

        go(lambda: rig.client.push_file("cr-a-0-aa", "/etc/x.conf", b"content\n"))

        (call,) = rig.calls()
        assert call["stdin"] == "content\n"
        assert call["argv"] == [
            "file",
            "push",
            "--create-dirs",
            "--mode",
            "0644",
            "-",
            "cr-a-0-aa/etc/x.conf",
        ]


def test_a_device_is_added_with_its_type_as_a_word_and_its_keys() -> None:
    with short_directory() as root:
        rig = Rig(root)

        go(
            lambda: rig.client.add_device(
                "cr-a-0-aa", "eth0", {"type": "nic", "network": "cr-out0"}
            )
        )

        (call,) = rig.calls()
        assert call["argv"] == [
            "config",
            "device",
            "add",
            "cr-a-0-aa",
            "eth0",
            "nic",
            "network=cr-out0",
        ]


def test_an_exec_passes_the_command_after_two_dashes_and_the_input_on_stdin() -> None:
    with short_directory() as root:
        rig = Rig(root, hang_on_stdin=True, stdout="out", exit=7, stderr="err")

        async def scenario() -> Any:
            process = await rig.client.start_exec(
                "cr-a-0-aa", ["docker", "run", "x"], stdin=b"in\n"
            )
            return await process.wait()

        result = go(scenario)

        (call,) = rig.calls()
        assert call["argv"] == [
            "exec",
            "cr-a-0-aa",
            "--force-noninteractive",
            "--",
            "docker",
            "run",
            "x",
        ]
        assert call["stdin"] == "in\n"
        assert (result.exit_code, result.stdout, result.stderr) == (7, "out", "err")


def test_an_exec_without_input_has_its_stdin_closed() -> None:
    with short_directory() as root:
        rig = Rig(root, hang_on_stdin=True)

        async def scenario() -> Any:
            return await run_exec(rig.client, "x", ["true"], timeout=3.0)

        assert go(scenario).exit_code == 0
        assert rig.calls()[0]["stdin"] == ""


def test_an_exec_that_runs_over_is_killed_with_a_code() -> None:
    with short_directory() as root:
        rig = Rig(root, sleep=30)

        async def scenario() -> Any:
            return await run_exec(rig.client, "x", ["sleep", "30"], timeout=0.3)

        assert go(scenario).exit_code == -9


def test_the_end_of_a_long_output_is_kept_and_not_the_start() -> None:
    with short_directory() as root:
        rig = Rig(root, stderr="a" * 40000 + "THE-END")

        async def scenario() -> Any:
            process = await rig.client.start_exec("x", ["docker", "run"])
            return await process.wait()

        result = go(scenario)

        assert result.stderr.endswith("THE-END") and len(result.stderr) <= 16 * 1024


def test_objects_are_asked_for_by_name() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> list[bool]:
            return [
                await rig.client.pool_exists("p"),
                await rig.client.image_exists("i"),
                await rig.client.network_exists("n"),
                await rig.client.acl_exists("a"),
            ]

        assert go(scenario) == [True] * 4
        assert [call["argv"] for call in rig.calls()] == [
            ["storage", "show", "p"],
            ["image", "info", "i"],
            ["network", "show", "n"],
            ["network", "acl", "show", "a"],
        ]
        rig.set(exit=1)
        assert go(scenario) == [False] * 4


def test_a_network_and_an_acl_are_read_from_the_api_in_the_default_project() -> None:
    with short_directory() as root:
        network = {
            "type": "bridge",
            "config": {"ipv4.nat": "false", "ipv4.address": "10.99.0.1/29"},
            "managed": True,
        }
        acl = {
            "name": "a",
            "ingress": [],
            "egress": [{"action": "allow", "destination_port": "3128", "description": ""}],
        }
        rig = Rig(root, stdout=json.dumps(network))

        found = go(lambda: rig.client.network_info("cr-ab12-o0"))
        rig.set(stdout=json.dumps(acl))
        rules = go(lambda: rig.client.acl_info("cr-ab12-o0"))

        assert found is not None and found.type == "bridge"
        assert found.config == {"ipv4.nat": "false", "ipv4.address": "10.99.0.1/29"}
        assert rules is not None and rules.ingress == ()
        assert rules.egress == ({"action": "allow", "destination_port": "3128", "description": ""},)
        assert [call["argv"] for call in rig.calls()] == [
            ["query", "/1.0/networks/cr-ab12-o0?project=default"],
            ["query", "/1.0/network-acls/cr-ab12-o0?project=default"],
        ]


def test_an_object_that_is_not_there_is_none_and_any_other_failure_is_an_error() -> None:
    with short_directory() as root:
        rig = Rig(root, exit=1, stderr="Error: Network not found\n")
        assert go(lambda: rig.client.network_info("n")) is None
        assert go(lambda: rig.client.acl_info("n")) is None

        rig.set(exit=1, stderr="Error: permission denied\n")
        with pytest.raises(IncusError, match="permission denied"):
            go(lambda: rig.client.network_info("n"))

        rig.set(stdout="[]")
        with pytest.raises(IncusError, match="not an object"):
            go(lambda: rig.client.network_info("n"))


def test_an_acl_is_created_and_its_rules_added() -> None:
    with short_directory() as root:
        rig = Rig(root)

        go(
            lambda: rig.client.create_acl(
                "cr-out0", [{"action": "allow", "protocol": "tcp", "destination_port": "3128"}]
            )
        )

        assert [call["argv"] for call in rig.calls()] == [
            ["network", "acl", "create", "cr-out0"],
            [
                "network",
                "acl",
                "rule",
                "add",
                "cr-out0",
                "egress",
                "action=allow",
                "protocol=tcp",
                "destination_port=3128",
            ],
        ]


def test_a_device_without_a_type_is_an_error_before_any_call() -> None:
    with short_directory() as root:
        rig = Rig(root)

        with pytest.raises(IncusError, match="no type"):
            go(lambda: rig.client.add_device("x", "eth0", {"network": "n"}))

        assert not rig.record.exists()
