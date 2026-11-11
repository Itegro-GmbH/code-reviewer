# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job of the whole-job lane and the host's side of it (#999; not a test file).

The job is the contract's example Implementer job, changed in the places where the lane's names and
fakes go in: the repository is on the lane's git host (an https URL on a name below
`lane.example.com`, which the Worker image of the lane trusts), the provider is a provider of the
catalog (`lane-provider`, a name of the lane, port 443: the key goes to the entry's address), the
environment has a setup script that reaches a public-looking host and a rule that lists the hosts
the job needs. The model follows a script: one tool call that uses what the setup left and fetches
a file through the network door, one more that commits, a closing text.

What the host holds besides: the proxy wall of the lane (`ProxyOuterWall` with the lane's resolver
and connector) that notes what the Worker's `narrow` said and when it was acknowledged."""

import contextlib
import copy
import json
import sys
import time
from collections.abc import Generator
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Turn
from fakes.wire.upstream import ScriptedUpstream
from lane_internet import (
    APP_HOST,
    FILES_HOST,
    GIT_HOST,
    MODEL_HOST,
    SETUP_ONLY_HOST,
    FilesHost,
    LaneInternet,
)
from lane_pki import Ca, server_context

from code_reviewer_runner.factory_runner.firecracker.outer_wall import VmIdentity
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import ProxyOuterWall
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage, Refusal
from code_reviewer_runner.job import ImplementerInput, parse_implementer_input
from git_support import HttpOrigin, Origin, system_git
from runner_app import FakeRunnerApp

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
EXAMPLE = CONTRACTS / "examples" / "implementer" / "RunnerJobInput.json"

REPOSITORY: Final = "acme/widgets"
CLONE_PATH: Final = f"/{REPOSITORY}.git"
CLONE_URL: Final = f"https://{GIT_HOST}{CLONE_PATH}"
BRANCH: Final = "implementer/a1b2c3"
GIT_TOKEN: Final = "ghs_lane-installation-token-0123456789"
MODEL_KEY: Final = "lane-model-key-stand-in-0123456789"
MODEL: Final = "lane-model-1"
INSTRUCTION: Final = "Fetch the two files of the lane and commit them."
# The commit the agent makes, and the two files in it.
SETUP_COPY: Final = "from-setup.txt"
AGENT_COPY: Final = "from-agent.txt"
CLOSING: Final = "I added what the setup and the network door fetched, and committed it."

SETUP_SCRIPT: Final = f"""\
echo "proxy variables: http_proxy=$http_proxy HTTP_PROXY=$HTTP_PROXY"
curl -fsSv --max-time 40 http://{FILES_HOST}/setup -o /opt/setup-fetched.txt
curl -fsSv --max-time 40 http://{SETUP_ONLY_HOST}/setup -o /opt/mirror-fetched.txt
cp /opt/setup-fetched.txt setup-fetched.txt
echo "the lane's setup is done"
"""

BOOK: Final[dict[str, Any]] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": "6000000",
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}


def job_document(*, setup_script: str = SETUP_SCRIPT) -> dict[str, Any]:
    """The lane's job as the app would send it: the example, with the lane's repository, provider
    and environment."""
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    spec = document["implementer"]
    spec["repo"] = {"fullName": REPOSITORY, "cloneUrl": CLONE_URL}
    spec["baseBranch"] = "main"
    spec["branch"] = BRANCH
    spec["instruction"] = INSTRUCTION
    spec["limits"] = {"timeLimitSeconds": 1200}
    spec["cost"] = {"keyMode": "managed", "priceBook": dict(BOOK), "maxTotalTokens": None}
    spec["modelEntry"].update(
        providerId="lane-provider",
        npm="@ai-sdk/openai-compatible",
        family="openai-chat",
        authHeader="Authorization",
        upstreamBaseUrl=f"https://{MODEL_HOST}/v1",
        modelId=MODEL,
    )
    spec["modelEntry"]["model"]["limit"] = {"context": 1_000_000, "output": 64_000}
    spec["modelEntry"]["model"]["reasoning"] = False
    spec["modelEntry"]["model"].pop("interleaved", None)
    # The hosts the job needs besides GitHub's, the provider's and the app's (which the outer wall
    # adds itself): the lane's git host (the final push) and the host the agent fetches from.
    spec["environment"] = {
        "name": "lane",
        "setupScript": setup_script,
        "network": {"mode": "list", "hosts": [GIT_HOST, FILES_HOST]},
    }
    document["git"] = {
        "provider": "github",
        "baseUrl": f"https://{GIT_HOST}/api/v3",
        "token": GIT_TOKEN,
        "botLogin": "code-reviewer[bot]",
    }
    document["llm"] = {
        "provider": "lane_provider",
        "model": MODEL,
        "apiKey": MODEL_KEY,
        "maxCostUsd": 0.5,
    }
    return copy.deepcopy(document)


