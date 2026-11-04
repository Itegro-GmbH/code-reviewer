# SPDX-License-Identifier: LicenseRef-Proprietary

"""The spikes R0 of the Factory-Runner (#853, `plans/customer-runner.md`): what the plan assumes about
running Claude Code headless in the agent's container (S1) and about the agent's own Docker on a
plain Linux host (S2), settled on a real VM before the runner (R1) is built.

    sudo python3 scripts/runner_spikes.py {s1,s2,all} [--out DIR] [--only LIST]

Run as root on a plain `spike-` VM (the platform's default image, Ubuntu 26.04; the script installs
`docker.io` itself and starts the daemon with `docker/sandbox/vm-prepare.sh`), with the repository's
`runner/`, `fakes/` and `docker/` on it. Standard library only (no `uv sync`). The script pulls
images, installs Claude Code from npm into an image, installs Sysbox from its release and removes
containers, networks and volumes by fixed names (`spike-`), so it refuses any host whose name does
not start with `spike-` unless `FOLLOW_UP_SPIKE_I_AM_ON_A_SPIKE_VM=1` is set (`spike_guard.py`).
It prints one JSON line per check (`{"check": ..., "ok": ...}`) and per measured fact
(`{"fact": ...}`), no secret, and keeps what it saw (the raw `stream-json` of every run, the
requests the strict provider received) in `--out`.

No real model, no real key, no subscription: the provider is the strict scripted Anthropic Messages
fake of `fakes/wire` behind a made-up key (it refuses a history the real API would refuse), and the
tokens that are tried for the login are made-up strings. The fake listens on the VM's address on an
`--internal` Docker network, the way the model door does, so a Claude Code that wants anything but
the one address it was given is refused (its traffic that fails is a fact too).

S1, Claude Code headless in a container (`--only` takes the names):

* `events`, `mcp`, `command`: one scripted turn that reads a file, runs a command, edits a file and
  ends, with the finish tool as a local MCP server (stdio in the container, and HTTP on the runner
  side), and as the command `factory-submit` through Claude Code's Bash tool. The raw events and the
  proposed mapping to the step records;
* `resume`: `--resume` in a new container with the session directory on a mounted volume;
* `permissions`: what an unattended run needs;
* `auth`: which environment variables and files carry the login, seen in the headers the provider
  receives;
* `cost`: the figure `result` carries for an API-key run.

S2, the agent's own Docker (`--only` takes `none`, `rootless`, `privileged`, `sysbox-plain`,
`sysbox`): the isolation each option needs from the host, the start time and a `docker run postgres`
inside the agent.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes.wire import upstream as upstream_module
from fakes.wire.formats import Turn
from fakes.wire.upstream import Refusal, ScriptedUpstream
from spike_guard import refuse_unless_spike_vm

from code_reviewer_runner.implementer.step_records import StepRecord
from code_reviewer_runner.redaction import Redactor

REPO = Path(__file__).resolve().parents[2]

# -- what S1 pins ----------------------------------------------------------------------------------

# The version of Claude Code the spike used (npm `stable` dist-tag on 2026-11-04). Pinned: the event
# shapes below are those of this version.
CLAUDE_CODE_VERSION = "2.1.311"
NODE_IMAGE = "node:24-bookworm-slim"
CLAUDE_IMAGE = f"spike-claude-code:{CLAUDE_CODE_VERSION}"
NETWORK = "spike-internal"
# A made-up key: it is accepted by the fake and by nothing else.
FAKE_KEY = "sk-ant-api03-spike-made-up-key-not-real-0000000000000000"
FAKE_OAUTH = "sk-ant-oat01-spike-made-up-token-not-real-000000000000"
FAKE_REFRESH = "sk-ant-ort01-spike-made-up-refresh-not-real-0000000000"
# A model Claude Code has a price for, and one it has not.
MODEL = "claude-sonnet-4-5"
UNKNOWN_MODEL = "spike-model-nobody-priced"
SMALL_MODEL = "claude-haiku-4-5"
IMAGE_DIR_NAME = "claude-image"


class Report:
    def __init__(self) -> None:
        self.ok = True

    def say(self, check: str, ok: bool, **details: Any) -> bool:
        self.ok = self.ok and ok
        print(json.dumps({"check": check, "ok": ok, **details}, default=str), flush=True)
        return ok

    def fact(self, name: str, **details: Any) -> None:
        print(json.dumps({"fact": name, **details}, default=str), flush=True)


REPORT = Report()


# -- docker ----------------------------------------------------------------------------------------


def docker(
    *args: str, stdin: bytes | None = None, timeout: float = 300.0, check: bool = False
) -> subprocess.CompletedProcess[str]:
    done = subprocess.run(
        ["docker", *args],
        input=None if stdin is None else stdin.decode(),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and done.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:3])} failed: {done.stderr.strip()[-400:]}")
    return done


def sh(script: str, *, timeout: float = 600.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True, timeout=timeout, check=False
    )


def ensure_docker() -> None:
    """Docker from the distribution and a daemon, the way a job VM has them: `docker.io` is
    installed when it is missing and `docker/sandbox/vm-prepare.sh` (the cgroup root and the start
    of `dockerd`; nothing of Sysbox) prepares the VM."""
    if shutil.which("docker") is None:
        sh(
            "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && "
            "apt-get install -y -qq docker.io docker-buildx ca-certificates curl > /dev/null",
            timeout=900,
        )
    prepared = sh(str(REPO / "docker" / "sandbox" / "vm-prepare.sh"))
    if prepared.returncode != 0:
        raise SystemExit(f"vm-prepare failed: {prepared.stderr[-400:]}")


def network_gateway() -> str:
    """The `--internal` network the agent's containers join, and the VM's address on it: the one
    place a provider can be reached."""
    if docker("network", "inspect", NETWORK).returncode != 0:
        docker("network", "create", "--internal", NETWORK, check=True)
    shown = docker(
        "network", "inspect", NETWORK, "--format", "{{(index .IPAM.Config 0).Gateway}}", check=True
    )
    return shown.stdout.strip()


def remove_leftovers() -> None:
    listed = docker("ps", "-aq", "--filter", "name=spike-")
    ids = listed.stdout.split()
    if ids:
        docker("rm", "-f", *ids)


# -- the provider: the strict fake of fakes/wire, reachable from the internal network --------------


def strict_history(_headers: Mapping[str, str], body: Mapping[str, Any]) -> Refusal | None:
    """The strict side of the fake: a history the real API would refuse is refused here. The first
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


@dataclass
class Provider:
    """The fake behind a made-up key, and the address a container reaches it at."""

    fake: ScriptedUpstream
    host: str

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.fake._server.server_address[1]}"  # pyright: ignore[reportPrivateUsage]

    def calls(self) -> list[dict[str, Any]]:
        """What each request was: path, model, tools offered, message count, the auth headers."""
        found: list[dict[str, Any]] = []
        for record in self.fake.records:
            body: Any = record.body
            document = cast("dict[str, Any]", body) if isinstance(body, dict) else {}
            tools = cast("list[dict[str, Any]]", document.get("tools") or [])
            found.append(
                {
                    "method": record.method,
                    "path": record.target,
                    "model": document.get("model"),
                    "tools": len(tools),
                    "messages": len(cast("list[Any]", document.get("messages") or [])),
                    "stream": document.get("stream"),
                    "x_api_key": "present" if "x-api-key" in record.headers else None,
                    "authorization": record.headers.get("authorization", "")[:24] or None,
                    "anthropic_beta": record.headers.get("anthropic-beta"),
                    "user_agent": record.headers.get("user-agent"),
                }
            )
        return found

    def requests_text(self) -> str:
        return json.dumps([record.body for record in self.fake.records])


@contextmanager
def provider(
    script: Sequence[Turn],
    host: str,
    *,
    model: str = MODEL,
    judge: Any = strict_history,
    bearer: bool = False,
) -> Generator[Provider]:
    """The scripted fake, listening on every address of the VM (the stock fake listens on loopback
    only; this is the spike's own subclass of its server, `fakes/` is not changed)."""
    real_server = upstream_module.ThreadingHTTPServer

    class Everywhere(real_server):  # type: ignore[misc, valid-type]
        def __init__(self, address: tuple[str, int], handler: Any) -> None:
            super().__init__(("0.0.0.0", address[1]), handler)

    with mock.patch.object(upstream_module, "ThreadingHTTPServer", Everywhere):
        fake = ScriptedUpstream(
            "messages",
            script,
            model,
            real_key=FAKE_OAUTH if bearer else FAKE_KEY,
            judge=judge,
            also_models=[SMALL_MODEL],
        )
    # `bearer`: the fake takes the key as `authorization: Bearer <key>` (what a subscription login
    # sends) instead of `x-api-key`. The key it expects is then the made-up token.
    with (
        mock.patch.dict(
            upstream_module.AUTH_HEADER, {"messages": "authorization"} if bearer else {}
        ),
        fake,
    ):
        yield Provider(fake, host)


# -- the image of Claude Code ----------------------------------------------------------------------

# The validation the finish tool does, shared by the MCP server and the command (what the runner's
# `submit_result` will do with the profile's result schema, in miniature).
VALIDATE_JS = r"""
const ALLOWED = new Set(["summary", "files"]);
exports.validate = (input) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "the result must be an object";
  for (const key of Object.keys(input)) if (!ALLOWED.has(key)) return `unknown field "${key}" (allowed: summary, files)`;
  if (typeof input.summary !== "string" || input.summary.length === 0) return 'field "summary" is required and must be a non-empty string';
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.some((f) => typeof f !== "string")))
    return 'field "files" must be an array of strings';
  return null;
};
exports.SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What was done, in one paragraph." },
    files: { type: "array", items: { type: "string" }, description: "Paths that were changed." },
  },
  required: ["summary"],
  additionalProperties: false,
};
"""

MCP_STDIO_JS = r"""
const fs = require("fs");
const { validate, SCHEMA } = require("/opt/spike/validate.js");
const log = (line) => fs.appendFileSync("/out/mcp-stdio.log", line + "\n");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(message) {
  log("<- " + JSON.stringify(message));
  const { id, method, params } = message;
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "factory", version: "0" } } });
  if (method === "tools/list")
    return send({ jsonrpc: "2.0", id, result: { tools: [{ name: "submit_result", description: "Submit the result of the task. Call it once, when the work is done.", inputSchema: SCHEMA }] } });
  if (method === "tools/call") {
    const problem = validate(params.arguments);
    if (problem) return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Rejected: " + problem }] } });
    fs.writeFileSync("/out/submitted-stdio.json", JSON.stringify(params.arguments));
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Result accepted." }] } });
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } });
}
"""

