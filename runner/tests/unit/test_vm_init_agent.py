# SPDX-License-Identifier: LicenseRef-Proprietary

"""What vm-init does with a start, over a fake vsock (#977): the start payload, the order of the
hosted launcher's steps, the exit report and the power off, and where the secrets go.

The vsock here is a socket pair per connection (`vm_init_support.FakeVsock`); no AF_VSOCK socket is
opened. The real boot path (a Firecracker VM, the real vsock, Docker and Sysbox in the guest) is
proven by the KVM lane of #978."""

import dataclasses
import json
import logging
import os
import socket
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.vm_init import wire
from code_reviewer_runner.vm_init.agent import Environment, Timing, VmInit
from code_reviewer_runner.vm_init.steps import CommandResult
from vm_init_support import (
    CONTROL_TOKEN,
    CREDENTIAL,
    IMAGE_ID,
    LOCAL_CREDENTIAL,
    OUTER_PROXY,
    FakeControl,
    FakePower,
    FakeRunner,
    FakeVsock,
    start_document,
    work_volume_mountinfo,
)

GOLDEN_ARGS = (
    Path(__file__).resolve().parents[3]
    / "dispatcher"
    / "src"
    / "launchers"
    / "testdata"
    / "docker-run.local-control.golden.json"
)
FAST = Timing(
    start_wait_seconds=0.2, start_read_seconds=0.5, report_seconds=0.6, report_retry_seconds=0.01
)


class Guest:
    """One vm-init with its fakes."""

    def __init__(self, *, status: int = 0, timing: Timing = FAST) -> None:
        self.vsock = FakeVsock()
        self.runner = FakeRunner(mountinfo=work_volume_mountinfo)
        self.control = FakeControl(status=status)
        self.power = FakePower()
        self.events: list[str] = []
        self.environment = Environment(
            vsock=self.vsock,
            runner=self.runner,
            spawn=self._spawn,
            power_off=self.end_vm,
            timing=timing,
            protect_self=self.protect,
        )

    def _spawn(self, args: tuple[str, ...], stdin: bytes) -> int:
        self.events.append("control")
        return self.control(args, stdin)

    def protect(self) -> bool:
        self.events.append("protect")
        return True

    def end_vm(self) -> bool:
        self.events.append("power-off")
        return self.power()

    def run(self) -> bool:
        return VmInit(self.environment).run()

    def start(self, document: Any = None) -> Any:
        host = self.vsock.host_connects()
        host.send(start_document() if document is None else document)
        return host

    def report(self) -> dict[str, Any]:
        assert len(self.vsock.report_host_ends) >= 1, "no exit report was sent"
        return self.vsock.report_host_ends[-1].read()


def _prepared(commands: list[tuple[str, ...]]) -> list[str]:
    return [c[0] if c[0] != "env" else c[2] for c in commands]


# #977-T01
def test_a_start_over_the_vsock_runs_control_with_the_arguments_and_the_job_on_stdin() -> None:
    guest = Guest()
    host = guest.start()

    guest.run()

    assert host.read() == {"version": 1, "type": "ack", "for": "start"}
    ((args, stdin),) = guest.control.calls
    assert args == tuple(start_document()["control"]["args"])
    assert json.loads(stdin)["credential"] == CREDENTIAL
    assert guest.vsock.listen_ports == [wire.START_PORT]
    assert guest.vsock.report_ports == [wire.REPORT_PORT]


# #977-T01
def test_the_hosted_golden_runs_unchanged_but_for_the_image_that_now_runs_by_its_id() -> None:
    golden = json.loads(GOLDEN_ARGS.read_text(encoding="utf-8"))
    (operand,) = [a for a in golden if a.startswith("registry.invalid/")]
    guest = Guest()
    guest.start(
        start_document(control={"args": golden}, image={"reference": operand, "id": IMAGE_ID})
    )

    guest.run()

    ((args, _),) = guest.control.calls
    assert list(args) == [IMAGE_ID if a == operand else a for a in golden]


