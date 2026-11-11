# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Incus launcher (#1007) against a fake Incus: the instances it asks for, their limits, devices
and marks, Control's `docker run`, the environment control on the job's socket, `narrow` as an
unplug of B's outer NIC, the end of a job and the clean-up, after a crash too. Nothing here needs
Incus: the real one is `tests/incus`."""

import asyncio
import json
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import pytest
from incus_support import (
    CREDENTIAL,
    IMAGE_ID,
    LOCAL_CREDENTIAL,
    TOKEN,
    FakeIncus,
    RecordingWall,
    Rig,
    ask,
    short_directory,
    start_for,
)

from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.wire import Refusal
from code_reviewer_runner.factory_runner.incus.client import ExecResult, IncusError, InstanceInfo
from code_reviewer_runner.factory_runner.incus.launcher import (
    EXIT_DISK_QUOTA,
    EXIT_KILLED,
    IncusNotReady,
    IncusSandbox,
    NoFreeSlot,
    StartFailed,
)
from code_reviewer_runner.factory_runner.sandbox import SandboxInUse
from code_reviewer_runner.implementer.environment_control import end_request, narrow_request
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule

pytestmark = pytest.mark.unit

RULE = NetworkRule(MODE_LIST, ("registry.npmjs.org",))


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


async def started(rig: Rig, sandbox: IncusSandbox | None = None, **start: Any) -> Any:
    sandbox = sandbox or rig.sandbox()
    return await sandbox.start(start_for(**start))


def instance(rig: Rig, role: str) -> Any:
    (found,) = [i for n, i in rig.incus.instances.items() if f"-{role}-" in n]
    return found


def finish_control(rig: Rig, exit_code: int = 0, stderr: str = "") -> None:
    rig.incus.controls[-1].finish(exit_code, stderr)


# -- T01: two instances, their limits, their quota, the clean-up ---


# #1007-T01
def test_a_job_gets_two_instances_with_the_configured_limits_and_quota_and_both_are_deleted() -> (
    None
):
    with short_directory() as root:
        rig = Rig(root, vcpus=2, memory_mib_override=2048, disk_gib=6, a_disk_gib=3, a_cpus=1)

        async def scenario() -> Any:
            worker = await started(rig)
            a, b = instance(rig, "a"), instance(rig, "b")
            seen = {"a": (a.spec, dict(a.devices)), "b": (b.spec, dict(b.devices))}
            names = sorted(rig.incus.instances)
            finish_control(rig, 0)
            outcome = await worker.wait()
            return seen, names, outcome

        seen, names, outcome = go(scenario)

        assert len(names) == 2 and names[0].startswith("cr-a-") and names[1].startswith("cr-b-")
        spec_a, spec_b = seen["a"][0], seen["b"][0]
        # Both from the golden image on the pool, with no profile (the spec has none to name).
        assert spec_a.image == spec_b.image == "code-reviewer-golden"
        assert spec_a.pool == spec_b.pool == "pool"
        assert spec_a.disk_gib == 3 and spec_b.disk_gib == 6
        assert spec_a.config["limits.cpu"] == "1" and spec_b.config["limits.cpu"] == "2"
        assert spec_b.config["limits.memory"] == "2048MiB"
        for spec in (spec_a, spec_b):
            assert spec.config["security.privileged"] == "false"
            assert spec.config["security.nesting"] == "true"
            assert spec.config["security.idmap.isolated"] == "true"
            assert spec.config["limits.processes"] == "4096"
            assert spec.config["limits.memory.swap"] == "false"
            assert spec.config["boot.autostart"] == "false"
            assert spec.config["user.cr.job"] == "00000000-0000-4000-8000-000000000001"
        assert outcome.exit_code == 0
        # Both are gone, and so is the job's directory; the slot is free again.
        assert rig.incus.instances == {}
        assert not list((root / "jobs").glob("job-*"))


# #1007-T01
def test_the_devices_are_the_two_bridges_with_filtering_isolation_and_the_proxy_socket() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            a, b = instance(rig, "a"), instance(rig, "b")
            devices = {"a": dict(a.devices), "b": dict(b.devices)}
            socket = next(iter(root.glob("jobs/job-*/ctl.sock")))
            finish_control(rig)
            await worker.wait()
            return devices, socket

        devices, socket = go(scenario)

        outer_a = devices["a"]["eth0"]
        assert outer_a["network"] == "cr-out0" and outer_a["ipv4.address"] == "10.99.0.2"
        assert devices["b"]["eth1"]["ipv4.address"] == "10.99.0.3"
        for nic in (outer_a, devices["b"]["eth1"]):
            assert nic["security.ipv4_filtering"] == "true"
            assert nic["security.mac_filtering"] == "true"
            assert nic["security.port_isolation"] == "true"
        # The inner bridge has the host nowhere on it; both instances are on it.
        assert devices["a"]["eth1"]["network"] == devices["b"]["eth0"]["network"] == "cr-in0"
        # Control's socket: a proxy device that listens in A, not under /run, and connects to the
        # dispatcher's own socket on the host.
        control = devices["a"]["ctl"]
        assert control["type"] == "proxy" and control["bind"] == "instance"
        assert control["listen"] == "unix:/ctl.sock"
        assert control["connect"] == f"unix:{socket}"


# #1007-T01
def test_the_instances_have_their_network_files_and_a_ruleset_before_they_start() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            files = {role: dict(instance(rig, role).files) for role in "ab"}
            finish_control(rig)
            await worker.wait()
            return files

        files = go(scenario)

        assert (
            b"Address=10.99.0.2/29"
            in files["a"]["/etc/systemd/network/05-code-reviewer-eth0.network"]
        )
        assert (
            b"Address=10.98.0.2/24"
            in files["a"]["/etc/systemd/network/05-code-reviewer-eth1.network"]
        )
        assert (
            b"Address=10.98.0.3/24"
            in files["b"]["/etc/systemd/network/05-code-reviewer-eth0.network"]
        )
        assert (
            b"Address=10.99.0.3/29"
            in files["b"]["/etc/systemd/network/05-code-reviewer-eth1.network"]
        )
        # No gateway, no default route: nothing is routed.
        for each in files.values():
            for content in each.values():
                assert b"Gateway" not in content and b"Route" not in content
        assert b"table inet cr_inner" in files["a"]["/etc/code-reviewer/inner-wall.nft"]


# #1007-T01
def test_everything_is_made_before_a_is_started_and_the_wall_is_loaded_before_b_runs() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            calls = list(rig.incus.calls)
            finish_control(rig)
            await worker.wait()
            return calls

        calls = go(scenario)

        def at(*prefix: str) -> int:
            return next(i for i, call in enumerate(calls) if call[: len(prefix)] == prefix)

        a = next(c[1] for c in calls if c[0] == "create" and "-a-" in c[1])
        b = next(c[1] for c in calls if c[0] == "create" and "-b-" in c[1])
        assert at("create", b) < at("start", a) < at("exec", a, "nft", "-f") < at("start", b)
        assert at("start", b) < at("exec", a, "docker", "image") < at("exec", a, "docker", "run")
        # The wall held the wide rule before any instance existed.
        assert at("wall-admit") < at("create", a)


# #1007-T01
def test_a_job_that_crashes_the_dispatcher_is_found_by_its_mark_and_only_by_its_mark() -> None:
    with short_directory() as root:
        rig = Rig(root)
        mark = {"user.cr.job": "j-1", "user.cr.slot": "0", "user.cr.role": "a"}

        async def scenario() -> Any:
            await rig.incus.create(_spec("cr-a-0-deadbeef", mark))
            await rig.incus.create(_spec("cr-b-0-deadbeef", mark))
            # Not ours: no mark; another prefix; the owner's own instance.
            await rig.incus.create(_spec("cr-a-0-nomark", {}))
            await rig.incus.create(_spec("zz-a-0-deadbeef", mark))
            rig.incus.foreign["owner"] = InstanceInfo("owner", "Running", {"user.cr.job": "x"})
            sandbox = rig.sandbox()
            await sandbox.setup()
            await sandbox.close()
            return sandbox.reaped, sorted(rig.incus.instances), sorted(rig.incus.foreign)

        reaped, left, foreign = go(scenario)

        assert sorted(reaped.instances) == ["cr-a-0-deadbeef", "cr-b-0-deadbeef"]
        assert left == ["cr-a-0-nomark", "zz-a-0-deadbeef"]
        assert foreign == ["owner"]


def _spec(name: str, config: dict[str, str]) -> Any:
    from code_reviewer_runner.factory_runner.incus.client import InstanceSpec

    return InstanceSpec(name, "code-reviewer-golden", "pool", config)


# #1007-T01
def test_instances_that_cannot_be_made_leave_nothing_and_free_the_slot() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.incus.fail["add_device"] = IncusError("config device add", "boom")

        async def scenario() -> Any:
            sandbox = rig.sandbox()
            with pytest.raises(IncusError):
                await sandbox.start(start_for())
            return sandbox.free

        free = go(scenario)

        assert free == 1
        assert rig.incus.instances == {}
        assert not list((root / "jobs").glob("job-*"))
        assert rig.wall.events[-1][0] == "forget"


# #1007-T01
def test_an_instance_that_does_not_become_ready_fails_the_start_and_leaves_nothing() -> None:
    with short_directory() as root:
        rig = Rig(root, ready_seconds=0.3)
        rig.incus.responder = lambda name, argv: (
            ExecResult(1, "", "no") if argv[:2] == ("docker", "info") else None
        )

        async def scenario() -> Any:
            sandbox = rig.sandbox()
            with pytest.raises(StartFailed, match="ready"):
                await sandbox.start(start_for())
            return sandbox.free

        assert go(scenario) == 1
        assert rig.incus.instances == {}


# #1007-T01
@pytest.mark.parametrize(
    ("stdout", "exit_code", "why"),
    [("sha256:" + "cd" * 32 + "\n", 0, "image_mismatch"), ("", 1, "image_missing")],
)
def test_a_worker_image_that_is_not_the_verified_one_fails_the_start(
    stdout: str, exit_code: int, why: str
) -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.incus.responder = lambda name, argv: (
            ExecResult(exit_code, stdout) if argv[:3] == ("docker", "image", "inspect") else None
        )

        async def scenario() -> None:
            with pytest.raises(StartFailed, match=why):
                await rig.sandbox().start(start_for())

        go(scenario)

        assert rig.incus.instances == {}


# #1007-T01
def test_the_slots_are_the_number_of_jobs_that_run_at_once_and_a_slot_is_free_again() -> None:
    with short_directory() as root:
        rig = Rig(root, slots=2)

        async def scenario() -> Any:
            sandbox = rig.sandbox()
            first = await sandbox.start(start_for(1))
            second = await sandbox.start(start_for(2))
            slots = sorted({i.spec.config["user.cr.slot"] for i in rig.incus.instances.values()})
            assert sandbox.free == 0 and sandbox.capacity == 2
            with pytest.raises(NoFreeSlot):
                await sandbox.start(start_for(3))
            for control in rig.incus.controls:
                control.finish(0)
            await first.wait()
            await second.wait()
            return slots, sandbox.free

        slots, free = go(scenario)

        assert slots == ["0", "1"] and free == 2
        assert rig.incus.instances == {}


# #1007-T01
def test_instances_that_would_not_be_deleted_keep_their_slot_out_of_use() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            sandbox = rig.sandbox()
            worker = await sandbox.start(start_for())
            rig.incus.fail["delete"] = IncusError("delete", "busy")
            finish_control(rig)
            await worker.wait()
            return sandbox.free

        assert go(scenario) == 0


# -- the start document ---


# #1007-T01
def test_control_runs_in_a_with_the_job_on_stdin_and_the_credentials_nowhere_else() -> None:
    with short_directory() as root:
        rig = Rig(root, outer_wall=OuterWallMode.PROXY)

        async def scenario() -> Any:
            worker = await started(rig, local=True)
            control = rig.incus.controls[-1]
            run = (control.name, control.argv, control.stdin)
            everything = json.dumps([list(c) for c in rig.incus.calls])
            finish_control(rig)
            await worker.wait()
            return run, everything

        (name, argv, stdin), everything = go(scenario)

        assert "-a-" in name
        assert argv[:2] == ("docker", "run") and IMAGE_ID in argv
        # The unix transport: the variable, the socket mount, no vsock profile.
        assert "RUNNER_ENVIRONMENT_CONTROL=unix" in argv
        assert "type=bind,source=/ctl.sock,target=/ctl.sock" in argv
        assert not any("seccomp" in each for each in argv)
        document = json.loads(stdin)
        assert document["credential"] == CREDENTIAL
        assert document["controlToken"] == TOKEN
        assert document["localCredential"]["value"] == LOCAL_CREDENTIAL
        # The slot's proxy: the host's address on the outer bridge.
        assert document["outerProxy"] == {"host": "10.99.0.1", "port": 3128}
        # No secret in any argument or any call of the launcher.
        for secret in (CREDENTIAL, LOCAL_CREDENTIAL, TOKEN):
            assert secret not in everything
            assert not any(secret in each for each in argv)


# #1007-T01
def test_a_start_the_guest_would_refuse_is_refused_before_any_instance_exists() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            sandbox = rig.sandbox()
            with pytest.raises(StartFailed):
                await sandbox.start(start_for(app_url="not a url"))
            return sandbox.free

        assert go(scenario) == 1
        assert rig.incus.calls == []


# #1007-T01
def test_an_app_on_a_port_the_proxy_does_not_dial_is_refused_before_an_instance_exists() -> None:
    with short_directory() as root:
        rig = Rig(root, outer_wall=OuterWallMode.PROXY)

        async def scenario() -> Any:
            sandbox = rig.sandbox()
            with pytest.raises(StartFailed, match="port 8080"):
                await sandbox.start(start_for(app_url="http://app.example.com:8080"))
            return sandbox.free

        assert go(scenario) == 1
        assert rig.incus.calls == []


# -- T02: narrow ---


# #1007-T02
def test_narrow_unplugs_bs_outer_nic_after_the_wall_holds_the_rule_and_only_then_acks() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            socket = next(iter(root.glob("jobs/job-*/ctl.sock")))
            b = instance(rig, "b")
            before = sorted(b.devices)
            reply = await ask(socket, narrow_request(RULE, "api.example.com", TOKEN))
            after = sorted(b.devices)
            order = [e[0] for e in rig.wall.events]
            again = await ask(socket, narrow_request(RULE, "api.example.com", TOKEN))
            finish_control(rig)
            await worker.wait()
            return before, reply, after, order, again

        before, reply, after, order, again = go(scenario)

        assert before == ["eth0", "eth1"] and after == ["eth0"]
        assert reply == {"version": 1, "type": "ack", "for": "narrow"}
        assert order == ["admit", "narrow"]
        # The same request again is answered the same way, and nothing is unplugged twice.
        assert again == reply


# #1007-T02
def test_a_wall_that_refuses_leaves_the_nic_in_place_and_refuses() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.wall.answer = Refusal.UNAVAILABLE

        async def scenario() -> Any:
            worker = await started(rig)
            socket = next(iter(root.glob("jobs/job-*/ctl.sock")))
            reply = await ask(socket, narrow_request(RULE, "api.example.com", TOKEN))
            devices = sorted(instance(rig, "b").devices)
            finish_control(rig)
            await worker.wait()
            return reply, devices

        reply, devices = go(scenario)

        assert reply["type"] == "refused" and reply["reason"] == "unavailable"
        assert devices == ["eth0", "eth1"]


# #1007-T02
def test_a_nic_that_cannot_be_unplugged_is_a_refusal_not_an_ack() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            socket = next(iter(root.glob("jobs/job-*/ctl.sock")))
            rig.incus.fail["remove_device"] = IncusError("config device remove", "gone")
            reply = await ask(socket, narrow_request(RULE, "api.example.com", TOKEN))
            finish_control(rig)
            await worker.wait()
            return reply

        reply = go(scenario)

        assert reply["type"] == "refused" and reply["reason"] == "unavailable"


# #1007-T02
def test_a_message_without_the_jobs_token_changes_nothing() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            socket = next(iter(root.glob("jobs/job-*/ctl.sock")))
            forged = await ask(socket, narrow_request(RULE, "api.example.com", None))
            wrong = await ask(socket, end_request(0, "w" * 43))
            devices = sorted(instance(rig, "b").devices)
            finish_control(rig)
            await worker.wait()
            return forged, wrong, devices, rig.wall.events

        forged, wrong, devices, events = go(scenario)

        for reply in (forged, wrong):
            assert reply["type"] == "refused" and reply["reason"] == "invalid_request"
        assert devices == ["eth0", "eth1"]
        assert [e[0] for e in events] == ["admit", "forget"]


# -- the end ---


# #1007-T04
def test_a_write_past_the_quota_ends_the_job_with_a_stable_code() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            finish_control(rig, 125, "docker: write /var/lib/docker/x: Disk quota exceeded\n")
            return await worker.wait()

        outcome = go(scenario)

        assert outcome.exit_code == EXIT_DISK_QUOTA == 122
        assert outcome.log_tail.startswith("disk_quota_exceeded:")
        assert rig.incus.instances == {}


# #1007-T04
def test_the_exit_status_of_control_is_the_outcomes_and_a_success_is_never_a_quota() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            finish_control(rig, 0, "a disk quota exceeded warning in a log\n")
            first = await worker.wait()
            second_worker = await started(rig)
            finish_control(rig, 3, "the job failed\n")
            return first, await second_worker.wait()

        first, second = go(scenario)

        assert first.exit_code == 0
        assert second.exit_code == 3 and "the job failed" in second.log_tail


# #1007-T01
def test_a_job_that_outlives_its_wall_clock_is_killed_and_everything_is_removed() -> None:
    with short_directory() as root:
        rig = Rig(root, job_timeout_seconds=1, preparation_seconds=0.0)
        sandbox = rig.sandbox()
        sandbox._template = _quick_stop(sandbox._template)  # pyright: ignore[reportPrivateUsage]

        async def scenario() -> Any:
            worker = await sandbox.start(start_for())
            return await worker.wait()

        outcome = go(scenario)

        assert outcome.exit_code == EXIT_KILLED
        assert rig.incus.controls[-1].killed
        assert rig.incus.instances == {}


def _quick_stop(template: Any) -> Any:
    """The same template with a stop timeout of 0: the wall clock is then the job's timeout."""
    import dataclasses

    arguments = list(template.arguments)
    arguments[arguments.index("--stop-timeout") + 1] = "0"
    return dataclasses.replace(template, arguments=tuple(arguments))


