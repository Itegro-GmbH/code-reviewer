# SPDX-License-Identifier: LicenseRef-Proprietary

"""The runner's self-test: it proves the base on this machine (#854, R1b; plan decision 3).

A runner announces OpenCode as `ready` only when this has passed, and `agent-docker` only when a
container ran inside a Docker inside Sysbox (S2 of the spikes: that is the one way the agent's own
Docker is allowed). The checks, in order, each with a stable name and no value in its detail:

- `docker`: the host's Docker answers at the socket and has the runtime that was chosen.
- `work-volume`: `/work` is a Docker volume of this container (the agent mounts it by name).
- `memory`: the memory limit leaves the agent's container enough to work.
- `agent-image`: the agent image is in the daemon (pulled from the reference if it was not).
- `agent-container`: it starts under the runtime, with the limits, and becomes ready.
- `opencode`: the OpenCode in it reports the version the runner pins.
- `canned-turn`: a whole turn of the pinned OpenCode against a canned model, inside the container:
  the engine starts, calls a provider, streams text and ends with the usage the model gave.
- `agent-docker` (a capability, may fail): under Sysbox, a container runs in the agent's Docker.

The canned model is `canned_provider.py`, run in the agent's container beside the engine, so the
turn needs no network, no key and no subscription. The container is a throwaway one with no
network at all and none of the volumes of a real turn. Whatever the check made is removed, and a
container left by an earlier self-test that was killed is removed first.

What this does not prove: the model door and the git rules, which have their own tests in the
repository (the lane runs a whole turn on a daemon), and the Sysbox wall itself.
"""

import contextlib
import json
import re
import socket
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, cast

from code_reviewer_runner.factory_runner import canned_provider
from code_reviewer_runner.factory_runner.config import Limits
from code_reviewer_runner.factory_runner.limits import (
    LimitsError,
    agent_memory_mb,
    machine_memory_mb,
)
from code_reviewer_runner.implementer.agent_container import (
    AGENT_IMAGE_REFERENCE,
    AGENT_RUNTIME,
    READY_FILE,
    agent_document,
)
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.exec_run import run_exec
from code_reviewer_runner.implementer.reader import work_volume_of
from code_reviewer_runner.implementer.role_labels import (
    RUNNER_ID_VARIABLE,
    RUNNER_LABEL,
    role_labels,
)
from code_reviewer_runner.implementer.runner_profile import entrypoint_for
from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object

SELFTEST_CONTAINER: Final = "code-reviewer-selftest-agent"
PIN_FILE: Final = Path("/opt/code-reviewer/pins/opencode-pin.json")
READY_SECONDS: Final = 120.0
VERSION_SECONDS: Final = 30.0
TURN_SECONDS: Final = 120.0
NESTED_SECONDS: Final = 120.0
CANNED_PORT: Final = 18765
CANNED_DIRECTORY: Final = "/tmp/selftest"
OPENCODE: Final = "opencode"

CHECK_DOCKER: Final = "docker"
CHECK_WORK_VOLUME: Final = "work-volume"
CHECK_MEMORY: Final = "memory"
CHECK_IMAGE: Final = "agent-image"
CHECK_CONTAINER: Final = "agent-container"
CHECK_OPENCODE: Final = "opencode"
CHECK_TURN: Final = "canned-turn"
CHECK_AGENT_DOCKER: Final = "agent-docker"
# The capability the manifest names when `agent-docker` passed.
CAPABILITY_AGENT_DOCKER: Final = "agent-docker"

