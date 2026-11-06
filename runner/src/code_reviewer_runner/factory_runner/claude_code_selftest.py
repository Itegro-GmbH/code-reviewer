# SPDX-License-Identifier: LicenseRef-Proprietary

"""What `factory-runner selftest` says about Claude Code (#856).

Two depths, and the cheap one is the default:

* **Readiness** (always, no model call, no cost): the device has a usable login, the layer with the
  pinned version is on the daemon, and the program in it reports that version (`claude --version`
  as the unprivileged user, in a throwaway container with no network). A device with no login at
  all says nothing, as in the manifest.
* **One tiny turn** (only with `--with-claude-code`, by hand): the real program, the device's real
  login, behind the same network door and in the same kind of container as a job, one short prompt
  and a small budget. It is a real call to Anthropic: it costs a few cents of the user's
  subscription (the estimate is printed) and nothing else. Nothing automated ever runs it; the
  tests use a double for the door and the container.

These checks are a capability of the machine like `agent-docker`: a failing one is said, and it
never costs the base (`SelfTestResult.base_ok` leaves the names that start with `claude-code`
out). The login is never printed: a detail holds words and the estimate.
"""

import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Final, Protocol

from code_reviewer_runner.dynamic_review.adapter import EngineError
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.factory_runner.config import (
    RunnerConfig,
    home_directory,
    runner_identity,
)
from code_reviewer_runner.factory_runner.limits import agent_memory_mb, machine_memory_mb
from code_reviewer_runner.factory_runner.prepare import job_environment
from code_reviewer_runner.factory_runner.selftest import (
    CHECK_CLAUDE_CODE_PREFIX,
    SELFTEST_CONTAINER,
    Check,
    SelfTestResult,
    clear_own_container,
    remove_container,
    throwaway_document,
)
from code_reviewer_runner.implementer.agent_container import (
    READY_FILE,
    AgentContainer,
    AgentSeams,
)
from code_reviewer_runner.implementer.claude_code.agent import ClaudeCodeAgent
from code_reviewer_runner.implementer.claude_code.command import (
    AGENT_HOME,
    AGENT_PATH,
    AGENT_USER,
    EXECUTABLE,
)
from code_reviewer_runner.implementer.claude_code.gates import subscription_rule
from code_reviewer_runner.implementer.claude_code.layer import LayerError, find_layer
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin, LoginProblem, load_login
from code_reviewer_runner.implementer.claude_code.readiness import AGENT_IMAGE, layer_spec
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.exec_run import run_exec
from code_reviewer_runner.implementer.netdoor_launcher import start_network_door
from code_reviewer_runner.implementer.network_rule import OFF, NetworkRule
from code_reviewer_runner.implementer.runner_profile import agent_seams
from code_reviewer_runner.job import IMPLEMENTER_AGENT_MEMORY_VARIABLE, JobError
from code_reviewer_runner.result import ErrorCode

CHECK_LOGIN: Final = f"{CHECK_CLAUDE_CODE_PREFIX}-login"
CHECK_LAYER: Final = f"{CHECK_CLAUDE_CODE_PREFIX}-layer"
CHECK_VERSION: Final = f"{CHECK_CLAUDE_CODE_PREFIX}-version"
CHECK_TURN: Final = f"{CHECK_CLAUDE_CODE_PREFIX}-turn"

READY_SECONDS: Final = 120.0
VERSION_SECONDS: Final = 30.0
# The whole tiny turn, door and container included, and the share of it Claude Code may use.
TURN_SECONDS: Final = 180.0
# A short prompt, the cheapest model Claude Code names, and a cap: a few cents at the most.
PROMPT: Final = "Reply with the single word: ok"
MODEL: Final = "haiku"
BUDGET_USD: Final = "0.25"


class TurnDoor(Protocol):
    def stop(self) -> dict[str, Any] | None: ...


class TurnPlace(Protocol):
    """The container of the tiny turn (`AgentContainer` is one)."""

    def create(self) -> tuple[str, ...]: ...

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None: ...

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> Any: ...

    def run_streaming(
        self,
        argv: list[str],
        environment: Mapping[str, str],
        *,
        user: str,
        stdin: bytes,
        timeout: float,
        consume: Callable[[bytes], None],
    ) -> Any: ...

    def engine_end_note(self) -> str | None: ...

    def stop(self) -> bool: ...

    def remove(self) -> None: ...


