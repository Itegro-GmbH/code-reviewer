# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment control of the Worker (#975): the one interface (`narrow`, `report_end`), its two
transports and the choice between them, and the framing of the vsock transport.

No test opens a real vsock: the socket is a seam, and a fake host answers over a `socketpair` of the
host, so the framing is proven on a real byte stream. The real AF_VSOCK path is proven by the lane
of #977 and #978, on a machine with KVM.

The https transport's call itself (`POST /network`, the token, the retries) stays in
`test_implementer_network.py`, unchanged."""

import io
import json
import logging
import socket
import struct
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, TextIO, cast

import pytest
from door_support import implementer_job_text
from jsonschema import Draft202012Validator

from code_reviewer_runner import worker_cli
from code_reviewer_runner.implementer import environment_control as control
from code_reviewer_runner.implementer.environment_control import (
    ENVIRONMENT_CONTROL_VARIABLE,
    HttpsControl,
    ProtocolError,
    Refusal,
    VsockControl,
    control_from_environment,
    encode_frame,
    read_frame,
    report_worker_end,
)
from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OPEN,
    OFF,
    NetworkRule,
)
from code_reviewer_runner.implementer.network_switch import (
    model_host_of,
    narrow_policy,
    parse_switch,
)
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams
from code_reviewer_runner.job import (
    IMPLEMENTER_NETWORK_SWITCH_VARIABLE,
    JobError,
    parse_implementer_input,
)
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
_DEFS: dict[str, Any] = json.loads(
    (CONTRACTS / "environment-control.v1.json").read_text(encoding="utf-8")
)["$defs"]

LIST = NetworkRule(MODE_LIST, ("registry.npmjs.org", "*.pythonhosted.org"))
OPEN = NetworkRule(MODE_OPEN)
MODEL_HOST = "api.example.com"
SWITCH_TEXT = json.dumps(
    {
        "url": "https://dispatcher.example.test/network",
        "vm": "cr-implementer-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-1",
        "appId": "factory",
        "network": LIST.to_json(),
        "modelHost": MODEL_HOST,
        "expires": 1_800_000_000,
        "token": "t" * 64,
    }
)


def valid(definition: str, document: Any) -> bool:
    validator = Draft202012Validator({"$ref": "#/$defs/" + definition, "$defs": _DEFS})
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def frame_of(document: Any) -> bytes:
    body = json.dumps(document).encode()
    return struct.pack(">I", len(body)) + body


# -- the host: reads frames from a fake socket and answers as the test says ---


class FakeHost:
    """The other end of a `socketpair`. It records every request, checks each against the
    contract file, and answers with the next of `answers`: a document, raw bytes, or `None` (say
    nothing, which is what a host that hangs does). A thread, so the Worker's side runs as it does
    in production."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[Any] = []
        self.connections = 0
        self.refuse_connect = False
        self._threads: list[threading.Thread] = []
        self._sockets: list[socket.socket] = []

    def connect(self, timeout: float) -> socket.socket:
        assert timeout > 0
        if self.refuse_connect:
            raise ConnectionRefusedError("no host")
        self.connections += 1
        worker, host = socket.socketpair()
        self._sockets += [worker, host]
        thread = threading.Thread(target=self._serve, args=(host,), daemon=True)
        thread.start()
        self._threads.append(thread)
        return worker

    def _serve(self, host: socket.socket) -> None:
        host.settimeout(5)
        try:
            request = read_frame(host, deadline_seconds=5)
        except (ProtocolError, OSError):
            return
        self.requests.append(request)
        assert valid("ControlRequest", request), request
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if answer is None:
            self._hold(host)
            return
        host.sendall(answer if isinstance(answer, bytes) else frame_of(answer))
        self._hold(host)

    def _hold(self, host: socket.socket) -> None:
        # Keep the connection open until the Worker closes it, as a host that is not done does.
        try:
            while host.recv(4096):
                pass
        except OSError:
            pass

    def close(self) -> None:
        for sock in self._sockets:
            sock.close()
        for thread in self._threads:
            thread.join(timeout=5)


@pytest.fixture
def host_factory() -> Any:
    hosts: list[FakeHost] = []

    def make(*answers: Any) -> FakeHost:
        host = FakeHost(*answers)
        hosts.append(host)
        return host

    yield make
    for host in hosts:
        host.close()


ACK = {"version": 1, "type": "ack", "for": "narrow"}
ACK_END = {"version": 1, "type": "ack", "for": "end"}


