# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: how the runner starts Claude Code headless in the agent's container: the command line, the
environment, the login that comes from the device and the user it runs as. Pure: nothing is run."""

import json
import os
import stat
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.claude_code.command import (
    AGENT_USER,
    CONFIG_DIRECTORY,
    FINISH_SERVER,
    ClaudeCommand,
    SessionChoice,
    claude_environment,
)
from code_reviewer_runner.implementer.claude_code.login import (
    ClaudeLogin,
    LoginProblem,
    load_login,
)

# Made up. Built from pieces: the secret scan of the repository flags anything shaped like a key.
TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
KEY = "sk-" + "ant-" + "api03-made-up-key-not-real-0000000000000000"
SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"


def command(**changes: object) -> ClaudeCommand:
    base: dict[str, object] = {"model": "claude-sonnet-4-5", "session": SessionChoice.new(SESSION)}
    base.update(changes)
    return ClaudeCommand(**base)  # type: ignore[arg-type]


# #856-T05
def test_the_command_is_headless_with_streamed_events_and_partial_messages() -> None:
    argv = command().argv()

    assert argv[:2] == ["claude", "-p"]
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv
    # Only `message_delta` carries the real token counts of a call.
    assert "--include-partial-messages" in argv
    assert argv[argv.index("--model") + 1] == "claude-sonnet-4-5"


# #856-T05
def test_the_agent_is_free_inside_the_sandbox_with_no_closed_list_of_tools() -> None:
    argv = command().argv()
    joined = " ".join(argv)

    assert argv[argv.index("--permission-mode") + 1] == "bypassPermissions"
    assert "allowedTools" not in joined and "allowed-tools" not in joined
    assert "--dangerously-skip-permissions" not in argv


# #856-T05
def test_what_the_repository_holds_cannot_change_settings_or_servers() -> None:
    argv = command().argv()

    assert argv[argv.index("--setting-sources") + 1] == "user"
    assert "--strict-mcp-config" in argv


# #856-T06
def test_a_new_session_gets_its_id_and_a_follow_up_resumes_the_stored_one() -> None:
    new = command(session=SessionChoice.new(SESSION)).argv()
    again = command(session=SessionChoice.resume(SESSION)).argv()

    assert new[new.index("--session-id") + 1] == SESSION and "--resume" not in new
    assert again[again.index("--resume") + 1] == SESSION and "--session-id" not in again


# #856-T06
def test_a_session_id_that_is_not_an_id_is_refused_before_it_can_be_an_option() -> None:
    for bad in ("--dangerously-skip-permissions", "../x", "", "abc", SESSION + " -x"):
        with pytest.raises(ValueError):
            SessionChoice.resume(bad)
        with pytest.raises(ValueError):
            SessionChoice.new(bad)


# #856-T07
def test_the_finish_tool_is_a_stdio_server_of_the_container_named_in_the_command() -> None:
    argv = command(
        finish_command=("/usr/local/bin/python3", "-I", "/etc/code-reviewer/factory-submit", "mcp")
    ).argv()

    document = json.loads(argv[argv.index("--mcp-config") + 1])

    assert document == {
        "mcpServers": {
            FINISH_SERVER: {
                "type": "stdio",
                "command": "/usr/local/bin/python3",
                "args": ["-I", "/etc/code-reviewer/factory-submit", "mcp"],
            }
        }
    }


# #856-T07
def test_a_turn_without_a_result_schema_has_no_server_at_all() -> None:
    assert "--mcp-config" not in command().argv()


# #856-T08
def test_a_cost_brake_and_the_instructions_are_options_and_the_prompt_is_not() -> None:
    argv = command(max_budget_usd="1.50", instructions="Rules of this workplace").argv()

    assert argv[argv.index("--max-budget-usd") + 1] == "1.50"
    assert argv[argv.index("--append-system-prompt") + 1] == "Rules of this workplace"
    # The prompt travels on standard input: no argument list limit, nothing in `ps`.
    assert "Fix the bug" not in " ".join(command().argv())


# #856-T08
def test_a_budget_that_is_not_an_amount_is_refused() -> None:
    for bad in ("0", "-1", "abc", "1e3", "1.50 --x", ""):
        with pytest.raises(ValueError):
            command(max_budget_usd=bad).argv()


# #856-T09
def test_the_login_is_in_the_environment_and_never_in_the_command_line() -> None:
    login = ClaudeLogin.oauth_token(TOKEN)
    environment = claude_environment(login)

    assert environment["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert "ANTHROPIC_API_KEY" not in environment
    assert TOKEN not in " ".join(command().argv())
    assert TOKEN not in repr(login) and TOKEN not in str(login)


# #856-T09
def test_an_api_key_login_is_the_key_alone_for_a_provider_the_runner_names() -> None:
    environment = claude_environment(ClaudeLogin.api_key(KEY), base_url="http://10.0.0.2:8080")

    assert environment["ANTHROPIC_API_KEY"] == KEY
    assert environment["ANTHROPIC_BASE_URL"] == "http://10.0.0.2:8080"
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in environment


# #856-T05
def test_the_environment_is_built_from_names_and_keeps_every_other_door_shut() -> None:
    environment = claude_environment(ClaudeLogin.oauth_token(TOKEN))

    assert environment["ENABLE_TOOL_SEARCH"] == "false"
    assert environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert environment["DISABLE_AUTOUPDATER"] == "1"
    # The login is scrubbed from the environment of the tools the agent runs (the engine test
    # proves it with the real program).
    assert environment["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] == "1"
    assert environment["CLAUDE_CONFIG_DIR"] == CONFIG_DIRECTORY
    assert environment["HOME"].startswith("/home/")
    # The undocumented switch that lets root run in bypass mode is not relied on.
    assert "IS_SANDBOX" not in environment
    assert set(environment) <= {
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
        "CLAUDE_CONFIG_DIR",
        "CI",
        "DISABLE_AUTOUPDATER",
        "ENABLE_TOOL_SEARCH",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
    }


# #856-T10
def test_claude_code_runs_as_a_user_that_is_not_root() -> None:
    assert AGENT_USER != "root" and not AGENT_USER.startswith("0")
    assert ":" in AGENT_USER


# -- the login of the device ---------------------------------------------------------------------


def write_token(directory: Path, text: str, mode: int = 0o600) -> Path:
    path = directory / "claude-code-token"
    path.write_text(text)
    path.chmod(mode)
    return path


# #856-T11
def test_the_token_comes_from_a_private_file_of_the_device(tmp_path: Path) -> None:
    path = write_token(tmp_path, TOKEN + "\n")

    login = load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}, tmp_path)

    assert isinstance(login, ClaudeLogin)
    assert login.environment() == {"CLAUDE_CODE_OAUTH_TOKEN": TOKEN}


# #856-T11
def test_the_token_file_of_the_runner_home_is_found_without_a_variable(tmp_path: Path) -> None:
    write_token(tmp_path, TOKEN)

    assert isinstance(load_login({}, tmp_path), ClaudeLogin)


# #856-T11
def test_the_token_may_come_from_the_runners_environment(tmp_path: Path) -> None:
    login = load_login({"CLAUDE_CODE_OAUTH_TOKEN": TOKEN}, tmp_path)

    assert isinstance(login, ClaudeLogin)


# #856-T11
def test_no_token_is_a_problem_that_says_where_to_put_one(tmp_path: Path) -> None:
    problem = load_login({}, tmp_path)

    assert isinstance(problem, LoginProblem)
    assert "claude setup-token" in problem.text


# #856-T12
def test_a_token_file_others_can_read_is_refused_and_the_value_is_never_named(
    tmp_path: Path,
) -> None:
    path = write_token(tmp_path, TOKEN, mode=0o644)

    problem = load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}, tmp_path)

    assert isinstance(problem, LoginProblem)
    assert "0600" in problem.text and TOKEN not in problem.text
    assert stat.S_IMODE(path.stat().st_mode) == 0o644


# #856-T12
def test_the_mode_of_the_token_file_is_checked_for_root_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A runner that runs as root is the one most likely to be handed a careless file."""
    path = write_token(tmp_path, TOKEN, mode=0o640)
    monkeypatch.setattr(os, "geteuid", lambda: path.stat().st_uid)  # the owner, root or not

    problem = load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}, tmp_path)

    assert isinstance(problem, LoginProblem) and "0600" in problem.text

    monkeypatch.setattr(os, "geteuid", lambda: 0)
    as_root = load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}, tmp_path)
    assert isinstance(as_root, LoginProblem), "never a login for root from this file"


# #856-T12
def test_a_token_file_of_another_owner_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = write_token(tmp_path, TOKEN)
    monkeypatch.setattr(os, "geteuid", lambda: path.stat().st_uid + 1)

    problem = load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}, tmp_path)

    assert isinstance(problem, LoginProblem)
    assert "owned by" in problem.text and TOKEN not in problem.text


# #856-T12
def test_a_token_that_is_empty_or_has_spaces_or_lines_is_refused_without_its_value(
    tmp_path: Path,
) -> None:
    for text in ("", "   \n", "two words", TOKEN + "\n" + TOKEN, "x" * 5000):
        path = write_token(tmp_path, text)
        problem = load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(path)}, tmp_path)

        assert isinstance(problem, LoginProblem)
        assert text.strip() == "" or text.split()[0] not in problem.text


# #856-T12
def test_a_token_file_that_is_a_link_or_missing_is_refused(tmp_path: Path) -> None:
    real = write_token(tmp_path, TOKEN)
    link = tmp_path / "link"
    link.symlink_to(real)

    assert isinstance(
        load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(link)}, tmp_path), LoginProblem
    )
    assert isinstance(
        load_login({"FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE": str(tmp_path / "none")}, tmp_path),
        LoginProblem,
    )