def _start_door(rule: NetworkRule, deadline_seconds: float) -> TurnDoor:
    return start_network_door(rule, deadline_seconds=deadline_seconds)


def _make_place(memory_mb: int, seams: AgentSeams, rule: NetworkRule) -> TurnPlace:
    return AgentContainer(memory_mb, seams, rule)


@dataclass(frozen=True)
class ClaudeSelfTestSeams:
    """What the tests replace; production leaves the defaults."""

    start_door: Callable[[NetworkRule, float], TurnDoor] = _start_door
    make_place: Callable[[int, AgentSeams, NetworkRule], TurnPlace] = _make_place
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    new_session: Callable[[], str] = lambda: str(uuid.uuid4())


def claude_code_checks(
    api: DockerApi,
    source: Mapping[str, str],
    job_environment: Mapping[str, str],
    home: Path,
    *,
    with_turn: bool,
    runner_id: str = "",
    seams: ClaudeSelfTestSeams = ClaudeSelfTestSeams(),  # noqa: B008
) -> tuple[Check, ...]:
    """The checks for Claude Code on this device, in order. Empty for a device with no login that
    was not asked (`with_turn` False). Stops at the first check that fails. `source` is the
    runner's environment (the login and the version choice), `job_environment` the one the
    containers of a job are made from (runtime, memory, CPUs)."""
    login = load_login(source, home)
    if isinstance(login, LoginProblem):
        if not login.configured and not with_turn:
            return ()
        return (Check(CHECK_LOGIN, False, login.text),)
    checks = [Check(CHECK_LOGIN, True, "a usable login (not shown)")]
    spec = layer_spec(source)
    if isinstance(spec, str):
        return (*checks, Check(CHECK_LAYER, False, spec))
    try:
        layer = find_layer(api, AGENT_IMAGE, spec)
    except LayerError as error:
        return (*checks, Check(CHECK_LAYER, False, str(error)))
    if layer is None:
        return (
            *checks,
            Check(CHECK_LAYER, False, f"the layer with Claude Code {spec.version} is not built "
                  "(a start of the runner builds it)"),
        )  # fmt: skip
    how = (
        "pinned digests checked at the build"
        if spec.integrity is not None
        else "a version chosen on this device, not checked against a digest"
    )
    checks.append(Check(CHECK_LAYER, True, f"{layer.image} ({how})"))
    environment = dict(job_environment)
    place_seams = agent_seams(environment, AgentSeams(image=layer.image, no_new_privileges=True))
    memory_mb = _memory_of(environment)
    version = _version_check(api, place_seams, memory_mb, runner_id, spec.version, seams)
    checks.append(version)
    if not version.ok or not with_turn:
        return tuple(checks)
    checks.append(_turn_check(login, place_seams, memory_mb, seams))
    return tuple(checks)


def _memory_of(environment: Mapping[str, str]) -> int:
    try:
        return max(512, int(environment.get(IMPLEMENTER_AGENT_MEMORY_VARIABLE, "0")))
    except ValueError:
        return 1024


def _version_check(
    api: DockerApi,
    place_seams: AgentSeams,
    memory_mb: int,
    runner_id: str,
    expected: str,
    seams: ClaudeSelfTestSeams,
) -> Check:
    """`claude --version` as the unprivileged user, in a throwaway container made from the layer:
    no network, no volume, no login."""
    cpus = place_seams.nano_cpus // 1_000_000_000 or None
    document = throwaway_document(
        place_seams.image, place_seams.runtime, memory_mb, cpus, runner_id
    )
    clear_own_container(api, SELFTEST_CONTAINER, runner_id)
    container: str | None = None
    try:
        container = api.create_container(document, SELFTEST_CONTAINER)
        api.start_container(container)
        end = seams.clock() + READY_SECONDS
        while True:
            done = run_exec(api, container, ["/usr/bin/test", "-e", READY_FILE], timeout=10.0)
            if done.returncode == 0 and not done.unanswered:
                break
            if seams.clock() >= end:
                return Check(CHECK_VERSION, False, "the container did not become ready in time")
            seams.sleep(0.2)
        done = run_exec(
            api,
            container,
            [EXECUTABLE, "--version"],
            user=AGENT_USER,
            env={"HOME": AGENT_HOME, "PATH": AGENT_PATH},
            timeout=VERSION_SECONDS,
            name="claude --version",
        )
    except DockerError as error:
        return Check(CHECK_VERSION, False, f"the daemon refused a step ({error.status})")
    finally:
        if container is not None:
            remove_container(api, container)
    found = done.stdout.strip().split(" ")[0]
    if done.returncode != 0 or done.unanswered or not found:
        return Check(CHECK_VERSION, False, "Claude Code did not report a version in the layer")
    if found != expected:
        return Check(
            CHECK_VERSION, False, f"Claude Code reports {found}, the layer was built for {expected}"
        )
    return Check(CHECK_VERSION, True, f"{found} as the unprivileged user; no model was called")