# #977-T01
def test_the_steps_run_in_the_order_of_the_hosted_launcher() -> None:
    guest = Guest()
    guest.start()

    guest.run()

    labels = _prepared(guest.runner.commands)
    assert labels == [
        "docker",  # does a daemon answer already?
        "mkdir",
        "mount",
        "mount",
        "sh",
        "/usr/local/sbin/vm-prepare.sh",
        "docker",  # the image id, right after the daemon as the hosted `prepare()` does
        "/usr/local/sbin/sysbox-prepare.sh",
        "mkdir",
        "fallocate",
        "mkfs.ext4",
        "mount",
        "mount",
        "mount",
        "cat",
        "docker",  # the volume
    ]
    assert guest.runner.commands[1:6] == [
        ("mkdir", "-p", "--", "/run/docker", "/run/containerd"),
        (
            "mount",
            "-t",
            "tmpfs",
            "-o",
            "size=64m,mode=0711,nosuid,nodev",
            "tmpfs",
            "/run/docker",
        ),
        (
            "mount",
            "-t",
            "tmpfs",
            "-o",
            "size=64m,mode=1777,nosuid,nodev",
            "tmpfs",
            "/run/containerd",
        ),
        guest.runner.commands[4],
        ("env", "TMPDIR=/run/containerd", "/usr/local/sbin/vm-prepare.sh"),
    ]


# #977-T01
def test_a_daemon_that_already_answers_keeps_the_steps_before_it_from_running() -> None:
    guest = Guest()
    guest.runner.rules.append((("docker", "info"), CommandResult(0)))
    guest.start()

    guest.run()

    commands = [c[0] for c in guest.runner.commands]
    assert "mount" in commands  # the work volume's
    assert guest.runner.commands[1][:3] == ("docker", "image", "inspect")
    assert guest.runner.commands[2] == ("/usr/local/sbin/sysbox-prepare.sh",)
    assert ("mkdir", "-p", "--", "/run/docker", "/run/containerd") not in guest.runner.commands


# #977-T01
def test_the_image_is_checked_against_the_manifests_id_before_anything_is_made() -> None:
    guest = Guest()
    guest.start()

    guest.run()

    image = [c for c in guest.runner.commands if c[:3] == ("docker", "image", "inspect")]
    assert image == [
        ("docker", "image", "inspect", "--format", "{{.Id}}", "code-reviewer-worker:golden")
    ]


# #977-T03
@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (0, "worker_exited"),
        (1, "worker_exited"),
        (2, "worker_exited"),
        (137, "worker_exited"),
        (125, "docker_failed"),
        (126, "docker_failed"),
        (127, "docker_failed"),
    ],
)
def test_controls_exit_status_reaches_the_host_and_the_vm_powers_off(
    status: int, reason: str
) -> None:
    guest = Guest(status=status)
    guest.start()

    guest.run()

    assert guest.report() == {
        "version": 1,
        "type": "exit",
        "exitCode": status,
        "reason": reason,
        "token": CONTROL_TOKEN,
    }
    assert guest.power.calls == 1
    assert guest.events == ["protect", "control", "power-off"]


# #977-T03
def test_a_status_outside_zero_to_255_is_reported_as_the_nearest_one() -> None:
    guest = Guest(status=300)
    guest.start()

    guest.run()

    assert guest.report()["exitCode"] == 255


# #977-T03
def test_the_vm_powers_off_after_the_report_and_run_returns_what_theend_vm_did() -> None:
    guest = Guest()
    guest.power.result = False
    guest.start()

    assert guest.run() is False
    assert guest.report()["type"] == "exit"


# #977-T03
def test_a_host_that_never_answers_the_report_does_not_keep_the_vm_alive() -> None:
    guest = Guest()
    guest.vsock.ack_reports = False
    guest.start()

    guest.run()

    assert guest.power.calls == 1
    assert guest.events == ["protect", "control", "power-off"]
    assert len(guest.vsock.report_host_ends) == 1  # the time it had went on waiting for the answer