FACTORY_SUBMIT_JS = r"""#!/usr/bin/env node
const fs = require("fs");
const { validate } = require("/opt/spike/validate.js");
let text = "";
process.stdin.on("data", (chunk) => (text += chunk));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(text); } catch (error) { console.error("factory-submit: stdin is not JSON: " + error.message); process.exit(2); }
  const problem = validate(input);
  if (problem) { console.error("factory-submit: rejected: " + problem); process.exit(2); }
  fs.writeFileSync("/out/submitted-command.json", JSON.stringify(input));
  console.log("factory-submit: result accepted");
});
"""

DOCKERFILE = f"""FROM {NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep procps \\
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@{CLAUDE_CODE_VERSION} && npm cache clean --force
COPY validate.js mcp-stdio.js /opt/spike/
COPY factory-submit /usr/local/bin/factory-submit
RUN chmod 0755 /usr/local/bin/factory-submit && mkdir -p /out /work
ENV HOME=/root
"""


def build_claude_image(out: Path) -> None:
    started = time.monotonic()
    context = out / IMAGE_DIR_NAME
    shutil.rmtree(context, ignore_errors=True)
    context.mkdir(parents=True)
    (context / "Dockerfile").write_text(DOCKERFILE)
    (context / "validate.js").write_text(VALIDATE_JS)
    (context / "mcp-stdio.js").write_text(MCP_STDIO_JS)
    (context / "factory-submit").write_text(FACTORY_SUBMIT_JS)
    built = docker("build", "-t", CLAUDE_IMAGE, str(context), timeout=1200)
    if built.returncode != 0:
        raise SystemExit(f"image build failed: {built.stderr[-800:]}")
    size = docker("image", "inspect", CLAUDE_IMAGE, "--format", "{{.Size}}").stdout.strip()
    version = docker("run", "--rm", CLAUDE_IMAGE, "claude", "--version").stdout.strip()
    REPORT.fact(
        "s1_image",
        base=NODE_IMAGE,
        claude_code=version,
        pinned=CLAUDE_CODE_VERSION,
        build_seconds=round(time.monotonic() - started, 1),
        image_bytes=int(size or 0),
    )


# -- one run of `claude -p` in a container ---------------------------------------------------------


@dataclass
class Run:
    name: str
    returncode: int
    seconds: float
    events: list[dict[str, Any]]
    stderr: str
    stdout_other: list[str]
    calls: list[dict[str, Any]] = field(default_factory=lambda: [])
    requests_text: str = ""

    def of_type(self, kind: str, subtype: str | None = None) -> list[dict[str, Any]]:
        return [
            e
            for e in self.events
            if e.get("type") == kind and (subtype is None or e.get("subtype") == subtype)
        ]

    @property
    def result(self) -> dict[str, Any]:
        found = self.of_type("result")
        return found[-1] if found else {}

    @property
    def session_id(self) -> str:
        init = self.of_type("system", "init")
        return str(init[0].get("session_id")) if init else ""


def claude(
    name: str,
    prov: Provider,
    out: Path,
    *,
    prompt: str,
    flags: Sequence[str] = (),
    env: Mapping[str, str | None] | None = None,
    mounts: Sequence[str] = (),
    user: str | None = None,
    workdir: str = "/work",
    model: str | None = MODEL,
    api_key: str | None = FAKE_KEY,
    timeout: float = 240.0,
    stream: bool = True,
) -> Run:
    """`claude -p` in a fresh container of the image on the internal network, with the provider's
    address as its base URL. The raw standard output is kept in `out`."""
    container = f"spike-{name}"[:60]
    docker("rm", "-f", container)
    environment: dict[str, str | None] = {
        "ANTHROPIC_BASE_URL": prov.url,
        "ANTHROPIC_API_KEY": api_key,
        # Everything that is not the conversation stays off (telemetry, updates, error reports).
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "ANTHROPIC_SMALL_FAST_MODEL": SMALL_MODEL,
    }
    environment.update(env or {})
    argv = ["docker", "run", "--rm", "--name", container, "--network", NETWORK, "-w", workdir]
    if user:
        argv += ["--user", user]
    for key, value in environment.items():
        if value is not None:
            argv += ["-e", f"{key}={value}"]
    for mount in mounts:
        argv += ["-v", mount]
    claude_argv = ["claude", "-p", prompt]
    if stream:
        claude_argv += ["--output-format", "stream-json", "--verbose"]
    if model:
        claude_argv += ["--model", model]
    argv += [CLAUDE_IMAGE, *claude_argv, *flags]
    started = time.monotonic()
    try:
        done = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            stdin=subprocess.DEVNULL,
        )
        code, stdout, stderr = done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired as expired:
        docker("rm", "-f", container)
        code, stdout, stderr = -9, str(expired.stdout or ""), "timeout " + str(expired.stderr or "")
    seconds = round(time.monotonic() - started, 2)
    (out / f"{name}.stdout.jsonl").write_text(stdout)
    (out / f"{name}.stderr.txt").write_text(stderr)
    events: list[dict[str, Any]] = []
    other: list[str] = []
    for line in stdout.splitlines():
        try:
            parsed = json.loads(line)
        except ValueError:
            other.append(line[:200])
            continue
        if isinstance(parsed, dict):
            events.append(cast("dict[str, Any]", parsed))
    run = Run(name, code, seconds, events, stderr, other, prov.calls(), prov.requests_text())
    (out / f"{name}.provider-calls.json").write_text(json.dumps(run.calls, indent=1))
    if prov.fake.records:
        (out / f"{name}.first-request.json").write_text(
            json.dumps(prov.fake.records[0].body, indent=1)
        )
    return run


def short(value: Any, limit: int = 120) -> Any:
    """`value` with every long string cut, for facts."""
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + f"...[{len(value)}]"
    if isinstance(value, list):
        return [short(v, limit) for v in cast("list[Any]", value)]
    if isinstance(value, dict):
        return {k: short(v, limit) for k, v in cast("dict[str, Any]", value).items()}
    return value


