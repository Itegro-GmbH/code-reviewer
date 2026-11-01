# SPDX-License-Identifier: LicenseRef-Proprietary

"""Helpers of the Implementer's git workspace tests (#762); not a test file.

* `guard_directory` builds the directory the image has at /opt/code-reviewer/guard from the hook and
  the matrix of the repository (#761). A repository without them fails the test with the reason: the
  guard tests never skip.
* `Origin` is a bare repository standing in for GitHub, on the file system.
* `HttpOrigin` serves such a repository over HTTP on loopback with `git http-backend`, and answers
  only a request that carries the `Authorization` header a token makes: the way the clone and the
  push of the workspace reach GitHub, with a held request so the tests can look at the live process.
"""

import base64
import gzip
import http.server
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "runner" / "guard" / "reference-transaction"
MATRIX = ROOT / "runner" / "scripts" / "guard_matrix.sh"
MIN_GIT = (2, 53)
TOKEN = "ghs_dummy-installation-token-0123456789"


def git_version(executable: str) -> tuple[int, ...]:
    out = subprocess.run([executable, "--version"], capture_output=True, text=True, check=True)
    found = re.search(r"git version (\d+(?:\.\d+)*)", out.stdout)
    assert found is not None, out.stdout
    return tuple(int(part) for part in found.group(1).split("."))


def guard_git() -> str:
    """The git the guard tests run: 2.53 or newer, or the test fails (older git is blind to a
    branch switch, so a guard test on it would prove nothing)."""
    executable = shutil.which("git")
    assert executable is not None, "git is not installed"
    version = git_version(executable)
    if version < MIN_GIT:
        pytest.fail(
            f"git {'.'.join(map(str, version))} at {executable} is older than 2.53: the branch "
            "guard cannot be proven on it. Put a git 2.53 or newer first on PATH."
        )
    return executable


def guard_directory(target: Path) -> Path:
    """The guard files as the image has them: the hook and the matrix side by side, root-style."""
    for source in (HOOK, MATRIX):
        if not source.is_file():
            pytest.fail(
                f"{source.relative_to(ROOT)} is missing: the guard files arrive with the worker "
                "image change (#761)"
            )
    target.mkdir(parents=True, exist_ok=True)
    for source in (HOOK, MATRIX):
        destination = target / source.name
        shutil.copyfile(source, destination)
        destination.chmod(0o755)
    return target


def raw(*args: str, cwd: Path | None = None, git: str = "git", **env: str) -> str:
    """Plain git with no system config and no hook: the set-up of the tests, never the agent."""
    full = {
        "PATH": os.environ["PATH"],
        "HOME": str(cwd or Path("/")),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_AUTHOR_NAME": "Seed",
        "GIT_AUTHOR_EMAIL": "seed@example.invalid",
        "GIT_COMMITTER_NAME": "Seed",
        "GIT_COMMITTER_EMAIL": "seed@example.invalid",
        **env,
    }
    done = subprocess.run(
        [git, *args], cwd=cwd, env=full, capture_output=True, text=True, check=False
    )
    assert done.returncode == 0, f"git {' '.join(args)}: {done.stderr}"
    return done.stdout.strip()