def vsock_control(host: FakeHost, **limits: float) -> VsockControl:
    return VsockControl(connect=host.connect, **limits)


# -- the framing ---


def test_a_frame_is_four_bytes_of_length_and_the_json_body() -> None:
    frame = encode_frame({"a": 1})

    assert frame == b"\x00\x00\x00\x07" + b'{"a":1}'


@pytest.mark.parametrize("document", [{"a": 1}, {"text": "äöü €"}, {"nested": {"x": [1, 2, 3]}}])
def test_a_frame_comes_back_as_the_document_even_a_byte_at_a_time(document: Any) -> None:
    worker, host = socket.socketpair()
    try:
        sender = threading.Thread(
            target=lambda: [host.sendall(bytes([byte])) for byte in encode_frame(document)]
        )
        sender.start()
        assert read_frame(worker, deadline_seconds=5) == document
        sender.join()
    finally:
        worker.close()
        host.close()


def test_a_frame_of_the_largest_size_is_read_and_one_byte_more_is_not_written() -> None:
    at_limit = {"pad": "x" * (control.MAX_FRAME_BYTES - len('{"pad":""}'))}
    assert len(json.dumps(at_limit, separators=(",", ":")).encode()) == control.MAX_FRAME_BYTES
    worker, host = socket.socketpair()
    try:
        writer = threading.Thread(target=lambda: host.sendall(encode_frame(at_limit)))
        writer.start()
        assert read_frame(worker, deadline_seconds=5) == at_limit
        writer.join()
    finally:
        worker.close()
        host.close()
    with pytest.raises(ProtocolError):
        encode_frame({"pad": "x" * control.MAX_FRAME_BYTES})


@pytest.mark.parametrize(
    "bytes_in",
    [
        struct.pack(">I", 0),
        struct.pack(">I", control.MAX_FRAME_BYTES + 1) + b"x",
        struct.pack(">I", 0xFFFFFFFF),
        b"\x00\x00",
        struct.pack(">I", 10) + b"{}",
        struct.pack(">I", 4) + b'"ab"',
        struct.pack(">I", 3) + b"{x}",
        struct.pack(">I", 2) + b"\xff\xfe",
        struct.pack(">I", 2) + b"[]",
    ],
)
def test_a_frame_that_is_not_a_frame_of_the_contract_is_a_protocol_error(bytes_in: bytes) -> None:
    worker, host = socket.socketpair()
    try:
        host.sendall(bytes_in)
        host.shutdown(socket.SHUT_WR)
        with pytest.raises(ProtocolError):
            read_frame(worker, deadline_seconds=5)
    finally:
        worker.close()
        host.close()


def test_a_frame_that_never_comes_ends_at_the_deadline() -> None:
    worker, host = socket.socketpair()
    try:
        host.sendall(b"\x00\x00")  # half a header, then nothing
        with pytest.raises(TimeoutError):
            read_frame(worker, deadline_seconds=0.2)
    finally:
        worker.close()
        host.close()


# -- #975-T02: the vsock transport ---


# #975-T02
def test_narrow_sends_the_closed_message_and_waits_for_the_ack(host_factory: Any) -> None:
    host = host_factory(ACK)

    vsock_control(host).narrow(LIST, MODEL_HOST)

    assert host.requests == [
        {
            "version": 1,
            "type": "narrow",
            "network": {"mode": "list", "hosts": ["registry.npmjs.org", "*.pythonhosted.org"]},
            "modelHost": MODEL_HOST,
        }
    ]
    assert host.connections == 1


# #975-T02
def test_the_rule_off_is_narrowed_too(host_factory: Any) -> None:
    host = host_factory(ACK)

    vsock_control(host).narrow(OFF, MODEL_HOST)

    assert host.requests[0]["network"] == {"mode": "off", "hosts": []}


# #975-T02
def test_a_host_that_never_answers_fails_the_job_with_the_stable_code(host_factory: Any) -> None:
    host = host_factory(None)

    with pytest.raises(JobError) as caught:
        vsock_control(host, narrow_seconds=0.3).narrow(LIST, MODEL_HOST)

    assert caught.value.code is ErrorCode.ENVIRONMENT_CONTROL_FAILED
    assert caught.value.detail.startswith("environment_control_timeout")


