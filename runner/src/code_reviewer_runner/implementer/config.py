# SPDX-License-Identifier: LicenseRef-Proprietary

"""The trusted engine configuration and environment of the Implementer's agent (#764).

The same skeleton as the Dynamic Review's (`dynamic_review/config.py`): the runner writes the
configuration itself, the repository cannot change it, the provider is the loopback proxy of the job
with the job's capability and the one chosen model, and everything that discovers, installs or
shares is off. What differs is the tool set: the agent writes. Permissions are default-deny, then
`read`, `grep`, `glob`, `list`, `edit`, `write`, `bash` and `todowrite` are allowed; the tools that
leave the machine or ask a person (`webfetch`, `websearch`, `task`, `question`) are denied by name
and every other, present or future, by the wildcard.

The engine runs as root in the agent's own container (#745, step 4), where it is free: what the
repository brings (its `opencode.json`, `.opencode/`, instruction files and skills) may apply, and
the engine's project discovery is on. What no file of the repository can change is what the model
door holds: the model (the door refuses any other), the cost limit, the output cap and the key (the
engine only holds a bearer that is worth nothing anywhere else), and the agent has no address to
send a request to other than the door's. The runner's own configuration below is a
`OPENCODE_CONFIG` file; a repository's file is merged over it and cannot take those away.
"""

from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.config import checked_native_provider
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily

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
    door_host: str | None = None,
) -> dict[str, Any]:
    """The whole engine configuration of one turn, as data the runner writes itself.

    `provider` is the `provider` object of the job's model entry
    (`job_model_entry.native_provider_config`): one provider with the SDK of the family, the
    loopback proxy as `baseURL`, the job's capability as `apiKey` and the one model. It is
    **asserted**, not trusted (`checked_native_provider`): a key the proxy did not expect, such as
    `headers`, would be the one way around it. The real key and the upstream address are not
    parameters of this function.
    """
    checked_native_provider(
        provider, model_reference, family, proxy_url, capability, door_host=door_host
    )
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


# The engine's environment (#745, step 4). Nothing here restricts what the agent may do or use; the
# flags keep the engine from reaching for a network it does not have (the model list, an update, a
# language server, a plugin package, a share link, telemetry), which would only make it wait.
_ENGINE_FLAGS: dict[str, str] = {
    "OPENCODE_PURE": "true",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
    "OPENCODE_DISABLE_MODELS_FETCH": "true",
    "OPENCODE_DISABLE_AUTOUPDATE": "true",
    "OPENCODE_DISABLE_LSP_DOWNLOAD": "true",
    "OPENCODE_DISABLE_FFF": "true",
    "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true",
    "OPENCODE_DISABLE_EMBEDDED_WEB_UI": "true",
    "OPENCODE_DISABLE_SHARE": "true",
    "OPENCODE_DISABLE_TELEMETRY": "true",
    "DO_NOT_TRACK": "1",
}
AGENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def implementer_environment(*, home: str, scratch_dir: str) -> dict[str, str]:
    """The environment of the engine, which its tools inherit: the flags above, the agent's home and
    scratch directory, `PATH` and the few variables that make tools behave in a place nobody
    watches. Built from names, never by inheriting. It carries no credential of any kind; the
    container has none to give."""
    environment = dict(_ENGINE_FLAGS)
    environment["HOME"] = home
    environment["XDG_CONFIG_HOME"] = f"{home}/.config"
    environment["XDG_DATA_HOME"] = f"{home}/.local/share"
    environment["XDG_CACHE_HOME"] = f"{home}/.cache"
    environment["XDG_STATE_HOME"] = f"{home}/.local/state"
    environment["TMPDIR"] = scratch_dir
    environment["CI"] = "1"
    environment["NO_COLOR"] = "1"
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["PATH"] = AGENT_PATH
    return environment