def shape(value: Any) -> Any:
    """The structure of a JSON value: keys with the type of each value (lists by their first item)."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in cast("dict[str, Any]", value).items()}
    if isinstance(value, list):
        items = cast("list[Any]", value)
        return [shape(items[0])] if items else []
    return type(value).__name__


# -- S1: Claude Code's events as our step records ----------------------------------------------------


def _ms(stamp: Any) -> int | None:
    """An ISO time stamp (`2026-11-04T21:35:55.880Z`) in epoch milliseconds."""
    if not isinstance(stamp, str):
        return None
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


class ClaudeEvents:
    """The proposed adapter of Claude Code's `stream-json` for the live view: each event becomes the
    engine-shaped event (`message.updated`, `message.part.updated`) that `StepConverter` already
    reads, so that the bounds (16 KiB of text, 4 KiB of tool input, the 5,000 records), the
    redaction and the rule that an output is never recorded stay where they are. Needs
    `--include-partial-messages`: only its `message_delta` carries the final token counts of a model
    call (`output_tokens` of an `assistant` event is 1, the count of `message_start`).

    * `assistant` event (one per content block, all of one model call share `message.id`):
      `thinking` -> a `reasoning` part, `text` -> a `text` part (both finished: the event comes when
      the block ended), `tool_use` -> a `tool` part, status `running`, part id = the `tool_use` id;
    * `user` event with a `tool_result` block -> the same tool part again, `completed`, or `error`
      with the text of the result when `is_error` is true;
    * `stream_event` `message_delta` -> a `step-finish` part with the call's tokens (no price: the
      price is computed from the book, `result.total_cost_usd` is the turn's total);
    * `system`, `result` and the rest -> nothing here (`result` ends the turn and carries the total).
    """

    def __init__(self, session_id: str) -> None:
        self.session = session_id
        self._messages: set[str] = set()
        self._blocks: Counter[str] = Counter()
        self._tools: dict[str, tuple[str, Any, int | None, str]] = {}
        self._current = ""

    def _event(self, kind: str, **properties: Any) -> dict[str, Any]:
        return {"type": kind, "properties": {"sessionID": self.session, **properties}}

    def _part(self, part: dict[str, Any], at: int | None) -> dict[str, Any]:
        return self._event("message.part.updated", part=part, time=at)

    def convert(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        kind = event.get("type")
        at = _ms(event.get("timestamp"))
        if kind == "assistant":
            return self._assistant(cast("dict[str, Any]", event.get("message") or {}), at)
        if kind == "user":
            return self._results(cast("dict[str, Any]", event.get("message") or {}), at)
        if kind == "stream_event":
            inner = cast("dict[str, Any]", event.get("event") or {})
            if inner.get("type") == "message_start":
                message = cast("dict[str, Any]", inner.get("message") or {})
                self._current = str(message.get("id"))
            if inner.get("type") == "message_delta":
                return self._step(inner, at)
        return []

    def _assistant(self, message: dict[str, Any], at: int | None) -> list[dict[str, Any]]:
        identifier = str(message.get("id"))
        found: list[dict[str, Any]] = []
        if identifier not in self._messages:
            self._messages.add(identifier)
            found.append(
                self._event("message.updated", info={"id": identifier, "role": "assistant"})
            )
        for block in cast("list[dict[str, Any]]", message.get("content") or []):
            self._blocks[identifier] += 1
            part_id = f"{identifier}.{self._blocks[identifier]}"
            if block.get("type") in ("thinking", "text"):
                text = (
                    block.get("thinking") if block.get("type") == "thinking" else block.get("text")
                )
                found.append(
                    self._part(
                        {
                            "id": part_id,
                            "type": "reasoning" if block.get("type") == "thinking" else "text",
                            "messageID": identifier,
                            "text": text,
                            "time": {"start": at, "end": at},
                        },
                        at,
                    )
                )
            if block.get("type") == "tool_use":
                call = str(block.get("id"))
                self._tools[call] = (str(block.get("name")), block.get("input"), at, identifier)
                found.append(self._tool_part(call, "running", at, None))
        return found

    def _tool_part(
        self, call: str, status: str, at: int | None, error: str | None
    ) -> dict[str, Any]:
        name, arguments, started, message = self._tools[call]
        state: dict[str, Any] = {
            "status": status,
            "input": arguments,
            "time": {"start": started, **({"end": at} if status != "running" else {})},
        }
        if error is not None:
            state["error"] = error
        return self._part(
            {
                "id": call,
                "type": "tool",
                "tool": name,
                "callID": call,
                "messageID": message,
                "state": state,
            },
            at,
        )

    def _results(self, message: dict[str, Any], at: int | None) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        content: Any = message.get("content")
        for block in cast("list[dict[str, Any]]", content) if isinstance(content, list) else []:
            call = str(block.get("tool_use_id"))
            if block.get("type") != "tool_result" or call not in self._tools:
                continue
            failed = bool(block.get("is_error"))
            text: Any = block.get("content")
            if isinstance(text, list):
                text = " ".join(str(b.get("text", "")) for b in cast("list[dict[str, Any]]", text))
            found.append(
                self._tool_part(
                    call, "error" if failed else "completed", at, str(text) if failed else None
                )
            )
        return found

    def _step(self, inner: dict[str, Any], at: int | None) -> list[dict[str, Any]]:
        usage = cast("dict[str, Any]", inner.get("usage") or {})
        delta = cast("dict[str, Any]", inner.get("delta") or {})
        part = {
            "id": f"{self._current}.step",
            "type": "step-finish",
            "messageID": self._current,
            "reason": delta.get("stop_reason"),
            "tokens": {
                "input": usage.get("input_tokens"),
                "output": usage.get("output_tokens"),
                "reasoning": 0,
                "cache": {
                    "read": usage.get("cache_read_input_tokens"),
                    "write": usage.get("cache_creation_input_tokens"),
                },
            },
        }
        return [self._part(part, at)]


def step_records(events: Sequence[Mapping[str, Any]]) -> list[StepRecord]:
    """The records `StepConverter` makes of a Claude Code run through the adapter above."""
    from code_reviewer_runner.implementer.step_records import StepConverter

    session = next((str(e.get("session_id")) for e in events if e.get("session_id")), "")
    adapter = ClaudeEvents(session)
    converter = StepConverter(session, Redactor((FAKE_KEY, FAKE_OAUTH, FAKE_REFRESH)))
    records: list[StepRecord] = []
    for event in events:
        for engine_event in adapter.convert(event):
            record = converter.convert(engine_event)
            if record is not None:
                records.append(record)
    return records


# -- S1: the scripted turn -------------------------------------------------------------------------

NOTES = "SPIKE-NOTES-LINE: hello from the repository\nsecond line\n"
ONE = "SPIKE-ONE-MARKER: read notes.txt, count its lines, change hello to HELLO, then say you are done."
ANSWER_ONE = "SPIKE-ANSWER-ONE: notes.txt now says HELLO."
BYPASS = ["--permission-mode", "bypassPermissions"]


def seed_work(directory: Path) -> Path:
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True)
    (directory / "notes.txt").write_text(NOTES)
    sh(
        f"cd {directory} && git init -q && git add . && "
        "git -c user.email=a@b -c user.name=s commit -qm init && chmod -R a+rwX ."
    )
    return directory


def read_notes() -> Turn:
    return Turn(tool="Read", args={"file_path": "/work/notes.txt"})


def script_events() -> list[Turn]:
    """Reads a file (with a thought first), runs a command beside a second read in one step
    (parallel tool use), edits the file, ends with text."""
    return [
        Turn(
            thinking="I should read the notes first.",
            tool="Read",
            args={"file_path": "/work/notes.txt"},
        ),
        Turn(
            tool="Bash",
            args={
                "command": "wc -l /work/notes.txt && echo SPIKE-BASH-OK",
                "description": "count lines",
            },
            also=(("Read", {"file_path": "/work/notes.txt", "limit": 1}),),
        ),
        Turn(
            tool="Edit",
            args={"file_path": "/work/notes.txt", "old_string": "hello", "new_string": "HELLO"},
        ),
        Turn(text=ANSWER_ONE),
    ]


def tool_results(run: Run) -> list[dict[str, Any]]:
    """Every `tool_result` of a run: the tool's name, whether it failed and the start of its text."""
    names: dict[str, str] = {}
    found: list[dict[str, Any]] = []
    for event in run.events:
        message_value: Any = event.get("message")
        message = cast("dict[str, Any]", message_value) if isinstance(message_value, dict) else {}
        content: Any = message.get("content")
        for block in cast("list[dict[str, Any]]", content) if isinstance(content, list) else []:
            if block.get("type") == "tool_use":
                names[str(block.get("id"))] = str(block.get("name"))
            if block.get("type") == "tool_result":
                text: Any = block.get("content")
                if isinstance(text, list):
                    text = " ".join(
                        str(b.get("text", "")) for b in cast("list[dict[str, Any]]", text)
                    )
                found.append(
                    {
                        "tool": names.get(str(block.get("tool_use_id"))),
                        "is_error": bool(block.get("is_error")),
                        "text": short(str(text), 160),
                    }
                )
    return found


def s1_events(out: Path, gateway: str) -> None:
    """(a) The events of a turn and their mapping to the step records; (g) the cost it reports."""
    work = seed_work(out / "work-events")
    with provider(script_events(), gateway) as prov:
        run = claude(
            "events",
            prov,
            out,
            prompt=ONE,
            flags=[*BYPASS, "--include-partial-messages"],
            mounts=[f"{work}:/work"],
            env={"IS_SANDBOX": "1"},
        )
    first_init = run.of_type("system", "init")
    init = first_init[0] if first_init else {}
    REPORT.say(
        "s1_events_turn_ends",
        run.returncode == 0
        and run.result.get("subtype") == "success"
        and ANSWER_ONE in str(run.result.get("result")),
        returncode=run.returncode,
        seconds=run.seconds,
        stderr=run.stderr[-200:],
        notes_after=(work / "notes.txt").read_text()[:30],
    )
    REPORT.fact(
        "s1_event_types",
        types=dict(Counter(f"{e.get('type')}/{e.get('subtype')}" for e in run.events)),
        stream_events=dict(
            Counter(
                str(cast("dict[str, Any]", e.get("event") or {}).get("type"))
                for e in run.of_type("stream_event")
            )
        ),
        init={
            k: init.get(k)
            for k in (
                "cwd",
                "session_id",
                "model",
                "permissionMode",
                "apiKeySource",
                "claude_code_version",
                "mcp_servers",
                "tools",
            )
        },
        init_keys=sorted(init),
        assistant_event_shape=shape(run.of_type("assistant")[0])
        if run.of_type("assistant")
        else None,
        user_event_shape=shape(run.of_type("user")[0]) if run.of_type("user") else None,
        result_keys=sorted(run.result),
        result_usage_keys=sorted(cast("dict[str, Any]", run.result.get("usage") or {})),
        model_usage=short(run.result.get("modelUsage")),
    )
    records = step_records(run.events)
    by_kind = Counter(r.kind for r in records)
    tools = {
        r.part_id: [x.status for x in records if x.part_id == r.part_id]
        for r in records
        if r.kind == "tool"
    }
    steps = [r for r in records if r.kind == "step"]
    usage = cast("dict[str, Any]", run.result.get("usage") or {})
    summed_in = sum((r.tokens or {}).get("input", 0) for r in steps)
    summed_out = sum((r.tokens or {}).get("output", 0) for r in steps)
    REPORT.say(
        "s1_events_map_to_step_records",
        by_kind == Counter(reasoning=1, text=1, tool=8, step=4)
        and all(v == ["running", "completed"] for v in tools.values())
        and summed_in == usage.get("input_tokens")
        and summed_out == usage.get("output_tokens"),
        by_kind=dict(by_kind),
        tool_statuses=tools,
        step_tokens=[dict(r.tokens or {}) for r in steps],
        summed_input=summed_in,
        summed_output=summed_out,
        result_usage_input=usage.get("input_tokens"),
        result_usage_output=usage.get("output_tokens"),
        records=[short(r.as_json(), 90) for r in records[:10]],
    )
    # (g) The figure `result` carries, against the list price of the model for the fake's usage.
    prices = {"input": 3.0, "output": 15.0, "cache_read": 0.30, "write_5m": 3.75, "write_1h": 6.0}
    creation = cast("dict[str, Any]", usage.get("cache_creation") or {})
    expected = (
        usage.get("input_tokens", 0) * prices["input"]
        + usage.get("output_tokens", 0) * prices["output"]
        + usage.get("cache_read_input_tokens", 0) * prices["cache_read"]
        + creation.get("ephemeral_5m_input_tokens", 0) * prices["write_5m"]
        + creation.get("ephemeral_1h_input_tokens", 0) * prices["write_1h"]
    ) / 1e6
    reported = run.result.get("total_cost_usd")
    REPORT.say(
        "s1_cost_of_an_api_key_run_is_the_list_price_of_the_usage",
        isinstance(reported, float) and abs(reported - expected) < 1e-9,
        total_cost_usd=reported,
        expected_from_list_prices=round(expected, 9),
        per_call_cost_in_events=any(
            "cost" in json.dumps(e.get("message", {})) for e in run.of_type("assistant")
        ),
        model_usage=short(run.result.get("modelUsage")),
        api_ms=run.result.get("duration_api_ms"),
        duration_ms=run.result.get("duration_ms"),
        wall_seconds=run.seconds,
    )
    REPORT.fact(
        "s1_provider_traffic",
        calls=[
            {k: c[k] for k in ("path", "model", "tools", "messages", "stream", "x_api_key")}
            for c in run.calls
        ],
        anthropic_beta=run.calls[0]["anthropic_beta"] if run.calls else None,
        user_agent=run.calls[0]["user_agent"] if run.calls else None,
        request_tool_names=sorted(
            {
                str(t.get("name"))
                for t in cast(
                    "list[dict[str, Any]]",
                    cast("dict[str, Any]", json.loads(run.requests_text)[0]).get("tools") or [],
                )
            }
        ),
    )


# -- S1 (b) and (c): the finish tool as an MCP server, and as a command ----------------------------

SUBMIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "What was done, in one paragraph."},
        "files": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Paths that were changed.",
        },
    },
    "required": ["summary"],
    "additionalProperties": False,
}
CAPABILITY = "spike-capability-0123456789"


def validate_result(value: Any) -> str | None:
    """The same rules as `VALIDATE_JS` (in miniature, what the profile's result schema will say)."""
    if not isinstance(value, dict):
        return "the result must be an object"
    document = cast("dict[str, Any]", value)
    for key in document:
        if key not in ("summary", "files"):
            return f'unknown field "{key}" (allowed: summary, files)'
    summary = document.get("summary")
    if not isinstance(summary, str) or not summary:
        return 'field "summary" is required and must be a non-empty string'
    files = document.get("files")
    if files is not None and (
        not isinstance(files, list) or any(not isinstance(f, str) for f in cast("list[Any]", files))
    ):
        return 'field "files" must be an array of strings'
    return None


