# SPDX-License-Identifier: LicenseRef-Proprietary

"""The real job entry point of the runner for an Implementer job, with the two last hops put on
loopback (#767).

An Implementer job has to reach two things that the privileged lane does not have: the model's
provider (the native path speaks https to a public address and refuses anything else) and the
package registries (the agent's egress proxy tunnels to a public address of a name on its
allowlist). The lane has loopback only. This wrapper is set as `PR_AGENT_COMMAND` of the lane's
Workers. It reads nothing itself: it puts two doubles behind the seams the engine suite uses
(`SessionSeams.upstream_for` and `SessionSeams.start_egress`) and hands over to the unchanged
entry point (`code_reviewer_runner.runner.main`), whose validation, lease check, git workspace,
ledger, model proxy, engine and push run as they do in a container:

* the model proxy's last hop is plain http to the fake LLM (`<llm base url>/chat/completions`);
  everything before it (the job's entry, the capability, the key swap, the cost ledger, the usage)
  is production code;
* the clone address stays an https address through the runner's own checks (the app and the
  contract demand one, and the repository of the lane states one) and is turned into http for
  the git commands, because the fake GitHub speaks plain http on loopback; host and path stay;
* the egress proxy keeps its allowlist and its judgement of the target, but a name resolves to a
  public documentation address and a connection to it is made to the fake registry on loopback, so
  a name of the list reaches the fake and every other name is refused by the proxy itself.

It also records the git commands the runner itself runs (the mirror: clone, fetch, push), one JSON
line each, in the file named by the third argument: the argument vector only (the token travels in
the environment of those processes, never in it). The journeys assert on it that the runner never
pushes with force.

When the job has ended, and before the process does, it looks through the engine user's home and
temporary directory (OpenCode's data, cache and sessions), the agent's repository, the mirror and
`/run` for the job's secrets: the installation token, the model key and the capability the engine
was handed (in `/run` the capability is the engine's configuration, by design, and is only left
out). It writes how many files it read and how many held each, never a value, next to the git log
(`<git command log>.<pid>.scan.json`, one per job).

    python run_job_against_fake_llm.py <llm base url> <fake registry port> <git command log>

Test stacks only; never set `PR_AGENT_COMMAND` on a real runner. Run it with the Python of the
runner's environment. The credentials stay on stdin: no argument is a secret."""

import faulthandler
import functools
import http.client
import json
import logging
import os
import socket
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from code_reviewer_runner import runner
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpUpstreamResponse,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
    UpstreamResponse,
)
from code_reviewer_runner.implementer import job_run
from code_reviewer_runner.implementer.egress_config import EgressSettings, start_egress
from code_reviewer_runner.implementer.egress_proxy import EgressProxy
from code_reviewer_runner.implementer.git_process import GitProcess
from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.job_run import JobSeams
from code_reviewer_runner.implementer.session import SessionSeams

# A public address; it only has to pass the proxy's judgement, nothing connects to it.
PUBLIC_ADDRESS = "93.184.216.34"


class LoopbackUpstream:
    """The `Upstream` seam over plain http to the fake LLM on loopback (as in the engine suite)."""

    def __init__(self, base_url: str) -> None:
        parts = urlsplit(base_url)
        if parts.hostname not in ("127.0.0.1", "::1", "localhost"):
            raise SystemExit("the fake LLM must be on loopback")
        self._host = parts.hostname or "127.0.0.1"
        self._port = parts.port or 80
        self._base_path = parts.path.rstrip("/")

    def send(self, request: UpstreamRequest, timeout: float) -> UpstreamResponse:
        logging.getLogger("fake-upstream").info(
            "POST %s (%d bytes)", request.path, len(request.body)
        )
        connection = http.client.HTTPConnection(self._host, self._port, timeout=timeout)
        try:
            connection.request(
                "POST",
                self._base_path + request.path,
                body=request.body,
                headers=dict(request.headers),
            )
            response = connection.getresponse()
        except TimeoutError:
            connection.close()
            raise UpstreamError(UpstreamFailure.TIMEOUT, sent=True) from None
        except (http.client.HTTPException, OSError):
            connection.close()
            raise UpstreamError(UpstreamFailure.UNREACHABLE) from None
        return HttpUpstreamResponse(connection, response)


def record_git_commands(log_path: str) -> None:
    """Logs the arguments of every git command the runner runs itself, then runs it."""
    run = GitProcess.run
    stream = GitProcess.stream

    def note(args: Sequence[str]) -> None:
        line = json.dumps({"time": time.time(), "argv": list(args)})
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    @functools.wraps(run)
    def recording_run(self: GitProcess, args: Sequence[str], **options: Any) -> Any:
        note(args)
        return run(self, args, **options)

    @functools.wraps(stream)
    def recording_stream(self: GitProcess, args: Sequence[str], **options: Any) -> Any:
        note(args)
        return stream(self, args, **options)

    GitProcess.run = recording_run  # type: ignore[method-assign,assignment]
    GitProcess.stream = recording_stream  # type: ignore[method-assign,assignment]


# A larger file is a cache or an object store, not a place for a token: the scan leaves it.
MAX_SCANNED_BYTES = 8 * 1024 * 1024


