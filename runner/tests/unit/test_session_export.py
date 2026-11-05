# SPDX-License-Identifier: LicenseRef-Proprietary

"""The export of the engine's session at the end of a turn (#839): the document built from the
engine's HTTP answers, its redaction, the blanking of what the model never reads again, the gzip
and the cap, and the reasons it gives up. The shapes are those the spike measured on a real VM
(`docs/implementer.md`, "Follow-up turns: what was measured on a real VM")."""

import base64
import gzip
import hashlib
import json
import os
import threading
import time
from collections.abc import Mapping
from typing import Any

import pytest

from code_reviewer_runner.implementer.session_export import (
    CAP_BYTES,
    MAX_DEPTH,
    MAX_INFO_BYTES,
    MAX_RAW_BYTES,
    PAGE_SIZE,
    ExportFailed,
    ExportReason,
    take_snapshot,
)
from code_reviewer_runner.redaction import REDACTED, Redactor

pytestmark = pytest.mark.unit

SESSION = "ses_abc"
SECRET = "secret-door-bearer-0123456789"


def tool_part(
    number: int, output: str = "ok", *, compacted: int | None = None, metadata: str = ""
) -> dict[str, Any]:
    time: dict[str, Any] = {"start": 1, "end": 2}
    if compacted is not None:
        time["compacted"] = compacted
    return {
        "id": f"prt_t{number}",
        "type": "tool",
        "tool": "bash",
        "callID": f"call_{number}",
        "state": {
            "status": "completed",
            "input": {"command": f"echo {number}"},
            "output": output,
            "title": "echo",
            "metadata": {"output": metadata, "exit": 0},
            "time": time,
        },
    }


def message(number: int, parts: list[dict[str, Any]], role: str = "assistant") -> dict[str, Any]:
    return {"info": {"id": f"msg_{number:04d}", "role": role, "sessionID": SESSION}, "parts": parts}