class HttpMcp:
    """The finish tool as an MCP server on the runner's side: Streamable HTTP, one POST per
    JSON-RPC message, JSON answers (no streaming), a bearer capability in the header. What it
    saw is kept in `log`."""

    def __init__(self, host: str) -> None:
        self.host = host
        self.log: list[dict[str, Any]] = []
        self.submitted: list[dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:
                return

            def _send(
                self, status: int, document: Any = None, extra: Mapping[str, str] | None = None
            ) -> None:
                payload = b"" if document is None else json.dumps(document).encode()
                self.send_response(status)
                if payload:
                    self.send_header("Content-Type", "application/json")
                for name, value in (extra or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:
                outer.log.append({"method": "GET", "path": self.path})
                self._send(405)

            def do_DELETE(self) -> None:
                outer.log.append({"method": "DELETE", "path": self.path})
                self._send(200)

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                message = cast("dict[str, Any]", json.loads(self.rfile.read(length) or b"{}"))
                authorised = self.headers.get("Authorization") == f"Bearer {CAPABILITY}"
                outer.log.append(
                    {
                        "method": message.get("method"),
                        "authorised": authorised,
                        "accept": self.headers.get("Accept"),
                        "session_header": self.headers.get("Mcp-Session-Id"),
                        "protocol_header": self.headers.get("MCP-Protocol-Version"),
                    }
                )
                if not authorised:
                    self._send(401, {"error": "capability"})
                    return
                identifier = message.get("id")
                if identifier is None:
                    self._send(202)
                    return
                result = outer.handle(message)
                self._send(
                    200,
                    {"jsonrpc": "2.0", "id": identifier, **result},
                    {"Mcp-Session-Id": "spike-session"},
                )

        self._server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self._server.server_address[1]}/mcp"

    def handle(self, message: dict[str, Any]) -> dict[str, Any]:
        method = message.get("method")
        params = cast("dict[str, Any]", message.get("params") or {})
        if method == "initialize":
            return {
                "result": {
                    "protocolVersion": params.get("protocolVersion"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "factory", "version": "0"},
                }
            }
        if method == "tools/list":
            return {
                "result": {
                    "tools": [
                        {
                            "name": "submit_result",
                            "description": "Submit the result of the task. Call it once, when the work is done.",
                            "inputSchema": SUBMIT_SCHEMA,
                        }
                    ]
                }
            }
        if method == "tools/call":
            arguments = params.get("arguments")
            problem = validate_result(arguments)
            if problem:
                return {
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": f"Rejected: {problem}"}],
                    }
                }
            self.submitted.append(cast("dict[str, Any]", arguments))
            return {"result": {"content": [{"type": "text", "text": "Result accepted."}]}}
        return {"error": {"code": -32601, "message": "no such method"}}

    def __enter__(self) -> "HttpMcp":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._server.shutdown()
        self._server.server_close()


def script_finish(tool: str, command: bool = False) -> list[Turn]:
    """Reads the notes, submits a result the finish tool must reject (a number, an unknown field),
    corrects it, ends."""
    bad: Mapping[str, Any] = {"summary": 5, "extra": True}
    good: Mapping[str, Any] = {"summary": "notes.txt now says HELLO", "files": ["notes.txt"]}
    if command:
        return [
            read_notes(),
            Turn(
                tool="Bash",
                args={
                    "command": f"echo '{json.dumps(bad)}' | factory-submit",
                    "description": "submit",
                },
            ),
            Turn(
                tool="Bash",
                args={
                    "command": f"echo '{json.dumps(good)}' | factory-submit",
                    "description": "submit",
                },
            ),
            Turn(text="SPIKE-FINISHED"),
        ]
    return [
        read_notes(),
        Turn(tool=tool, args=bad),
        Turn(tool=tool, args=good),
        Turn(text="SPIKE-FINISHED"),
    ]


def s1_finish_tool(out: Path, gateway: str) -> None:
    """(b) A local MCP server with `submit_result` and a JSON-schema input: stdio in the container,
    and HTTP on the runner's side. (c) `factory-submit` on PATH, through the Bash tool."""
    tool = "mcp__factory__submit_result"
    stdio_config = json.dumps(
        {"mcpServers": {"factory": {"command": "node", "args": ["/opt/spike/mcp-stdio.js"]}}}
    )
    with HttpMcp(gateway) as http:
        http_config = json.dumps(
            {
                "mcpServers": {
                    "factory": {
                        "type": "http",
                        "url": http.url,
                        "headers": {"Authorization": f"Bearer {CAPABILITY}"},
                    }
                }
            }
        )
        for kind, config in (
            ("stdio", stdio_config),
            ("http", http_config),
            ("stdio-search-off", stdio_config),
        ):
            work = seed_work(out / f"work-mcp-{kind}")
            results = out / f"out-mcp-{kind}"
            shutil.rmtree(results, ignore_errors=True)
            results.mkdir()
            results.chmod(0o777)
            with provider(script_finish(tool), gateway) as prov:
                run = claude(
                    f"mcp-{kind}",
                    prov,
                    out,
                    prompt=ONE,
                    flags=[*BYPASS, "--mcp-config", config, "--strict-mcp-config"],
                    mounts=[f"{work}:/work", f"{results}:/out"],
                    env={
                        "IS_SANDBOX": "1",
                        **({"ENABLE_TOOL_SEARCH": "false"} if kind.endswith("off") else {}),
                    },
                )
                body = json.loads(run.requests_text)
            init = run.of_type("system", "init")
            listed = [
                t
                for t in cast(
                    "list[dict[str, Any]]", cast("dict[str, Any]", body[0]).get("tools") or []
                )
                if "submit_result" in str(t.get("name"))
            ]
            answers = [r for r in tool_results(run) if r["tool"] == tool]
            submitted = (
                (results / "submitted-stdio.json").exists()
                if kind.startswith("stdio")
                else bool(http.submitted)
            )
            first_request = json.dumps(body[0])
            REPORT.say(
                f"s1_mcp_{kind}_finish_tool_is_listed_and_called",
                run.returncode == 0
                and len(answers) == 2
                and answers[0]["is_error"]
                and not answers[1]["is_error"]
                and submitted,
                returncode=run.returncode,
                stderr=run.stderr[-300:],
                mcp_servers=init[0].get("mcp_servers") if init else None,
                tool_in_init=tool in cast("list[str]", init[0].get("tools") if init else []),
                tool_in_first_request=[short(t, 300) for t in listed],
                name_mentions_in_first_request=first_request.count("submit_result"),
                mention_context=[
                    first_request[m - 80 : m + 60]
                    for m in [first_request.find("submit_result")]
                    if m >= 0
                ],
                tool_names_in_first_request=sorted(
                    str(t.get("name"))
                    for t in cast(
                        "list[dict[str, Any]]", cast("dict[str, Any]", body[0]).get("tools") or []
                    )
                ),
                answers=answers,
                denials=run.result.get("permission_denials"),
                second_request_carries_the_error=("Rejected:" in run.requests_text),
                server_log=[
                    x[:200] for x in (results / "mcp-stdio.log").read_text().splitlines()[:6]
                ]
                if kind.startswith("stdio") and (results / "mcp-stdio.log").exists()
                else http.log[:8],
                seconds=run.seconds,
            )
            http.log.clear()
            http.submitted.clear()
    # (c) the command
    work = seed_work(out / "work-command")
    results = out / "out-command"
    shutil.rmtree(results, ignore_errors=True)
    results.mkdir()
    results.chmod(0o777)
    with provider(script_finish("", command=True), gateway) as prov:
        run = claude(
            "command",
            prov,
            out,
            prompt=ONE,
            flags=BYPASS,
            mounts=[f"{work}:/work", f"{results}:/out"],
            env={"IS_SANDBOX": "1"},
        )
    answers = [r for r in tool_results(run) if r["tool"] == "Bash"]
    REPORT.say(
        "s1_factory_submit_command_through_the_bash_tool",
        run.returncode == 0
        and len(answers) == 2
        and answers[0]["is_error"]
        and not answers[1]["is_error"]
        and (results / "submitted-command.json").exists(),
        answers=answers,
        second_request_carries_the_error=("factory-submit: rejected" in run.requests_text),
        seconds=run.seconds,
    )


# -- S1 (d): --resume in a new container, the session on a volume ------------------------------------

R1 = "SPIKE-R1-MARKER: read notes.txt and tell me what the first line says."
A1 = "SPIKE-R1-ANSWER: the first line says hello."
R2 = "SPIKE-R2-MARKER: now say which marker I gave you first."
A2 = "SPIKE-R2-ANSWER: the first marker was R1."


def tree(root: Path) -> dict[str, Any]:
    """What a directory holds: the number of files, the bytes, the largest files."""
    files = [p for p in root.rglob("*") if p.is_file()]
    sizes = sorted(((p.stat().st_size, str(p.relative_to(root))) for p in files), reverse=True)
    return {"files": len(files), "bytes": sum(s for s, _ in sizes), "largest": sizes[:6]}


def mentions(root: Path, needle: str) -> list[str]:
    """The files under `root` that hold `needle`."""
    found = sh(f"grep -rl -F -- {needle!r} {root} || true").stdout.split()
    return [str(Path(f).relative_to(root)) for f in found]


