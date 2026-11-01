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
* the egress proxy keeps its allowlist and its judgement of the target, but a name resolves to a
  public documentation address and a connection to it is made to the fake registry on loopback, so
  a name of the list reaches the fake and every other name is refused by the proxy itself.

It also records the git commands the runner itself runs (the mirror: clone, fetch, push), one JSON
line each, in the file named by the third argument: the argument vector only (the token travels in
the environment of those processes, never in it). The journeys assert on it that the runner never
pushes with force.

    python run_job_against_fake_llm.py <llm base url> <fake registry port> <git command log>

Test stacks only; never set `PR_AGENT_COMMAND` on a real runner. Run it with the Python of the
runner's environment. The credentials stay on stdin: no argument is a secret."""

import functools
import http.client
import json
import socket
import sys
import time
from collections.abc import Sequence
from typing import Any
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

    record_git_commands(git_log)
    seams = JobSeams(
        session_seams=SessionSeams(
            upstream_for=lambda _base_url: LoopbackUpstream(llm_base_url),
            start_egress=egress,
        )
    )
    runner.run_implementer_job = functools.partial(job_run.run_implementer_job, seams=seams)
    return runner.main()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