class Engine:
    """The engine's session routes: `GET /session/<id>` and the paged `GET /session/<id>/message`
    (the newest `limit` messages, oldest first, the cursor of the next older page in the
    `x-next-cursor` header)."""

    def __init__(self, messages: list[dict[str, Any]], *, info: Mapping[str, Any] | None = None):
        self.messages = messages
        self.info = dict(info or {"id": SESSION, "title": "Implementer", "version": "1.19.0"})
        self.calls: list[str] = []
        self.timeouts: list[float] = []
        self.status = 200

    def __call__(self, path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        self.calls.append(path)
        self.timeouts.append(timeout)
        if self.status != 200:
            return self.status, {}, b'{"error":"x"}'
        route, _, query = path.partition("?")
        if route == f"/session/{SESSION}":
            return 200, {}, json.dumps(self.info).encode()
        assert route == f"/session/{SESSION}/message"
        arguments = dict(pair.split("=") for pair in query.split("&") if pair)
        limit = int(arguments["limit"])
        end = int(arguments["before"]) if "before" in arguments else len(self.messages)
        start = max(0, end - limit)
        headers = {"x-next-cursor": str(start)} if start > 0 else {}
        return 200, headers, json.dumps(self.messages[start:end]).encode()


def clock_at(*times: float):
    iterator = iter(times)
    last = [0.0]

    def now() -> float:
        last[0] = next(iterator, last[0])
        return last[0]

    return now


def snapshot_of(engine: Engine, **options: Any):
    options.setdefault("redactor", Redactor([SECRET]))
    options.setdefault("seconds", 5.0)
    return take_snapshot(engine, SESSION, **options)


def document_of(snapshot: Any) -> dict[str, Any]:
    return json.loads(gzip.decompress(snapshot.data))


# #839-T01
def test_the_pages_come_back_newest_first_and_the_export_is_in_the_order_of_the_engine() -> None:
    messages = [message(n, [tool_part(n)]) for n in range(120)]
    engine = Engine(messages)

    snapshot = snapshot_of(engine)

    document = document_of(snapshot)
    assert [m["info"]["id"] for m in document["messages"]] == [m["info"]["id"] for m in messages]
    assert document["info"]["id"] == SESSION
    assert snapshot.messages == 120
    # One call for the session, three pages of 50.
    assert len(engine.calls) == 4
    assert all(f"limit={PAGE_SIZE}" in call for call in engine.calls[1:])


# #839-T01
def test_a_session_without_messages_is_an_empty_list() -> None:
    document = document_of(snapshot_of(Engine([])))

    assert document["messages"] == []


# #839-T02
def test_the_redaction_works_on_the_string_values_and_leaves_valid_json() -> None:
    # The `Bearer ...` shape of the redactor runs up to a quote; on the JSON text that would eat the
    # backslash of an escaped quote.
    nasty = 'say "hello" Bearer abc.def and "quoted"'
    messages = [
        message(
            1,
            [
                {"id": "prt_a", "type": "text", "text": f"the key is {SECRET} and {nasty}"},
                tool_part(2, output=f"printed {SECRET}"),
            ],
        )
    ]
    engine = Engine(messages)
    engine.info = {"id": SESSION, "title": f"about {SECRET}"}

    document = document_of(snapshot_of(engine))

    text = document["messages"][0]["parts"][0]["text"]
    assert SECRET not in json.dumps(document)
    assert REDACTED in text
    assert 'say "hello"' in text and 'and "quoted"' in text.replace("Bearer abc.def", "")
    assert document["messages"][0]["parts"][1]["state"]["output"] == f"printed {REDACTED}"
    assert document["info"]["title"] == f"about {REDACTED}"


# #839-T02
def test_a_secret_in_a_key_is_redacted_too() -> None:
    messages = [message(1, [{"id": "prt_a", "type": "text", "text": "x", SECRET: 1}])]

    document = document_of(snapshot_of(Engine(messages)))

    assert SECRET not in json.dumps(document)


# #839-T03
def test_the_output_of_a_compacted_tool_part_and_the_long_strings_of_its_metadata_are_blanked() -> (
    None
):
    long = "m" * 300
    messages = [
        message(
            1,
            [
                tool_part(1, output="O" * 1000, compacted=99, metadata=long),
                tool_part(2, output="live output", metadata=long),
            ],
        )
    ]

    snapshot = snapshot_of(Engine(messages))

    compacted, live = document_of(snapshot)["messages"][0]["parts"]
    assert compacted["state"]["output"] == ""
    assert compacted["state"]["metadata"] == {"output": "", "exit": 0}
    # What the model still reads is left exactly as it was.
    assert live["state"]["output"] == "live output"
    assert live["state"]["metadata"]["output"] == long
    assert compacted["state"]["input"] == {"command": "echo 1"}
    assert compacted["state"]["time"]["compacted"] == 99
    assert snapshot.blanked == 1


# #839-T03
def test_short_metadata_strings_of_a_compacted_part_are_kept() -> None:
    messages = [message(1, [tool_part(1, output="x", compacted=5, metadata="short")])]

    document = document_of(snapshot_of(Engine(messages)))

    assert document["messages"][0]["parts"][0]["state"]["metadata"]["output"] == "short"


# #839-T03
def test_a_compacted_part_without_metadata_stays_without_the_key() -> None:
    part = tool_part(1, output="x", compacted=5)
    del part["state"]["metadata"]

    document = document_of(snapshot_of(Engine([message(1, [part])])))

    state = document["messages"][0]["parts"][0]["state"]
    assert "metadata" not in state
    assert state["output"] == ""


# #839-T03
def test_a_part_that_is_not_a_tool_part_is_never_blanked() -> None:
    messages = [
        message(1, [{"id": "prt_a", "type": "text", "text": "t" * 5000, "time": {"compacted": 1}}])
    ]

    document = document_of(snapshot_of(Engine(messages)))

    assert document["messages"][0]["parts"][0]["text"] == "t" * 5000


# #839-T04
def test_the_snapshot_is_gzipped_compact_json_with_its_sizes_and_checksum() -> None:
    snapshot = snapshot_of(Engine([message(1, [tool_part(1)])]))

    raw = gzip.decompress(snapshot.data)
    assert snapshot.raw_bytes == len(raw)
    assert snapshot.sha256 == hashlib.sha256(snapshot.data).hexdigest()
    assert b": " not in raw and b", " not in raw, "compact separators"
    assert snapshot.data[:2] == b"\x1f\x8b"
    # The same input gives the same bytes (no time in the gzip header).
    assert snapshot_of(Engine([message(1, [tool_part(1)])])).data == snapshot.data


# #839-T04
def test_text_with_a_lone_surrogate_does_not_break_the_dump() -> None:
    engine = Engine([message(1, [{"id": "prt_a", "type": "text", "text": "x"}])])
    engine.messages[0]["parts"][0]["text"] = "broken \ud83d here"

    snapshot = snapshot_of(engine)

    assert json.loads(gzip.decompress(snapshot.data))["messages"][0]["parts"][0]["text"]


# #839-T05
def test_a_snapshot_over_the_cap_is_not_stored() -> None:
    # Random text does not compress: 9 MB of it gzips to more than the cap.
    noise = base64.b64encode(os.urandom(9_000_000)).decode()
    messages = [message(1, [tool_part(1, output=noise)])]

    with pytest.raises(ExportFailed) as caught:
        snapshot_of(Engine(messages))

    assert caught.value.reason is ExportReason.TOO_LARGE
    assert CAP_BYTES == 8 * 1024 * 1024


# #839-T05
def test_a_transcript_whose_compacted_outputs_fit_once_they_are_blanked_is_stored() -> None:
    noise = base64.b64encode(os.urandom(9_000_000)).decode()
    messages = [message(1, [tool_part(1, output=noise, compacted=1), tool_part(2)])]

    snapshot = snapshot_of(Engine(messages))

    assert len(snapshot.data) < CAP_BYTES


# #839-T06
@pytest.mark.parametrize("status", [404, 500, 400])
def test_a_refused_call_is_a_failed_export(status: int) -> None:
    engine = Engine([message(1, [])])
    engine.status = status

    with pytest.raises(ExportFailed) as caught:
        snapshot_of(engine)

    assert caught.value.reason is ExportReason.BAD_ANSWER


# #839-T06
def test_an_answer_that_is_not_json_is_a_failed_export() -> None:
    def broken(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b"<html>"

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(broken, SESSION, redactor=Redactor([]), seconds=5.0)

    assert caught.value.reason is ExportReason.BAD_ANSWER


# #839-T06
def test_an_engine_that_cannot_be_reached_is_a_failed_export() -> None:
    def gone(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        raise ConnectionRefusedError

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(gone, SESSION, redactor=Redactor([]), seconds=5.0)

    assert caught.value.reason is ExportReason.UNREACHABLE


# #839-T06
def test_an_endless_cursor_is_a_failed_export() -> None:
    def looping(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        if "/message" not in path:
            return 200, {}, b"{}"
        return 200, {"x-next-cursor": "1"}, b"[]"

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(looping, SESSION, redactor=Redactor([]), seconds=60.0)

    assert caught.value.reason is ExportReason.BAD_ANSWER


# #839-T07
def test_every_call_gets_the_time_that_is_left_and_the_export_gives_up_when_it_is_gone() -> None:
    engine = Engine([message(n, []) for n in range(200)])

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(
            engine,
            SESSION,
            redactor=Redactor([]),
            seconds=5.0,
            clock=clock_at(100.0, 101.0, 102.5, 106.0),
        )

    assert caught.value.reason is ExportReason.OUT_OF_TIME
    assert all(0 < timeout <= 5.0 for timeout in engine.timeouts)
    assert engine.timeouts[0] == pytest.approx(4.0)
    assert engine.timeouts[1] == pytest.approx(2.5)


# #839-T07
def test_the_transcript_is_read_only_up_to_a_bound_of_memory() -> None:
    page = json.dumps([message(1, [tool_part(1, output="x" * 700_000)])]).encode()
    served = [0]

    def bulky(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        if "/message" not in path:
            return 200, {}, b"{}"
        served[0] += 1
        return 200, {"x-next-cursor": str(served[0])}, page

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(bulky, SESSION, redactor=Redactor([]), seconds=60.0)

    assert caught.value.reason is ExportReason.TOO_LARGE


# -- the production fetch --------------------------------------------------------------------


class EngineServer:
    """A loopback server that plays the engine's two session routes, over one keep-alive
    connection, and remembers what it was asked."""

    def __init__(self, messages: list[dict[str, Any]]) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        outer = self
        engine = Engine(messages)
        self.requests: list[tuple[str, str | None]] = []
        self.connections = 0

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self) -> None:
                super().setup()
                outer.connections += 1

            def do_GET(self) -> None:
                outer.requests.append((self.path, self.headers.get("x-opencode-directory")))
                status, headers, body = engine(self.path, 1.0)
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


# #839-T19
def test_the_production_fetch_scopes_every_call_to_the_directory_over_one_connection() -> None:
    from code_reviewer_runner.implementer.session_export import EngineFetch

    server = EngineServer([message(n, [tool_part(n)]) for n in range(120)])
    fetch = EngineFetch(server.url, "/work/repo")
    try:
        snapshot = take_snapshot(fetch, SESSION, redactor=Redactor([]), seconds=10.0)
    finally:
        fetch.close()
        server.stop()

    assert snapshot.messages == 120
    assert len(server.requests) == 4
    assert {directory for _, directory in server.requests} == {"/work/repo"}
    assert server.connections == 1, "each connection through the tunnel costs an exec"


# #839-T19
def test_the_production_fetch_of_a_dead_engine_is_an_unreachable_engine() -> None:
    from code_reviewer_runner.implementer.session_export import EngineFetch

    server = EngineServer([])
    url = server.url
    server.stop()
    fetch = EngineFetch(url, "/work/repo")

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(fetch, SESSION, redactor=Redactor([]), seconds=5.0)

    assert caught.value.reason is ExportReason.UNREACHABLE


# -- the agent's own call -------------------------------------------------------------------------


def an_agent() -> Any:
    from decimal import Decimal

    from code_reviewer_runner.dynamic_review.budget import BudgetLedger, UnitCosts
    from code_reviewer_runner.implementer.agent import ImplementerAgent
    from code_reviewer_runner.implementer.limits import agent_limits

    return ImplementerAgent(
        ledger=BudgetLedger(
            agent_limits(600.0, Decimal("5"), "cost_limit"),
            unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4)),
        ),
        runtime=None,  # type: ignore[arg-type]  # never used by the export
        command=["opencode"],
        directory="/work/repo",
        make_config=lambda path: {},
        instructions=("instructions.md", "text"),
        environment={},
        model="m",
        provider_id="p",
    )


# #839-T19
def test_the_agent_exports_the_session_it_opened_from_its_engine() -> None:
    from code_reviewer_runner.dynamic_review.adapter import EngineClient

    server = EngineServer([message(n, [tool_part(n, output=f"secret {SECRET}")]) for n in range(3)])
    agent = an_agent()
    agent._client = EngineClient(server.url, "/work/repo")  # pyright: ignore[reportPrivateUsage]
    agent.session_id = SESSION
    try:
        snapshot = agent.export_session(Redactor([SECRET]), 5.0)
    finally:
        server.stop()

    document = document_of(snapshot)
    assert [m["info"]["id"] for m in document["messages"]] == [f"msg_{n:04d}" for n in range(3)]
    assert SECRET not in json.dumps(document)
    assert {directory for _, directory in server.requests} == {"/work/repo"}


# #839-T19
def test_an_agent_without_a_session_has_nothing_to_export() -> None:
    with pytest.raises(ExportFailed) as caught:
        an_agent().export_session(Redactor([]), 5.0)

    assert caught.value.reason is ExportReason.UNREACHABLE


# -- the budget holds against an engine that is not the engine ------------------------------------


class TricklingServer:
    """A loopback server that answers the session and then sends a message page one byte at a
    time (the agent can replace the engine on its port). `closed` is set when the client's end
    goes away."""

    def __init__(self, *, pause: float = 0.1, length: int = 80) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        outer = self
        self.closed = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                body = b"{}" if "/message" not in self.path else b"[" + b" " * (length - 2) + b"]"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if "/message" not in self.path:
                    self.wfile.write(body)
                    return
                try:
                    for index in range(len(body)):
                        self.wfile.write(body[index : index + 1])
                        self.wfile.flush()
                        time.sleep(pause)
                except OSError:
                    outer.closed.set()

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


# #839-T07
def test_an_engine_that_trickles_its_body_costs_the_budget_and_not_more() -> None:
    from code_reviewer_runner.implementer.session_export import EngineFetch

    # 80 bytes at 0.1 s each: 8 s of body, and every read of it is inside the socket timeout.
    server = TricklingServer(pause=0.1, length=80)
    fetch = EngineFetch(server.url, "/work/repo")
    began = time.monotonic()
    try:
        with pytest.raises(ExportFailed) as caught:
            take_snapshot(
                fetch,
                SESSION,
                redactor=Redactor([]),
                seconds=1.0,
                abort=fetch.close,
            )
        elapsed = time.monotonic() - began
        # The connection is closed, so the server sees it go.
        assert server.closed.wait(2.0)
    finally:
        fetch.close()
        server.stop()

    assert caught.value.reason is ExportReason.OUT_OF_TIME
    assert elapsed < 1.5


# #839-T07
def test_the_agent_gives_up_on_a_trickling_engine_within_its_budget() -> None:
    from code_reviewer_runner.dynamic_review.adapter import EngineClient

    server = TricklingServer(pause=0.1, length=80)
    agent = an_agent()
    agent._client = EngineClient(server.url, "/work/repo")  # pyright: ignore[reportPrivateUsage]
    agent.session_id = SESSION
    began = time.monotonic()
    try:
        with pytest.raises(ExportFailed) as caught:
            agent.export_session(Redactor([]), 1.0)
        elapsed = time.monotonic() - began
    finally:
        server.stop()

    assert caught.value.reason is ExportReason.OUT_OF_TIME
    assert elapsed < 1.5


# #839-T07
def test_the_export_leaves_no_thread_behind_when_it_finishes() -> None:
    import threading

    before = {t.ident for t in threading.enumerate()}
    snapshot_of(Engine([message(1, [tool_part(1)])]))

    assert {t.ident for t in threading.enumerate()} <= before


# #839-T07
def test_a_slow_computation_is_given_up_on_at_the_deadline_and_stops() -> None:
    # The redactor is the slow part here: the budget is held while it works, and it is told to stop.
    release = threading.Event()
    calls = [0]

    class Slow(Redactor):
        def redact(self, text: str) -> str:
            calls[0] += 1
            release.wait(5.0)
            return text

    began = time.monotonic()
    with pytest.raises(ExportFailed) as caught:
        snapshot_of(Engine([message(1, [tool_part(1)])]), redactor=Slow([]), seconds=0.3)
    elapsed = time.monotonic() - began
    at_deadline = calls[0]
    release.set()

    assert caught.value.reason is ExportReason.OUT_OF_TIME
    assert elapsed < 1.0
    # The thread really ends once the call it was in returns, and starts no other.
    for worker in [t for t in threading.enumerate() if t.name == "session-export"]:
        worker.join(2.0)
        assert not worker.is_alive()
    assert calls[0] == at_deadline


# -- a document made to be expensive ----------------------------------------------------------


def hostile_page(strings: int) -> bytes:
    """One page that is a message whose single text part holds `strings` tiny strings."""
    body = ",".join(['""'] * strings)
    return (
        '[{"info":{"id":"msg_1","role":"assistant"},"parts":[{"id":"p","type":"text","x":['
        + body
        + "]}]}]"
    ).encode()


# #839-T07
def test_a_document_of_millions_of_tiny_strings_is_refused_before_it_is_parsed() -> None:
    import tracemalloc

    page = hostile_page(7_500_000)
    assert len(page) < MAX_RAW_BYTES

    def hostile(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b"{}" if "/message" not in path else page

    tracemalloc.start()
    began = time.monotonic()
    try:
        with pytest.raises(ExportFailed) as caught:
            take_snapshot(hostile, SESSION, redactor=Redactor([]), seconds=30.0)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    elapsed = time.monotonic() - began

    assert caught.value.reason is ExportReason.TOO_LARGE
    assert elapsed < 2.0
    # Nothing of the document was built: far less than the 680 MB it took to process.
    assert peak < 64 * 1024 * 1024


# #839-T07
def test_a_document_nested_deeper_than_any_transcript_is_refused() -> None:
    deep = b"[" * 200 + b"]" * 200
    page = b'[{"info":{"id":"m"},"parts":[{"type":"text","x":' + deep + b"}]}]"

    def hostile(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b"{}" if "/message" not in path else page

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(hostile, SESSION, redactor=Redactor([]), seconds=10.0)

    assert caught.value.reason is ExportReason.TOO_LARGE


# #839-T07
def test_a_document_nested_past_the_parsers_own_limit_is_a_bad_answer() -> None:
    page = b"[" * 200_000 + b"]" * 200_000

    def hostile(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b"{}" if "/message" not in path else page

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(hostile, SESSION, redactor=Redactor([]), seconds=10.0)

    assert caught.value.reason in (ExportReason.BAD_ANSWER, ExportReason.TOO_LARGE)


# #839-T07
@pytest.mark.parametrize(("extra", "reason"), [(0, None), (1, ExportReason.TOO_LARGE)])
def test_the_depth_cap_lets_exactly_max_depth_levels_through(
    extra: int, reason: ExportReason | None
) -> None:
    # The document, its messages, a message, its parts and a part are five levels already.
    levels = MAX_DEPTH - 5 + extra
    page = (
        b'[{"info":{"id":"m"},"parts":[{"type":"text","x":'
        + b"[" * levels
        + b"]" * levels
        + b"}]}]"
    )

    def deep(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b"{}" if "/message" not in path else page

    if reason is None:
        assert document_of(take_snapshot(deep, SESSION, redactor=Redactor([]), seconds=10.0))
        return
    with pytest.raises(ExportFailed) as caught:
        take_snapshot(deep, SESSION, redactor=Redactor([]), seconds=10.0)
    assert caught.value.reason is reason


# #839-T07
def test_a_session_record_over_its_own_limit_is_refused_without_parsing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parsed: list[int] = []
    real = json.loads

    def spy(text: Any, *args: Any, **kwargs: Any) -> Any:
        parsed.append(len(text))
        return real(text, *args, **kwargs)

    monkeypatch.setattr(json, "loads", spy)
    # Far below the 64 MiB of the messages, far over what a session record is: 700k empty lists.
    info = b"[" + b",".join([b"[]"] * 700_000) + b"]"
    assert MAX_INFO_BYTES < len(info) < MAX_RAW_BYTES

    def hostile(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, info if "/message" not in path else b"[]"

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(hostile, SESSION, redactor=Redactor([]), seconds=10.0)

    assert caught.value.reason is ExportReason.TOO_LARGE
    assert parsed == []


# #839-T07
def test_the_elements_of_the_session_record_are_counted_before_it_is_parsed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from code_reviewer_runner.implementer import session_export

    parsed: list[int] = []
    real = json.loads

    def spy(text: Any, *args: Any, **kwargs: Any) -> Any:
        parsed.append(len(text))
        return real(text, *args, **kwargs)

    monkeypatch.setattr(json, "loads", spy)
    monkeypatch.setattr(session_export, "MAX_NODES", 2)

    def hostile(path: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b"[1,2,3]" if "/message" not in path else b"[]"

    with pytest.raises(ExportFailed) as caught:
        take_snapshot(hostile, SESSION, redactor=Redactor([]), seconds=10.0)

    assert caught.value.reason is ExportReason.TOO_LARGE
    assert parsed == []


# #839-T07
def test_a_document_cut_at_the_limit_of_the_production_fetch_is_too_large(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from code_reviewer_runner.implementer import session_export
    from code_reviewer_runner.implementer.session_export import EngineFetch

    monkeypatch.setattr(session_export, "MAX_RAW_BYTES", 4000)
    server = EngineServer([message(n, [tool_part(n, output="x" * 500)]) for n in range(20)])
    fetch = EngineFetch(server.url, "/work/repo", limit=4000)
    try:
        with pytest.raises(ExportFailed) as caught:
            take_snapshot(fetch, SESSION, redactor=Redactor([]), seconds=10.0)
    finally:
        fetch.close()
        server.stop()

    assert caught.value.reason is ExportReason.TOO_LARGE


# #839-T07
def test_a_close_between_the_lock_and_the_request_sends_nothing_to_the_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import http.client

    from code_reviewer_runner.implementer.session_export import EngineFetch

    server = EngineServer([])
    fetch = EngineFetch(server.url, "/work/repo")
    original = http.client.HTTPConnection.request

    def closed_in_the_window(self: http.client.HTTPConnection, *args: Any, **kwargs: Any) -> None:
        fetch.close()
        original(self, *args, **kwargs)

    monkeypatch.setattr(http.client.HTTPConnection, "request", closed_in_the_window)
    try:
        with pytest.raises((OSError, http.client.HTTPException)):
            fetch(f"/session/{SESSION}", 2.0)
        time.sleep(0.2)
        assert server.requests == []
        assert server.connections <= 1
    finally:
        fetch.close()
        server.stop()


# #839-T07
def test_the_production_fetch_stops_reading_past_its_limit_across_all_calls() -> None:
    from code_reviewer_runner.implementer.session_export import EngineFetch

    server = EngineServer([message(1, [tool_part(1, output="x" * 5000)])])
    fetch = EngineFetch(server.url, "/work/repo", limit=1000)
    try:
        first = fetch(f"/session/{SESSION}", 2.0)
        second = fetch(f"/session/{SESSION}/message?limit=50", 2.0)
    finally:
        fetch.close()
        server.stop()

    assert 0 < len(first[2]) < 200
    # What the first call read counts for the second: one byte past what is left of the limit,
    # which is what says the document is too large.
    assert len(second[2]) == 1000 - len(first[2]) + 1


# -- tool metadata that nests its copies of the content -------------------------------------


def edit_part(number: int, size: int, *, compacted: int | None) -> dict[str, Any]:
    """An edit tool part the way the engine reports one: the diff and, nested in the metadata, the
    whole file before and after."""
    part = tool_part(number, output="Edit applied", compacted=compacted)
    part["tool"] = "edit"
    part["state"]["input"] = {"filePath": f"/work/f{number}.py", "oldString": "a", "newString": "b"}
    part["state"]["metadata"] = {
        "diff": "d" * size,
        "filediff": {
            "file": f"/work/f{number}.py",
            "before": "b" * size,
            "after": "a" * size,
            "additions": 1,
            "deletions": 1,
        },
        "files": [{"relativePath": "f.py", "before": "x" * size, "after": "y" * size}],
        "diagnostics": {},
    }
    return part


# #839-T03
def test_the_long_strings_nested_in_the_metadata_of_a_compacted_part_are_blanked_too() -> None:
    messages = [message(1, [edit_part(1, 5000, compacted=7), edit_part(2, 5000, compacted=None)])]

    document = document_of(snapshot_of(Engine(messages)))

    compacted, live = document["messages"][0]["parts"]
    found = compacted["state"]["metadata"]
    assert found["diff"] == ""
    assert found["filediff"] == {
        "file": "/work/f1.py",
        "before": "",
        "after": "",
        "additions": 1,
        "deletions": 1,
    }
    assert found["files"] == [{"relativePath": "f.py", "before": "", "after": ""}]
    # The short strings and the shape stay; the input the model is sent is untouched.
    assert found["diagnostics"] == {}
    assert compacted["state"]["input"]["filePath"] == "/work/f1.py"
    # A part the model still reads in full is not changed.
    assert live["state"]["metadata"]["filediff"]["before"] == "b" * 5000


# #839-T05
def test_an_edit_heavy_session_stays_well_under_the_cap_once_its_old_diffs_are_blanked() -> None:
    # 300 edits of 30 KB files, random so that gzip does not help: 36 MB of metadata, far over
    # the cap of what is stored, and inside what the export reads.
    noise = base64.b64encode(os.urandom(30_000)).decode()
    parts: list[dict[str, Any]] = []
    for number in range(300):
        part = edit_part(number, 0, compacted=number + 1 if number < 290 else None)
        part["state"]["metadata"]["filediff"]["before"] = noise
        part["state"]["metadata"]["filediff"]["after"] = noise
        part["state"]["metadata"]["diff"] = noise
        parts.append(part)
    messages = [message(n, parts[n * 10 : n * 10 + 10]) for n in range(30)]

    snapshot = snapshot_of(Engine(messages))

    assert snapshot.blanked == 290
    # Only the ten edits the model still reads in full are left at size: 3 copies of 40 KB each.
    assert snapshot.raw_bytes < 3 * 1024 * 1024
    assert len(snapshot.data) < CAP_BYTES // 4
