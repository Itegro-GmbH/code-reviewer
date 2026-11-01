# SPDX-License-Identifier: LicenseRef-Proprietary

"""The trusted engine configuration and environment of the Implementer's agent (#764).

The same skeleton as the Dynamic Review's (`dynamic_review/config.py`): the runner writes the
configuration itself, the repository cannot change it, the provider is the loopback proxy of the job
with the job's capability and the one chosen model, and everything that discovers, installs or
shares is off. What differs is the tool set: the agent writes. Permissions are default-deny, then
`read`, `grep`, `glob`, `list`, `edit`, `write`, `bash` and `todowrite` are allowed; the tools that
leave the machine or ask a person (`webfetch`, `websearch`, `task`, `question`) are denied by name
and every other, present or future, by the wildcard.

Nothing executable or configurable comes from the repository (owner rule): no plugin, no MCP server,
no LSP, no formatter, no setup script, and no repository skill or instruction file (the discovery
flags of the engine are on, `skills.paths` is empty). The flags are not a proof of isolation on
their own (spike #85); the engine user, the read-only guard files and the closed network are.
"""

from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.config import (
    checked_native_provider,
    engine_environment,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily

from .egress_config import EgressSettings, apply_egress_environment

# The one agent the run may use; the request names it and may name no other.
IMPLEMENTER_AGENT = "implementer"
SESSION_TITLE = "code-reviewer-implementer"
ALLOWED_TOOLS: tuple[str, ...] = (
    "read",
    "grep",
    "glob",
    "list",
    "edit",
    "write",
    "bash",
    "todowrite",
    # Paths outside the repository: `bash` reaches them anyway, and a refusal only adds friction
    # (`mkdir`, `cat`, `cd`, `rm` outside /work/repo were refused, with the rules shown to the
    # model).
    "external_directory",
)
# Denied by name as well as by the wildcard, so a reader of the file sees the decision.
DENIED_TOOLS: tuple[str, ...] = ("webfetch", "websearch", "task", "question")


def permission_block() -> dict[str, str]:
    """Default-deny first, then the explicit allows and denies (the wildcard is read first)."""
    permissions = {"*": "deny"}
    permissions.update(dict.fromkeys(ALLOWED_TOOLS, "allow"))
    permissions.update(dict.fromkeys(DENIED_TOOLS, "deny"))
    return permissions


def build_engine_config(
    *,
    provider: Mapping[str, Any],
    model_reference: str,
    family: WireFamily,
    proxy_url: str,
    capability: str,
    instructions_path: str,
) -> dict[str, Any]:
    """The whole engine configuration of one turn, as data the runner writes itself.

    `provider` is the `provider` object of the job's model entry
    (`job_model_entry.native_provider_config`): one provider with the SDK of the family, the
    loopback proxy as `baseURL`, the job's capability as `apiKey` and the one model. It is
    **asserted**, not trusted (`checked_native_provider`): a key the proxy did not expect, such as
    `headers`, would be the one way around it. The real key and the upstream address are not
    parameters of this function.
    """
    checked_native_provider(provider, model_reference, family, proxy_url, capability)
    if not instructions_path.startswith("/"):
        raise ValueError("the instruction file must be an absolute path the runner wrote")
    return {
        "permission": permission_block(),
        "agent": {
            IMPLEMENTER_AGENT: {
                "description": "Implementer: carries out one task in the repository",
                "mode": "primary",
                "model": model_reference,
                # No `prompt`: the agent keeps the stock prompt of the engine for its model; the
                # runner's addition is the instruction file below.
            }
        },
        "provider": dict(provider),
        "enabled_providers": list(provider),
        # The one instruction file: the runner's own (`prompts.instructions_text`), written into the
        # engine user's trusted directory. No instruction file or skill of the repository.
        "instructions": [instructions_path],
        "skills": {"paths": []},
        "plugin": [],
        "mcp": {},
        "lsp": False,
        "formatter": False,
        "snapshot": False,
        "share": "disabled",
        "autoupdate": False,
        # Compaction is on, as the stock engine has it: a long task fills the window, and the
        # engine summarises and goes on. (Dynamic turns it off because its return tool is lost
        # after one; the Implementer has no such tool.)
        "compaction": {"auto": True, "prune": True},
    }


_COMPACTION_FLAGS = ("OPENCODE_DISABLE_AUTOCOMPACT", "OPENCODE_DISABLE_PRUNE")
# What the engine takes from the workspace's environment: git's guard, the identity and the config
# that points git at the guard. PATH and HOME are composed here, and nothing else passes.
_WORKSPACE_NAMES = (
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TERMINAL_PROMPT",
    "CODE_REVIEWER_GUARD_CONF",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
)


def implementer_environment(
    workspace: Mapping[str, str],
    *,
    home: str,
    scratch_dir: str,
    tools_dir: str | None,
    egress: EgressSettings,
) -> dict[str, str]:
    """The environment of the engine, which its tools inherit (#764): the flags of the Dynamic
    engine, the private home, a minimal `PATH` (the verified tools first, then the workspace's,
    which holds the git of the guard), the git identity and guard variables of the workspace
    (`GitWorkspace.agent_environment`) and the egress proxy variables (#763). Built from names,
    never by inheriting: no credential of any kind, no `NO_PROXY`.

    `workspace` must be the workspace's own environment (`GitWorkspace.agent_environment()`); only
    the names above are taken from it."""
    environment = engine_environment(
        proxy_url="",
        home=home,
        scratch_dir=scratch_dir,
        node_bin=None,
        tools_dir=None,
    )
    # Compaction and pruning are the engine's own (see `build_engine_config`).
    for name in _COMPACTION_FLAGS:
        environment.pop(name, None)
    # A variable of the review engine that names the proxy and that nothing here reads.
    environment.pop("REVIEW_PROXY_URL", None)
    path = workspace.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    environment["PATH"] = f"{tools_dir}:{path}" if tools_dir else path
    for name in _WORKSPACE_NAMES:
        if name in workspace:
            environment[name] = workspace[name]
    return apply_egress_environment(environment, egress)