# #975-T02
@pytest.mark.parametrize("reason", [reason.value for reason in Refusal])
def test_a_refused_narrow_fails_the_job_with_the_stable_code_and_the_reason(
    host_factory: Any, reason: str
) -> None:
    host = host_factory({"version": 1, "type": "refused", "for": "narrow", "reason": reason})

    with pytest.raises(JobError) as caught:
        vsock_control(host).narrow(LIST, MODEL_HOST)

    assert caught.value.code is ErrorCode.ENVIRONMENT_CONTROL_FAILED
    assert caught.value.detail.startswith(f"environment_control_refused: {reason}")
    assert host.connections == 1, "a refusal is final, the Worker does not ask again"


# #975-T02
def test_a_host_that_cannot_be_reached_fails_the_job_with_the_stable_code(
    host_factory: Any,
) -> None:
    host = host_factory(ACK)
    host.refuse_connect = True

    with pytest.raises(JobError) as caught:
        vsock_control(host).narrow(LIST, MODEL_HOST)

    assert caught.value.code is ErrorCode.ENVIRONMENT_CONTROL_FAILED
    assert caught.value.detail.startswith("environment_control_unavailable")


# #975-T02
@pytest.mark.parametrize(
    "answer",
    [
        b"",
        struct.pack(">I", 0),
        struct.pack(">I", control.MAX_FRAME_BYTES + 1),
        frame_of({"version": 2, "type": "ack", "for": "narrow"}),
        frame_of({"version": 1, "type": "ack", "for": "end"}),
        frame_of({"version": 1, "type": "ack", "for": "narrow", "extra": True}),
        frame_of({"version": 1, "type": "refused", "for": "narrow", "reason": "because"}),
        frame_of(["ack"]),
        struct.pack(">I", 5) + b"nojson",
    ],
)
def test_an_answer_that_is_not_a_reply_of_the_contract_fails_the_job_the_same_way(
    host_factory: Any, answer: bytes
) -> None:
    host = host_factory(answer)

    with pytest.raises(JobError) as caught:
        vsock_control(host, narrow_seconds=1).narrow(LIST, MODEL_HOST)

    assert caught.value.code is ErrorCode.ENVIRONMENT_CONTROL_FAILED
    assert caught.value.detail.startswith(
        ("environment_control_protocol", "environment_control_timeout")
    )


# #975-T02
def test_the_deadline_covers_the_connect_and_the_whole_exchange(host_factory: Any) -> None:
    seen: list[float] = []
    host = host_factory(ACK)

    def connect(timeout: float) -> socket.socket:
        seen.append(timeout)
        return host.connect(timeout)

    VsockControl(connect=connect, narrow_seconds=7.0).narrow(LIST, MODEL_HOST)

    assert len(seen) == 1 and 0 < seen[0] <= 7.0


# #975-T02
def test_the_worker_closes_its_end_after_every_exchange(host_factory: Any) -> None:
    host = host_factory(ACK)
    control_ = vsock_control(host)

    control_.narrow(LIST, MODEL_HOST)

    worker = host._sockets[0]  # pyright: ignore[reportPrivateUsage]
    assert worker.fileno() == -1


# -- report_end ---


# #975-T02
def test_report_end_sends_the_exit_code_and_waits_for_the_ack(host_factory: Any) -> None:
    host = host_factory(ACK_END)

    vsock_control(host).report_end(1)

    assert host.requests == [{"version": 1, "type": "end", "exitCode": 1}]


# #975-T02
@pytest.mark.parametrize(
    "answer",
    [
        None,
        ACK,
        {"version": 1, "type": "refused", "for": "end", "reason": "unavailable"},
        b"",
        struct.pack(">I", 2) + b"[]",
    ],
)
def test_a_report_end_that_fails_changes_nothing(host_factory: Any, answer: Any) -> None:
    host = host_factory(answer)

    vsock_control(host, end_seconds=0.3).report_end(0)  # no exception: the Worker is ending anyway


# #975-T02
def test_a_report_end_to_a_host_that_cannot_be_reached_changes_nothing(
    host_factory: Any,
) -> None:
    host = host_factory(ACK_END)
    host.refuse_connect = True

    vsock_control(host).report_end(0)


# -- the choice of the transport ---


def https_post(
    calls: list[tuple[str, dict[str, Any], float]],
) -> Callable[[str, bytes, float], tuple[int, bytes]]:
    def post(url: str, body: bytes, timeout: float) -> tuple[int, bytes]:
        calls.append((url, json.loads(body), timeout))
        return 200, b'{"status":"applied"}'

    return post


