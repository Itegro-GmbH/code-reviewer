# SPDX-License-Identifier: LicenseRef-Proprietary

"""Shared helpers of the privileged suite: users, helpers run as another user, a local Git repo.

Nothing here talks to a real network: the sentinels and the "model" are loopback listeners the
tests own, and the Git objects are made locally by `fakes/dynamic_git`.
"""

import contextlib
import errno
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Generator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.dynamic_git.fixtures import GitFixture, git

from code_reviewer_runner.dynamic_findings import DynamicFindings
from code_reviewer_runner.dynamic_review.checkout import PreparedContent, prepare_content
from code_reviewer_runner.dynamic_review.ipv6_off import disable_ipv6
from code_reviewer_runner.dynamic_review.limits import Budget, Limits
from code_reviewer_runner.dynamic_review.netguard import (
    EgressMode,
    NetworkConfinement,
    table_family,
    table_name,
)
from code_reviewer_runner.dynamic_review.pr_context import PreparationContext, metadata_text
from code_reviewer_runner.dynamic_review.publish import Published
from code_reviewer_runner.dynamic_review.static_isolation import (
    DEFAULT_ENGINE_PORT,
    DEFAULT_PROXY_PORT,
)
from code_reviewer_runner.dynamic_review.transport import LocalTransport
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.redaction import Redactor

# The dedicated engine user, a stranger (another job's user) and the user Diff jobs drop to. The
# script that runs this suite creates them; ids and groups are distinct on purpose.
ENGINE_UID = 10101
ENGINE_GID = 10101
STRANGER_UID = 10201
STRANGER_GID = 10201
JOB_UID = 10001
JOB_GID = 10001

TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
API_KEY = "dummy-openrouter-key-0123456789"
TOKEN = "dummy-installation-token-0123456789"
CAPABILITIES = json.dumps(
    {
        "tool_choice_required": True,
        "structured_output": True,
        "max_output_tokens": 4096,
        "input_usd_per_mtok": 1,
        "output_usd_per_mtok": 4,
    }
)

# What the Worker's container is created with (the hardened container spec cap_add), by Linux
# capability number, in two parts (#244). The job part is all that the loop, the job process and
# the supervisor hold once startup is over; the startup part exists only until the engine user's
# static nft rules are installed, and is then dropped from the bounding set for good.
JOB_CAPABILITIES = {
    "CHOWN": 0,
    "DAC_OVERRIDE": 1,
    "FOWNER": 3,
    "KILL": 5,
    "SETGID": 6,
    "SETUID": 7,
}
STARTUP_CAPABILITIES = {"SETPCAP": 8, "NET_ADMIN": 12}
PRODUCTION_CAPABILITIES = {**JOB_CAPABILITIES, **STARTUP_CAPABILITIES}

# The two ports of the single Dynamic slot (the defaults of `static_isolation`): the static rules
# of the job phase name them, and a job's model proxy and engine use them.
PROXY_PORT = DEFAULT_PROXY_PORT
ENGINE_PORT = DEFAULT_ENGINE_PORT


# Which egress ruleset the job phase of this run is forced to (#345). Production decides it from the
# kernel (`netguard.select_egress_mode`); the suite's fallback pass pretends the kernel has no
# `inet` through the `detect` seam of the startup step (`job_phase.py`). This variable belongs to
# the test harness: no module of the runner reads it (a unit test pins that).
FORCE_FALLBACK_VARIABLE = "CR_PRIVILEGED_EGRESS_MODE"
EGRESS_MODE = (
    EgressMode.FALLBACK
    if os.environ.get(FORCE_FALLBACK_VARIABLE) == "fallback"
    else EgressMode.FULL
)
# What a refused connection looks like to the user: an immediate error from the reject, never a
# timeout. How long it takes is not part of that: a SYN retransmit may add a second.
REFUSED = {errno.EACCES, errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH}


def blocked(result: dict[str, Any], mode: EgressMode) -> bool:
    """True when a connection attempt (from `connect_as`) did not get through, as the mode says.

    The full ruleset refuses at once: the strict assertion, an errno of `REFUSED`, no timeout. The
    fallback ruleset drops, so a timeout (no errno) is the expected outcome there as well.
    """
    if result["connected"]:
        return False
    if mode is EgressMode.FULL:
        return result["errno"] in REFUSED
    return result["errno"] is None or result["errno"] in REFUSED