# #977-T03
def test_the_report_is_tried_again_when_the_host_is_not_listening_yet() -> None:
    guest = Guest()
    guest.vsock.connect_errors = [OSError("refused"), OSError("refused")]
    guest.start()

    guest.run()

    assert guest.report()["reason"] == "worker_exited"
    assert guest.vsock.report_ports == [wire.REPORT_PORT] * 3


# #977-T03
def test_a_report_the_host_answers_wrongly_is_sent_again() -> None:
    guest = Guest()
    guest.vsock.ack_reports = False
    guest.start()
    original = guest.vsock.connect_host
    calls: list[int] = []

    def connect(port: int, timeout: float) -> Any:
        calls.append(port)
        stream = original(port, timeout)
        host = guest.vsock.report_host_ends[-1]
        host.send(
            {"version": 1, "type": "ack", "for": "start"}
            if len(calls) == 1
            else {"version": 1, "type": "ack", "for": "exit"}
        )
        return stream

    guest.vsock.connect_host = connect  # type: ignore[method-assign]

    guest.run()

    assert len(calls) == 2


# #977-T02
@pytest.mark.parametrize(
    "document",
    [
        {"version": 1, "type": "start"},
        start_document(version=2),
        start_document(job={"appUrl": "https://a.example", "jobId": "j"}),
        start_document(control={"args": ["run", f"--env=X={CREDENTIAL}", IMAGE_ID]}),
        start_document(control={"args": ["run", "--privileged", IMAGE_ID]}),
        start_document(control={"args": ["run", "other:tag"]}),
        start_document(controlToken=None),
        [1, 2],
    ],
    ids=[
        "missing keys",
        "version",
        "job without credential",
        "credential in arguments",
        "a refused option",
        "another image",
        "no token",
        "array",
    ],
)
def test_a_malformed_start_is_refused_and_the_vm_powers_off_with_a_stable_code(
    document: Any,
) -> None:
    guest = Guest()
    host = guest.start(document)

    guest.run()

    assert host.read() == {
        "version": 1,
        "type": "refused",
        "for": "start",
        "reason": "invalid_start",
    }
    assert guest.report() == {
        "version": 1,
        "type": "exit",
        "exitCode": 2,
        "reason": "start_invalid",
    }
    assert guest.control.calls == []
    assert guest.power.calls == 1
    # Nothing was made for a start that is not one.
    assert not any(c[0] in ("fallocate", "mkfs.ext4") for c in guest.runner.commands)


# #977-T02
def test_an_oversized_start_is_refused_and_the_vm_powers_off() -> None:
    guest = Guest()
    host = guest.vsock.host_connects()
    host.send_raw((wire.MAX_FRAME_BYTES + 1).to_bytes(4, "big"))

    guest.run()

    assert host.read()["type"] == "refused"
    assert guest.report()["reason"] == "start_invalid"
    assert guest.control.calls == []


# #977-T02
def test_a_start_that_does_not_come_whole_in_time_is_refused() -> None:
    guest = Guest()
    host = guest.vsock.host_connects()
    host.send_raw((100).to_bytes(4, "big") + b"{")

    guest.run()

    assert guest.report()["reason"] == "start_invalid"
    assert guest.control.calls == []


# #977-T02
def test_a_byte_after_the_frame_of_the_start_is_a_protocol_error() -> None:
    guest = Guest()
    host = guest.start()
    host.send_raw(b"x")

    guest.run()

    assert host.read()["type"] == "refused"
    assert guest.control.calls == []


# #977-T02
def test_no_start_in_time_ends_the_vm_with_a_report_and_no_job() -> None:
    guest = Guest()

    guest.run()

    assert guest.report() == {
        "version": 1,
        "type": "exit",
        "exitCode": 2,
        "reason": "start_timeout",
    }
    assert guest.power.calls == 1
    assert guest.control.calls == []


# #977-T02
def test_the_time_to_wait_for_the_start_is_what_is_left_after_the_preparation() -> None:
    guest = Guest()

    guest.run()

    assert guest.vsock.listener is not None
    (timeout,) = guest.vsock.listener.timeouts
    assert 0 <= timeout <= FAST.start_wait_seconds