class EngineTraces:
    """Where the engine lives (its home and temporary directory) and the capability it was handed,
    found when it is started. What the engine prints goes to a file next to the git log."""

    def __init__(self, log_path: str = "") -> None:
        self.log_path = log_path
        self.directories: set[str] = set()
        self.capabilities: set[str] = set()

    def popen(self, argv: list[str], **options: Any) -> subprocess.Popen[bytes]:
        environment: dict[str, str] = options["env"]
        for name in ("HOME", "TMPDIR"):
            if name in environment:
                self.directories.add(environment[name])
        try:
            config = json.loads(Path(environment["OPENCODE_CONFIG"]).read_text(encoding="utf-8"))
            for provider in config.get("provider", {}).values():
                key = provider.get("options", {}).get("apiKey")
                if isinstance(key, str) and key:
                    self.capabilities.add(key)
        except (KeyError, OSError, ValueError, AttributeError):
            pass
        if self.log_path:
            log = open(f"{self.log_path}.{os.getpid()}.engine.txt", "ab")  # noqa: SIM115
            options.update(stdout=log, stderr=subprocess.STDOUT)
        return cast("subprocess.Popen[bytes]", subprocess.Popen(argv, **options))

    def scan(self, secrets: dict[str, str], report_path: str) -> None:
        """Counts, per place and per secret, the files that hold it: the engine's home and temporary
        directory, the agent's repository, the root's mirror, and `/run` (the guard's files, the
        engine's configuration, the Worker's files) without the lane's records. The capability is
        the engine's credential for the proxy of this job: it is in the engine's configuration
        under `/run` by design, so there it is left out."""
        capabilities = {f"capability-{n}": c for n, c in enumerate(self.capabilities)}
        everything = {**secrets, **capabilities}
        records = os.path.dirname(report_path)
        places: dict[str, tuple[list[str], dict[str, str], list[str]]] = {
            "engine-directories": (sorted(self.directories), everything, []),
            "repository": (["/work/repo"], everything, []),
            "mirror": (["/work/mirror.git"], everything, []),
            "run": (["/run"], secrets, [records]),
        }
        roots: dict[str, dict[str, Any]] = {}
        for label, (directories, needles, skipped) in places.items():
            found = dict.fromkeys(needles, 0)
            files = 0
            for directory in directories:
                for root, names, filenames in os.walk(directory, followlinks=False):
                    names[:] = [n for n in names if os.path.join(root, n) not in skipped]
                    for name in filenames:
                        path = Path(root, name)
                        if path.is_symlink():
                            continue
                        try:
                            if path.stat().st_size > MAX_SCANNED_BYTES:
                                continue
                            data = path.read_bytes()
                        except OSError:
                            continue
                        files += 1
                        for needle, value in needles.items():
                            if value.encode() in data:
                                found[needle] += 1
            roots[label] = {"files": files, "found": found}
        # The capabilities go to a file of their own (mode 0600) that the journey reads to search
        # every page and log for a value nobody else knows. No report or log is made from it.
        with open(report_path + ".capabilities", "a", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            for capability in sorted(self.capabilities):
                handle.write(capability + "\n")
        Path(report_path).write_text(json.dumps({"roots": roots}), encoding="utf-8")


def clone_over_http() -> None:
    """Has the workspace take the clone address as an http address: the checks of the job, which
    demand an https address, have run by then; this is the git commands' way to the fake GitHub."""
    init = GitWorkspace.__init__

    def init_over_http(
        self: GitWorkspace,
        spec: WorkspaceSpec,
        layout: WorkspaceLayout,
        agent: AgentUser,
        identity: GitIdentity,
        **options: Any,
    ) -> None:
        options["schemes"] = ("https", "http")
        spec = replace(spec, clone_url=spec.clone_url.replace("https://", "http://", 1))
        init(self, spec, layout, agent, identity, **options)

    GitWorkspace.__init__ = init_over_http  # type: ignore[method-assign]


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        sys.stderr.write(
            "usage: run_job_against_fake_llm.py "
            "<llm base url> <fake registry port> <git command log>\n"
        )
        return 2
    llm_base_url, registry_port, git_log = argv[1], int(argv[2]), argv[3]

    def resolve(_host: str) -> list[str]:
        return [PUBLIC_ADDRESS]

    def connect(_address: tuple[str, int], timeout: float) -> socket.socket:
        return socket.create_connection(("127.0.0.1", registry_port), timeout=timeout)

    def egress(settings: EgressSettings) -> EgressProxy | None:
        return start_egress(settings, resolve=resolve, connect=connect)

    # What the job says about itself (its log, the model proxy) goes to a file next to the git log:
    # the Worker keeps no record of it, and a journey that fails has to be read from something.
    job_log = f"{git_log}.{os.getpid()}.job.txt"
    notes = open(job_log, "a", buffering=1, encoding="utf-8")  # noqa: SIM115
    os.dup2(notes.fileno(), 2)
    logging.basicConfig(stream=notes, level=logging.DEBUG, force=True)
    # A job that does not end says where it is: the stacks of every thread, every thirty seconds,
    # in a file next to the log (open for as long as the process lives).
    stacks = f"{git_log}.{os.getpid()}.stacks.txt"
    trace = open(stacks, "w", encoding="utf-8")  # noqa: SIM115
    faulthandler.dump_traceback_later(30, repeat=True, file=trace)
    record_git_commands(git_log)
    clone_over_http()
    traces = EngineTraces(git_log)
    seams = JobSeams(
        session_seams=SessionSeams(
            upstream_for=lambda _base_url: LoopbackUpstream(llm_base_url),
            start_egress=egress,
            popen=traces.popen,
        )
    )

    def run_and_scan(job: Any, started: float, environment: Any, **options: Any) -> Any:
        result = job_run.run_implementer_job(job, started, environment, seams=seams, **options)
        traces.scan(
            {"installation-token": job.git.token, "model-key": job.llm.api_key},
            f"{git_log}.{os.getpid()}.scan.json",
        )
        subprocess.Popen(["sleep", "600"], start_new_session=True)  # MUTANT
        return result

    runner.run_implementer_job = run_and_scan
    return runner.main([])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
