# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job the runner reads from stdin, and its validation.

Shape (basis of the runner contract v1, see the lead decisions for CR-10):

    {
      "prUrl": "https://github.com/<owner>/<repo>/pull/<n>",
      "command": "review",
      "git": {"provider": "github", "baseUrl": "https://api.github.com",
              "token": "<installation token>", "botLogin": "<app slug>[bot]"},
      "llm": {"provider": "openrouter",                       // a slug of llm_providers.PROVIDERS
              "model": "<vendor>/<model>", "apiKey": "<key>",
              "baseUrl": "http://127.0.0.1:<port>/api/v1",     // optional, loopback only (fakes)
              "requireParameters": true,                       // optional, with baseUrl (fakes)
              "maxTokens": 163840,                             // optional, context window
              "maxCostUsd": 0.5,                               // optional, the project's cost limit
              "operatorMaxCostUsd": 1.0,                       // optional, the operator's maximum
              "fallbackModels": ["<vendor>/<model>"]},         // optional, at most five
      "env": {"PR_REVIEWER__EXTRA_INSTRUCTIONS": "<string>"}   // optional, tool settings only
    }

`/review` is the only command (the product removed `/ask`, `/improve` and `/describe`). A job that
names a removed command is refused with `invalid_command` before PR-Agent is loaded; that failure is
reported for the job (the loop completes it), so a mixed deployment never strands it. For a `review`
job the runner stays compatible with the previous release's v1 payload: the legacy `args` field and
the option families of the removed tools (`PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`,
`PR_QUESTIONS__*`) are **accepted and ignored** — they are never handed to PR-Agent. The `env` the
runner builds holds only `PR_REVIEWER__*` settings. Everything that decides where a credential or a
request goes (GitHub and LLM endpoints, tokens, the model, output switches) has its own validated
field above or is pinned by the runner. Values of `env` are text: PR-Agent never evaluates them (see
`pr_agent_config.build_option_settings`).