class Origin:
    """A bare repository with a `main` branch, standing in for the repository on GitHub."""

    def __init__(self, base: Path, git: str = "git") -> None:
        self.path = base / "origin.git"
        self.git = git
        raw("init", "-q", "--bare", "--initial-branch=main", str(self.path), git=git)
        seed = base / "seed"
        raw("clone", "-q", str(self.path), str(seed), git=git)
        raw("checkout", "-q", "-b", "main", cwd=seed, git=git)
        (seed / "README.md").write_text("# demo\n")
        raw("add", "-A", cwd=seed, git=git)
        raw("commit", "-qm", "first", cwd=seed, git=git)
        (seed / "src").mkdir()
        (seed / "src" / "app.py").write_text("print('hi')\n")
        raw("add", "-A", cwd=seed, git=git)
        raw("commit", "-qm", "second", cwd=seed, git=git)
        raw("push", "-q", "origin", "main", cwd=seed, git=git)
        self.seed = seed

    @property
    def url(self) -> str:
        return f"file://{self.path}"

    def tip(self, branch: str = "main") -> str | None:
        done = subprocess.run(
            [
                self.git,
                "--git-dir",
                str(self.path),
                "rev-parse",
                "-q",
                "--verify",
                f"refs/heads/{branch}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return done.stdout.strip() or None

    def commit_on(self, branch: str, name: str, content: str = "x\n") -> str:
        """A commit on a branch made in the seed clone and pushed (what someone else did)."""
        if self.tip(branch) is None:
            raw("checkout", "-q", "-b", branch, "main", cwd=self.seed, git=self.git)
        else:
            raw("fetch", "-q", "origin", cwd=self.seed, git=self.git)
            raw("checkout", "-q", "-B", branch, f"origin/{branch}", cwd=self.seed, git=self.git)
        (self.seed / name).write_text(content)
        raw("add", "-A", cwd=self.seed, git=self.git)
        raw("commit", "-qm", f"other {name}", cwd=self.seed, git=self.git)
        raw("push", "-q", "origin", branch, cwd=self.seed, git=self.git)
        sha = raw("rev-parse", "HEAD", cwd=self.seed, git=self.git)
        raw("checkout", "-q", "main", cwd=self.seed, git=self.git)
        return sha

    def reject_with_hook(self, text: str) -> None:
        """A pre-receive hook that refuses every push with this message (GitHub's own refusals)."""
        hook = self.path / "hooks" / "pre-receive"
        hook.parent.mkdir(exist_ok=True)
        hook.write_text(f"#!/bin/sh\necho '{text}' >&2\nexit 1\n")
        hook.chmod(0o755)


def basic(token: str) -> str:
    return "Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()


class HttpOrigin:
    """`git http-backend` on loopback behind a check of the Authorization header.

    `hold()` makes the next request wait until `release()`, with `arrived` set: the clone or the
    push is then a live process the test can look at.
    """

    def __init__(self, origin: Origin, token: str, git: str) -> None:
        self.origin = origin
        self.token = token
        self.git = git
        self.requests: list[tuple[str, str | None]] = []
        self.arrived = threading.Event()
        self._release = threading.Event()
        self._release.set()
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:
                return

            def _serve(self) -> None:
                header = self.headers.get("Authorization")
                outer.requests.append((self.path.split("?")[0], header))
                if not outer._release.is_set():
                    outer.arrived.set()
                    outer._release.wait(30)
                if header != basic(outer.token):
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="git"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = self._body()
                path, _, query = self.path.partition("?")
                env = {
                    "PATH": os.environ["PATH"],
                    "GIT_HTTP_EXPORT_ALL": "1",
                    "GIT_PROJECT_ROOT": str(outer.origin.path.parent),
                    "PATH_INFO": path,
                    "QUERY_STRING": query,
                    "REQUEST_METHOD": self.command,
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": str(len(body)),
                    "REMOTE_USER": "x-access-token",
                    "REMOTE_ADDR": "127.0.0.1",
                    "GIT_PROTOCOL": self.headers.get("Git-Protocol", ""),
                    "HOME": str(outer.origin.path.parent),
                    "GIT_CONFIG_NOSYSTEM": "1",
                }
                done = subprocess.run(
                    [outer.git, "http-backend"],
                    input=body,
                    env=env,
                    capture_output=True,
                    check=False,
                )
                head, _, payload = done.stdout.partition(b"\r\n\r\n")
                status = 200
                headers: list[tuple[str, str]] = []
                for line in head.decode("latin-1").split("\r\n"):
                    name, _, value = line.partition(":")
                    if name.lower() == "status":
                        status = int(value.strip().split()[0])
                    elif name:
                        headers.append((name, value.strip()))
                self.send_response(status)
                for name, value in headers:
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _body(self) -> bytes:
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    chunks = b""
                    while True:
                        size = int(self.rfile.readline().strip() or b"0", 16)
                        if size == 0:
                            self.rfile.readline()
                            break
                        chunks += self.rfile.read(size)
                        self.rfile.readline()
                    data = chunks
                else:
                    data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data

            do_GET = _serve
            do_POST = _serve

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "HttpOrigin":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._release.set()
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/{self.origin.path.name}"

    def hold(self) -> None:
        self.arrived.clear()
        self._release.clear()

    def release(self) -> None:
        self._release.set()


def processes_mentioning(*needles: str) -> list[str]:
    """The command lines (of every process this user can read) that contain any of the needles."""
    found: list[str] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            command = (
                (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            )
        except OSError:
            continue
        if any(needle in command for needle in needles):
            found.append(command)
    return found


def still_running(*needles: str, wait: float = 5.0) -> list[str]:
    """`processes_mentioning`, given a moment: a killed process is listed until the kernel has
    taken it down and its parent (or init) has collected it."""
    deadline = time.monotonic() + wait
    found = processes_mentioning(*needles)
    while found and time.monotonic() < deadline:
        time.sleep(0.1)
        found = processes_mentioning(*needles)
    return found


def environments_mentioning(needle: str) -> int:
    """How many processes of this user have the needle in their environment (a positive control)."""
    count = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            if needle.encode() in (entry / "environ").read_bytes():
                count += 1
        except OSError:
            continue
    return count


def files_mentioning(root: Path, *needles: str) -> list[Path]:
    """Every regular file below root (also hidden ones and .git) whose bytes contain a needle."""
    found: list[Path] = []
    for path in root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if any(needle.encode() in data for needle in needles):
            found.append(path)
    return found
