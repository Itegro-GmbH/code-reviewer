# SPDX-License-Identifier: LicenseRef-Proprietary

"""The canned model of the self-test (#854, R1b): the one wire format the engine needs, with a
stream and without."""

import json
import threading
import urllib.request
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner import canned_provider
from code_reviewer_runner.factory_runner.canned_provider import ANSWER, USAGE, Handler

pytestmark = pytest.mark.unit


@pytest.fixture
def url() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions"
    server.shutdown()
    server.server_close()


def post(url: str, body: dict[str, object]) -> tuple[str, bytes]:
    request = urllib.request.Request(
        url, json.dumps(body).encode(), {"content-type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.headers["content-type"], response.read()


def test_a_request_without_a_stream_is_answered_with_a_whole_completion(url: str) -> None:
    kind, body = post(url, {"model": "canned", "messages": []})

    assert kind == "application/json"
    answer = json.loads(body)
    assert answer["choices"][0]["message"]["content"] == ANSWER
    assert answer["choices"][0]["finish_reason"] == "stop"
    assert answer["usage"] == USAGE


def test_a_request_with_a_stream_gets_the_words_then_the_usage_then_done(url: str) -> None:
    kind, body = post(url, {"model": "canned", "stream": True, "messages": []})

    assert kind == "text/event-stream"
    events = [line[6:] for line in body.decode().splitlines() if line.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(event) for event in events[:-1]]
    assert "".join(c["choices"][0]["delta"].get("content", "") for c in chunks) == ANSWER
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert chunks[-1]["usage"] == USAGE


def test_the_module_is_standard_library_only_so_that_the_agent_image_can_run_it() -> None:
    source = Path(canned_provider.__file__).read_text(encoding="utf-8")
    imports = {
        line.split()[1].split(".")[0]
        for line in source.splitlines()
        if line.startswith(("import ", "from "))
    }

    assert imports <= {"json", "sys", "typing", "http"}