# #975-T01
def test_the_switch_variable_chooses_https_and_the_wire_is_what_narrow_policy_sends() -> None:
    chosen: list[tuple[str, dict[str, Any], float]] = []
    reference: list[tuple[str, dict[str, Any], float]] = []

    transport = control_from_environment(
        {IMPLEMENTER_NETWORK_SWITCH_VARIABLE: SWITCH_TEXT},
        post=https_post(chosen),
        pause_seconds=0,
    )
    assert isinstance(transport, HttpsControl)
    transport.narrow(LIST, MODEL_HOST)

    switch = parse_switch(SWITCH_TEXT)
    assert switch is not None
    narrow_policy(switch, LIST, MODEL_HOST, post=https_post(reference), pause_seconds=0)
    assert chosen == reference and len(chosen) == 1
    assert chosen[0][0] == "https://dispatcher.example.test/network"
    assert chosen[0][1]["token"] == "t" * 64


# #975-T01
def test_https_refuses_what_the_dispatcher_did_not_sign_exactly_as_before() -> None:
    transport = control_from_environment(
        {IMPLEMENTER_NETWORK_SWITCH_VARIABLE: SWITCH_TEXT}, post=https_post([]), pause_seconds=0
    )
    assert transport is not None

    with pytest.raises(JobError) as caught:
        transport.narrow(OPEN, MODEL_HOST)
    assert caught.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID

    with pytest.raises(JobError) as caught:
        transport.narrow(LIST, "other.example.com")
    assert caught.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


# #975-T01
def test_https_has_nothing_to_report_at_the_end() -> None:
    calls: list[tuple[str, dict[str, Any], float]] = []
    transport = control_from_environment(
        {IMPLEMENTER_NETWORK_SWITCH_VARIABLE: SWITCH_TEXT}, post=https_post(calls), pause_seconds=0
    )
    assert transport is not None

    transport.report_end(0)

    assert calls == []


# #975-T02
def test_the_vsock_variable_chooses_vsock(host_factory: Any) -> None:
    host = host_factory(ACK)

    transport = control_from_environment(
        {ENVIRONMENT_CONTROL_VARIABLE: "vsock"}, connect=host.connect
    )

    assert isinstance(transport, VsockControl)
    transport.narrow(LIST, MODEL_HOST)
    assert host.requests[0]["type"] == "narrow"


# #975-T03
@pytest.mark.parametrize("environment", [{}, {IMPLEMENTER_NETWORK_SWITCH_VARIABLE: "  "}])
def test_no_transport_is_none(environment: dict[str, str]) -> None:
    assert control_from_environment(environment) is None


@pytest.mark.parametrize("value", ["", "https", "VSOCK", "tcp", "vsock "])
def test_a_vsock_variable_that_is_not_vsock_is_a_config_error(value: str) -> None:
    with pytest.raises(JobError) as caught:
        control_from_environment({ENVIRONMENT_CONTROL_VARIABLE: value})

    assert caught.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


def test_both_variables_are_ambiguous_and_refused() -> None:
    with pytest.raises(JobError) as caught:
        control_from_environment(
            {
                ENVIRONMENT_CONTROL_VARIABLE: "vsock",
                IMPLEMENTER_NETWORK_SWITCH_VARIABLE: SWITCH_TEXT,
            }
        )

    assert caught.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


# -- the end of the Worker ---


# #975-T02
def test_the_worker_reports_its_exit_code_over_vsock(host_factory: Any) -> None:
    host = host_factory(ACK_END)

    report_worker_end({ENVIRONMENT_CONTROL_VARIABLE: "vsock"}, 2, connect=host.connect)

    assert host.requests == [{"version": 1, "type": "end", "exitCode": 2}]


# #975-T01
def test_the_worker_reports_nothing_without_vsock(host_factory: Any) -> None:
    host = host_factory(ACK_END)

    report_worker_end({}, 0, connect=host.connect)
    report_worker_end({IMPLEMENTER_NETWORK_SWITCH_VARIABLE: SWITCH_TEXT}, 0, connect=host.connect)

    assert host.connections == 0


