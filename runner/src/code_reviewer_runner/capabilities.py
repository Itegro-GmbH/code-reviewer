# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engines a runner may advertise, and the startup self-check that gates them (#195).

A runner advertises an engine in the claim body only after the startup self-check proved the
isolation is effective. The check is simple and fails closed: the engine process must run as the
dedicated unprivileged user, the export mechanism must be read-only for it, and egress must be
proxy-only. A failure never falls back to a host setting, a fork or a weaker mode: the engine is
simply not advertised, and the job loop logs the stable isolation code.

The concrete probes against the container are `dynamic_review/self_check.py` (#202); this module
owns the policy and the result: any failure, expected or not, leaves `opencode` unadvertised.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass

from code_reviewer_runner.result import ErrorCode

ENGINE_DIFF = "pr-agent"
ENGINE_DYNAMIC = "opencode"
# The Implementer's engine (#746, #765). `ALL_ENGINES` are the reviewer engines the Dynamic
# self-check gates; `implementer` is advertised on top of them only when its own start-up check
# (`implementer/startup.py`) holds too, and only in a container that has a work directory.
ENGINE_IMPLEMENTER = "implementer"
ALL_ENGINES: tuple[str, ...] = (ENGINE_DIFF, ENGINE_DYNAMIC)
KNOWN_ENGINES: tuple[str, ...] = (*ALL_ENGINES, ENGINE_IMPLEMENTER)


class IsolationSelfCheckError(Exception):
    """The startup self-check failed.

    `code` is stable; `detail` names the property, never a value.
    """

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class IsolationFacts:
    """The effective facts the self-check reads. #202 measures them; here they are injected."""

    # The user the engine process would run as, and the dedicated unprivileged user it must be.
    uid: int
    expected_uid: int
    # True when the prepared export is read-only for the engine user.
    export_read_only: bool
    # True when the only network the engine can reach is the runner-owned model proxy.
    egress_proxy_only: bool


def verify_isolation(facts: IsolationFacts) -> None:
    """Raise `IsolationSelfCheckError` unless every isolation property holds. Fail closed."""
    if facts.uid == 0:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the engine would run as root, not the dedicated unprivileged user",
        )
    if facts.uid != facts.expected_uid:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the engine user is not the dedicated unprivileged user",
        )
    if not facts.export_read_only:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the prepared export is writable by the engine user",
        )
    if not facts.egress_proxy_only:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "egress is not proxy-only",
        )


def self_check_outcome(
    verify: Callable[[], object],
) -> tuple[tuple[str, ...], IsolationSelfCheckError | None]:
    """The engines this runner advertises, and why `opencode` is missing when it is.

    Both engines only after `verify` proved the isolation. A failed check, and any unexpected error
    inside it, drops `opencode` and keeps `pr-agent`; `pr-agent` runs in the same process boundary
    as before and needs none of this.
    """
    try:
        verify()
    except IsolationSelfCheckError as error:
        return (ENGINE_DIFF,), error
    except Exception:
        return (ENGINE_DIFF,), IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED, "the self-check could not be completed"
        )
    return ALL_ENGINES, None


def advertised_engines(verify: Callable[[], object]) -> tuple[str, ...]:
    """The engines this runner advertises: both only after `verify` proved the isolation."""
    return self_check_outcome(verify)[0]


# The engines a runner advertised, handed by the job loop to the Dynamic job process it starts.
# The job process refuses a Dynamic job unless `opencode` is in it (`runner.run_dynamic_job`); it is
# set by the loop alone, never read from operator configuration.
ENGINES_VARIABLE = "RUNNER_ADVERTISED_ENGINES"
# The engine command the same way: the loop sets it for a Dynamic job process, from the executable
# the self-check verified. The operator's own environment is never passed on under this name.
OPENCODE_COMMAND_VARIABLE = "RUNNER_OPENCODE_COMMAND"
# And the `rg` the same check verified: the file the engine runs for its grep and glob, first on its
# PATH. Set by the loop for a Dynamic job process; never read from operator configuration.
RIPGREP_PATH_VARIABLE = "RUNNER_DYNAMIC_RIPGREP"


def engines_from_environment(environment: Mapping[str, str]) -> tuple[str, ...]:
    """The known engines named in `ENGINES_VARIABLE`; nothing when it is unset."""
    named = environment.get(ENGINES_VARIABLE, "").split(",")
    return tuple(engine for engine in KNOWN_ENGINES if engine in named)