def s1_resume(out: Path, gateway: str) -> None:
    """(d) The first turn ends and its container is thrown away; a new container with the same
    directory mounted continues the session with `--resume <id>`. The strict provider must see the
    first turn's history in the second turn's first request."""
    work = seed_work(out / "work-resume")
    session = out / "session-volume"
    shutil.rmtree(session, ignore_errors=True)
    session.mkdir()
    mounts = [f"{work}:/work", f"{session}:/root/.claude"]
    with provider([read_notes(), Turn(text=A1)], gateway) as prov:
        one = claude(
            "resume-1", prov, out, prompt=R1, flags=BYPASS, mounts=mounts, env={"IS_SANDBOX": "1"}
        )
    sid = one.session_id
    after_one = tree(session)
    gone = docker("ps", "-a", "--filter", "name=spike-resume-1", "-q").stdout.strip() == ""
    with provider([Turn(text=A2)], gateway) as prov:
        two = claude(
            "resume-2",
            prov,
            out,
            prompt=R2,
            flags=[*BYPASS, "--resume", sid],
            mounts=mounts,
            env={"IS_SANDBOX": "1"},
        )
        text = two.requests_text
        first = cast("dict[str, Any]", json.loads(text)[0]) if prov.fake.records else {}
    carries = {
        "r1_marker": R1[:16] in text,
        "r1_answer": A1 in text,
        "tool_result_of_turn_one": "SPIKE-NOTES-LINE" in text,
        "r2_marker": R2[:16] in text,
    }
    REPORT.say(
        "s1_resume_continues_the_first_turns_history_in_a_new_container",
        gone
        and two.returncode == 0
        and all(carries.values())
        and A2 in str(two.result.get("result")),
        first_container_gone=gone,
        carries=carries,
        session_id_first=sid,
        session_id_second=two.session_id,
        same_session_id=sid == two.session_id,
        messages_in_first_request=len(cast("list[Any]", first.get("messages") or [])),
        seconds=[one.seconds, two.seconds],
        returncode=two.returncode,
        stderr=two.stderr[-300:],
        session_volume_after_turn_one=after_one,
        session_volume_after_turn_two=tree(session),
        key_in_the_volume=mentions(session, FAKE_KEY[-24:]),
    )
    # The same, but what goes wrong: an empty volume, another working directory, the id we chose.
    empty = out / "session-empty"
    shutil.rmtree(empty, ignore_errors=True)
    empty.mkdir()
    with provider([Turn(text=A2)], gateway) as prov:
        lost = claude(
            "resume-empty",
            prov,
            out,
            prompt=R2,
            flags=[*BYPASS, "--resume", sid],
            mounts=[f"{work}:/work", f"{empty}:/root/.claude"],
            env={"IS_SANDBOX": "1"},
        )
    REPORT.fact(
        "s1_resume_with_an_empty_volume",
        returncode=lost.returncode,
        result=short(lost.result.get("result")),
        is_error=lost.result.get("is_error"),
        stderr=lost.stderr[-300:],
        provider_calls=len(lost.calls),
    )
    other = out / "work-resume-other"
    shutil.rmtree(other, ignore_errors=True)
    shutil.copytree(work, other)
    with provider([Turn(text=A2)], gateway) as prov:
        moved = claude(
            "resume-other-dir",
            prov,
            out,
            prompt=R2,
            flags=[*BYPASS, "--resume", sid],
            mounts=[f"{other}:/other", f"{session}:/root/.claude"],
            workdir="/other",
            env={"IS_SANDBOX": "1"},
        )
    REPORT.fact(
        "s1_resume_from_another_working_directory",
        returncode=moved.returncode,
        result=short(moved.result.get("result")),
        is_error=moved.result.get("is_error"),
        carries_turn_one=R1[:16] in moved.requests_text and A1 in moved.requests_text,
        stderr=moved.stderr[-300:],
        provider_calls=len(moved.calls),
    )
    chosen = "5f0c1b2e-7a4d-4c1e-9b3a-0d2e6f8a9c11"
    config = out / "claude-config-volume"
    shutil.rmtree(config, ignore_errors=True)
    config.mkdir()
    with provider([read_notes(), Turn(text=A1)], gateway) as prov:
        c1 = claude(
            "resume-config-dir-1",
            prov,
            out,
            prompt=R1,
            flags=[*BYPASS, "--session-id", chosen],
            mounts=[f"{work}:/work", f"{config}:/session"],
            env={"IS_SANDBOX": "1", "CLAUDE_CONFIG_DIR": "/session"},
        )
    with provider([Turn(text=A2)], gateway) as prov:
        c2 = claude(
            "resume-config-dir-2",
            prov,
            out,
            prompt=R2,
            flags=[*BYPASS, "--resume", chosen],
            mounts=[f"{work}:/work", f"{config}:/session"],
            env={"IS_SANDBOX": "1", "CLAUDE_CONFIG_DIR": "/session"},
        )
        carried = R1[:16] in c2.requests_text and A1 in c2.requests_text
    REPORT.say(
        "s1_resume_with_a_chosen_session_id_and_one_config_directory",
        c1.session_id == chosen and c2.returncode == 0 and carried,
        session_id_of_turn_one=c1.session_id,
        session_id_of_turn_two=c2.session_id,
        carried=carried,
        volume=tree(config),
    )


# -- S1 (e): the permission mode of an unattended run -------------------------------------------------


def script_permissions() -> list[Turn]:
    """A read, a command that writes in the working directory, an edit, a write outside it, a
    command that writes outside it."""
    return [
        read_notes(),
        Turn(
            tool="Bash",
            args={"command": "echo allowed > /work/bash-out.txt", "description": "write in cwd"},
        ),
        Turn(
            tool="Edit",
            args={"file_path": "/work/notes.txt", "old_string": "hello", "new_string": "HELLO"},
        ),
        Turn(tool="Write", args={"file_path": "/tmp/outside.txt", "content": "outside\n"}),
        Turn(
            tool="Bash",
            args={
                "command": "touch /etc/spike-outside && echo SPIKE-OUTSIDE-OK",
                "description": "touch outside",
            },
        ),
        Turn(text="SPIKE-PERMISSIONS-DONE"),
    ]


def s1_permissions(out: Path, gateway: str) -> None:
    """(e) What each way of running unattended allows. The script asks for five things; the table
    says which were done, which were refused and what the refusal said."""
    variants: list[tuple[str, list[str], dict[str, str], str | None]] = [
        ("default", [], {}, None),
        ("acceptEdits", ["--permission-mode", "acceptEdits"], {}, None),
        ("allowedTools", ["--allowedTools", "Read,Edit,Write,Bash"], {}, None),
        ("dontAsk", ["--permission-mode", "dontAsk"], {}, None),
        ("bypassPermissions-root", ["--permission-mode", "bypassPermissions"], {}, None),
        ("dangerously-skip-root", ["--dangerously-skip-permissions"], {}, None),
        (
            "dangerously-skip-root-IS_SANDBOX",
            ["--dangerously-skip-permissions"],
            {"IS_SANDBOX": "1"},
            None,
        ),
        ("bypassPermissions-root-IS_SANDBOX", BYPASS, {"IS_SANDBOX": "1"}, None),
        (
            "settings-defaultMode-root",
            ["--settings", json.dumps({"permissions": {"defaultMode": "bypassPermissions"}})],
            {},
            None,
        ),
        (
            "dangerously-skip-user-1000",
            ["--dangerously-skip-permissions"],
            {"HOME": "/home/node"},
            "1000:1000",
        ),
    ]
    table: dict[str, Any] = {}
    for name, flags, env, user in variants:
        work = seed_work(out / f"work-perm-{name}")
        with provider(script_permissions(), gateway) as prov:
            run = claude(
                f"perm-{name}",
                prov,
                out,
                prompt=ONE,
                flags=flags,
                mounts=[f"{work}:/work"],
                env=env,
                user=user,
                timeout=90,
            )
        init = run.of_type("system", "init")
        results = tool_results(run)
        table[name] = {
            "rc": run.returncode,
            "mode": init[0].get("permissionMode") if init else None,
            "tools_run": [("ok" if not r["is_error"] else "refused") for r in results],
            "bash_out_in_cwd": (work / "bash-out.txt").exists(),
            "notes_edited": "HELLO" in (work / "notes.txt").read_text(),
            "denials": len(cast("list[Any]", run.result.get("permission_denials") or [])),
            "refusal_text": next((r["text"] for r in results if r["is_error"]), None),
            "stderr": short(run.stderr.strip(), 220) or None,
            "stdout_other": run.stdout_other[:2],
        }
        REPORT.fact(f"s1_permissions_{name}", **table[name])
    ran_all = [n for n, v in table.items() if v["tools_run"] == ["ok"] * 5]
    REPORT.say(
        "s1_permissions_some_mode_runs_everything_unattended",
        bool(ran_all),
        modes_that_run_all_five_calls=ran_all,
    )
    helps = docker("run", "--rm", CLAUDE_IMAGE, "claude", "--help").stdout
    (out / "claude-help.txt").write_text(helps)
    wanted_flags = [
        "--permission-mode",
        "--dangerously-skip-permissions",
        "--allowedTools",
        "--disallowedTools",
        "--mcp-config",
        "--strict-mcp-config",
        "--resume",
        "--session-id",
        "--fork-session",
        "--input-format",
        "--include-partial-messages",
        "--max-turns",
        "--max-budget-usd",
        "--append-system-prompt",
        "--settings",
        "--setting-sources",
        "--add-dir",
        "--bare",
        "--model",
        "--fallback-model",
        "--no-session-persistence",
        "--verbose",
        "--output-format",
    ]
    REPORT.fact("s1_cli_flags", present={f: f in helps for f in wanted_flags})


# -- S1 (f) and (g): the login, and the cost it reports ------------------------------------------------


def credentials_file(directory: Path, *, expires_in_ms: int) -> None:
    """A `.credentials.json` as `claude` writes it after a login (made-up values)."""
    directory.mkdir(parents=True, exist_ok=True)
    expires = int(time.time() * 1000) + expires_in_ms
    (directory / ".credentials.json").write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": FAKE_OAUTH,
                    "refreshToken": FAKE_REFRESH,
                    "expiresAt": expires,
                    "scopes": ["user:inference", "user:profile"],
                    "subscriptionType": "max",
                }
            }
        )
    )
    (directory / ".credentials.json").chmod(0o600)