# The environment of the Dynamic Worker (the hardened container spec) as far as startup reads it.
RUNNER_ENVIRONMENT = {
    "RUNNER_DIFF_JOB_USER": f"{JOB_UID}:{JOB_GID}",
    "RUNNER_DYNAMIC_ENGINE_UID": str(ENGINE_UID),
    "RUNNER_DYNAMIC_ENGINE_GID": str(ENGINE_GID),
}


def exec_directory(prefix: str) -> Path:
    """A new directory, root-owned and enterable by everybody, where programs may run.

    The container's tmpfs are `noexec`, as is the `/tmp` this suite runs on (#249), so a test that
    needs to run a copy of the engine puts it here: a tmpfs of the script that allows exec, which
    stands in for the image's `/usr/local/bin`. Fails, never skips, without it.
    """
    root = os.environ.get("CR_EXEC_DIR")
    if not root:
        pytest.fail("CR_EXEC_DIR is not set: use scripts/run_privileged_offline.sh")
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=root))
    directory.chmod(0o755)
    return directory


def python3() -> str:
    path = shutil.which("python3", path=TRUSTED_PATH)
    assert path is not None, "a system python3 is needed to run helpers as another user"
    return path


def ripgrep() -> str:
    """The `rg` of this host that stands in for the image's verified one (the loop names it)."""
    extra = os.environ.get("OPENCODE_TEST_PATH")
    path = shutil.which("rg", path=f"{extra}:{TRUSTED_PATH}" if extra else TRUSTED_PATH)
    assert path is not None, "a ripgrep is needed: the engine's grep and glob run it (apt ripgrep)"
    return path


def run_as(
    uid: int, gid: int, code: str, *args: str, timeout: float = 30
) -> subprocess.CompletedProcess[str]:
    """Run a Python snippet as another user with no supplementary group and a closed environment."""
    return subprocess.run(
        [python3(), "-I", "-c", code, *args],
        user=uid,
        group=gid,
        extra_groups=(),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env={"PATH": TRUSTED_PATH},
    )


CONNECT = """
import json, socket, sys, time
results = {}
for label, host, port in json.loads(sys.argv[1]):
    started = time.monotonic()
    try:
        with socket.create_connection((host, int(port)), timeout=2):
            results[label] = {"connected": True}
    except OSError as error:
        results[label] = {
            "connected": False,
            "errno": error.errno,
            "seconds": time.monotonic() - started,
        }
print(json.dumps(results))
"""


def connect_as(uid: int, gid: int, targets: list[tuple[str, str, int]]) -> dict[str, Any]:
    """Which of the (label, host, port) targets the user can open a TCP connection to."""
    done = run_as(uid, gid, CONNECT, json.dumps(targets))
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@contextmanager
def listener(
    host: str = "127.0.0.1", family: int = socket.AF_INET, port: int = 0
) -> Generator[int]:
    """A TCP listener the test owns (a stand-in for a service the engine must not reach)."""
    with socket.socket(family, socket.SOCK_STREAM) as server:
        # The slot's fixed port is bound again and again, test after test.
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((host, port))
        server.listen(8)
        yield int(server.getsockname()[1])


def slot_proxy() -> AbstractContextManager[int]:
    """A listener on the slot's fixed proxy port: what the engine user is allowed to reach."""
    return listener(port=PROXY_PORT)


def _ipv6_settings() -> dict[Path, str]:
    conf = Path("/proc/sys/net/ipv6/conf")
    return {
        entry / "disable_ipv6": (entry / "disable_ipv6").read_text()
        for entry in conf.iterdir()
        if (entry / "disable_ipv6").exists()
    }


@contextmanager
def ipv6_settings_restored() -> Generator[None]:
    """Whatever a test does to the IPv6 settings of the namespace, they are as before afterwards."""
    before = _ipv6_settings()
    try:
        yield
    finally:
        for path, value in before.items():
            path.write_text(value)


@contextmanager
def ipv6_switched_off() -> Generator[None]:
    """IPv6 off by the production step (`disable_ipv6`), the previous settings back afterwards."""
    with ipv6_settings_restored():
        disable_ipv6()
        yield