# The engine's config for the canned turn: one provider, one model, nothing that discovers,
# installs or shares (the same flags the real turns have, `implementer/config.py`).
_CANNED_CONFIG: Final[dict[str, Any]] = {
    "provider": {
        "selftest": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": f"http://127.0.0.1:{CANNED_PORT}/v1", "apiKey": "selftest"},
            "models": {
                "canned": {
                    "name": "canned",
                    "tool_call": True,
                    "limit": {"context": 32000, "output": 1000},
                }
            },
        }
    },
    "enabled_providers": ["selftest"],
    "permission": {"*": "deny"},
    "mcp": {},
    "lsp": False,
    "formatter": False,
    "snapshot": False,
    "share": "disabled",
    "autoupdate": False,
    "plugin": [],
    "skills": {"paths": []},
}
_ENGINE_ENV: Final = {
    "HOME": "/root",
    "OPENCODE_CONFIG": f"{CANNED_DIRECTORY}/opencode.json",
    "OPENCODE_PURE": "true",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
    "OPENCODE_DISABLE_MODELS_FETCH": "true",
    "OPENCODE_DISABLE_AUTOUPDATE": "true",
    "OPENCODE_DISABLE_LSP_DOWNLOAD": "true",
    "OPENCODE_DISABLE_SHARE": "true",
    "OPENCODE_DISABLE_TELEMETRY": "true",
    "DO_NOT_TRACK": "1",
    "CI": "1",
    "NO_COLOR": "1",
}
# A constant script: writes the canned model and its config from the standard input (a tar-like
# pair, split on a marker line), starts the model, runs one turn, ends the model. No value of the
# runner is in an argument.
_TURN_SCRIPT: Final = (
    f"set -eu; mkdir -p {CANNED_DIRECTORY} /tmp/selftest-work; cd /tmp/selftest-work; "
    f"python3 {CANNED_DIRECTORY}/canned_provider.py {CANNED_PORT} & model=$!; sleep 1; "
    f"set +e; {OPENCODE} run --format json -m selftest/canned 'say ok'; code=$?; "
    "kill $model 2>/dev/null; exit $code"
)
_WRITE_SCRIPT: Final = 'set -eu; mkdir -p "$(dirname "$1")"; cat > "$1"'
_NESTED_SCRIPT: Final = (
    "set -eu; tar -C / -c usr/local/bin/docker-init | docker import - selftest-probe; "
    "docker run --rm --network none selftest-probe /usr/local/bin/docker-init --version; "
    "docker rmi -f selftest-probe >/dev/null 2>&1 || true"
)
_DIGEST: Final = re.compile(r"sha256:[0-9a-f]{64}")
_STALE_IMAGE: Final = (
    "the agent image in the daemon is not the one this runner pins (its digest differs) "
    "and this self-test cannot pull a new one; pull the pinned image or name it with "
    "FACTORY_RUNNER_AGENT_IMAGE"
)
_VERSION: Final = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?")


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass(frozen=True)
class SelfTestResult:
    checks: tuple[Check, ...]
    runtime: str
    opencode_version: str | None = None
    # Seconds the whole self-test took.
    seconds: float = 0.0

    @property
    def base_ok(self) -> bool:
        """The base holds: every check but the capability passed."""
        return all(check.ok for check in self.checks if check.name != CHECK_AGENT_DOCKER)

    @property
    def agent_docker(self) -> bool:
        return any(check.name == CHECK_AGENT_DOCKER and check.ok for check in self.checks)

    @property
    def capabilities(self) -> tuple[str, ...]:
        return (CAPABILITY_AGENT_DOCKER,) if self.agent_docker else ()

    def failed(self) -> Check | None:
        """The first check of the base that failed."""
        return next((c for c in self.checks if not c.ok and c.name != CHECK_AGENT_DOCKER), None)


@dataclass(frozen=True)
class SelfTestSeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    pin_file: Path = PIN_FILE
    work_dir: Path = Path("/work")
    # The name the agent image has in the daemon (the lane names its own).
    image: str = AGENT_IMAGE_REFERENCE
    # The file of this very module's canned model, copied into the container.
    canned_source: Path = Path(canned_provider.__file__)