def _turn_check(
    login: ClaudeLogin, place_seams: AgentSeams, memory_mb: int, seams: ClaudeSelfTestSeams
) -> Check:
    """One tiny turn with the real login behind the forced network door. Never raises."""
    started = seams.clock()
    rule = subscription_rule(OFF)
    door: TurnDoor | None = None
    place: TurnPlace | None = None
    agent: ClaudeCodeAgent | None = None
    try:
        door = seams.start_door(rule, TURN_SECONDS)
        place = seams.make_place(memory_mb, place_seams, rule)
        place.create()

        def remaining() -> float:
            return TURN_SECONDS - (seams.clock() - started)

        def deadline() -> None:
            if remaining() <= 0:
                raise LimitError(ErrorCode.TIME_LIMIT_REACHED, "the tiny turn ran out of time")

        agent = ClaudeCodeAgent(
            place=place,
            login=login,
            model=MODEL,
            session_id=seams.new_session(),
            secrets=(),
            remaining_seconds=remaining,
            check_deadline=deadline,
            max_budget_usd=BUDGET_USD,
        )
        agent.start()
        answer = agent.turn(PROMPT)
    except JobError as error:
        return Check(CHECK_TURN, False, f"{error.code.value}: {error.detail}")
    except (EngineError, LimitError) as error:
        return Check(CHECK_TURN, False, f"{error.code.value}: {error}")
    finally:
        log = _end(agent, place, door)
    if "ok" not in answer.text.lower():
        return Check(
            CHECK_TURN, False, "the turn ended without the answer that was asked for" + log
        )
    return Check(CHECK_TURN, True, _estimate(agent) + log)


def _end(agent: ClaudeCodeAgent | None, place: TurnPlace | None, door: TurnDoor | None) -> str:
    """Take the container and the door away; what the door saw, in words."""
    if agent is not None:
        agent.stop()
    elif place is not None:
        place.stop()
    if place is not None:
        place.remove()
    log = None if door is None else door.stop()
    if not log:
        return ""
    return f"; the network door let {log.get('allowed', 0)} and refused {log.get('refused', 0)}"


def _estimate(agent: ClaudeCodeAgent | None) -> str:
    cost: Decimal | None = None if agent is None else agent.estimated_cost_usd
    if cost is None:
        return "answered; no estimate, through your subscription"
    return f"answered; ≈ ${cost:.4f} at API prices, through your subscription (nothing billed)"


def device_checks(
    config: RunnerConfig,
    source: Mapping[str, str],
    result: SelfTestResult,
    *,
    with_turn: bool,
    api: Callable[[], DockerApi] = DockerApi,
    seams: ClaudeSelfTestSeams = ClaudeSelfTestSeams(),  # noqa: B008
) -> tuple[Check, ...]:
    """The checks of the `selftest` command, after the base: none when the base failed (a daemon
    that fails it cannot hold a layer either). The login is looked at before the daemon is, so a
    device that does not use Claude Code touches nothing."""
    if not result.base_ok:
        return ()
    home = home_directory(source)
    login = load_login(source, home)
    if isinstance(login, LoginProblem) and not login.configured and not with_turn:
        return ()
    memory = agent_memory_mb(config.limits, machine_mb=machine_memory_mb())
    return claude_code_checks(
        api(),
        source,
        job_environment(source, config, result.runtime, memory),
        home,
        with_turn=with_turn,
        runner_id=runner_identity(config),
        seams=seams,
    )