Validation never echoes a value from the job into its error detail: the job holds secrets, and the
detail ends up in the result JSON and in logs. Details name fields, never contents.
"""

import json
import math
import re
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum
from typing import Any, NoReturn, cast
from urllib.parse import SplitResult, urlsplit

from code_reviewer_runner.dynamic_review.job_model_entry import (
    JobModelEntry,
    JobModelEntryError,
    parse_job_model_entry,
)
from code_reviewer_runner.dynamic_review.passthrough.address import UpstreamRefused
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    CostPolicy,
    CostPolicyError,
    parse_cost_policy,
)
from code_reviewer_runner.dynamic_review.passthrough.destination import (
    PROVIDER_SLUG,
    key_destination,
)
from code_reviewer_runner.dynamic_review.prompts import MAX_SKILL_BYTES as MAX_DYNAMIC_SKILL_BYTES
from code_reviewer_runner.implementer.network_rule import OFF, NetworkRule, RuleError, parse_rule
from code_reviewer_runner.llm_providers import (
    LlmProviderSpec,
    provider_for,
    registered_provider_ids,
    without_prefix,
)
from code_reviewer_runner.platforms import PLATFORMS
from code_reviewer_runner.result import ErrorCode

MAX_JOB_BYTES = 1024 * 1024
MAX_SECRET_CHARS = 4096

_TOP_LEVEL_FIELDS = {
    "prUrl",
    "command",
    "args",
    "reviewKind",
    "dynamic",
    "base",
    "git",
    "llm",
    "env",
}
# The fields of an implementer job (#746): no pull request, so no `prUrl`, `command`, `args`, `base`
# or `dynamic`, and the `implementer` object instead.
_IMPLEMENTER_TOP_LEVEL_FIELDS = {"reviewKind", "implementer", "git", "llm", "env"}
_IMPLEMENTER_FIELDS = {
    "repo",
    "baseBranch",
    "branch",
    "instruction",
    "limits",
    "cost",
    "modelEntry",
    "capabilities",
    "environment",
    "profile",
}
_IMPLEMENTER_ENVIRONMENT_FIELDS = {"name", "setupScript", "network"}
# The profile version a turn was started with (#843, `ImplementerProfile` of the contract).
_IMPLEMENTER_PROFILE_FIELDS = {"name", "version", "instructions", "canPush"}
_PROFILE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
MAX_PROFILE_INSTRUCTION_CHARS = 20_000
# The bounds of the contract (`contracts/environment-sizes.v1.json`): a script is text of at most
# 64 KB.
MAX_SETUP_SCRIPT_BYTES = 64 * 1024
MAX_ENVIRONMENT_NAME_CHARS = 80
_IMPLEMENTER_REPO_FIELDS = {"fullName", "cloneUrl"}
_IMPLEMENTER_LIMIT_FIELDS = {"timeLimitSeconds"}
MAX_INSTRUCTION_CHARS = 20_000
MIN_TIME_LIMIT_SECONDS = 60
MAX_TIME_LIMIT_SECONDS = 14_400
# A branch name as the contract bounds it: no whitespace, not starting with a dash.
_BRANCH_NAME = re.compile(r"[^\s-][^\s]{0,254}")
_REPO_FULL_NAME = re.compile(r"[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}")
_CLONE_URL = re.compile(r"https://[^\s@]{1,2040}")

# The names of the environment variables the Worker container of an implementer job gets (#746,
# `KnownImplementerEnvironmentName` of the contract; a test compares them). The Dispatcher sets
# them.
IMPLEMENTER_WORK_DIR_VARIABLE = "RUNNER_IMPLEMENTER_WORK_DIR"
# #745, step 3: `docker` when the container carries the VM's Docker socket, which it starts the
# model door, the agent's container (step 4) and the reader with.
IMPLEMENTER_MODEL_DOOR_VARIABLE = "RUNNER_IMPLEMENTER_MODEL_DOOR"
# #745, step 4: the golden snapshot's Sysbox verdict and the memory of the agent's container.
IMPLEMENTER_SANDBOX_PROOF_VARIABLE = "RUNNER_IMPLEMENTER_SANDBOX_PROOF"
IMPLEMENTER_AGENT_MEMORY_VARIABLE = "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"
# #745, step 7: the Dispatcher's way to narrow the VM's network policy once the setup is done
# (`implementer/network_switch.py`). Unset, the policy is not changed and the report says so.
IMPLEMENTER_NETWORK_SWITCH_VARIABLE = "RUNNER_IMPLEMENTER_NETWORK_SWITCH"
IMPLEMENTER_ENVIRONMENT_NAMES: tuple[str, ...] = (
    IMPLEMENTER_WORK_DIR_VARIABLE,
    IMPLEMENTER_MODEL_DOOR_VARIABLE,
    IMPLEMENTER_SANDBOX_PROOF_VARIABLE,
    IMPLEMENTER_AGENT_MEMORY_VARIABLE,
    IMPLEMENTER_NETWORK_SWITCH_VARIABLE,
)
IMPLEMENTER_WORK_DIR = "/work"
_GIT_FIELDS = {"provider", "baseUrl", "token", "botLogin"}
_LLM_FIELDS = {
    "provider",
    "model",
    "apiKey",
    "baseUrl",
    "requireParameters",
    "maxTokens",
    "maxCostUsd",
    "operatorMaxCostUsd",
    "fallbackModels",
}
_DYNAMIC_FIELDS = {"model", "skill", "limits", "capabilities", "cost", "modelEntry"}
_CAPABILITY_FIELDS = {
    "toolChoiceRequired",
    "structuredOutput",
    "maxOutputTokens",
    "contextWindowTokens",
    "inputUsdPerMtok",
    "outputUsdPerMtok",
}
MAX_OUTPUT_TOKENS_LIMIT = 10_000_000
MAX_WINDOW_TOKENS_LIMIT = 100_000_000
# Exact decimal text, no sign and no exponent: the same pattern as `UnitPrice` in the contract.
_UNIT_PRICE = re.compile(r"(0|[1-9][0-9]{0,5})(\.[0-9]{1,18})?")
_DYNAMIC_LIMIT_FIELDS = {"maxFindings"}
_BASE_FIELDS = {
    "repository",
    "baseRef",
    "headSha",
    "previousReviewedSha",
    "attemptedShas",
    "attemptedShasTruncated",
    "comparison",
}
# The contract bounds the list; a longer one is not a claim of this app.
MAX_ATTEMPTED_SHAS = 20
_ATTEMPTED_SHAS_DETAIL = (
    f"base.attemptedShas must be a list of at most {MAX_ATTEMPTED_SHAS} distinct "
    "40 character lower-case commit ids"
)
_COMPARISONS = ("full", "incremental")
_LOWER_SHA = re.compile(r"[0-9a-f]{40}")
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MIN_CONTEXT_TOKENS = 1000
MAX_CONTEXT_TOKENS = 10_000_000
# #666: the most a project may set as its cost limit per review (the app's bound, 10 000 cents).
MAX_PROJECT_COST_USD = 100
# A fallback chain longer than this only multiplies the cost and the time of a failing review.
MAX_FALLBACK_MODELS = 5
_FIELD_NAME = re.compile(r"[A-Za-z0-9_.-]{1,40}")
_PR_PATH = re.compile(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]{0,8})")
# The login the review app posts as: its slug (letters, digits and hyphens, not starting with a
# hyphen, at most 39 characters) with the optional `[bot]` suffix that GitHub adds. Use `fullmatch`,
# so that nothing may precede or follow it, not even a newline. The only definition: `parse_job` and
# the identity patch (identity_patch.py) both validate with it.
BOT_LOGIN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}")
# A catalog provider's model is named as the entry of the claim names it (`job_model_entry.py`).
_CATALOG_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}")
# `env` may only set the options of the PR-Agent tools. An allowlist instead of a list of forbidden
# keys: PR-Agent has many sections (litellm, openai, azure, push_outputs, ...) that route requests
# or credentials, and a new PR-Agent version can add more. One option name per key: a second `__`
# would address a nested value.
# The previous release's app could send the option families of the removed tools; they are accepted
# (v1 compatibility) but ignored, never handed to PR-Agent. Only the review family reaches the job.
_ENV_KEY = re.compile(
    r"(PR_REVIEWER|PR_DESCRIPTION|PR_CODE_SUGGESTIONS|PR_QUESTIONS)__[A-Z0-9]+(_[A-Z0-9]+)*"
)
_REMOVED_TOOL_ENV_KEY = re.compile(
    r"(PR_DESCRIPTION|PR_CODE_SUGGESTIONS|PR_QUESTIONS)__[A-Z0-9]+(_[A-Z0-9]+)*"
)
# The names of the options the runner sets itself (switches that decide what is published). A job
# may not set them: the runner's value must win, and a repository file may not change them either
# (see `repo_settings_guard.PROTECTED_SETTINGS`, which a test compares with this list).
RESERVED_OPTIONS = frozenset(
    {
        "PR_REVIEWER__FINAL_UPDATE_MESSAGE",
        "PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY",
        "PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT",
    }
)


class Command(StrEnum):
    REVIEW = "review"


class ReviewKind(StrEnum):
    """The review kind a job was queued for (#195). Diff is the legacy shape (absent field)."""

    DIFF = "diff"
    DYNAMIC = "dynamic"
    # A turn of the Implementer (#746): about a branch of a repository, not a pull request.
    # `parse_job` (the review path) refuses it and never returns a `Job` of this kind;
    # `parse_runnable_job` returns its own type (#765).
    IMPLEMENTER = "implementer"


@dataclass(frozen=True)
class DynamicLimits:
    max_findings: int


@dataclass(frozen=True)
class JobCapabilities:
    """What the app read from the provider's model metadata about the job's model (#279).

    Optional on the wire and only sent to a runner that advertised it. It comes from the app, a
    trusted party, never from the repository; the runner still intersects it with its operator's
    descriptor (`dynamic_review.proxy.capabilities_for_job`), so it can only narrow. The two unit
    prices are both present or both absent.
    """

    tool_choice_required: bool
    structured_output: bool
    max_output_tokens: int
    context_window_tokens: int
    input_usd_per_mtok: Decimal | None = None
    output_usd_per_mtok: Decimal | None = None


@dataclass(frozen=True)
class DynamicReview:
    """The Dynamic options (#195): model, skill and the output limit.

    Closed; the skill is literal.
    """

    model: str
    skill: str
    limits: DynamicLimits
    capabilities: JobCapabilities | None = None
    # Whose key pays and what bounds the cost of a native job (#553); None for a job of today.
    cost: CostPolicy | None = None
    # The provider and the one model of a native job (#548, #578), without a key; None for a job of
    # today. A native job always has a cost policy too.
    model_entry: JobModelEntry | None = None


@dataclass(frozen=True)
class ClaimBase:
    """The checkout facts (#195).

    Exact head, base identity, declared comparison mode, prior head and (#255) the heads of the
    app's earlier jobs of this pull request that did not succeed, and (#257) whether that list was
    cut at its bound.
    """

    repository: str
    base_ref: str
    head_sha: str
    previous_reviewed_sha: str | None
    comparison: str
    attempted_shas: tuple[str, ...] = ()
    attempted_shas_truncated: bool = False


@dataclass(frozen=True)
class ImplementerRepo:
    full_name: str
    clone_url: str


@dataclass(frozen=True)
class ImplementerLimits:
    time_limit_seconds: int


@dataclass(frozen=True)
class ImplementerEnvironment:
    """The environment a turn was started with (#818, `ImplementerEnvironment` of the contract): the
    setup script that runs once in the repository's folder, in a container of its own, before the
    model is called, and (#745, step 7) the rule for the agent's network. Present only when the
    environment has a script or a rule other than `off`. The script is data written by a member of
    the workspace; it holds no secret and is never read as a command of the app. No script is the
    empty string."""

    name: str
    setup_script: str = ""
    network: NetworkRule = OFF

    @property
    def has_script(self) -> bool:
        return self.setup_script != ""


@dataclass(frozen=True)
class ImplementerProfile:
    """The profile version a turn was started with (#843, `ImplementerProfile` of the contract),
    as the app copied it when the turn started. `instructions` is the system-level text written by
    a member of the workspace: data for the agent's prompt, never a command of the app. `can_push`
    says whether Control pushes the branches the agent made when the turn ends. A turn without a
    profile has none and runs with the platform's own defaults, as every turn did before."""

    name: str
    version: int
    can_push: bool
    instructions: str = ""


@dataclass(frozen=True)
class ImplementerSpec:
    """What an implementer job asks for (#746, `ImplementerJob` of the contract). Closed.

    The cost policy and the model entry are those of the native Dynamic job and are required here:
    a model runs only through the passthrough proxy, with a price or a token cap.
    """

    repo: ImplementerRepo
    base_branch: str
    branch: str
    instruction: str
    limits: ImplementerLimits
    cost: CostPolicy
    model_entry: JobModelEntry
    capabilities: JobCapabilities | None = None
    environment: ImplementerEnvironment | None = None
    profile: ImplementerProfile | None = None


class JobError(Exception):
    """The job was refused. `detail` is safe to log: it names fields and never contains values."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class GitAccess:
    base_url: str
    token: str
    bot_login: str
    provider: str = "github"


@dataclass(frozen=True)
class LlmAccess:
    # The slug of the registry entry (`llm_providers.py`) this job's model is reached through.
    provider: str
    model: str
    api_key: str
    base_url: str | None = None
    max_tokens: int | None = None
    # #666: the cost limit the customer set for a review of the project, in USD; None: none was set.
    # The run is held to the smaller of this and the operator's limit.
    max_cost_usd: Decimal | None = None
    # #689: the most one review may cost as the operator set it in the admin portal, in USD; None:
    # the app did not send it (an app of the release before), and a Dynamic run is held to the
    # operator's environment variable instead.
    operator_max_cost_usd: Decimal | None = None
    fallback_models: tuple[str, ...] = ()
    # Whether every request carries the provider's require-parameters field (OpenRouter's
    # `provider.require_parameters`, #270). True for the provider itself when its entry has the
    # mechanism; a local fake only gets it when the test double that gave it its address asks.
    # `_llm_access` is the one constructor in production and always sets it.
    require_parameters: bool = True


@dataclass(frozen=True)
class Job:
    pr_url: str
    command: Command
    git: GitAccess
    llm: LlmAccess
    env: dict[str, str] = field(default_factory=lambda: {})
    review_kind: ReviewKind = ReviewKind.DIFF
    dynamic: DynamicReview | None = None
    base: ClaimBase | None = None

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every value that must never appear in an output."""
        # `env` is a closed list of tool options and holds no credentials, so its values are not
        # secrets: treating a value such as "true" as one would blank the result of a good run.
        return (self.git.token, self.llm.api_key)


@dataclass(frozen=True)
class ImplementerInput:
    """A parsed implementer job (#746). Not a `Job`: it has no pull request and no command."""

    git: GitAccess
    llm: LlmAccess
    implementer: ImplementerSpec
    env: dict[str, str] = field(default_factory=lambda: {})
    # The parts of the job text that the model door is built from (`llm`, `modelEntry`, `cost`), as
    # they came (#745, step 3). The door parses them again with `parse_model_access`, so that it
    # judges them by the very rules the job was judged by. Holds the key: never printed.
    model_access: dict[str, Any] | None = field(default=None, repr=False, compare=False)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every value that must never appear in an output."""
        return (self.git.token, self.llm.api_key)


def _invalid(detail: str) -> JobError:
    return JobError(ErrorCode.INVALID_JOB, detail)


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{path} must be an object")
    return value  # pyright: ignore[reportUnknownVariableType]


def _section(data: dict[str, Any], key: str) -> dict[str, Any]:
    if key not in data:
        raise _invalid(f"{key} is required")
    return _object(data[key], key)


def _check_fields(data: dict[str, Any], allowed: set[str], prefix: str) -> None:
    for key in data:
        if key not in allowed:
            # A key name is part of the input too: only echo it when it looks like a plain name.
            shown = key if _FIELD_NAME.fullmatch(key) else "<invalid name>"
            raise _invalid(f"unknown field {prefix}{shown}")


def _string(data: dict[str, Any], key: str, prefix: str, *, max_chars: int = 2048) -> str:
    value = data.get(key)
    if value is None:
        raise _invalid(f"{prefix}{key} is required")
    if not isinstance(value, str) or not value.strip() or len(value) > max_chars:
        raise _invalid(f"{prefix}{key} must be a non-empty string")
    return value


def _secret(data: dict[str, Any], key: str, prefix: str) -> str:
    value = _string(data, key, prefix, max_chars=MAX_SECRET_CHARS)
    if any(char.isspace() or not char.isprintable() for char in value):
        raise _invalid(f"{prefix}{key} must not contain whitespace or control characters")
    return value


def _checked_url(value: str, field_name: str) -> SplitResult:
    try:
        parts = urlsplit(value)
        _ = parts.port  # raises ValueError for a malformed port
    except ValueError:
        raise _invalid(f"{field_name} is not a valid URL") from None
    host = parts.hostname or ""
    secure = parts.scheme == "https"
    local_http = parts.scheme == "http" and host in _LOOPBACK_HOSTS
    if not host or not (secure or local_http):
        raise _invalid(f"{field_name} must be an https URL (http only for loopback)")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise _invalid(f"{field_name} must not contain credentials, a query or a fragment")
    return parts


def _git_access(data: dict[str, Any]) -> GitAccess:
    git = _section(data, "git")
    _check_fields(git, _GIT_FIELDS, "git.")
    provider = _string(git, "provider", "git.")
    if provider not in PLATFORMS:
        raise _invalid(f"git.provider must be one of: {', '.join(sorted(PLATFORMS))}")
    base_url = _string(git, "baseUrl", "git.").rstrip("/")
    _checked_url(base_url, "git.baseUrl")
    token = _secret(git, "token", "git.")
    bot_login = _string(git, "botLogin", "git.")
    if not BOT_LOGIN_PATTERN.fullmatch(bot_login):
        raise _invalid("git.botLogin must be an app slug, optionally with the [bot] suffix")
    return GitAccess(
        provider=provider,
        base_url=base_url,
        token=token,
        bot_login=bot_login if bot_login.endswith("[bot]") else f"{bot_login}[bot]",
    )


def _catalog_llm_access(llm: dict[str, Any], slug: str) -> LlmAccess:
    """The `llm` section of a native job whose provider the registry does not have (#555): a
    provider of the models.dev catalog, whose key goes to the address of the claim's entry
    (`key_destination`). Nothing of the legacy path applies, so nothing only it reads is taken."""
    if PROVIDER_SLUG.fullmatch(slug) is None:
        raise _invalid("llm.provider is not a provider slug")
    for name in ("baseUrl", "requireParameters", "fallbackModels"):
        if name in llm:
            raise _invalid(f"llm.{name} is not accepted for a provider of the catalog")
    model = _string(llm, "model", "llm.")
    if not _CATALOG_MODEL.fullmatch(model):
        raise _invalid("llm.model contains characters that are not allowed in a model name")
    return LlmAccess(
        provider=slug,
        model=model,
        api_key=_secret(llm, "apiKey", "llm."),
        require_parameters=False,
        max_tokens=_max_tokens(llm),
        max_cost_usd=_max_cost_usd(llm),
        operator_max_cost_usd=_operator_max_cost_usd(llm),
    )


def _llm_access(
    data: dict[str, Any], *, catalog: bool = False, catalog_model_id: bool = False
) -> LlmAccess:
    """`catalog`: the job is native, so a provider outside the registry may be a catalog one.
    `catalog_model_id`: the job is a task of the Implementer, whose model comes from the catalog
    whichever provider it is, so its id has the charset of a catalog id (the app's
    `isCatalogModelId`) also for a provider of the registry. A review keeps the registry's rule."""
    llm = _section(data, "llm")
    _check_fields(llm, _LLM_FIELDS, "llm.")
    slug = _string(llm, "provider", "llm.")
    provider = provider_for(slug)
    if provider is None and catalog:
        return _catalog_llm_access(llm, slug)
    if provider is None:
        raise _invalid(
            f"llm.provider must be one of: {', '.join(sorted(registered_provider_ids()))}"
        )
    model = _string(llm, "model", "llm.")
    if not (_CATALOG_MODEL if catalog_model_id else _MODEL).fullmatch(model):
        raise _invalid("llm.model contains characters that are not allowed in a model name")
    base_url = _llm_base_url(llm)
    return LlmAccess(
        provider=provider.id,
        model=model,
        api_key=_secret(llm, "apiKey", "llm."),
        base_url=base_url,
        require_parameters=_require_parameters(llm, base_url)
        and provider.require_parameters is not None,
        max_tokens=_max_tokens(llm),
        max_cost_usd=_max_cost_usd(llm),
        operator_max_cost_usd=_operator_max_cost_usd(llm),
        fallback_models=_fallback_models(llm, model, provider),
    )


def _llm_base_url(llm: dict[str, Any]) -> str | None:
    if "baseUrl" not in llm:
        return None
    base_url = _string(llm, "baseUrl", "llm.").rstrip("/")
    parts = _checked_url(base_url, "llm.baseUrl")
    # The shared LLM key goes to this address, so it may only point at a local fake.
    if (parts.hostname or "") not in _LOOPBACK_HOSTS:
        raise _invalid("llm.baseUrl is only accepted for loopback addresses")
    return base_url


def _require_parameters(llm: dict[str, Any], base_url: str | None) -> bool:
    """The provider itself always requires the parameters; only a local fake may differ (#270).

    `requireParameters` exists for the test doubles that add `llm.baseUrl`: without that address
    the destination is the provider itself and there is nothing to switch.
    """
    if base_url is None:
        if "requireParameters" in llm:
            raise _invalid("llm.requireParameters is only accepted with llm.baseUrl")
        return True
    value = llm.get("requireParameters", False)
    if not isinstance(value, bool):
        raise _invalid("llm.requireParameters must be a boolean")
    return value


def _max_tokens(llm: dict[str, Any]) -> int | None:
    if "maxTokens" not in llm:
        return None
    value = llm["maxTokens"]
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid("llm.maxTokens must be an integer")
    if not MIN_CONTEXT_TOKENS <= value <= MAX_CONTEXT_TOKENS:
        raise _invalid("llm.maxTokens is out of range")
    return value


def _cost_usd(llm: dict[str, Any], name: str) -> Decimal | None:
    """A cost field of `llm`: a finite number above zero and at most `MAX_PROJECT_COST_USD`."""
    if name not in llm:
        return None
    value = llm[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid(f"llm.{name} must be a number")
    if not math.isfinite(value) or not 0 < value <= MAX_PROJECT_COST_USD:
        raise _invalid(f"llm.{name} is out of range")
    # The shortest text of the number, so 0.07 is 0.07 and not the float's long tail.
    return Decimal(repr(value))


def _max_cost_usd(llm: dict[str, Any]) -> Decimal | None:
    """`llm.maxCostUsd` (#666): the customer's limit."""
    return _cost_usd(llm, "maxCostUsd")


def _operator_max_cost_usd(llm: dict[str, Any]) -> Decimal | None:
    """`llm.operatorMaxCostUsd` (#689): the operator's maximum per review (admin portal)."""
    return _cost_usd(llm, "operatorMaxCostUsd")


def _fallback_models(
    llm: dict[str, Any], primary: str, provider: LlmProviderSpec
) -> tuple[str, ...]:
    if "fallbackModels" not in llm:
        return ()
    value: Any = llm["fallbackModels"]
    if not isinstance(value, list):
        raise _invalid("llm.fallbackModels must be a list of model names")
    models: list[Any] = value  # pyright: ignore[reportUnknownVariableType]
    if len(models) > MAX_FALLBACK_MODELS:
        raise _invalid(f"llm.fallbackModels may hold at most {MAX_FALLBACK_MODELS} models")
    seen = {without_prefix(provider, primary)}
    for model in models:
        if not isinstance(model, str) or not _MODEL.fullmatch(model):
            raise _invalid("llm.fallbackModels must hold valid model names")
        if without_prefix(provider, model) in seen:
            raise _invalid("llm.fallbackModels must not repeat a model or the primary model")
        seen.add(without_prefix(provider, model))
    return tuple(models)


def _web_host(api_base_url: str) -> str:
    """The host a pull request URL must have for this API base URL."""
    netloc = urlsplit(api_base_url).netloc
    return "github.com" if netloc == "api.github.com" else netloc


def _pr_url(data: dict[str, Any], git: GitAccess) -> str:
    value = _string(data, "prUrl", "")
    # urlsplit silently drops tabs and newlines, so the raw text has to be checked here.
    if any(char.isspace() or not char.isprintable() for char in value):
        raise _invalid("prUrl must not contain whitespace or control characters")
    parts = _checked_url(value, "prUrl")
    if parts.netloc != _web_host(git.base_url):
        raise _invalid("prUrl must point to the host of git.baseUrl")
    if not _PR_PATH.fullmatch(parts.path):
        raise _invalid("prUrl must look like https://<host>/<owner>/<repo>/pull/<number>")
    return value


def _refuse_command() -> NoReturn:
    raise JobError(ErrorCode.INVALID_COMMAND, "command is not one of the allowed commands")


def _command(data: dict[str, Any]) -> Command:
    if "command" not in data:
        raise _invalid("command is required")
    value = data["command"]
    if not isinstance(value, str):
        _refuse_command()
    try:
        return Command(value)
    except ValueError:
        _refuse_command()


def _env(data: dict[str, Any]) -> dict[str, str]:
    """The review tool's options. A legacy option of a removed tool is accepted and dropped."""
    if data.get("env") is None:
        return {}
    env: dict[str, str] = {}
    for key, value in _object(data["env"], "env").items():
        if not _ENV_KEY.fullmatch(key):
            raise _invalid("env may only set options of the PR-Agent tools")
        if not isinstance(value, str):
            raise _invalid("env values must be strings")
        # A previous release sent the removed tools' options too; they are ignored, so they never
        # reach PR-Agent (which no longer runs those tools).
        if _REMOVED_TOOL_ENV_KEY.fullmatch(key):
            continue
        if key in RESERVED_OPTIONS:
            raise _invalid(f"env option {key} is set by the runner and cannot be set by a job")
        env[key] = value
    return env


def _review_kind(data: dict[str, Any]) -> ReviewKind:
    """The pinned review kind (#195). Absent means Diff, the shape of a previous-release job."""
    if "reviewKind" not in data:
        return ReviewKind.DIFF
    value = data["reviewKind"]
    if not isinstance(value, str):
        raise _invalid("reviewKind must be 'diff' or 'dynamic'")
    try:
        return ReviewKind(value)
    except ValueError:
        raise _invalid("reviewKind must be 'diff' or 'dynamic'") from None


def _dynamic_review(data: dict[str, Any]) -> DynamicReview:
    """The Dynamic options (#195). Closed: an executable, core override, endpoint or permission
    field is an unknown field and is refused. The skill is literal data and is never interpreted."""
    dynamic = _section(data, "dynamic")
    _check_fields(dynamic, _DYNAMIC_FIELDS, "dynamic.")
    model = _string(dynamic, "model", "dynamic.", max_chars=200)
    if not _MODEL.fullmatch(model):
        raise _invalid("dynamic.model contains characters that are not allowed in a model name")
    skill = dynamic.get("skill")
    if not isinstance(skill, str):
        raise _invalid("dynamic.skill must be a string")
    # The bound is in UTF-8 bytes, not characters (#198): a multibyte character counts as its bytes.
    try:
        skill_bytes = skill.encode("utf-8")
    except UnicodeEncodeError:
        raise _invalid("dynamic.skill must be valid UTF-8") from None
    if len(skill_bytes) > MAX_DYNAMIC_SKILL_BYTES:
        raise _invalid(
            f"dynamic.skill must be a string of at most {MAX_DYNAMIC_SKILL_BYTES} UTF-8 bytes"
        )
    limits = _object(dynamic.get("limits"), "dynamic.limits")
    _check_fields(limits, _DYNAMIC_LIMIT_FIELDS, "dynamic.limits.")
    max_findings = limits.get("maxFindings")
    if (
        isinstance(max_findings, bool)
        or not isinstance(max_findings, int)
        or not 1 <= max_findings <= 30
    ):
        raise _invalid("dynamic.limits.maxFindings must be an integer between 1 and 30")
    return DynamicReview(
        model=model,
        skill=skill,
        limits=DynamicLimits(max_findings=max_findings),
        capabilities=_job_capabilities(dynamic),
        cost=_job_cost_policy(dynamic),
        model_entry=_job_model_entry(dynamic),
    )


def _job_cost_policy(dynamic: dict[str, Any]) -> CostPolicy | None:
    """The cost policy of a native job (#553), or None. Strict: a policy that is not exactly one
    is a refused job, never a run that guesses a price or runs without a bound."""
    if "cost" not in dynamic:
        return None
    try:
        return parse_cost_policy(dynamic["cost"])
    except CostPolicyError as error:
        raise _invalid(error.detail) from None


def _job_model_entry(dynamic: dict[str, Any]) -> JobModelEntry | None:
    """The model entry of a native job (#578), or None. Strict, and never without the cost policy
    that bounds the run: an entry alone would be a native run with no price and no cap."""
    if "modelEntry" not in dynamic:
        return None
    if "cost" not in dynamic:
        raise _invalid("dynamic.modelEntry needs dynamic.cost")
    try:
        return parse_job_model_entry(dynamic["modelEntry"])
    except JobModelEntryError:
        raise _invalid("dynamic.modelEntry is not a job model entry") from None


def _entry_matches(dynamic: DynamicReview, llm: LlmAccess) -> None:
    """The entry names the model of the job and the provider the key belongs to. The key goes to
    the entry's address, so an entry of another provider would send it there."""
    entry = dynamic.model_entry
    if entry is None:
        return
    if entry.model_id != dynamic.model:
        raise _invalid("dynamic.modelEntry is not the model of the job")
    _entry_is_of_llm(entry, llm, "dynamic.modelEntry")


def _entry_is_of_llm(entry: JobModelEntry, llm: LlmAccess, name: str) -> None:
    """The entry is of the model and provider of `llm`, and its address is one the key may go to."""
    if entry.model_id != llm.model:
        raise _invalid(f"{name} is not the model of the job")
    if entry.provider_id != llm.provider.replace("_", "-"):
        raise _invalid(f"{name} is not of the provider of llm.provider")
    # The key goes to the registry's address for a registry provider, and for any other provider to
    # the plain public https address of the entry and to no other (`key_destination`).
    try:
        key_destination(llm.provider, entry)
    except UpstreamRefused:
        raise _invalid(f"{name}.upstreamBaseUrl is not the address of the provider") from None


def _capability_integer(document: dict[str, Any], key: str, upper: int) -> int:
    value = document.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= upper:
        raise _invalid(f"dynamic.capabilities.{key} must be an integer between 1 and {upper}")
    return value


def _capability_boolean(document: dict[str, Any], key: str) -> bool:
    value = document.get(key)
    if not isinstance(value, bool):
        raise _invalid(f"dynamic.capabilities.{key} must be a boolean")
    return value


def _unit_price(document: dict[str, Any], key: str) -> Decimal:
    value = document[key]
    if not isinstance(value, str) or not _UNIT_PRICE.fullmatch(value):
        raise _invalid(f"dynamic.capabilities.{key} must be an exact decimal text")
    return Decimal(value)


def _job_capabilities(dynamic: dict[str, Any]) -> JobCapabilities | None:
    """The model descriptor the app read from provider metadata (#279), or None when absent.

    Closed and typed like the contract's `DynamicModelCapabilities`. It never carries a command,
    endpoint or credential, and a malformed one is a refused job, not a guess.
    """
    if "capabilities" not in dynamic:
        return None
    document = _object(dynamic["capabilities"], "dynamic.capabilities")
    _check_fields(document, _CAPABILITY_FIELDS, "dynamic.capabilities.")
    prices = {"inputUsdPerMtok", "outputUsdPerMtok"} & document.keys()
    if len(prices) == 1:
        raise _invalid("dynamic.capabilities must name both unit prices or neither")
    return JobCapabilities(
        tool_choice_required=_capability_boolean(document, "toolChoiceRequired"),
        structured_output=_capability_boolean(document, "structuredOutput"),
        max_output_tokens=_capability_integer(document, "maxOutputTokens", MAX_OUTPUT_TOKENS_LIMIT),
        context_window_tokens=_capability_integer(
            document, "contextWindowTokens", MAX_WINDOW_TOKENS_LIMIT
        ),
        input_usd_per_mtok=_unit_price(document, "inputUsdPerMtok") if prices else None,
        output_usd_per_mtok=_unit_price(document, "outputUsdPerMtok") if prices else None,
    )


def _claim_base(data: dict[str, Any]) -> ClaimBase:
    """The checkout facts (#195). `comparison` is a declared mode, not proof of completeness."""
    base = _section(data, "base")
    _check_fields(base, _BASE_FIELDS, "base.")
    repository = _string(base, "repository", "base.", max_chars=200)
    base_ref = _string(base, "baseRef", "base.", max_chars=255)
    head_sha = _string(base, "headSha", "base.")
    if not _LOWER_SHA.fullmatch(head_sha):
        raise _invalid("base.headSha must be a 40 character lower-case commit id")
    # Required, like the schema: a tagged Dynamic job always states the previous reviewed head.
    if "previousReviewedSha" not in base:
        raise _invalid("base.previousReviewedSha is required")
    previous = base["previousReviewedSha"]
    if previous is not None and (
        not isinstance(previous, str) or not _LOWER_SHA.fullmatch(previous)
    ):
        raise _invalid(
            "base.previousReviewedSha must be null or a 40 character lower-case commit id"
        )
    attempted = _attempted_shas(base)
    comparison = _string(base, "comparison", "base.")
    if comparison not in _COMPARISONS:
        raise _invalid("base.comparison must be 'full' or 'incremental'")
    return ClaimBase(
        repository=repository,
        base_ref=base_ref,
        head_sha=head_sha,
        previous_reviewed_sha=previous,
        comparison=comparison,
        attempted_shas=attempted,
        attempted_shas_truncated=_attempted_shas_truncated(base),
    )


def _attempted_shas(base: dict[str, Any]) -> tuple[str, ...]:
    """The optional `attemptedShas` (#255): absent means none (an app from before the field)."""
    if "attemptedShas" not in base:
        return ()
    raw: object = base["attemptedShas"]
    if not isinstance(raw, list):
        raise _invalid(_ATTEMPTED_SHAS_DETAIL)
    items = cast("list[object]", raw)
    shas = [item for item in items if isinstance(item, str) and _LOWER_SHA.fullmatch(item)]
    if len(shas) != len(items) or len(items) > MAX_ATTEMPTED_SHAS or len(set(shas)) != len(shas):
        raise _invalid(_ATTEMPTED_SHAS_DETAIL)
    return tuple(shas)


def _attempted_shas_truncated(base: dict[str, Any]) -> bool:
    """The optional `attemptedShasTruncated` (#257): absent means false (an app from before it)."""
    if "attemptedShasTruncated" not in base:
        return False
    raw: object = base["attemptedShasTruncated"]
    if not isinstance(raw, bool):
        raise _invalid("base.attemptedShasTruncated must be a boolean")
    return raw


def _load_job(raw: str) -> dict[str, Any]:
    """The JSON object of the stdin text, or `JobError`."""
    if len(raw) > MAX_JOB_BYTES:
        raise _invalid("the job is larger than 1 MiB")
    try:
        data: Any = json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: absurdly deep nesting
        raise _invalid("stdin is not valid JSON") from None
    return _object(data, "the job")


def _matching(value: object, pattern: re.Pattern[str], path: str, what: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise _invalid(f"{path} must be {what}")
    return value


def _implementer_repo(spec: dict[str, Any], git: GitAccess) -> ImplementerRepo:
    """The repository of a turn. The job carries a token that may write it and the runner sends that
    token to `cloneUrl`: the address must be the provider's web host and exactly this repository,
    never another host, another repository or a loopback address (#762)."""
    repo = _section(spec, "repo")
    _check_fields(repo, _IMPLEMENTER_REPO_FIELDS, "implementer.repo.")
    full_name = _matching(
        repo.get("fullName"), _REPO_FULL_NAME, "implementer.repo.fullName", "owner/name"
    )
    clone_url = _matching(
        repo.get("cloneUrl"), _CLONE_URL, "implementer.repo.cloneUrl", "an https URL"
    )
    parts = _checked_url(clone_url, "implementer.repo.cloneUrl")
    if parts.netloc != _web_host(git.base_url):
        raise _invalid("implementer.repo.cloneUrl must point to the host of git.baseUrl")
    if parts.path not in (f"/{full_name}", f"/{full_name}.git"):
        raise _invalid(
            "implementer.repo.cloneUrl must be https://<host>/<owner>/<name>[.git] of "
            "implementer.repo.fullName"
        )
    return ImplementerRepo(full_name=full_name, clone_url=clone_url)


def _implementer_limits(spec: dict[str, Any]) -> ImplementerLimits:
    limits = _section(spec, "limits")
    _check_fields(limits, _IMPLEMENTER_LIMIT_FIELDS, "implementer.limits.")
    seconds = limits.get("timeLimitSeconds")
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, int)
        or not MIN_TIME_LIMIT_SECONDS <= seconds <= MAX_TIME_LIMIT_SECONDS
    ):
        raise _invalid(
            "implementer.limits.timeLimitSeconds must be an integer between "
            f"{MIN_TIME_LIMIT_SECONDS} and {MAX_TIME_LIMIT_SECONDS}"
        )
    return ImplementerLimits(time_limit_seconds=seconds)


def _implementer_spec(data: dict[str, Any], git: GitAccess) -> ImplementerSpec:
    """The `implementer` object (#746). Closed: an unknown field is refused. The instruction is
    literal data and is never interpreted. The cost policy and the model entry are required."""
    spec = _section(data, "implementer")
    _check_fields(spec, _IMPLEMENTER_FIELDS, "implementer.")
    instruction = spec.get("instruction")
    if not isinstance(instruction, str) or not 1 <= len(instruction) <= MAX_INSTRUCTION_CHARS:
        raise _invalid(
            f"implementer.instruction must be a string of 1 to {MAX_INSTRUCTION_CHARS} characters"
        )
    for name in ("cost", "modelEntry"):
        if name not in spec:
            raise _invalid(f"implementer.{name} is required")
    cost = _job_cost_policy(spec)
    entry = _job_model_entry(spec)
    assert cost is not None and entry is not None  # both keys are present, so both parse or raise
    base_branch = _matching(
        spec.get("baseBranch"), _BRANCH_NAME, "implementer.baseBranch", "a branch name"
    )
    branch = _matching(spec.get("branch"), _BRANCH_NAME, "implementer.branch", "a branch name")
    if branch == base_branch:
        raise _invalid("implementer.branch must differ from implementer.baseBranch")
    return ImplementerSpec(
        repo=_implementer_repo(spec, git),
        base_branch=base_branch,
        branch=branch,
        instruction=instruction,
        limits=_implementer_limits(spec),
        cost=cost,
        model_entry=entry,
        capabilities=_job_capabilities(spec),
        environment=_implementer_environment(spec),
        profile=_implementer_profile(spec),
    )


def _implementer_environment(spec: dict[str, Any]) -> ImplementerEnvironment | None:
    """The `implementer.environment` object (#818). Closed. A script of only white space is no
    script: the Worker would have nothing to run, so the app does not send one. `network` is the
    environment's rule for the agent's network (#745, step 7); absent is `off`."""
    if "environment" not in spec:
        return None
    given = _object(spec["environment"], "implementer.environment")
    _check_fields(given, _IMPLEMENTER_ENVIRONMENT_FIELDS, "implementer.environment.")
    name, script = given.get("name"), given.get("setupScript", "")
    if not isinstance(name, str) or not 1 <= len(name) <= MAX_ENVIRONMENT_NAME_CHARS:
        raise _invalid(
            "implementer.environment.name must be a string of 1 to "
            f"{MAX_ENVIRONMENT_NAME_CHARS} characters"
        )
    if "setupScript" not in given and "network" not in given:
        raise _invalid("implementer.environment must carry a setupScript or a network rule")
    if "setupScript" in given and (not isinstance(script, str) or not script.strip()):
        raise _invalid("implementer.environment.setupScript must be a non-empty string")
    assert isinstance(script, str)
    try:
        too_long = len(script.encode("utf-8")) > MAX_SETUP_SCRIPT_BYTES
    except UnicodeEncodeError:  # half of a character: not text
        too_long = True
    if "\x00" in script or too_long:
        raise _invalid(
            "implementer.environment.setupScript must be text of at most "
            f"{MAX_SETUP_SCRIPT_BYTES} bytes without a NUL"
        )
    rule = OFF
    if "network" in given:
        try:
            rule = parse_rule(given["network"], "implementer.environment.network")
        except RuleError as error:
            raise _invalid(str(error)) from None
    return ImplementerEnvironment(name=name, setup_script=script, network=rule)


def _implementer_profile(spec: dict[str, Any]) -> ImplementerProfile | None:
    """The `implementer.profile` object (#843). Closed; every refusal names the field and never a
    value (the instructions are a member's text and are not echoed)."""
    if "profile" not in spec:
        return None
    given = _object(spec["profile"], "implementer.profile")
    _check_fields(given, _IMPLEMENTER_PROFILE_FIELDS, "implementer.profile.")
    name = given.get("name")
    if not isinstance(name, str) or _PROFILE_NAME.fullmatch(name) is None:
        raise _invalid("implementer.profile.name must be a lower case profile name")
    version = given.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise _invalid("implementer.profile.version must be an integer of 1 or more")
    can_push = given.get("canPush")
    if not isinstance(can_push, bool):
        raise _invalid("implementer.profile.canPush must be true or false")
    instructions = ""
    if "instructions" in given:
        text = given["instructions"]
        if not isinstance(text, str) or not 1 <= len(text) <= MAX_PROFILE_INSTRUCTION_CHARS:
            raise _invalid(
                "implementer.profile.instructions must be a string of 1 to "
                f"{MAX_PROFILE_INSTRUCTION_CHARS} characters"
            )
        instructions = text
    return ImplementerProfile(
        name=name, version=version, can_push=can_push, instructions=instructions
    )


def _implementer_input(job: dict[str, Any]) -> ImplementerInput:
    _check_fields(job, _IMPLEMENTER_TOP_LEVEL_FIELDS, "")
    git = _git_access(job)
    spec = _implementer_spec(job, git)
    # A native job only: its provider may be a provider of the catalog, and the key goes to the
    # address of the entry and to no other.
    llm = _llm_access(job, catalog=True, catalog_model_id=True)
    _entry_is_of_llm(spec.model_entry, llm, "implementer.modelEntry")
    raw_spec = _section(job, "implementer")
    return ImplementerInput(
        git=git,
        llm=llm,
        implementer=spec,
        env=_env(job),
        model_access={
            "llm": job["llm"],
            "modelEntry": raw_spec["modelEntry"],
            "cost": raw_spec["cost"],
        },
    )


def parse_model_access(document: object) -> tuple[LlmAccess, JobModelEntry, CostPolicy]:
    """The model access of an Implementer turn from `ImplementerInput.model_access`, judged by the
    rules of the job itself (#745, step 3): the `llm` section of a task, the model entry and the
    cost policy, and the entry must be of the provider the key belongs to. Raises `JobError`."""
    data = _object(document, "the model access")
    _check_fields(data, {"llm", "modelEntry", "cost"}, "")
    for name in ("llm", "modelEntry", "cost"):
        if name not in data:
            raise _invalid(f"{name} is required")
    llm = _llm_access(data, catalog=True, catalog_model_id=True)
    cost = _job_cost_policy(data)
    entry = _job_model_entry(data)
    assert cost is not None and entry is not None  # both keys are present
    _entry_is_of_llm(entry, llm, "modelEntry")
    return llm, entry, cost


def parse_implementer_input(raw: str) -> ImplementerInput:
    """Parse and validate an implementer job (#746). Raises JobError; never returns a half valid
    job. `parse_job` refuses the kind; `parse_runnable_job` is the one the runner runs it from."""
    job = _load_job(raw)
    if job.get("reviewKind") != ReviewKind.IMPLEMENTER.value:
        raise _invalid("reviewKind must be 'implementer'")
    return _implementer_input(job)


def _implementer_engine_unavailable() -> JobError:
    return JobError(
        ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
        "this runner has no engine for implementer jobs",
    )


def parse_job(raw: str) -> Job:
    """Parse and validate the stdin text. Raises JobError; never returns a half valid job.

    A job of the implementer kind (#746) is validated and then refused with
    `implementer_engine_unavailable`: this function is the review path, and the kind is never read
    as a Diff or Dynamic job. The one that runs it is `parse_runnable_job` (#765)."""
    job = _load_job(raw)
    if job.get("reviewKind") == ReviewKind.IMPLEMENTER.value:
        _implementer_input(job)
        raise _implementer_engine_unavailable()
    return _review_job(job)


def parse_runnable_job(raw: str) -> Job | ImplementerInput:
    """`parse_job` for the code that can run every kind (the job host and the job process, #765):
    an implementer job is validated into its own type, anything else is parsed as before. The
    caller decides whether this runner may run the kind (`implementer` advertised)."""
    job = _load_job(raw)
    if job.get("reviewKind") == ReviewKind.IMPLEMENTER.value:
        return _implementer_input(job)
    return _review_job(job)


def _review_job(job: dict[str, Any]) -> Job:
    command = _command(job)
    review_kind = _review_kind(job)
    # `args` (the legacy question of the removed `/ask`) is an allowed field so a previous release's
    # payload still parses for a review; it is never read, so it never reaches PR-Agent.
    _check_fields(job, _TOP_LEVEL_FIELDS, "")
    if review_kind is ReviewKind.DYNAMIC:
        dynamic = _dynamic_review(job)
        base = _claim_base(job)
    elif review_kind is ReviewKind.DIFF:
        if "dynamic" in job or "base" in job:
            raise _invalid("a diff job must not carry dynamic options")
        dynamic = None
        base = None
    else:
        raise _implementer_engine_unavailable()
    git = _git_access(job)
    llm = _llm_access(job, catalog=dynamic is not None and dynamic.model_entry is not None)
    if dynamic is not None:
        _entry_matches(dynamic, llm)
    return Job(
        pr_url=_pr_url(job, git),
        command=command,
        git=git,
        llm=llm,
        env=_env(job),
        review_kind=review_kind,
        dynamic=dynamic,
        base=base,
    )