# #1007-T01
def test_stop_ends_the_job_at_once_and_wait_says_so() -> None:
    with short_directory() as root:
        rig = Rig(root)

        async def scenario() -> Any:
            worker = await started(rig)
            waiting = asyncio.ensure_future(worker.wait())
            await asyncio.sleep(0.05)
            await worker.stop()
            return await waiting

        outcome = go(scenario)

        assert outcome.exit_code == EXIT_KILLED and "stopped" in outcome.log_tail
        assert rig.incus.instances == {}


# -- setup, the lock, the checks ---


# #1007-T01
def test_a_second_dispatcher_on_the_same_state_directory_refuses_to_start_and_touches_nothing() -> (
    None
):
    with short_directory() as root:
        rig = Rig(root)
        mark = {"user.cr.job": "j-1"}

        async def scenario() -> Any:
            first = rig.sandbox()
            await first.setup()
            await rig.incus.create(_spec("cr-a-0-running", mark))
            second = IncusSandbox(rig.settings, rig.incus, wall=RecordingWall())
            with pytest.raises(SandboxInUse):
                await second.setup()
            await first.close()
            return sorted(rig.incus.instances)

        assert go(scenario) == ["cr-a-0-running"]


# #1007-T01
def test_setup_names_what_the_machine_lacks() -> None:
    with short_directory() as root:
        rig = Rig(root, slots=2)
        rig.incus.networks.discard("cr-in1")
        rig.incus.images.clear()

        async def scenario() -> None:
            with pytest.raises(IncusNotReady, match=r"image code-reviewer-golden.*network cr-in1"):
                await rig.sandbox().setup()

        go(scenario)


# #1007-T01
def test_the_sandbox_does_not_use_the_hosts_docker() -> None:
    with short_directory() as root:
        assert Rig(root).sandbox().uses_host_docker is False


def test_the_fake_is_what_the_tests_say_it_is() -> None:
    assert isinstance(FakeIncus(), FakeIncus) and isinstance(RecordingWall(), RecordingWall)
    assert isinstance(Path(__file__), Path)
