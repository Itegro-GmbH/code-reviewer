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
from collections.abc import Mapping
from typing import Any

import pytest

from code_reviewer_runner.implementer.session_export import (
    CAP_BYTES,
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
