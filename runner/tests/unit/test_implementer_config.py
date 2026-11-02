# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engine configuration and the engine environment of the Implementer's agent (#764).

Both are written by the runner and nothing else: the repository, the job text and the model have no
say in either. The golden configuration below is the whole of what the pinned engine is told.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.config import PROXY_PROVIDER_ID, NativeConfigRefused
from code_reviewer_runner.dynamic_review.job_model_entry import (
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.implementer.config import (
    IMPLEMENTER_AGENT,
    build_engine_config,
    implementer_environment,
)
from code_reviewer_runner.job import parse_implementer_input

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
PROXY_URL = "http://127.0.0.1:41000"
CAPABILITY = "c" * 43
INSTRUCTIONS = "/run/engine/implementer-instructions.md"


def make_config(**overrides: Any) -> dict[str, Any]:
    entry = parse_implementer_input(EXAMPLE.read_text(encoding="utf-8")).implementer.model_entry
    family = WireFamily(entry.family)
    options: dict[str, Any] = {
        "provider": native_provider_config(
            entry, base_url=spec_of(family).proxy_base_url(PROXY_URL), api_key=CAPABILITY
        ),
        "model_reference": native_model_reference(entry),
        "family": family,
        "proxy_url": PROXY_URL,
        "capability": CAPABILITY,
        "instructions_path": INSTRUCTIONS,
    }
    options.update(overrides)
    return build_engine_config(**options)


GOLDEN_PERMISSIONS = {
    "*": "deny",
    "read": "allow",
    "grep": "allow",
    "glob": "allow",
    "list": "allow",
    "edit": "allow",
    "write": "allow",
    "bash": "allow",
    "todowrite": "allow",
    "external_directory": "allow",
    "webfetch": "deny",
    "websearch": "deny",
    "task": "deny",
    "question": "deny",
}


# #764-T01
def test_the_generated_config_is_the_golden_one() -> None:
    config = make_config()

    assert config == {
        "permission": GOLDEN_PERMISSIONS,
        "agent": {
            IMPLEMENTER_AGENT: {
                "description": "Implementer: carries out one task in the repository",
                "mode": "primary",
                "model": "openrouter/deepseek/deepseek-v4.1-flash",
                # no "prompt": the agent keeps the stock prompt of the engine
            }
        },
        "provider": {
            "openrouter": {
                "npm": "@openrouter/ai-sdk-provider",
                "options": {"baseURL": f"{PROXY_URL}/v1", "apiKey": CAPABILITY},
                "models": {
                    "deepseek/deepseek-v4.1-flash": config["provider"]["openrouter"]["models"][
                        "deepseek/deepseek-v4.1-flash"
                    ]
                },
            }
        },
        "enabled_providers": ["openrouter"],
        "instructions": [INSTRUCTIONS],
        "skills": {"paths": []},
        "plugin": [],
        "mcp": {},
        "lsp": False,
        "formatter": False,
        "snapshot": False,
        "share": "disabled",
        "autoupdate": False,
        "compaction": {"auto": True, "prune": True},
    }


# #764-T01
def test_default_deny_comes_first_and_every_other_tool_is_denied_by_the_wildcard() -> None:
    permission = make_config()["permission"]

    assert next(iter(permission)) == "*" and permission["*"] == "deny"
    allowed = {name for name, value in permission.items() if value == "allow"}
    assert allowed == {
        "read",
        "grep",
        "glob",
        "list",
        "edit",
        "write",
        "bash",
        "todowrite",
        "external_directory",
    }
    for name in ("webfetch", "websearch", "task", "question"):
        assert permission[name] == "deny"
    for name in ("skill", "lsp", "codesearch", "StructuredOutput"):
        assert name not in permission, "left to the wildcard"


# #764-T01
def test_nothing_that_discovers_or_installs_is_on_and_no_key_is_in_the_config() -> None:
    config = make_config()

    assert config["plugin"] == [] and config["mcp"] == {}
    assert config["lsp"] is False and config["formatter"] is False
    assert config["snapshot"] is False and config["share"] == "disabled"
    assert config["autoupdate"] is False
    assert config["instructions"] == [INSTRUCTIONS], (
        "the runner's file and nothing of the repository"
    )
    assert config["compaction"] == {"auto": True, "prune": True}, (
        "the engine compacts a full window"
    )
    assert "prompt" not in config["agent"][IMPLEMENTER_AGENT], "the stock prompt stays"
    assert config["skills"] == {"paths": []}, "repository skills are never loaded"
    assert len(config["provider"]) == 1 and len(config["agent"]) == 1
    assert next(iter(config["provider"].values()))["options"]["apiKey"] == CAPABILITY
    assert "headers" not in json.dumps(config)


# #764-T01
def test_the_provider_block_is_asserted_like_the_native_dynamic_one() -> None:
    entry = parse_implementer_input(EXAMPLE.read_text(encoding="utf-8")).implementer.model_entry
    block = native_provider_config(
        entry,
        base_url=spec_of(WireFamily(entry.family)).proxy_base_url(PROXY_URL),
        api_key=CAPABILITY,
    )
    block["openrouter"]["options"]["headers"] = {"x-evil": "1"}

    with pytest.raises(NativeConfigRefused):
        make_config(provider=block)
    with pytest.raises(NativeConfigRefused):
        make_config(capability="short")
    assert PROXY_PROVIDER_ID not in make_config()["provider"], "not the legacy proxy provider"


# -- the environment of the engine and of its tools -------------------------------------------

EXPECTED_NAMES = {
    # the flags of the engine that keep it from waiting for a network it does not have
    "OPENCODE_PURE",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_LSP_DOWNLOAD",
    "OPENCODE_DISABLE_FFF",
    "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
    "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
    "OPENCODE_DISABLE_SHARE",
    "OPENCODE_DISABLE_TELEMETRY",
    "DO_NOT_TRACK",
    # the agent's own place
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
    "CI",
    "NO_COLOR",
    "GIT_TERMINAL_PROMPT",
    "PATH",
}


def make_environment() -> dict[str, str]:
    return implementer_environment(home="/root", scratch_dir="/tmp")


# #745 step 4: the repository's own OpenCode files apply; nothing here switches them off.
def test_the_engine_environment_does_not_switch_off_the_repositorys_configuration_or_skills() -> None:
    environment = make_environment()

    for flag in (
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    ):
        assert flag not in environment


# #764-R2
def test_the_engine_environment_does_not_switch_compaction_off() -> None:
    environment = make_environment()

    assert "OPENCODE_DISABLE_AUTOCOMPACT" not in environment
    assert "OPENCODE_DISABLE_PRUNE" not in environment


# #764-R7
def test_the_instruction_file_must_be_an_absolute_path_the_runner_wrote() -> None:
    with pytest.raises(ValueError):
        make_config(instructions_path="implementer.md")


# #764-T02
def test_the_engine_environment_has_exactly_the_named_variables() -> None:
    assert set(make_environment()) == EXPECTED_NAMES


# #745 step 4: there is no proxy to point the tools at and no credential to give them.
def test_the_engine_environment_names_no_proxy_and_no_credential() -> None:
    environment = make_environment()

    assert not {name for name in environment if "proxy" in name.lower()}
    assert not {
        name
        for name in environment
        if any(word in name.upper() for word in ("TOKEN", "KEY", "SECRET", "PASSWORD", "GITHUB"))
    }
    assert "REVIEW_PROXY_URL" not in environment, "no variable of the review engine"


# #764-T02
def test_the_agents_home_and_path_are_the_roots() -> None:
    environment = make_environment()

    assert environment["HOME"] == "/root"
    assert environment["XDG_DATA_HOME"] == "/root/.local/share"
    assert environment["TMPDIR"] == "/tmp"
    assert environment["PATH"] == "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