# #977-T02
def test_only_one_start_is_accepted() -> None:
    guest = Guest()
    guest.start()
    second = guest.vsock.host_connects()
    second.send(start_document())

    guest.run()

    assert len(guest.control.calls) == 1
    assert guest.vsock.listener is not None and guest.vsock.listener.closed


# #977-T02
def test_a_vm_that_cannot_listen_reports_a_failed_preparation_and_powers_off() -> None:
    guest = Guest()
    guest.vsock.refuse_listen = True

    guest.run()

    assert guest.report()["reason"] == "prepare_failed"
    assert guest.power.calls == 1


# #977-T02
@pytest.mark.parametrize(
    ("failing", "label"),
    [
        (("env", "TMPDIR=/run/containerd"), "vm-prepare"),
        (("mount", "-t", "tmpfs"), "run-directory"),
    ],
)
def test_a_daemon_that_cannot_be_started_ends_the_vm_before_a_start_is_taken(
    failing: tuple[str, ...], label: str
) -> None:
    _ = label
    guest = Guest()
    guest.runner.rules.append((failing, CommandResult(1)))
    host = guest.start()

    guest.run()

    assert guest.report() == {
        "version": 1,
        "type": "exit",
        "exitCode": 2,
        "reason": "prepare_failed",
    }
    assert guest.control.calls == []
    host.sock.settimeout(0.05)
    with pytest.raises(TimeoutError):
        host.sock.recv(1)  # the start was never read, so never answered


# #977-T02
def test_an_image_that_is_not_in_the_vm_ends_it() -> None:
    guest = Guest()
    guest.runner.rules.append((("docker", "image"), CommandResult(1)))
    guest.start()

    guest.run()

    assert guest.report()["reason"] == "image_missing"
    assert guest.control.calls == []


# #977-T02
def test_an_image_with_another_id_than_the_manifests_ends_the_vm() -> None:
    guest = Guest()
    guest.runner.rules.append((("docker", "image"), CommandResult(0, "sha256:" + "cd" * 32 + "\n")))
    guest.start()

    guest.run()

    assert guest.report() == {
        "version": 1,
        "type": "exit",
        "exitCode": 2,
        "reason": "image_mismatch",
        "token": CONTROL_TOKEN,
    }
    assert guest.control.calls == []
    assert IMAGE_ID.encode() not in b"".join(
        c.encode() for cmd in guest.runner.commands for c in cmd[:1]
    )


# #977-T02
def test_a_work_volume_that_cannot_be_made_ends_the_vm_before_control() -> None:
    guest = Guest()
    guest.runner.rules.append((("mkfs.ext4",), CommandResult(1)))
    guest.start()

    guest.run()

    assert guest.report()["reason"] == "prepare_failed"
    assert guest.control.calls == []


# #977-T02
def test_a_work_volume_whose_mount_has_not_the_options_ends_the_vm_before_control() -> None:
    guest = Guest()
    guest.runner.mountinfo = lambda: work_volume_mountinfo().replace(
        "rw,nosuid", "rw,noexec,nosuid", 1
    )
    guest.start()

    guest.run()

    assert guest.report()["reason"] == "prepare_failed"
    assert guest.control.calls == []
    assert not any(c[:2] == ("docker", "volume") for c in guest.runner.commands)


