# SPDX-License-Identifier: LicenseRef-Proprietary

"""A canned model for the runner's self-test (#854, R1b): `python3 canned_provider.py <port>`.

It speaks the one wire format the engine's `@ai-sdk/openai-compatible` provider needs, an
OpenAI-style chat completion with or without a stream, and answers every request with the same
words. The self-test copies this very file into the agent's container (the image has Python) and
runs the pinned OpenCode against it there, so the turn needs no network, no key and no model. It
lives in the product because the self-test runs on a customer's machine, where the fakes of the
repository are not.

Standard library only; it listens on the loopback and logs nothing.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast

ANSWER = "SELFTEST-OK"
USAGE = {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
_CHUNK = {"id": "canned-1", "object": "chat.completion.chunk", "created": 1, "model": "canned"}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0") or 0)
        try:
            body: object = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        if isinstance(body, dict) and cast("dict[str, object]", body).get("stream"):
            self._stream()
        else:
            self._whole()

    def _whole(self) -> None:
        payload = json.dumps(
            {
                "id": "canned-1",
                "object": "chat.completion",
                "created": 1,
                "model": "canned",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": ANSWER},
                        "finish_reason": "stop",
                    }
                ],
                "usage": USAGE,
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _stream(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        deltas: list[tuple[dict[str, object], str | None, dict[str, int] | None]] = [
            ({"role": "assistant", "content": ""}, None, None),
            ({"content": ANSWER}, None, None),
            ({}, "stop", USAGE),
        ]
        for delta, reason, usage in deltas:
            chunk: dict[str, object] = {
                **_CHUNK,
                "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
            }
            if usage is not None:
                chunk["usage"] = usage
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


def serve(port: int) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), _Handler).serve_forever()


if __name__ == "__main__":
    serve(int(sys.argv[1]))