def s1_auth(out: Path, gateway: str) -> None:
    """(f) Which variables and files carry the login, seen in what the provider receives. Made-up
    values only; the provider accepts the made-up key (or, for a subscription login, the made-up
    token as a bearer) so that the run goes on to its end and (g) shows the figure for it."""
    one_turn = [Turn(text="SPIKE-AUTH-OK")]
    day = 24 * 3600 * 1000
    variants: list[dict[str, Any]] = [
        {"name": "api-key", "api_key": FAKE_KEY, "env": {}, "bearer": False},
        {"name": "nothing", "api_key": None, "env": {}, "bearer": False},
        {
            "name": "oauth-token-env",
            "api_key": None,
            "env": {"CLAUDE_CODE_OAUTH_TOKEN": FAKE_OAUTH},
            "bearer": True,
        },
        {
            "name": "auth-token-env",
            "api_key": None,
            "env": {"ANTHROPIC_AUTH_TOKEN": FAKE_OAUTH},
            "bearer": True,
        },
        {
            "name": "api-key-and-oauth-token",
            "api_key": FAKE_KEY,
            "env": {"CLAUDE_CODE_OAUTH_TOKEN": FAKE_OAUTH},
            "bearer": False,
        },
        {"name": "credentials-file", "api_key": None, "env": {}, "bearer": True, "file": 365 * day},
        {
            "name": "credentials-file-expired",
            "api_key": None,
            "env": {},
            "bearer": True,
            "file": -day,
            "timeout": 100,
        },
        {
            "name": "api-key-helper",
            "api_key": None,
            "env": {},
            "bearer": False,
            "flags": ["--settings", json.dumps({"apiKeyHelper": f"echo {FAKE_KEY}"})],
        },
    ]
    for variant in variants:
        name = str(variant["name"])
        work = seed_work(out / f"work-auth-{name}")
        home = out / f"home-auth-{name}"
        shutil.rmtree(home, ignore_errors=True)
        home.mkdir()
        if "file" in variant:
            credentials_file(home, expires_in_ms=int(variant["file"]))
        with provider(one_turn, gateway, bearer=bool(variant["bearer"])) as prov:
            run = claude(
                f"auth-{name}",
                prov,
                out,
                prompt="say ok",
                flags=[*BYPASS, *variant.get("flags", [])],
                mounts=[f"{work}:/work", f"{home}:/root/.claude"],
                env={"IS_SANDBOX": "1", **variant["env"]},
                api_key=variant["api_key"],
                timeout=float(variant.get("timeout", 60)),
            )
            seen = [
                {
                    "x_api_key": "x-api-key" in r.headers,
                    "authorization": r.headers.get("authorization", "")[:14] or None,
                    "beta_has_oauth": "oauth" in r.headers.get("anthropic-beta", ""),
                    "status_hint": r.headers.get("x-app"),
                }
                for r in prov.fake.records
            ]
        init = run.of_type("system", "init")
        REPORT.fact(
            f"s1_auth_{name}",
            rc=run.returncode,
            seconds=run.seconds,
            api_key_source=init[0].get("apiKeySource") if init else None,
            provider_requests=seen[:2],
            result_ok=run.result.get("subtype"),
            result_is_error=run.result.get("is_error"),
            result_text=short(run.result.get("result"), 140),
            total_cost_usd=run.result.get("total_cost_usd"),
            cost_basis={
                k: v.get("costBasis")
                for k, v in cast(
                    "dict[str, dict[str, Any]]", run.result.get("modelUsage") or {}
                ).items()
            },
            stderr=short(run.stderr.strip(), 300) or None,
            files_in_the_config_dir=sorted(
                str(p.relative_to(home)) for p in home.rglob("*") if p.is_file()
            )[:12],
            token_stored_in_files=mentions(home, FAKE_OAUTH[-20:])
            if "file" not in variant
            else "n/a (the file is the input)",
        )
    # What the CLI says about the login without a network (a made-up token, a made-up key).
    for label, env in (
        ("oauth-token", {"CLAUDE_CODE_OAUTH_TOKEN": FAKE_OAUTH}),
        ("api-key", {"ANTHROPIC_API_KEY": FAKE_KEY}),
    ):
        status = docker(
            "run",
            "--rm",
            "--network",
            NETWORK,
            *[x for k, v in env.items() for x in ("-e", f"{k}={v}")],
            CLAUDE_IMAGE,
            "claude",
            "auth",
            "status",
            timeout=60,
        )
        REPORT.fact(
            f"s1_auth_status_with_{label}",
            rc=status.returncode,
            text=short((status.stdout + status.stderr).strip(), 400),
        )
    # What the CLI itself offers around the login.
    for argv in (["claude", "auth", "--help"], ["claude", "setup-token", "--help"]):
        helped = docker("run", "--rm", CLAUDE_IMAGE, *argv, timeout=60)
        REPORT.fact(
            f"s1_cli_{'_'.join(argv[1:-1])}",
            rc=helped.returncode,
            text=short((helped.stdout + helped.stderr).strip(), 600),
        )


def s1_cost(out: Path, gateway: str) -> None:
    """(g) What `result` reports for a model nobody priced, and what `--max-budget-usd` does."""
    work = seed_work(out / "work-cost")
    with provider(script_events(), gateway, model=UNKNOWN_MODEL) as prov:
        run = claude(
            "cost-unknown-model",
            prov,
            out,
            prompt=ONE,
            flags=BYPASS,
            mounts=[f"{work}:/work"],
            env={"IS_SANDBOX": "1"},
            model=UNKNOWN_MODEL,
        )
    REPORT.fact(
        "s1_cost_of_a_model_without_a_price",
        rc=run.returncode,
        total_cost_usd=run.result.get("total_cost_usd"),
        model_usage=short(run.result.get("modelUsage")),
        stderr=short(run.stderr.strip(), 200) or None,
    )
    work = seed_work(out / "work-budget")
    with provider(script_events(), gateway) as prov:
        run = claude(
            "cost-budget",
            prov,
            out,
            prompt=ONE,
            flags=[*BYPASS, "--max-budget-usd", "0.01"],
            mounts=[f"{work}:/work"],
            env={"IS_SANDBOX": "1"},
        )
    REPORT.fact(
        "s1_max_budget_usd_stops_the_turn",
        rc=run.returncode,
        subtype=run.result.get("subtype"),
        is_error=run.result.get("is_error"),
        total_cost_usd=run.result.get("total_cost_usd"),
        provider_calls=len(run.calls),
        terminal_reason=run.result.get("terminal_reason"),
        errors=short(run.result.get("errors")),
    )


# -- S1: follow-up messages in one process, and what a run costs the container ---------------------------


def stream_input(out: Path, gateway: str) -> None:
    """The hosted turn sends its extra message to the same session (a tree left dirty): with
    `--input-format stream-json` one `claude` process takes a second user message after the first
    `result`, and ends when its input does."""
    work = seed_work(out / "work-stream-input")
    with provider([read_notes(), Turn(text=A1), Turn(text=A2)], gateway) as prov:
        container = "spike-stream-input"
        docker("rm", "-f", container)
        argv = [
            "docker",
            "run",
            "--rm",
            "-i",
            "--name",
            container,
            "--network",
            NETWORK,
            "-w",
            "/work",
            "-e",
            f"ANTHROPIC_BASE_URL={prov.url}",
            "-e",
            f"ANTHROPIC_API_KEY={FAKE_KEY}",
            "-e",
            "IS_SANDBOX=1",
            "-e",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
            "-v",
            f"{work}:/work",
            CLAUDE_IMAGE,
            "claude",
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            MODEL,
            *BYPASS,
        ]
        started = time.monotonic()
        process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        assert process.stdin is not None and process.stdout is not None
        results: list[dict[str, Any]] = []
        stamps: list[float] = []

        def send(text: str) -> None:
            assert process.stdin is not None
            message = {
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": text}]},
            }
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()

        send(R1)
        for line in process.stdout:
            try:
                event = cast("dict[str, Any]", json.loads(line))
            except ValueError:
                continue
            if event.get("type") == "result":
                results.append(event)
                stamps.append(round(time.monotonic() - started, 2))
                if len(results) == 1:
                    send(R2)
                else:
                    process.stdin.close()
        try:
            code = process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            code = -9
        text = prov.requests_text()
    REPORT.say(
        "s1_stream_json_input_takes_a_second_user_message_in_the_same_process",
        len(results) == 2 and code == 0 and R1[:16] in text and A1 in text,
        results=[short(r.get("result")) for r in results],
        session_ids=[r.get("session_id") for r in results],
        total_cost_usd=[r.get("total_cost_usd") for r in results],
        seconds_at_results=stamps,
        returncode=code,
        provider_requests=len(prov.fake.records),
    )


def resources(out: Path, gateway: str) -> None:
    """What a `claude -p` run costs the container: the peak memory of its cgroup and the time."""
    work = seed_work(out / "work-resources")
    with provider(script_events(), gateway) as prov:
        container = "spike-resources"
        docker("rm", "-f", container)
        started = time.monotonic()
        done = docker(
            "run",
            "--rm",
            "--name",
            container,
            "--network",
            NETWORK,
            "-w",
            "/work",
            "-e",
            f"ANTHROPIC_BASE_URL={prov.url}",
            "-e",
            f"ANTHROPIC_API_KEY={FAKE_KEY}",
            "-e",
            "IS_SANDBOX=1",
            "-e",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
            "-v",
            f"{work}:/work",
            CLAUDE_IMAGE,
            "sh",
            "-c",
            f"claude -p {ONE!r} --model {MODEL} --permission-mode bypassPermissions >/dev/null 2>&1; "
            "cat /sys/fs/cgroup/memory.peak",
        )
    peak = int(done.stdout.strip().split()[-1]) if done.stdout.strip().split() else 0
    REPORT.fact(
        "s1_resources_of_one_run",
        container_memory_peak_mib=round(peak / 1048576, 1),
        wall_seconds=round(time.monotonic() - started, 2),
        node=docker("run", "--rm", CLAUDE_IMAGE, "node", "--version").stdout.strip(),
    )


# -- S2: the agent's own Docker --------------------------------------------------------------------

DIND_VERSION = "29.9.2"
DIND_IMAGE = f"docker:{DIND_VERSION}-dind"
DIND_ROOTLESS_IMAGE = f"docker:{DIND_VERSION}-dind-rootless"
POSTGRES = "postgres:17-alpine"
# Sysbox as the golden snapshot pins it (`dispatcher/src/snapshot/config.ts`).
SYSBOX_VERSION = "0.7.1"
SYSBOX_SHA256 = "9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5"
SYSBOX_URL = f"https://github.com/nestybox/sysbox/releases/download/v{SYSBOX_VERSION}/sysbox-ce_{SYSBOX_VERSION}.linux_amd64.deb"
ROOTLESS_SOCKET = "unix:///run/user/1000/docker.sock"


def timed_docker(
    *args: str, timeout: float = 300.0
) -> tuple[subprocess.CompletedProcess[str], float]:
    started = time.monotonic()
    done = docker(*args, timeout=timeout)
    return done, round(time.monotonic() - started, 2)


def inner(
    container: str, command: str, *, host: str | None = None, timeout: float = 300.0
) -> tuple[subprocess.CompletedProcess[str], float]:
    """A command in the agent's container, with its Docker client pointed at the agent's own daemon."""
    prefix = f"export DOCKER_HOST={host}; " if host else ""
    return timed_docker("exec", container, "sh", "-c", prefix + command, timeout=timeout)