def test_a_broken_configuration_does_not_stop_the_worker_from_ending(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        report_worker_end({ENVIRONMENT_CONTROL_VARIABLE: "carrier-pigeon"}, 0)

    assert any("environment control" in record.getMessage() for record in caplog.records)


def test_the_log_never_carries_the_rule(
    host_factory: Any, caplog: pytest.LogCaptureFixture
) -> None:
    host = host_factory({"version": 1, "type": "refused", "for": "narrow", "reason": "unavailable"})

    with caplog.at_level(logging.DEBUG), pytest.raises(JobError) as caught:
        vsock_control(host).narrow(LIST, MODEL_HOST)

    for text in [caught.value.detail, *[record.getMessage() for record in caplog.records]]:
        assert "registry.npmjs.org" not in text and MODEL_HOST not in text


# -- the session and the Worker use it ---


def session_with(environment: dict[str, str], seams: SessionSeams) -> ImplementerSession:
    job = parse_implementer_input(implementer_job_text())
    return ImplementerSession(
        job,
        workspace=cast("Any", None),
        command=["opencode"],
        place=lambda: cast("Any", None),
        environment=environment,
        seams=seams,
    )


def start_network(session: ImplementerSession) -> None:
    entry = session.job.implementer.model_entry
    session._start_network(  # pyright: ignore[reportPrivateUsage]
        cast("Any", type("Model", (), {"entry": entry})())
    )


# #975-T02
def test_the_session_narrows_the_wall_over_vsock_before_the_agent(host_factory: Any) -> None:
    host = host_factory(ACK)
    session = session_with(
        {ENVIRONMENT_CONTROL_VARIABLE: "vsock"}, SessionSeams(control_connect=host.connect)
    )

    start_network(session)

    entry = session.job.implementer.model_entry
    assert entry is not None
    [request] = host.requests
    assert request["type"] == "narrow" and request["network"] == OFF.to_json()
    assert request["modelHost"] == model_host_of(entry.upstream_base_url)
    assert session._vm_policy == "narrowed"  # pyright: ignore[reportPrivateUsage]


# #975-T02
def test_a_host_that_never_answers_ends_the_turn_with_the_stable_code(host_factory: Any) -> None:
    host = host_factory(None)
    session = session_with(
        {ENVIRONMENT_CONTROL_VARIABLE: "vsock"},
        SessionSeams(control_connect=host.connect, control_narrow_seconds=0.3),
    )

    with pytest.raises(JobError) as caught:
        start_network(session)

    assert caught.value.code is ErrorCode.ENVIRONMENT_CONTROL_FAILED


# #975-T02
def test_a_refused_rule_ends_the_turn_with_the_stable_code(host_factory: Any) -> None:
    host = host_factory(
        {"version": 1, "type": "refused", "for": "narrow", "reason": "rule_not_allowed"}
    )
    session = session_with(
        {ENVIRONMENT_CONTROL_VARIABLE: "vsock"}, SessionSeams(control_connect=host.connect)
    )

    with pytest.raises(JobError) as caught:
        start_network(session)

    assert caught.value.code is ErrorCode.ENVIRONMENT_CONTROL_FAILED
    assert "rule_not_allowed" in caught.value.detail


# #975-T03
def test_with_no_transport_the_turn_goes_on_and_one_line_says_the_wall_is_not_narrowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    session = session_with({}, SessionSeams())

    with caplog.at_level(logging.INFO):
        start_network(session)

    said = [
        record.getMessage()
        for record in caplog.records
        if "outer network wall is not narrowed" in record.getMessage()
    ]
    assert len(said) == 1
    assert session._vm_policy == "not_configured"  # pyright: ignore[reportPrivateUsage]
    assert any("network policy was not changed" in note for note in session._notes)  # pyright: ignore[reportPrivateUsage]


# #975-T02
def test_the_worker_reports_its_exit_code_when_it_ends(monkeypatch: pytest.MonkeyPatch) -> None:
    reported: list[tuple[dict[str, str], int]] = []

    def run(env: dict[str, str], source: TextIO) -> int:
        _ = (env, source)
        return 1

    def report(env: Mapping[str, str], code: int) -> None:
        reported.append((dict(env), code))

    monkeypatch.setattr(worker_cli, "_run", run)
    monkeypatch.setattr(worker_cli, "report_worker_end", report)

    code = worker_cli.main(
        ["--once"], environment={ENVIRONMENT_CONTROL_VARIABLE: "vsock"}, stdin=io.StringIO("")
    )

    assert code == 1
    assert reported == [({ENVIRONMENT_CONTROL_VARIABLE: "vsock"}, 1)]