@contextmanager
def installed_rules(
    proxy_port: int,
    engine_port: int,
    mode: EgressMode = EgressMode.FULL,
    egress_port: int | None = None,
) -> Generator[None]:
    """The engine user's rules for these ports, installed like the startup does, removed after.

    Needs NET_ADMIN, so only the startup phase of the suite can use it. The job phase has the
    runner's own static rules and no way to touch them. The fallback rules do not see IPv6, so
    that mode runs with IPv6 switched off, as the startup step leaves it. `egress_port` is the
    Implementer container's third port (#763).
    """
    with contextlib.ExitStack() as stack:
        if mode is EgressMode.FALLBACK:
            stack.enter_context(ipv6_switched_off())
        NetworkConfinement(ENGINE_UID, mode=mode).apply(proxy_port, engine_port, egress_port)
        try:
            yield
        finally:
            delete_rules(mode)


def delete_rules(mode: EgressMode) -> None:
    nft = shutil.which("nft", path="/usr/sbin:/sbin:" + TRUSTED_PATH)
    assert nft is not None
    subprocess.run(
        [nft, "delete", "table", table_family(mode), table_name(ENGINE_UID)],
        capture_output=True,
        timeout=10,
        check=False,
    )


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def wait_for(path: Path, seconds: float = 30.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if path.is_file():
            return True
        time.sleep(0.05)
    return False


def pids_gone(pids: list[int], seconds: float = 10.0) -> bool:
    from code_reviewer_runner.dynamic_review.engine_user import user_pids

    end = time.monotonic() + seconds
    while time.monotonic() < end:
        alive = set(user_pids(ENGINE_UID))
        if not alive & set(pids):
            return True
        time.sleep(0.05)
    return False


def nft_tables() -> str:
    nft = shutil.which("nft", path="/usr/sbin:/sbin:" + TRUSTED_PATH)
    assert nft is not None, "nft is not installed"
    done = subprocess.run(
        [nft, "list", "tables"], capture_output=True, text=True, timeout=10, check=False
    )
    assert done.returncode == 0, done.stderr
    return done.stdout


class Repo:
    """A bare Git repository with a base commit and a pull request head, made locally."""

    def __init__(self, path: Path, files: dict[str, bytes], changed: dict[str, bytes]) -> None:
        self.git = GitFixture(path)
        base = self.git.commit(dict(files))
        self.git.head = self.git.commit({**files, **changed}, base)
        git(self.git.path, "update-ref", "refs/heads/main", base)
        git(self.git.path, "update-ref", "refs/pull/7/head", self.git.head)

    @classmethod
    def existing(cls, path: Path, head: str) -> "Repo":
        """A repository another process made (`Repo(...)`), opened by its path and head."""
        repo = object.__new__(cls)
        repo.git = GitFixture.__new__(GitFixture)
        repo.git.path = path
        repo.git.head = head
        return repo

    @property
    def head(self) -> str:
        return self.git.head

    def context_for(self, job: Job, **options: Any) -> PreparationContext:
        """The `context_for` of the production preparer: no GitHub to read the pull request from."""
        return PreparationContext(metadata=metadata_text("Privileged fixture", ""), prior_state="")

    def content_for(self, job: Job, directory: Path, **options: Any) -> PreparedContent:
        """The `content_for` of the production preparer, reading this repository, not GitHub."""
        assert job.base is not None
        budget: Budget | None = options.get("budget")
        limits: Limits = options["limits"]
        return prepare_content(
            job.base,
            7,
            LocalTransport(self.git.path),
            directory,
            Redactor(job.secrets),
            limits=limits,
            cancelled=options["cancelled"],
            metadata=options["metadata"],
            prior_state=options["prior_state"],
            budget=budget,
        )


def dynamic_job(
    head: str,
    base_url: str = "http://127.0.0.1:9",
    provider: str = "openrouter",
    model: str = "deepseek/deepseek-v4.1-flash",
) -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": model,
                    "skill": "Look for real bugs.",
                    "limits": {"maxFindings": 5},
                },
                "base": {
                    "repository": "octo/repo",
                    "baseRef": "main",
                    "headSha": head,
                    "previousReviewedSha": None,
                    "comparison": "full",
                },
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": TOKEN,
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {
                    "provider": provider,
                    "model": model,
                    "apiKey": API_KEY,
                    "baseUrl": base_url,
                },
            }
        )
    )


def no_publication(job: Job, found: DynamicFindings) -> Published:
    """The `publish` seam of a suite that proves the engine boundary: the supervisor writes the
    summary after the engine is gone (`runner.run_dynamic_job`), which these tests do not judge."""
    return Published(comment_url="https://github.com/octo/repo/pull/7#issuecomment-1", created=True)