def exercise(
    name: str,
    run_args: Sequence[str],
    image: str,
    *,
    host: str | None = None,
    ready_seconds: float = 60.0,
    pull_first: bool = True,
) -> dict[str, Any]:
    """Start the agent's container as `run_args` says, wait until its own Docker answers, and run
    postgres in it. Everything is measured; nothing is assumed."""
    container = f"spike-agent-{name}"[:60]
    docker("rm", "-f", container)
    facts: dict[str, Any] = {"option": name, "image": image, "run_args": list(run_args)}
    started = time.monotonic()
    # The image's own default (TLS on its TCP port): with `DOCKER_TLS_CERTDIR` empty its daemon
    # binds an unprotected port and delays its start by 15 seconds on purpose (measured).
    created = docker("run", "-d", "--name", container, *run_args, image, timeout=120)
    facts["create_seconds"] = round(time.monotonic() - started, 2)
    if created.returncode != 0:
        facts.update(started=False, error=short(created.stderr.strip(), 400))
        return facts
    ready: float | None = None
    deadline = time.monotonic() + ready_seconds
    while time.monotonic() < deadline:
        if docker("inspect", "-f", "{{.State.Running}}", container).stdout.strip() != "true":
            break
        probe = docker(
            "exec",
            container,
            "sh",
            "-c",
            (f"DOCKER_HOST={host} " if host else "") + "docker info --format '{{.ServerVersion}}'",
        )
        if probe.returncode == 0:
            ready = round(time.monotonic() - started, 2)
            facts["inner_server_version"] = probe.stdout.strip()
            break
        time.sleep(0.25)
    facts["inner_docker_ready_seconds"] = ready
    inspected = docker(
        "inspect",
        "-f",
        "{{json .HostConfig.Privileged}} {{json .HostConfig.CapAdd}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.Devices}} {{.HostConfig.Runtime}} {{.Config.User}}",
        container,
    )
    facts["host_config"] = inspected.stdout.strip()
    maps = docker("exec", container, "sh", "-c", "id -u; cat /proc/self/uid_map")
    facts["uid_and_uid_map"] = " | ".join(maps.stdout.split("\n")[:3]).strip()
    attempt = docker(
        "exec",
        container,
        "sh",
        "-c",
        "ls /dev/vdb >/dev/null 2>&1 && mkdir -p /h && mount /dev/vdb /h 2>&1 && cat /h/etc/hostname 2>&1 || echo 'cannot reach the host disk'",
    )
    facts["host_disk_from_the_agent"] = short(attempt.stdout.strip().replace("\n", " / "), 160)
    if ready is None:
        logs = docker("logs", "--tail", "12", container)
        facts.update(started=False, log_tail=short((logs.stdout + logs.stderr).strip()[-700:], 700))
        docker("rm", "-f", container)
        return facts
    facts["started"] = True
    if pull_first:
        pulled, seconds = inner(container, f"docker pull -q {POSTGRES}", host=host, timeout=300)
        facts["inner_pull_postgres_seconds"] = seconds
        facts["inner_pull_ok"] = pulled.returncode == 0
        if pulled.returncode != 0:
            facts["inner_pull_error"] = short((pulled.stderr + pulled.stdout).strip(), 300)
    began = time.monotonic()
    run, _ = inner(
        container,
        f"docker run -d --name pg -e POSTGRES_PASSWORD=x {POSTGRES}",
        host=host,
        timeout=300,
    )
    facts["inner_docker_run_ok"] = run.returncode == 0
    if run.returncode != 0:
        facts["inner_run_error"] = short((run.stderr + run.stdout).strip(), 400)
    else:
        for _ in range(240):
            ok, _ = inner(
                container,
                "docker exec pg pg_isready -U postgres -q && docker exec pg psql -U postgres -tAc 'select 6*7'",
                host=host,
                timeout=30,
            )
            if ok.returncode == 0 and ok.stdout.strip().endswith("42"):
                facts["inner_postgres_answers_seconds"] = round(time.monotonic() - began, 2)
                break
            time.sleep(0.25)
        else:
            facts["inner_postgres_answers_seconds"] = None
    peak = docker("exec", container, "cat", "/sys/fs/cgroup/memory.peak")
    facts["outer_container_memory_peak_mib"] = (
        round(int(peak.stdout.strip() or 0) / 1048576, 1) if peak.returncode == 0 else None
    )
    facts["total_seconds_to_a_running_postgres"] = round(time.monotonic() - started, 2)
    docker("rm", "-f", container)
    return facts


def pull_dind(out: Path) -> None:
    for image in (DIND_IMAGE, DIND_ROOTLESS_IMAGE, POSTGRES, "alpine:3.22"):
        done, seconds = timed_docker("pull", "-q", image, timeout=600)
        size = docker("image", "inspect", image, "--format", "{{.Size}}").stdout.strip()
        REPORT.fact(
            "s2_image",
            image=image,
            pull_seconds=seconds,
            rc=done.returncode,
            size_bytes=int(size or 0),
        )


def s2_none(out: Path) -> None:
    """(3) No Docker in the agent. The agent's container has nothing of Docker; the runner can start
    the services a task needs beside it, on the agent's network (a service container)."""
    container = "spike-agent-none"
    docker("rm", "-f", container)
    started = time.monotonic()
    docker("run", "-d", "--name", container, "alpine:3.22", "sleep", "600", check=True)
    created = round(time.monotonic() - started, 2)
    probe = docker(
        "exec",
        container,
        "sh",
        "-c",
        "docker run --rm hello-world 2>&1; ls /var/run/docker.sock 2>&1; echo rc=$?",
    )
    inspected = docker(
        "inspect",
        "-f",
        "{{json .HostConfig.Privileged}} {{json .HostConfig.CapAdd}} {{json .HostConfig.SecurityOpt}} {{.HostConfig.Runtime}}",
        container,
    )
    docker("rm", "-f", container)
    REPORT.fact(
        "s2_none_plain_container",
        container_start_seconds=created,
        docker_run_inside=short(probe.stdout.strip().replace("\n", " / "), 200),
        host_config=inspected.stdout.strip(),
    )
    # A service container the runner starts: the agent reaches it by name on a network it shares.
    network = "spike-services"
    docker("network", "rm", network)
    docker("network", "create", network, check=True)
    began = time.monotonic()
    docker(
        "run",
        "-d",
        "--name",
        "spike-service-pg",
        "--network",
        network,
        "-e",
        "POSTGRES_PASSWORD=x",
        POSTGRES,
        check=True,
    )
    docker(
        "run", "-d", "--name", container, "--network", network, POSTGRES, "sleep", "600", check=True
    )
    answered: float | None = None
    for _ in range(240):
        ok = docker("exec", container, "sh", "-c", "pg_isready -h spike-service-pg -U postgres -q")
        if ok.returncode == 0:
            answered = round(time.monotonic() - began, 2)
            break
        time.sleep(0.25)
    docker("rm", "-f", container, "spike-service-pg")
    docker("network", "rm", network)
    REPORT.say(
        "s2_none_a_service_container_beside_the_agent",
        answered is not None,
        postgres_answers_from_the_agent_seconds=answered,
        image_already_pulled=True,
    )


PLATFORM_TUN_MODE = 0o600


def open_tun_device() -> None:
    """A regular Linux host has `/dev/net/tun` at mode 0666; this platform's image has 0600, which
    an unprivileged user inside a container cannot open (rootless Docker's `slirp4netns` needs it).
    The rootless and privileged options are measured with the device as a regular host has it, and
    the fact says so."""
    before = os.stat("/dev/net/tun").st_mode & 0o777
    os.chmod("/dev/net/tun", 0o666)
    REPORT.fact(
        "s2_tun_device", mode_on_this_platform=oct(before), mode_for_the_measurements="0o666"
    )


def s2_privileged() -> None:
    """Rootful Docker-in-Docker with `--privileged`: what it needs and what it gives away."""
    facts = exercise("privileged", ["--privileged"], DIND_IMAGE)
    REPORT.fact("s2_privileged_rootful_dind", **facts)


def s2_rootless() -> None:
    """(2) Rootless Docker-in-Docker in a container, with as little as can be taken away: what does
    it need beside `--privileged`?"""
    open_tun_device()
    tun = ["--device", "/dev/net/tun"]
    seccomp = ["--security-opt", "seccomp=unconfined"]
    apparmor = ["--security-opt", "apparmor=unconfined"]
    systempaths = ["--security-opt", "systempaths=unconfined"]
    variants: list[tuple[str, list[str]]] = [
        ("no-flags", []),
        ("tun-device-only", tun),
        ("tun-and-seccomp-unconfined", [*tun, *seccomp]),
        ("tun-seccomp-and-systempaths-unconfined", [*tun, *seccomp, *systempaths]),
        (
            "tun-seccomp-apparmor-and-systempaths-unconfined",
            [*tun, *seccomp, *apparmor, *systempaths],
        ),
        ("privileged", ["--privileged"]),
    ]
    results: list[dict[str, Any]] = []
    for name, flags in variants:
        facts = exercise(
            f"rootless-{name}", flags, DIND_ROOTLESS_IMAGE, host=ROOTLESS_SOCKET, ready_seconds=45
        )
        results.append(facts)
        REPORT.fact("s2_rootless_dind", variant=name, **facts)
    working = [r["option"] for r in results if r.get("inner_postgres_answers_seconds") is not None]
    REPORT.say(
        "s2_rootless_dind_some_variant_runs_postgres", bool(working), variants_that_work=working
    )


def sysbox_state() -> dict[str, Any]:
    return {
        "installed": sh("dpkg-query -W -f='${Version}' sysbox-ce 2>/dev/null").stdout.strip()
        or None,
        "mgr_running": sh("pgrep -x sysbox-mgr").returncode == 0,
        "fs_running": sh("pgrep -x sysbox-fs").returncode == 0,
        "kcore_masked": "/proc/kcore" in Path("/proc/self/mountinfo").read_text(),
        "tun_mode": oct(os.stat("/dev/net/tun").st_mode & 0o777)
        if Path("/dev/net/tun").exists()
        else None,
    }


def install_package(deb: Path) -> subprocess.CompletedProcess[str]:
    return sh(
        "export DEBIAN_FRONTEND=noninteractive; stub=$(mktemp -d); "
        "printf '#!/bin/sh\\nexit 0\\n' > $stub/systemctl; chmod 0755 $stub/systemctl; "
        f"PATH=$stub:$PATH apt-get install -y -qq kmod jq {deb} 2>&1 | tail -6; rm -rf $stub",
        timeout=600,
    )


