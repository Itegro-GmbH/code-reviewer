# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer's git through the outer wall's proxy (#994): the clone, the fetch and the push of
a VM on a customer's machine ask the proxy for a tunnel and go nowhere else. Real `git`, a loopback
stand-in for the proxy and a loopback "origin" that must never be dialled when the proxy refuses."""

import shutil
import socket
import threading
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.git_process import (
    TRUSTED_PATH,
    GitProcess,
    basic_authorization,
    token_environment,
)
from code_reviewer_runner.implementer.git_workspace import (
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.outer_proxy import OuterProxy
from workspace_support import LocalAccess

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")

TOKEN = "ghs_secret-token-0123456789"


class Listener:
    """A loopback listener that records the head of what each connection sends and answers with
    `answer` (None: nothing)."""

    def __init__(self, answer: bytes | None) -> None:
        self.answer = answer
        self.heads: list[bytes] = []
        self.connections = 0
        self._socket = socket.socket()
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(8)
        threading.Thread(target=self._serve, daemon=True).start()

    @property
    def port(self) -> int:
        return int(self._socket.getsockname()[1])

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self._socket.accept()
            except OSError:
                return
            self.connections += 1
            with connection:
                connection.settimeout(2)
                data = b""
                try:
                    while b"\r\n\r\n" not in data:
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    self.heads.append(data)
                    if self.answer is not None:
                        connection.sendall(self.answer)
                except OSError:
                    pass

    def close(self) -> None:
        self._socket.close()


@contextmanager
def listener(answer: bytes | None = None) -> Generator[Listener]:
    found = Listener(answer)
    try:
        yield found
    finally:
        found.close()


REFUSED = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


def git_in(tmp_path: Path) -> GitProcess:
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    return GitProcess(shutil.which("git") or "git", TRUSTED_PATH, home, TOKEN)


def ls_remote(tmp_path: Path, url: str, proxy: str | None) -> tuple[int, str]:
    process = git_in(tmp_path)
    environment = {**process.base_environment("https"), **token_environment(TOKEN, proxy=proxy)}
    done = process.run(["ls-remote", url], env=environment, cwd=tmp_path, timeout=20)
    return done.returncode, done.stderr


# #994-T03
def test_without_a_proxy_the_environment_is_what_it_was() -> None:
    environment = token_environment(TOKEN)

    assert environment["GIT_CONFIG_COUNT"] == "3"
    assert "http.proxy" not in environment.values()


# #994-T01
def test_with_a_proxy_git_is_configured_to_use_it_and_nothing_else_changes() -> None:
    plain = token_environment(TOKEN)
    proxied = token_environment(TOKEN, proxy="http://172.31.0.1:3128")

    assert proxied["GIT_CONFIG_COUNT"] == "4"
    assert {k: v for k, v in proxied.items() if k in plain and k != "GIT_CONFIG_COUNT"} == {
        k: v for k, v in plain.items() if k != "GIT_CONFIG_COUNT"
    }
    assert proxied["GIT_CONFIG_KEY_3"] == "http.proxy"
    assert proxied["GIT_CONFIG_VALUE_3"] == "http://172.31.0.1:3128"
    assert proxied["GIT_CONFIG_VALUE_1"] == "false"  # redirects are still not followed


# #994-T01
def test_git_asks_the_proxy_for_a_tunnel_to_the_provider_and_never_sends_it_the_token(
    tmp_path: Path,
) -> None:
    with listener(REFUSED) as proxy:
        code, _ = ls_remote(
            tmp_path,
            "https://git.example.invalid/acme/widgets.git",
            f"http://127.0.0.1:{proxy.port}",
        )

    assert code != 0
    assert [head.split(b"\r\n")[0] for head in proxy.heads] == [
        b"CONNECT git.example.invalid:443 HTTP/1.1"
    ]
    everything = b"".join(proxy.heads)
    assert TOKEN.encode() not in everything
    assert basic_authorization(TOKEN).split()[1].encode() not in everything


# #994-T04
def test_a_proxy_that_refuses_the_tunnel_ends_the_command_and_the_origin_is_never_dialled(
    tmp_path: Path,
) -> None:
    with listener(REFUSED) as proxy, listener(None) as origin:
        code, stderr = ls_remote(
            tmp_path,
            f"https://127.0.0.1:{origin.port}/acme/widgets.git",
            f"http://127.0.0.1:{proxy.port}",
        )

    assert code != 0
    assert "403" in stderr or "tunnel" in stderr.lower() or "proxy" in stderr.lower(), stderr
    assert origin.connections == 0
    assert len(proxy.heads) >= 1


# #994-T04
def test_a_proxy_that_is_not_there_ends_the_command_and_the_origin_is_never_dialled(
    tmp_path: Path,
) -> None:
    gone = socket.socket()
    gone.bind(("127.0.0.1", 0))
    port = gone.getsockname()[1]
    gone.close()
    with listener(None) as origin:
        code, _ = ls_remote(
            tmp_path,
            f"https://127.0.0.1:{origin.port}/acme/widgets.git",
            f"http://127.0.0.1:{port}",
        )

    assert code != 0
    assert origin.connections == 0


# #994-T04
@pytest.mark.parametrize("variable", ["no_proxy", "NO_PROXY", "https_proxy", "all_proxy"])
def test_the_ambient_environment_cannot_take_the_command_around_the_proxy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, variable: str
) -> None:
    # The runner's own environment is not git's: the closed environment never inherits it.
    monkeypatch.setenv(variable, "*" if variable.startswith("no") else "http://127.0.0.1:9")
    with listener(REFUSED) as proxy, listener(None) as origin:
        code, _ = ls_remote(
            tmp_path,
            f"https://127.0.0.1:{origin.port}/acme/widgets.git",
            f"http://127.0.0.1:{proxy.port}",
        )

    assert code != 0
    assert origin.connections == 0
    assert len(proxy.heads) >= 1


def workspace(tmp_path: Path, proxy: OuterProxy | None) -> GitWorkspace:
    layout = WorkspaceLayout(work_dir=tmp_path / "work", run_dir=tmp_path / "run")
    return GitWorkspace(
        WorkspaceSpec(
            clone_url="https://github.com/acme/widgets.git",
            token=TOKEN,
            base_branch="main",
            branch="implementer/a1",
        ),
        layout,
        GitIdentity("Implementer", "i@example.invalid"),
        LocalAccess(layout.work_dir / "repo", "git", tmp_path),
        proxy=proxy,
    )


# #994-T01
def test_the_workspace_hands_the_proxy_to_every_command_that_talks_to_the_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[dict[str, str]] = []

    def run(self: GitProcess, args: object, *, env: dict[str, str], **_: object) -> object:
        seen.append(dict(env))
        from code_reviewer_runner.implementer.git_process import Outcome

        return Outcome(1, "", "stop here")

    monkeypatch.setattr(GitProcess, "run", run)
    proxied = workspace(tmp_path, OuterProxy("172.31.0.1", 3128))
    plain = workspace(tmp_path, None)

    for each in (proxied, plain):
        mirror = each._mirror  # pyright: ignore[reportPrivateUsage]
        mirror(["fetch", "https://github.com/acme/widgets.git"], protocols="https", token=True)
        mirror(["gc"], protocols="file")

    with_proxy, local_with, without_proxy, local_without = seen
    values = set(with_proxy.values())
    assert "http.proxy" in values and "http://172.31.0.1:3128" in values
    assert "http.proxy" not in set(without_proxy.values())
    # A command that does not talk to the provider has neither the token nor the proxy.
    assert not any("http.proxy" in v or "Authorization" in v for v in local_with.values())
    assert not any("http.proxy" in v or "Authorization" in v for v in local_without.values())
