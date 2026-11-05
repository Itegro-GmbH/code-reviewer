# SPDX-License-Identifier: LicenseRef-Proprietary

"""Support for the engine tests of the Claude Code adapter (#856; not a test file): the verified
pinned executable, the strict history rule of the fake provider and one run of `claude -p` the way
the adapter starts it, in a directory of a test."""

import json
import os
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.upstream import Refusal, ScriptedUpstream

from code_reviewer_runner.implementer import finish_tool
from code_reviewer_runner.implementer.claude_code.command import (
    ClaudeCommand,
    SessionChoice,
    claude_environment,
)
from code_reviewer_runner.implementer.claude_code.events import (
    ClaudeEvents,
    ClaudeResult,
    LineSplitter,
    parse_result,
)
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin

BINARY_VARIABLE = "CLAUDE_CODE_BIN"
DEFAULT_BINARY = (
    Path.home() / ".cache" / "code-reviewer" / "claude-code" / "node_modules/.bin/claude"
)
# A made-up key: accepted by the fake and by nothing else (built from pieces: the secret scan of
# the repository flags anything shaped like a key).
FAKE_KEY = "sk-" + "ant-" + "api03-engine-made-up-key-not-real-000000000000"
MODEL = "claude-sonnet-4-5"
SMALL_MODEL = "claude-haiku-4-5"
SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"


def claude_binary() -> Path:
    """The verified pinned executable. Absence is a failure with the fix, never a skip."""
    override = os.environ.get(BINARY_VARIABLE)
    path = Path(override) if override else DEFAULT_BINARY
    if not path.is_file():
        raise AssertionError(
            f"the pinned Claude Code is not installed ({path}): run "
            "`uv run python scripts/fetch_claude_code.py` once (it needs npm and the internet)"
        )
    return path


def strict_history(_headers: Mapping[str, str], body: Mapping[str, Any]) -> Refusal | None:
    """The strict side of the fake: a history the real API would refuse is refused. The first
    message is the user's, every `tool_use` of an assistant message is answered by a `tool_result`
    of its id in the user message after it, and a `tool_result` answers nothing else."""
    messages = cast("list[dict[str, Any]]", body.get("messages") or [])

    def refuse(why: str) -> Refusal:
        return 400, {
            "type": "error",
            "error": {"type": "invalid_request_error", "message": f"messages: {why}"},
        }

    if not messages or messages[0].get("role") != "user":
        return refuse("the first message must be a user message")
    pending: set[str] = set()
    for index, message in enumerate(messages):
        content: Any = message.get("content")
        blocks = cast("list[dict[str, Any]]", content) if isinstance(content, list) else []
        if message.get("role") == "assistant":
            pending = {str(b.get("id")) for b in blocks if b.get("type") == "tool_use"}
            continue
        answered = {str(b.get("tool_use_id")) for b in blocks if b.get("type") == "tool_result"}
        if answered != pending:
            return refuse(
                f"the tool_result ids of message {index} do not match the tool_use before"
            )
        pending = set()
    if pending:
        return refuse("the last message has a tool_use that nothing answers")
    return None


def provider(script: Sequence[Any]) -> ScriptedUpstream:
    return ScriptedUpstream(
        "messages",
        script,
        MODEL,
        real_key=FAKE_KEY,
        judge=strict_history,
        also_models=[SMALL_MODEL],
    )


@dataclass
class Turn:
    returncode: int
    events: list[dict[str, Any]]
    stderr: str
    ignored: int

    @property
    def result(self) -> ClaudeResult:
        """The end of the turn, read as the adapter reads it (with the `error` of a failed call)."""
        adapter = ClaudeEvents("engine-test")
        for event in self.events:
            adapter.convert(event)
        ended = next(e for e in reversed(self.events) if e.get("type") == "result")
        return parse_result(ended, adapter.take_api_error())

    @property
    def init(self) -> dict[str, Any]:
        return next(e for e in self.events if e.get("subtype") == "init")


class Workplace:
    """A directory with a repository, a home for Claude Code and the finish tool's files."""

    def __init__(self, root: Path, schema: Mapping[str, Any] | None = None) -> None:
        self.repo = root / "repo"
        self.home = root / "home"
        self.config = self.home / ".claude"
        self.result_file = root / "result.json"
        self.schema_file = root / "schema.json"
        self.tool = root / "factory-submit"
        self.repo.mkdir()
        self.config.mkdir(parents=True)
        (self.repo / "notes.txt").write_text("hello\n")
        subprocess.run(
            "git init -q && git add . && git -c user.email=a@b -c user.name=t commit -qm init",
            shell=True,
            cwd=self.repo,
            check=True,
        )
        self.schema = schema
        if schema is not None:
            self.schema_file.write_text(json.dumps(schema))
            source = Path(finish_tool.__file__).read_bytes()
            self.tool.write_bytes(f"#!{sys.executable} -I\n".encode() + source)
            self.tool.chmod(0o755)

    def run(
        self,
        provider_url: str,
        prompt: str,
        *,
        session: SessionChoice | None = None,
        logged_in: bool = True,
        timeout: float = 120.0,
        max_budget_usd: str | None = None,
        setting_sources: str | None = None,
        extra_environment: Mapping[str, str] | None = None,
    ) -> Turn:
        """One `claude -p`, started with the adapter's own command line and environment, as the
        user of the test (not root, so bypass mode needs no switch). `extra_environment` is added to
        the adapter's own, for a control."""
        command = ClaudeCommand(
            model=MODEL,
            session=session or SessionChoice.new(SESSION),
            finish_command=None
            if self.schema is None
            else (sys.executable, "-I", str(self.tool), "mcp"),
            instructions="Rules of this workplace.",
            max_budget_usd=max_budget_usd,
        )
        environment = claude_environment(ClaudeLogin.api_key(FAKE_KEY), base_url=provider_url)
        if not logged_in:
            environment.pop("ANTHROPIC_API_KEY")
        environment.update(
            {
                "HOME": str(self.home),
                "CLAUDE_CONFIG_DIR": str(self.config),
                "PATH": f"{claude_binary().parent}:{os.environ['PATH']}",
                "FACTORY_RESULT_SCHEMA": str(self.schema_file),
                "FACTORY_RESULT_FILE": str(self.result_file),
                "TMPDIR": str(self.home),
            }
        )
        environment.update(extra_environment or {})
        argv = command.argv()
        argv[0] = str(claude_binary())
        if setting_sources is not None:  # a control: what the adapter's own line keeps out
            argv[argv.index("--setting-sources") + 1] = setting_sources
            argv.remove("--strict-mcp-config")
        done = subprocess.run(
            argv,
            input=prompt.encode(),
            cwd=self.repo,
            env=environment,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        splitter = LineSplitter()
        events = splitter.feed(done.stdout) + splitter.finish()
        return Turn(done.returncode, events, done.stderr.decode(errors="replace"), splitter.ignored)
