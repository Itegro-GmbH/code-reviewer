# SPDX-License-Identifier: LicenseRef-Proprietary

"""Whether a runner announces Claude Code, and as ready (#856, plan decisions 4 and 11).

The platform's catalog holds only OpenCode; Claude Code exists for the app only when a runner
announces it in its manifest as **ready**: installed (the layer with the pinned version is on the
device's daemon, `layer.py`) and logged in (a token the device holds, `login.py`). A device with no
login at all does not use Claude Code and says nothing about it. A device that has a login but no
usable layer or token announces it as not ready and says why in its log; a harness that is not
ready never costs the base: OpenCode stays as it was.

The proof is the layer's own: its build fails unless the installed program reports the pinned
version, and the token file is read the way the turn reads it. What is **not** yet proven here is a
turn of the adapter against a canned provider inside the container (a follow-up of #856): until it
exists, "ready" means "installed and logged in", and the first real turn is the first real test of
the login.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .layer import CLAUDE_CODE_VERSION, LayerDaemon, LayerError, LayerSpec, ensure_layer, find_layer
from .login import ClaudeLogin, LoginProblem, load_login

HARNESS_CLAUDE_CODE: Final = "claude-code"
# The agent image the runner starts agents from (`agent_container.AGENT_IMAGE_REFERENCE`).
AGENT_IMAGE: Final = "code-reviewer-agent:golden"
# A version chosen on the device (`FACTORY_RUNNER_CLAUDE_CODE_VERSION`), exact, instead of the pin.
VERSION_VARIABLE: Final = "FACTORY_RUNNER_CLAUDE_CODE_VERSION"


@dataclass(frozen=True)
class HarnessStatus:
    """What a runner says of a harness: its version, whether it takes jobs, and notes for the
    log (words, never a secret)."""

    version: str
    ready: bool
    notes: tuple[str, ...]


def layer_spec(environment: Mapping[str, str]) -> LayerSpec | str:
    """The pinned layer, or the device's own exact version; a text when that is not a version."""
    chosen = environment.get(VERSION_VARIABLE, "").strip()
    if not chosen:
        return LayerSpec()
    if chosen == CLAUDE_CODE_VERSION:
        return LayerSpec()  # the pin itself keeps its digest check
    try:
        return LayerSpec(version=chosen, integrity=None)
    except ValueError:
        return f"{VERSION_VARIABLE} is not an exact version such as 2.1.311"


def claude_code_status(
    daemon: LayerDaemon,
    environment: Mapping[str, str],
    home: Path,
    *,
    build: bool,
    agent_image: str = AGENT_IMAGE,
) -> HarnessStatus | None:
    """None for a device that does not use Claude Code. `build` False only looks (the self-test
    command pulls and names nothing); True builds a missing layer (a starting runner)."""
    login = load_login(environment, home)
    if isinstance(login, LoginProblem) and not login.configured:
        return None
    spec = layer_spec(environment)
    if isinstance(spec, str):
        return HarnessStatus("0", False, (spec,))
    if isinstance(login, LoginProblem):
        return HarnessStatus(spec.version, False, (login.text,))
    try:
        if build:
            layer = ensure_layer(daemon, agent_image, spec)
            notes = (f"the layer with Claude Code {spec.version} was built",) if layer.built else ()
        elif find_layer(daemon, agent_image, spec) is None:
            return HarnessStatus(
                spec.version,
                False,
                (f"the layer with Claude Code {spec.version} is not built (a start builds it)",),
            )
        else:
            notes = ()
    except LayerError as error:
        return HarnessStatus(spec.version, False, (str(error),))
    return HarnessStatus(spec.version, True, notes)


@dataclass(frozen=True)
class ReadyHarness:
    """What a job that asks for Claude Code is run with: the device's login and the image of the
    layer (the agent image with Claude Code in it)."""

    login: ClaudeLogin
    image: str


@dataclass(frozen=True)
class HarnessNotReady:
    """Why this device cannot run Claude Code for the job in hand. `text` is words, never a
    secret."""

    text: str


def ready_harness(
    daemon: LayerDaemon,
    environment: Mapping[str, str],
    home: Path,
    *,
    agent_image: str = AGENT_IMAGE,
) -> ReadyHarness | HarnessNotReady:
    """The readiness of the manifest, looked at again for **this job** (#856): the login is read
    and the layer is looked for, nothing is built. A device that cannot run Claude Code refuses the
    job; it never runs it with another harness."""
    login = load_login(environment, home)
    if isinstance(login, LoginProblem):
        return HarnessNotReady(login.text)
    spec = layer_spec(environment)
    if isinstance(spec, str):
        return HarnessNotReady(spec)
    try:
        layer = find_layer(daemon, agent_image, spec)
    except LayerError as error:
        return HarnessNotReady(str(error))
    if layer is None:
        return HarnessNotReady(f"the layer with Claude Code {spec.version} is not on this daemon")
    return ReadyHarness(login, layer.image)


__all__ = [
    "HARNESS_CLAUDE_CODE",
    "HarnessNotReady",
    "HarnessStatus",
    "ReadyHarness",
    "claude_code_status",
    "layer_spec",
    "ready_harness",
]