def parsed(document: dict[str, Any] | None = None) -> ImplementerInput:
    """The job through the Worker's own parser (the tests of the lane's helpers hold the document
    to it, so that a job the lane would send is one the Worker accepts)."""
    return parse_implementer_input(json.dumps(document or job_document()))


def agent_script() -> list[Turn]:
    """What the model does: use the setup's file, fetch one through the door, commit, say so."""
    command = (
        f"cp /opt/setup-fetched.txt {SETUP_COPY} && "
        f"curl -fsS http://{FILES_HOST}/agent -o {AGENT_COPY} && "
        f"git add {SETUP_COPY} {AGENT_COPY} && git commit -qm 'Add what the lane fetched'"
    )
    return [
        Turn(tool="bash", args={"command": command, "description": "use the setup and fetch"}),
        Turn(text=CLOSING),
    ]


class RecordingProxyWall(ProxyOuterWall):
    """The real proxy wall that notes what the Worker's `narrow` said and when the wall held it."""

    def __init__(self, *args: Any, **options: Any) -> None:
        super().__init__(*args, **options)
        self.narrows: list[NarrowMessage] = []
        self.narrowed_at: float | None = None

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        refusal = await super().narrow(vm, message)
        if refusal is None:
            self.narrows.append(message)
            self.narrowed_at = time.monotonic()
        return refusal


@dataclass
class LaneFakes:
    """Everything the job reaches that is not the host's proxy: the App, the git endpoint, the
    provider and the files host, each on the loopback behind a public-looking name."""

    internet: LaneInternet
    app: FakeRunnerApp
    origin: Origin
    git_host: HttpOrigin
    model: ScriptedUpstream
    files: FilesHost


@contextlib.contextmanager
def lane_fakes(directory: Path, ca: Ca, *, with_git: bool = True) -> Generator[LaneFakes]:
    """Start the fakes. With `with_git` false the lane's git host has no name (the resolver refuses
    it): the proxy cannot clone for the job, which is how the lane makes it refuse."""
    with ExitStack() as stack:
        origin = Origin(directory / "git")
        git_host = stack.enter_context(
            HttpOrigin(
                origin,
                GIT_TOKEN,
                system_git(),
                tls=server_context(ca, [GIT_HOST], directory / "git-cert"),
                mount=CLONE_PATH,
            )
        )
        model = stack.enter_context(
            ScriptedUpstream(
                "chat",
                agent_script(),
                MODEL,
                real_key=MODEL_KEY,
                tls=server_context(ca, [MODEL_HOST], directory / "model-cert"),
            )
        )
        files = stack.enter_context(FilesHost())
        app = FakeRunnerApp().start()
        stack.callback(app.stop)
        internet = LaneInternet()
        if with_git:
            internet.expose(GIT_HOST, 443, git_host.port)
        internet.expose(MODEL_HOST, 443, model.port)
        internet.expose(FILES_HOST, 80, files.port)
        # The host only the setup may reach: the job's rule does not list it.
        internet.expose(SETUP_ONLY_HOST, 80, files.port)
        internet.expose(APP_HOST, 80, app.port)
        yield LaneFakes(internet, app, origin, git_host, model, files)
