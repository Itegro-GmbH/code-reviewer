# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: `DockerApi.build_image`, the call that builds the Claude Code layer on the device: a tar
as the body, a stream of JSON lines back in which an `error` line is a failed build although the
status is 200. Against a small daemon on a Unix socket."""

import json
import socketserver
import threading
from collections.abc import Generator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError

CONTEXT = b"not really a tar, the daemon of this test does not look"


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


@contextmanager
def daemon(
    tmp_path: Path, status: int, lines: list[dict[str, str]]
) -> Generator[tuple[DockerApi, list[tuple[str, str, bytes]]]]:
    seen: list[tuple[str, str, bytes]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            seen.append((self.path, self.headers.get("Content-Type", ""), body))
            payload = "".join(json.dumps(line) + "\r\n" for line in lines).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            return

    path = str(tmp_path / "docker.sock")
    server = _Server(path, Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield DockerApi(path), seen
    finally:
        server.shutdown()
        server.server_close()


# #856-T17
def test_a_build_sends_the_tar_with_the_tag_and_does_not_pull_or_keep_leftovers(
    tmp_path: Path,
) -> None:
    with daemon(tmp_path, 200, [{"stream": "Step 1/2"}, {"aux": "x"}]) as (api, seen):
        api.build_image(CONTEXT, "code-reviewer-agent-claude-code:2.1.311-abc", timeout=5)

    [(path, kind, body)] = seen
    assert path.startswith("/build?")
    for part in ("t=code-reviewer-agent-claude-code%3A2.1.311-abc", "rm=1", "forcerm=1", "pull=0"):
        assert part in path
    assert kind == "application/x-tar" and body == CONTEXT


# #856-T17
def test_an_error_line_in_the_stream_is_a_failed_build_with_its_text(tmp_path: Path) -> None:
    lines = [{"stream": "Step 2/2"}, {"error": "npm error 404 not found"}]
    with daemon(tmp_path, 200, lines) as (api, _), pytest.raises(DockerError) as failed:
        api.build_image(CONTEXT, "x:y", timeout=5)

    assert "npm error 404" in failed.value.message


# #856-T17
def test_a_status_other_than_200_is_a_failed_build(tmp_path: Path) -> None:
    with (
        daemon(tmp_path, 500, [{"message": "the daemon is unwell"}]) as (api, _),
        pytest.raises(DockerError) as failed,
    ):
        api.build_image(CONTEXT, "x:y", timeout=5)

    assert failed.value.status == 500


# #856-T17
def test_a_tag_that_is_not_a_plain_name_is_refused_before_a_call(tmp_path: Path) -> None:
    with daemon(tmp_path, 200, []) as (api, seen):
        for bad in ("x y", "x&rm=0", "../x", ""):
            with pytest.raises(ValueError):
                api.build_image(CONTEXT, bad, timeout=5)

    assert seen == []