def install_sysbox() -> dict[str, Any]:
    """(1) The Sysbox package as the golden snapshot installs it, on this distribution: download,
    checksum, install without systemd, and what the package says it needs."""
    facts: dict[str, Any] = {
        "os": sh("grep PRETTY_NAME /etc/os-release").stdout.strip(),
        "kernel": os.uname().release,
    }
    if sysbox_state()["installed"]:
        facts["already_installed"] = True
        return facts
    deb = Path("/tmp/spike-sysbox.deb")
    started = time.monotonic()
    got = sh(
        f"curl --fail --silent --show-error --location --retry 3 --max-time 180 --output {deb} {SYSBOX_URL}"
    )
    facts["download_seconds"] = round(time.monotonic() - started, 2)
    facts["download_ok"] = got.returncode == 0
    if got.returncode != 0:
        facts["error"] = got.stderr[-300:]
        return facts
    facts["deb_bytes"] = deb.stat().st_size
    digest = sh(f"sha256sum {deb}").stdout.split()[0]
    facts["sha256_is_the_pinned_one"] = digest == SYSBOX_SHA256
    control = sh(
        f"dpkg -I {deb} | grep -E '^ (Depends|Recommends|Conflicts|Provides|Description)' | cut -c1-300"
    ).stdout
    facts["package_control"] = control.strip().splitlines()
    scripts = sh(
        f"rm -rf /tmp/spike-deb && mkdir /tmp/spike-deb && dpkg -e {deb} /tmp/spike-deb && ls /tmp/spike-deb && grep -hE 'systemctl|docker|restart|reboot|modprobe|useradd|subuid' /tmp/spike-deb/postinst /tmp/spike-deb/preinst /tmp/spike-deb/prerm 2>/dev/null | head -40"
    ).stdout
    facts["maintainer_scripts_touch"] = scripts.strip().splitlines()[:40]
    # First as a customer would: Docker is running, nothing is prepared, the package does what its
    # maintainer script does. The host here has no systemd, so a `systemctl` stub is first on the
    # `PATH` (dpkg keeps its own `PATH` for maintainer scripts: the stub is seen by `apt`, not by
    # the script, and the result says what happened).
    config = Path("/etc/docker/daemon.json")
    config.unlink(missing_ok=True)
    began = time.monotonic()
    first = install_package(deb)
    facts["first_install"] = {
        "seconds": round(time.monotonic() - began, 2),
        "package_status": sh("dpkg -s sysbox-ce | grep ^Status").stdout.strip(),
        "output_tail": short(first.stdout.strip(), 500),
        "daemon_json_afterwards": json.loads(config.read_text()) if config.exists() else None,
    }
    # Then as the golden snapshot does: the package is installed while the daemon is not running
    # (the maintainer script then only advises a restart), and the daemon is configured and
    # started after it.
    sh(
        "pkill -x sysbox-fs; pkill -x sysbox-mgr; dpkg --purge --force-all sysbox-ce; pkill -x dockerd; "
        "for i in $(seq 1 100); do pgrep -x dockerd >/dev/null || break; sleep 0.1; done"
    )
    config.unlink(missing_ok=True)
    began = time.monotonic()
    installed = install_package(deb)
    facts["install_seconds"] = round(time.monotonic() - began, 2)
    facts["install_output_tail"] = short(installed.stdout.strip(), 300)
    facts["package_status"] = sh("dpkg -s sysbox-ce | grep ^Status").stdout.strip()
    register_runtime()
    facts["installed_version"] = sysbox_state()["installed"]
    facts["sysbox_runc_version"] = (
        sh("sysbox-runc --version | head -3").stdout.strip().replace("\n", " / ")
    )
    units = (
        sh("dpkg -L sysbox-ce | grep -E 'systemd|\\.service$|/usr/bin/sysbox'")
        .stdout.strip()
        .splitlines()
    )
    facts["files_of_interest"] = units[:14]
    facts["disk_bytes_installed"] = (
        int(sh("dpkg-query -W -f='${Installed-Size}' sysbox-ce").stdout.strip() or 0) * 1024
    )
    return facts


def register_runtime() -> None:
    """`/etc/docker/daemon.json` as the golden snapshot writes it (the runtime registered, `runc` still
    the default) and a restart of the daemon, which a package on a systemd host does by itself."""
    config = {
        "ipv6": False,
        "ip6tables": False,
        "live-restore": False,
        "runtimes": {"sysbox-runc": {"path": "/usr/bin/sysbox-runc"}},
        "log-opts": {"max-size": "10m", "max-file": "2"},
    }
    Path("/etc/docker/daemon.json").write_text(json.dumps(config, indent=2) + "\n")
    sh(
        "pkill -x dockerd; for i in $(seq 1 100); do pgrep -x dockerd >/dev/null || break; sleep 0.1; done"
    )
    prepared = sh(str(REPO / "docker" / "sandbox" / "vm-prepare.sh"))
    if prepared.returncode != 0:
        raise SystemExit(f"vm-prepare failed after the restart: {prepared.stderr[-300:]}")


def sysbox_attempt() -> tuple[bool, str]:
    done = docker(
        "run", "--rm", "--runtime=sysbox-runc", "alpine:3.22", "echo", "sysbox-ok", timeout=90
    )
    return done.returncode == 0 and "sysbox-ok" in done.stdout, short(
        (done.stderr + done.stdout).strip().replace("\n", " / ")[-300:], 300
    )


def s2_sysbox_plain(out: Path) -> bool:
    """(1) Sysbox without our boot steps, one step at a time: what the package alone gives, and which
    of the steps of `docker/sandbox/sysbox-prepare.sh` this platform needs and why. Returns whether
    a container ran at the end."""
    REPORT.fact("s2_sysbox_install", **install_sysbox())
    state = sysbox_state()
    if state["mgr_running"] or not state["kcore_masked"]:
        REPORT.fact(
            "s2_sysbox_ablation_skipped",
            reason="the VM was prepared already (a rerun)",
            state=state,
        )
        return sysbox_attempt()[0]
    if Path("/dev/net/tun").exists():
        os.chmod("/dev/net/tun", PLATFORM_TUN_MODE)  # back to what the platform ships
    steps: list[tuple[str, str]] = [
        ("package only (daemons not running)", "true"),
        (
            "plus sysbox-mgr and sysbox-fs (what systemd does on a normal host)",
            "mkdir -p /var/log; nohup setsid sysbox-mgr > /var/log/sysbox-mgr.log 2>&1 & "
            "for i in $(seq 1 100); do [ -S /run/sysbox/sysmgr.sock ] && break; sleep 0.1; done; "
            "nohup setsid sysbox-fs > /var/log/sysbox-fs.log 2>&1 & for i in $(seq 1 100); do [ -S /run/sysbox/sysfs.sock ] && break; sleep 0.1; done",
        ),
        ("plus /dev/net/tun mode 0666 (the platform has 0600)", "chmod 0666 /dev/net/tun"),
        (
            "plus unmounting the platform's /proc/kcore and /proc/keys",
            'for n in /proc/kcore /proc/keys; do grep -q " $n " /proc/self/mountinfo && umount $n || true; done',
        ),
        (
            "plus the sysctl file of the package",
            "sysctl -q -e -p /lib/sysctl.d/99-sysbox-sysctl.conf",
        ),
    ]
    first_working: str | None = None
    for label, command in steps:
        sh(command)
        ok, text = sysbox_attempt()
        REPORT.fact("s2_sysbox_ablation", step=label, container_runs=ok, result=text)
        if ok and first_working is None:
            first_working = label
    REPORT.say(
        "s2_sysbox_runs_a_container_after_some_steps",
        first_working is not None,
        first_step_that_works=first_working,
    )
    return first_working is not None


def s2_sysbox(out: Path) -> None:
    """The hosted setup, as `sysbox-prepare.sh` makes it, and the same exercise as the others."""
    prepared = sh(str(REPO / "docker" / "sandbox" / "sysbox-prepare.sh"), timeout=120)
    REPORT.say(
        "s2_sysbox_prepare_script_exits_zero",
        prepared.returncode == 0,
        stderr=prepared.stderr[-300:],
    )
    facts = exercise("sysbox", ["--runtime=sysbox-runc"], DIND_IMAGE)
    REPORT.fact("s2_sysbox_dind", **facts)
    again = exercise("sysbox-2", ["--runtime=sysbox-runc"], DIND_IMAGE, pull_first=False)
    REPORT.fact("s2_sysbox_dind_second_start", **again)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=["s1", "s2", "all", "build"])
    parser.add_argument("--out", help="work directory; default: a fresh one in the temp directory")
    parser.add_argument("--only", default="", help="comma list of the parts to run")
    arguments = parser.parse_args()
    refuse_unless_spike_vm(socket.gethostname(), os.environ)
    out = Path(arguments.out) if arguments.out else Path(tempfile.mkdtemp(prefix="runner-spikes-"))
    out.mkdir(parents=True, exist_ok=True)
    only = {part for part in arguments.only.split(",") if part}
    ensure_docker()
    remove_leftovers()
    gateway = network_gateway()

    def wanted(name: str, group: str) -> bool:
        return arguments.what in (group, "all") and (not only or name in only)

    if (
        arguments.what in ("build", "s1", "all")
        and docker("image", "inspect", CLAUDE_IMAGE).returncode != 0
    ):
        build_claude_image(out)
    try:
        if wanted("events", "s1"):
            s1_events(out, gateway)
        if wanted("finish", "s1"):
            s1_finish_tool(out, gateway)
        if wanted("resume", "s1"):
            s1_resume(out, gateway)
        if wanted("permissions", "s1"):
            s1_permissions(out, gateway)
        if wanted("auth", "s1"):
            s1_auth(out, gateway)
        if wanted("cost", "s1"):
            s1_cost(out, gateway)
        if wanted("stream-input", "s1"):
            stream_input(out, gateway)
        if wanted("resources", "s1"):
            resources(out, gateway)
        if arguments.what in ("s2", "all"):
            pull_dind(out)
            if wanted("none", "s2"):
                s2_none(out)
            if wanted("rootless", "s2"):
                s2_rootless()
            if wanted("privileged", "s2"):
                s2_privileged()
            if wanted("sysbox-plain", "s2"):
                s2_sysbox_plain(out)
            if wanted("sysbox", "s2"):
                s2_sysbox(out)
    finally:
        remove_leftovers()
    _ = (Callable, threading, BaseHTTPRequestHandler, ThreadingHTTPServer, field)
    REPORT.say("total", REPORT.ok)
    return 0 if REPORT.ok else 1


if __name__ == "__main__":
    sys.exit(main())