# #977-T04
def test_the_local_credential_reaches_controls_stdin_and_nowhere_else(
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    caplog.set_level(logging.DEBUG)
    guest = Guest()
    host = guest.start()

    guest.run()

    ((args, stdin),) = guest.control.calls
    document = json.loads(stdin)
    assert document["credential"] == CREDENTIAL
    assert document["controlToken"] == CONTROL_TOKEN
    assert document["localCredential"] == {
        "name": "CLAUDE_CODE_OAUTH_TOKEN",
        "value": LOCAL_CREDENTIAL,
    }
    report = guest.vsock.report_host_ends[-1].read()
    everything_else = [
        *[" ".join(a) for a in guest.runner.commands],
        " ".join(args),
        json.dumps(host.read()),
        caplog.text,
        capfd.readouterr().out,
        capfd.readouterr().err,
    ]
    for secret in (CREDENTIAL, LOCAL_CREDENTIAL, CONTROL_TOKEN):
        assert not [text for text in everything_else if secret in text]
    # The token is in the report, which is where the host reads it, and the credentials are not.
    assert report["token"] == CONTROL_TOKEN
    assert CREDENTIAL not in json.dumps(report) and LOCAL_CREDENTIAL not in json.dumps(report)
    # No file was written anywhere the guest works.
    assert [p for p in tmp_path.rglob("*")] == []


# #994-T01
def test_the_proxy_of_the_start_reaches_controls_stdin_and_no_command_or_argument() -> None:
    guest = Guest()
    guest.start(start_document(outerProxy=OUTER_PROXY))

    guest.run()

    ((args, stdin),) = guest.control.calls
    assert json.loads(stdin)["outerProxy"] == OUTER_PROXY
    assert not [
        text
        for text in [*[" ".join(c) for c in guest.runner.commands], " ".join(args)]
        if "172.31." in text
    ]


# #994-T03
def test_a_start_without_a_proxy_gives_control_no_proxy() -> None:
    guest = Guest()
    guest.start()

    guest.run()

    ((_, stdin),) = guest.control.calls
    assert "outerProxy" not in json.loads(stdin)


# #994-T04
def test_a_public_proxy_address_refuses_the_start_and_runs_nothing() -> None:
    guest = Guest()
    guest.start(start_document(outerProxy={"host": "8.8.8.8", "port": 3128}))

    guest.run()

    assert guest.report()["reason"] == "start_invalid"
    assert guest.control.calls == []


# #977-T04
def test_a_refused_start_leaves_no_trace_of_the_credential_in_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    guest = Guest()
    guest.start(start_document(control={"args": ["run", f"--env=X={LOCAL_CREDENTIAL}", IMAGE_ID]}))

    guest.run()

    assert CREDENTIAL not in caplog.text and LOCAL_CREDENTIAL not in caplog.text
    assert CONTROL_TOKEN not in caplog.text
    assert caplog.text  # something was logged: the refusal


# #977-T04
def test_the_credential_is_in_no_command_the_guest_runs(tmp_path: Path) -> None:
    guest = Guest()
    guest.start()

    guest.run()

    flat = "\n".join(" ".join(c) for c in guest.runner.commands)
    assert CREDENTIAL not in flat and LOCAL_CREDENTIAL not in flat and CONTROL_TOKEN not in flat
    assert os.listdir(tmp_path) == []


def test_the_fake_vsock_connections_are_real_sockets() -> None:
    guest_end, host_end = socket.socketpair()
    assert guest_end.family == host_end.family


# #977-T02
def test_an_unexpected_error_still_ends_the_vm_with_a_report_and_never_logs_its_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    guest = Guest()
    guest.start()

    def explode(args: tuple[str, ...], stdin: bytes) -> int:
        raise RuntimeError(stdin.decode())

    guest.environment = dataclasses.replace(guest.environment, spawn=explode)

    guest.run()

    assert guest.report() == {
        "version": 1,
        "type": "exit",
        "exitCode": 2,
        "reason": "prepare_failed",
        "token": CONTROL_TOKEN,
    }
    assert guest.power.calls == 1
    assert "RuntimeError" in caplog.text
    assert CREDENTIAL not in caplog.text


# -- the token (#977 fix round) ---


# #977-T07
def test_every_report_after_a_start_was_read_carries_the_hosts_token() -> None:
    cases: list[tuple[Guest, str]] = []
    mismatch = Guest()
    mismatch.runner.rules.append((("docker", "image"), CommandResult(0, "sha256:" + "cd" * 32)))
    cases.append((mismatch, "image_mismatch"))
    missing = Guest()
    missing.runner.rules.append((("docker", "image"), CommandResult(1)))
    cases.append((missing, "image_missing"))
    volume = Guest()
    volume.runner.rules.append((("mkfs.ext4",), CommandResult(1)))
    cases.append((volume, "prepare_failed"))
    sysbox = Guest()
    sysbox.runner.rules.append((("/usr/local/sbin/sysbox-prepare.sh",), CommandResult(1)))
    cases.append((sysbox, "prepare_failed"))
    ran = Guest(status=1)
    cases.append((ran, "worker_exited"))
    for guest, reason in cases:
        guest.start()

        guest.run()

        report = guest.report()
        assert report["reason"] == reason
        assert report["token"] == CONTROL_TOKEN


# #977-T07
@pytest.mark.parametrize("what", ["no start", "refused start", "no vsock", "no daemon"])
def test_a_report_of_a_vm_that_never_took_a_start_has_no_token(what: str) -> None:
    guest = Guest()
    if what == "refused start":
        guest.start(start_document(version=2))
    if what == "no vsock":
        guest.vsock.refuse_listen = True
    if what == "no daemon":
        guest.runner.rules.append((("env", "TMPDIR=/run/containerd"), CommandResult(1)))
        guest.start()

    guest.run()

    assert "token" not in guest.report()


# #977-T07
def test_the_token_is_in_the_report_that_is_sent_again_after_a_lost_ack() -> None:
    guest = Guest()
    guest.vsock.ack_reports = False
    guest.start()
    original = guest.vsock.connect_host
    calls: list[int] = []

    def connect(port: int, timeout: float) -> Any:
        calls.append(port)
        stream = original(port, timeout)
        guest.vsock.report_host_ends[-1].send(
            {"version": 1, "type": "ack", "for": "start" if len(calls) == 1 else "exit"}
        )
        return stream

    guest.vsock.connect_host = connect  # type: ignore[method-assign]

    guest.run()

    reports = [end.read() for end in guest.vsock.report_host_ends]
    assert len(reports) == 2
    assert reports[0] == reports[1]
    assert reports[0]["token"] == CONTROL_TOKEN


# -- vm-init protects itself and ends the VM whatever happens (#977 fix round) ---


# #977-T08
def test_vm_init_protects_itself_from_the_oom_killer_before_it_does_anything_else() -> None:
    guest = Guest()
    guest.start()

    guest.run()

    assert guest.events[0] == "protect"


# #977-T08
def test_a_vm_init_that_cannot_protect_itself_goes_on() -> None:
    guest = Guest()

    def refuse() -> bool:
        raise OSError("no")

    guest.environment = dataclasses.replace(guest.environment, protect_self=refuse)
    guest.start()

    guest.run()

    assert guest.report()["reason"] == "worker_exited"
    assert guest.power.calls == 1


# #977-T09
def test_the_vm_powers_off_even_when_the_report_itself_blows_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guest = Guest()
    guest.start()

    def explode(self: VmInit, outcome: object) -> None:
        raise RuntimeError("a bug in the report")

    monkeypatch.setattr(VmInit, "_report", explode)

    guest.run()

    assert guest.power.calls == 1
    assert guest.events[-1] == "power-off"


# #977-T09
def test_the_vm_reports_and_powers_off_when_a_listener_cannot_be_closed() -> None:
    guest = Guest()
    guest.start()
    listen = guest.vsock.listen

    def listen_and_break(port: int) -> Any:
        listener = listen(port)

        def close() -> None:
            listener.closed = True
            raise OSError("cannot close")

        listener.close = close  # type: ignore[method-assign]
        return listener

    guest.vsock.listen = listen_and_break  # type: ignore[method-assign]

    guest.run()

    assert guest.report()["reason"] == "worker_exited"
    assert guest.power.calls == 1


# #977-T09
def test_a_power_off_that_raises_is_not_hidden_by_a_return() -> None:
    guest = Guest()
    guest.start()

    def refuse() -> bool:
        raise OSError("the kernel said no")

    guest.environment = dataclasses.replace(guest.environment, power_off=refuse)

    with pytest.raises(OSError):
        guest.run()

    assert guest.report()["reason"] == "worker_exited"