@dataclass
class _Run:
    """The state of one self-test."""

    api: DockerApi
    seams: SelfTestSeams
    checks: list[Check] = field(default_factory=lambda: list[Check]())
    # The agent image was pulled by this self-test (it is not pulled twice), and OpenCode in the
    # agent's container was not the pinned version (an image that is older than this runner).
    pulled: bool = False
    stale: bool = False
    # The runner's id for the label of the throwaway container (`implementer/role_labels.py`).
    runner_id: str = ""

    def record(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append(Check(name, ok, detail))
        return ok


def pinned_opencode_version(pin_file: Path = PIN_FILE) -> str | None:
    try:
        document = as_object(json.loads(pin_file.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None
    version = document.get("version") if document else None
    return version if isinstance(version, str) and _VERSION.fullmatch(version) else None


def run_selftest(
    *,
    runtime: str,
    limits: Limits,
    agent_image: str | None,
    pull: Callable[[DockerApi, str], None] | None = None,
    seams: SelfTestSeams = SelfTestSeams(),  # noqa: B008
    meminfo: str = "/proc/meminfo",
    runner_id: str = "",
) -> SelfTestResult:
    """Run every check with the runtime `runtime` (`runc` or `sysbox-runc`); stop at the first one
    of the base that fails. `agent_image` is the reference to pull when the agent image is not in
    the daemon (None: it must already be there). `pull` is the Engine API call that does it."""
    started = seams.clock()
    api = seams.api()
    run = _Run(api, seams, runner_id=runner_id)
    version = None
    memory = _memory(run, limits, meminfo) if _daemon(run, runtime) and _work_volume(run) else None
    if memory and _image(run, agent_image, pull):
        version = _agent(run, runtime, memory, limits.cpus)
        if run.stale and not run.pulled and agent_image is not None and pull is not None:
            # An image of the right name that holds another OpenCode: replace it by the one the
            # reference names, once, and look again.
            del run.checks[-2:]  # the container and the opencode check of the stale image
            run.stale = False
            if _pull(run, agent_image, pull, "the agent image is not the one this runner pins"):
                version = _agent(run, runtime, memory, limits.cpus)
    return SelfTestResult(tuple(run.checks), runtime, version, seams.clock() - started)


def _agent(run: _Run, runtime: str, memory: int, cpus: int | None) -> str | None:
    """The agent's container, the engine in it, the canned turn, the nested Docker. The version
    OpenCode reported, if it did."""
    container = _start(run, runtime, memory, cpus)
    if container is None:
        return None
    version = None
    try:
        version = _opencode(run, container)
        if version is not None and _turn(run, container) and runtime == AGENT_RUNTIME:
            _nested(run, container)
    finally:
        _remove(run.api, container)
    return version


# -- the checks ------------------------------------------------------------------------------------


def _daemon(run: _Run, runtime: str) -> bool:
    if not run.api.ping():
        return run.record(CHECK_DOCKER, False, "the Docker daemon does not answer at its socket")
    try:
        runtimes = run.api.runtimes()
    except DockerError:
        return run.record(CHECK_DOCKER, False, "the Docker daemon did not describe itself")
    if runtime != "runc" and runtime not in runtimes:
        return run.record(CHECK_DOCKER, False, f"the daemon has no {runtime} runtime")
    return run.record(CHECK_DOCKER, True, f"runtime {runtime}")


def _work_volume(run: _Run) -> bool:
    try:
        work_volume_of(run.api.inspect_container(run.seams.hostname()))
    except (JobError, DockerError):
        return run.record(
            CHECK_WORK_VOLUME,
            False,
            "this container has no Docker volume at /work (start it with -v <name>:/work, "
            "and without --hostname or --network host)",
        )
    if not run.seams.work_dir.is_dir():
        return run.record(CHECK_WORK_VOLUME, False, "/work is not a directory")
    return run.record(CHECK_WORK_VOLUME, True)


def _memory(run: _Run, limits: Limits, meminfo: str) -> int | None:
    try:
        memory = agent_memory_mb(limits, machine_mb=machine_memory_mb(meminfo))
    except LimitsError as error:
        run.record(CHECK_MEMORY, False, str(error))
        return None
    run.record(CHECK_MEMORY, True, f"{memory} MB for the agent")
    return memory


def pinned_digest(reference: str | None) -> str | None:
    """`sha256:...` of a reference that names its image by digest."""
    if reference is None or "@" not in reference:
        return None
    digest = reference.partition("@")[2]
    return digest if _DIGEST.fullmatch(digest) else None


def _image(run: _Run, reference: str | None, pull: Callable[[DockerApi, str], None] | None) -> bool:
    """The agent image is in the daemon under the runner's name, and is the one the reference pins.

    A reference by digest is compared with the digests the daemon knows the image by: an image of
    the right name with another digest is replaced (pulled and named again). A reference by tag
    cannot be compared; it passes with a warning, and `_opencode` still holds the engine in it to
    the version this runner pins (a mismatch there pulls once, too)."""
    warning = _digest_warning(reference)
    try:
        present: dict[str, Any] | None = run.api.inspect_image(run.seams.image)
    except DockerError:
        present = None
    if present is not None:
        digest = pinned_digest(reference)
        if digest is None or digest in _digests(present):
            return run.record(CHECK_IMAGE, True, warning)
        if reference is None or pull is None:
            return run.record(CHECK_IMAGE, False, _STALE_IMAGE)
        return _pull(run, reference, pull, "the agent image is not the one this runner pins")
    if reference is None or pull is None:
        return run.record(
            CHECK_IMAGE,
            False,
            "the agent image is not in the daemon and no image reference is configured "
            "(FACTORY_RUNNER_AGENT_IMAGE)",
        )
    return _pull(run, reference, pull, None)


def _pull(
    run: _Run, reference: str, pull: Callable[[DockerApi, str], None], replacing: str | None
) -> bool:
    """Pull `reference` and name it the runner's image. `replacing`: why an image that is there
    is replaced. Records the check."""
    try:
        pull(run.api, reference)
        run.api.inspect_image(run.seams.image)
    except DockerError:
        what = "the agent image could not be pulled"
        return run.record(CHECK_IMAGE, False, f"{replacing}, and {what}" if replacing else what)
    run.pulled = True
    detail = "replaced: " + replacing if replacing else "pulled"
    warning = _digest_warning(reference)
    return run.record(CHECK_IMAGE, True, f"{detail}; {warning}" if warning else detail)


def _digests(image: dict[str, Any]) -> set[str]:
    """The digests the daemon knows an image by (`RepoDigests`: `name@sha256:...`)."""
    listed = image.get("RepoDigests")
    if not isinstance(listed, list):
        return set()
    return {
        entry.partition("@")[2]
        for entry in cast("list[object]", listed)
        if isinstance(entry, str) and "@" in entry
    }


def _digest_warning(reference: str | None) -> str:
    if reference is None or pinned_digest(reference) is not None:
        return ""
    return (
        "warning: the agent image reference names a tag, not a digest "
        "(@sha256:...): the image behind a tag can change, and this runner cannot tell"
    )


def _throwaway(
    image: str, runtime: str, memory_mb: int, cpus: int | None, runner_id: str
) -> dict[str, object]:
    """The agent's container as a real turn makes it, without the network and the volumes."""
    document = agent_document(
        image,
        "selftest",
        memory_mb * 1024 * 1024,
        runtime=runtime,
        entrypoint=entrypoint_for(runtime),
        nano_cpus=0 if cpus is None else cpus * 1_000_000_000,
    )
    host = dict(document["HostConfig"])
    host["NetworkMode"] = "none"
    host["Mounts"] = []
    document.pop("NetworkingConfig", None)
    document["HostConfig"] = host
    document["Labels"] = role_labels("selftest", {RUNNER_ID_VARIABLE: runner_id})
    return document


def _start(run: _Run, runtime: str, memory_mb: int, cpus: int | None) -> str | None:
    api = run.api
    _clear_own(api, SELFTEST_CONTAINER, run.runner_id)
    container: str | None = None
    try:
        container = api.create_container(
            _throwaway(run.seams.image, runtime, memory_mb, cpus, run.runner_id), SELFTEST_CONTAINER
        )
        api.start_container(container)
        end = run.seams.clock() + READY_SECONDS
        while True:
            done = run_exec(api, container, ["/usr/bin/test", "-e", READY_FILE], timeout=10.0)
            if done.returncode == 0 and not done.unanswered:
                run.record(CHECK_CONTAINER, True, f"runtime {runtime}")
                return container
            if run.seams.clock() >= end:
                run.record(CHECK_CONTAINER, False, "the container did not become ready in time")
                break
            run.seams.sleep(0.2)
    except DockerError as error:
        detail = f"the daemon refused a step ({error.status})"
        if error.status == 409:
            detail += f": a container named {SELFTEST_CONTAINER} of another runner is in the way"
        run.record(CHECK_CONTAINER, False, detail)
    if container is not None:
        _remove(api, container)
    return None


def _opencode(run: _Run, container: str) -> str | None:
    expected = pinned_opencode_version(run.seams.pin_file)
    done = run_exec(
        run.api, container, [OPENCODE, "--version"], timeout=VERSION_SECONDS, name="opencode"
    )
    found = done.stdout.strip()
    if done.returncode != 0 or done.unanswered or not _VERSION.fullmatch(found):
        run.record(CHECK_OPENCODE, False, "OpenCode did not report a version in the agent's image")
        return None
    if expected is not None and found != expected:
        run.stale = True
        run.record(
            CHECK_OPENCODE,
            False,
            f"OpenCode reports {found}, the runner pins {expected}: the agent image "
            f"{run.seams.image} in the daemon is older or newer than this runner "
            "(name the right one with FACTORY_RUNNER_AGENT_IMAGE, ideally by digest)",
        )
        return None
    run.record(CHECK_OPENCODE, True, found)
    return found


def _write(run: _Run, container: str, path: str, data: bytes) -> bool:
    done = run_exec(
        run.api,
        container,
        ["/bin/sh", "-c", _WRITE_SCRIPT, "write", path],
        stdin=data,
        timeout=15.0,
        name="write a file",
    )
    return done.returncode == 0 and not done.unanswered


def _turn(run: _Run, container: str) -> bool:
    try:
        source = run.seams.canned_source.read_bytes()
    except OSError:
        return run.record(CHECK_TURN, False, "the canned model is not in the runner")
    config = json.dumps(_CANNED_CONFIG).encode()
    if not (
        _write(run, container, f"{CANNED_DIRECTORY}/canned_provider.py", source)
        and _write(run, container, f"{CANNED_DIRECTORY}/opencode.json", config)
    ):
        return run.record(CHECK_TURN, False, "the canned model could not be put into the container")
    done = run_exec(
        run.api,
        container,
        ["/bin/sh", "-c", _TURN_SCRIPT],
        env=_ENGINE_ENV,
        timeout=TURN_SECONDS,
        name="the canned turn",
    )
    if done.unanswered:
        return run.record(CHECK_TURN, False, "the turn did not end in time")
    problem = turn_problem(done.stdout)
    if problem is not None or done.returncode != 0:
        return run.record(CHECK_TURN, False, problem or "OpenCode ended with an error")
    return run.record(CHECK_TURN, True)


def turn_problem(output: str) -> str | None:
    """What is wrong with the JSON events of `opencode run --format json`, or None when the turn
    streamed the canned answer and ended with the usage the canned model gave."""
    text = ""
    finished: dict[str, Any] | None = None
    for line in output.splitlines():
        try:
            event = as_object(json.loads(line))
        except ValueError:
            continue
        part = as_object(event.get("part")) if event else None
        if event is None or part is None:
            continue
        if event.get("type") == "text" and isinstance(part.get("text"), str):
            text += part["text"]
        if event.get("type") == "step_finish":
            finished = part
    if canned_provider.ANSWER not in text:
        return "the engine did not stream the canned answer"
    tokens = as_object(finished.get("tokens")) if finished else None
    if tokens is None or tokens.get("input") != canned_provider.USAGE["prompt_tokens"]:
        return "the engine did not report the usage the model gave"
    return None


def _nested(run: _Run, container: str) -> None:
    done = run_exec(
        run.api,
        container,
        ["/bin/sh", "-c", _NESTED_SCRIPT],
        timeout=NESTED_SECONDS,
        name="the agent's docker",
    )
    ok = done.returncode == 0 and not done.unanswered
    run.record(
        CHECK_AGENT_DOCKER,
        ok,
        "a container ran in the agent's own Docker" if ok else "no container ran in the agent",
    )


def _clear_own(api: DockerApi, container: str, runner_id: str) -> None:
    """Remove `container` if it is this runner's (a self-test that was killed leaves one): the name
    is fixed, so another runner's must not be removed by it."""
    try:
        found = api.inspect_container(container)
    except DockerError:
        return
    config = found.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    owner = labels.get(RUNNER_LABEL) if isinstance(labels, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    if (owner if isinstance(owner, str) else "") == runner_id:
        _remove(api, container)


def _remove(api: DockerApi, container: str) -> None:
    with contextlib.suppress(DockerError):
        api.stop_container(container, grace=1, timeout=30.0)
    with contextlib.suppress(DockerError):
        api.remove_container(container)


def summary(result: SelfTestResult, checks: Sequence[Check] | None = None) -> list[str]:
    """One line per check for the terminal and the log."""
    lines = [
        f"{'ok  ' if check.ok else 'FAIL'} {check.name}"
        + (f": {check.detail}" if check.detail else "")
        for check in checks or result.checks
    ]
    return lines
