# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1158: on the Cloudflare placement the outbound handler terminates TLS for every request of the
VM, so every container Control makes in the VM (the doors, the readers, the setup and agent
container) has to trust that authority. The Dispatcher binds the VM's bundle into Control's own
container; Control binds the same file, read-only, into every container it creates and sets the
variables that make the tools read it. Without the file (every other placement) nothing changes."""

import json
import socketserver
import threading
from collections.abc import Generator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.intercept_ca import (
    INTERCEPT_CA_BUNDLE,
    INTERCEPT_CA_VARIABLES,
    system_roots,
    with_intercept_ca,
)

BUNDLE = "/etc/cr-sandbox/ca-bundle.crt"


# #1158-R01
def test_the_bundle_is_the_one_path_the_dispatcher_mounts() -> None:
    assert INTERCEPT_CA_BUNDLE == BUNDLE
    assert set(INTERCEPT_CA_VARIABLES) == {
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "NODE_EXTRA_CA_CERTS",
        "GIT_SSL_CAINFO",
    }


# #1158-R02
def test_a_document_gets_the_bundle_read_only_at_the_same_path_and_the_five_variables(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "ca-bundle.crt"
    bundle.write_text("roots")
    document: dict[str, Any] = {
        "Image": "x",
        "Env": ["HOME=/home/runner"],
        "HostConfig": {"Binds": ["/a:/b:ro"], "Memory": 1},
    }

    result = with_intercept_ca(document, path=str(bundle))

    assert result["HostConfig"]["Binds"] == ["/a:/b:ro", f"{bundle}:{bundle}:ro"]
    assert result["HostConfig"]["Memory"] == 1
    assert "HOME=/home/runner" in result["Env"]
    for name in INTERCEPT_CA_VARIABLES:
        assert f"{name}={bundle}" in result["Env"]
    # The caller's document is not changed.
    assert document["HostConfig"]["Binds"] == ["/a:/b:ro"]
    assert document["Env"] == ["HOME=/home/runner"]


# #1158-R03
def test_a_document_without_binds_or_env_gets_them(tmp_path: Path) -> None:
    bundle = tmp_path / "ca-bundle.crt"
    bundle.write_text("roots")

    result = with_intercept_ca({"Image": "x"}, path=str(bundle))

    assert result["HostConfig"]["Binds"] == [f"{bundle}:{bundle}:ro"]
    assert len(result["Env"]) == len(INTERCEPT_CA_VARIABLES)


# #1158-R04
def test_a_variable_the_document_sets_itself_is_kept(tmp_path: Path) -> None:
    bundle = tmp_path / "ca-bundle.crt"
    bundle.write_text("roots")

    result = with_intercept_ca(
        {"Image": "x", "Env": ["SSL_CERT_FILE=/agent/bundle.pem"]}, path=str(bundle)
    )

    assert [e for e in result["Env"] if e.startswith("SSL_CERT_FILE=")] == [
        "SSL_CERT_FILE=/agent/bundle.pem"
    ]
    assert f"REQUESTS_CA_BUNDLE={bundle}" in result["Env"]


# #1158-R05
def test_without_the_file_the_document_is_untouched(tmp_path: Path) -> None:
    document: dict[str, Any] = {"Image": "x", "Env": ["A=1"], "HostConfig": {"Binds": []}}

    assert with_intercept_ca(document, path=str(tmp_path / "none.crt")) == document


# #1158-R06
def test_the_system_roots_are_the_bundle_when_it_is_there_and_the_images_own_otherwise(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "ca-bundle.crt"
    bundle.write_bytes(b"roots and the handler")
    own = tmp_path / "own.crt"
    own.write_bytes(b"images roots")

    assert system_roots(path=str(bundle), fallback=str(own)) == b"roots and the handler"
    assert system_roots(path=str(tmp_path / "none"), fallback=str(own)) == b"images roots"


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


@contextmanager
def daemon(tmp_path: Path) -> Generator[tuple[DockerApi, list[dict[str, Any]]]]:
    seen: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            seen.append(json.loads(body))
            payload = json.dumps({"Id": "abc"}).encode()
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            return

    path = str(tmp_path / "docker.sock")
    server = _Server(path, Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield DockerApi(path), seen
    finally:
        server.shutdown()
        server.server_close()


# #1158-R07
def test_create_container_sends_the_document_unchanged_where_there_is_no_bundle(
    tmp_path: Path,
) -> None:
    with daemon(tmp_path) as (api, seen):
        api.create_container({"Image": "x", "Env": ["A=1"]}, "name")

    # The test host has no /etc/cr-sandbox: the one place the bundle is looked for.
    assert seen == [{"Image": "x", "Env": ["A=1"]}]


# #1158-R08
def test_create_container_adds_the_bundle_when_the_api_was_told_where_it_is(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "ca-bundle.crt"
    bundle.write_text("roots")
    with daemon(tmp_path) as (api, seen):
        api.intercept_ca_path = str(bundle)
        api.create_container({"Image": "x"}, "name")

    assert seen[0]["HostConfig"]["Binds"] == [f"{bundle}:{bundle}:ro"]
