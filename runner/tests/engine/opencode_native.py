# SPDX-License-Identifier: LicenseRef-Proprietary

"""Support for the engine tests of the native provider path (#546, study #544).

It starts the real, pinned OpenCode (`opencode_support.opencode_binary()`) the way the adapter does
(`serve` on a loopback port, the closed environment of `config.engine_environment`, default-deny
permissions, one agent), but with provider entries of the test's choosing instead of the runner's
model proxy: the entry the study proposes to generate per job (`provider.<id>` with `npm`,
`options.baseURL` and `options.apiKey` and `models.<model>`), pointing at the key swapping relay of
`fakes/wire/relay.py`, which points at the scripted upstream of `fakes/wire/upstream.py`.

An engine start costs about five seconds, so one engine holds many providers (`Provider`), each with
its own fake upstream and relay, and answers many turns, each on a provider and model of the test's
choice. A test that needs a different environment (a models file, a refused config) starts its own.

Nothing here is production code and nothing talks beyond loopback. The turn it sends has no
`format`, so the engine runs its ordinary tool loop and ends in plain text (decision 4 of #544).
"""

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Generator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, cast

from engine_ports import EngineExitedEarly, start_on_free_port
from opencode_support import extra_path, opencode_binary, ripgrep_binary

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Family, Turn
from fakes.wire.relay import KeySwapRelay, Seen
from fakes.wire.upstream import Judge, OnAnswer, Record, ScriptedUpstream

from code_reviewer_runner.dynamic_review.config import engine_environment, permission_block

REAL_KEY = "real-key-stand-in-0123456789"
DUMMY_KEY = "dummy-capability-0123456789"

# A provider id and a model id that the embedded snapshot of the pinned engine has never heard of.
DEFAULT_IDS: dict[Family, tuple[str, str]] = {
    "chat": ("acme-chat", "acme-chat-9"),
    "responses": ("acme-resp", "acme-resp-9"),
    "messages": ("acme-claude", "acme-claude-9"),
    "google": ("acme-gemini", "acme-gemini-9"),
}
# The AI SDK package of a family and the base path the SDK appends its route to.
NPM: dict[Family, str] = {
    "chat": "@ai-sdk/openai-compatible",
    "responses": "@ai-sdk/openai",
    "messages": "@ai-sdk/anthropic",
    "google": "@ai-sdk/google",
}
BASE_PATH: dict[Family, str] = {
    "chat": "/v1",
    "responses": "/v1",
    "messages": "/v1",
    "google": "/v1beta",
}
# The smallest model entry that states what the study proposes to generate: limits and capabilities.
MINIMAL_ENTRY: dict[str, Any] = {
    "name": "Spike model",
    "limit": {"context": 200000, "output": 8192},
    "tool_call": True,
    "reasoning": False,
    "temperature": True,
}
SESSION_TITLE = "spike"
TURN_SECONDS = 120.0
HEALTH_SECONDS = 60.0


@dataclass
class Provider:
    """One `provider.<id>` block of the engine's config, with the fakes behind it.

    The upstream serves `model` (and the models of `served`); `others` are further model entries of
    the block, which the engine lists (`GET /config/providers`) whether or not anything serves them.
    `entry=None` is `MINIMAL_ENTRY`, `npm=False` leaves the SDK unnamed, `pinned` makes the relay
    refuse every model but `model`, and `tune` sets faults and framing on the upstream.
    """

    family: Family
    id: str | None = None
    model: str | None = None
    entry: Mapping[str, Any] | None = None
    npm: bool = True
    steps: int = 6
    thinking: str = ""
    # The model's turns when the test needs more than the six tool calls of `tool_script`.
    script: Callable[[Path], Sequence[Turn]] | None = None
    others: Mapping[str, Mapping[str, Any]] = field(default_factory=lambda: {})
    served: Sequence[str] = ()
    pinned: bool = False
    judge: Judge | None = None
    on_answer: OnAnswer | None = None
    tune: Callable[[ScriptedUpstream], None] | None = None

    @property
    def provider_id(self) -> str:
        return self.id or DEFAULT_IDS[self.family][0]

    @property
    def model_id(self) -> str:
        return self.model or DEFAULT_IDS[self.family][1]


@dataclass
class Assistant:
    """One assistant message of the session: what the engine counted and what it did."""

    tokens: dict[str, Any]
    cost: float
    finish: str | None
    error: dict[str, Any] | None
    tools: list[str]
    text: str


@dataclass
class Outcome:
    """One turn: what the engine answered, and what went through the relay during it."""

    http_status: int
    reply: Any
    assistants: list[Assistant]
    records: list[Record]  # what the upstream received
    seen: list[Seen]  # what the relay saw (the engine's request, the key shown as `<dummy>`)

    def bodies(self) -> list[dict[str, Any]]:
        """The JSON bodies of the engine's calls, tool-less title calls included."""
        found: list[dict[str, Any]] = []
        for seen in self.seen:
            body: Any = seen.body
            if isinstance(body, dict):
                found.append(cast("dict[str, Any]", body))
        return found


@dataclass
class Run(Outcome):
    """A single turn on an engine of its own, with the engine's view of the model and its log."""

    resolved: dict[str, Any]
    log: str


def tool_script(export: Path, steps: int, thinking: str = "") -> list[Turn]:
    """Up to six tool calls over the little export, then the final text."""
    plan = [
        Turn(tool="glob", args={"pattern": "**/*.py"}, thinking=thinking),
        Turn(tool="read", args={"filePath": str(export / "src" / "app.py")}, thinking=thinking),
        Turn(tool="grep", args={"pattern": "def "}, thinking=thinking),
        Turn(tool="read", args={"filePath": str(export / "src" / "db.py")}, thinking=thinking),
        Turn(tool="glob", args={"pattern": "*.md"}, thinking=thinking),
        Turn(tool="grep", args={"pattern": "query"}, thinking=thinking),
    ][:steps]
    return [*plan, Turn(text='{"findings": [], "summary": "spike done"}', thinking=thinking)]


def make_export(root: Path) -> Path:
    export = root / "export"
    (export / "src").mkdir(parents=True)
    (export / "src" / "app.py").write_text("def handler(user):\n    return query(user)\n")
    (export / "src" / "db.py").write_text("def query(value):\n    return 'SELECT ' + value\n")
    (export / "README.md").write_text("# demo\n")
    return export


def _call(
    method: str, url: str, body: Any, directory: str | None, timeout: float = 30.0
) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if directory:
        headers["x-opencode-directory"] = directory
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, raw.decode("utf-8", "replace")


def provider_block(provider: Provider, relay_url: str) -> dict[str, Any]:
    """The `provider.<id>` block: what the study would generate for one job."""
    family = provider.family
    models: dict[str, Any] = {
        provider.model_id: dict(MINIMAL_ENTRY if provider.entry is None else provider.entry)
    }
    models.update({name: dict(entry) for name, entry in provider.others.items()})
    block: dict[str, Any] = {
        "name": f"spike {family}",
        "options": {"baseURL": relay_url + BASE_PATH[family], "apiKey": DUMMY_KEY},
        "models": models,
    }
    if provider.npm:
        block["npm"] = NPM[family]
    return block


def models_file(family: Family, provider: str, model: str) -> dict[str, Any]:
    """The smallest `OPENCODE_MODELS_PATH` file that worked: one provider, one model."""
    return {
        provider: {
            "id": provider,
            "name": "Spike",
            "npm": NPM[family],
            "env": [],
            "models": {
                model: {
                    "id": model,
                    "name": "Spike model",
                    "tool_call": True,
                    "limit": {"context": 200000, "output": 8192},
                }
            },
        }
    }


def engine_config(blocks: Mapping[str, dict[str, Any]], default: str) -> dict[str, Any]:
    """The trusted configuration of `config.build_engine_config`, with these provider blocks."""
    return {
        "permission": permission_block(),
        "agent": {
            "review": {
                "description": "Read-only review",
                "mode": "primary",
                "model": default,
                "prompt": "You review code. Use read, grep and glob, then answer in JSON text.",
            }
        },
        "provider": dict(blocks),
        "enabled_providers": list(blocks),
        "instructions": [],
        "plugin": [],
        "mcp": {},
        "lsp": False,
        "formatter": False,
        "snapshot": False,
        "share": "disabled",
        "autoupdate": False,
        "compaction": {"auto": False, "prune": False},
    }


class _Engine:
    """The pinned `opencode serve` process. It is stopped when it does not come up healthy."""

    process: subprocess.Popen[bytes]
    base: str

    def __init__(
        self,
        config: dict[str, Any],
        export: Path,
        home: Path,
        relay_url: str,
        models_path: Path | None,
    ) -> None:
        home.mkdir(parents=True, exist_ok=True)
        config_path = home / "opencode.json"
        config_path.write_text(json.dumps(config))
        ripgrep = ripgrep_binary()
        if ripgrep is None:
            raise AssertionError(
                "no ripgrep on this machine: set OPENCODE_TEST_PATH to its directory"
            )
        environment = engine_environment(
            proxy_url=relay_url,
            home=str(home),
            scratch_dir=str(home),
            node_bin=extra_path(),
            tools_dir=str(ripgrep.parent),
        )
        environment["OPENCODE_CONFIG"] = str(config_path)
        if models_path is not None:
            environment["OPENCODE_MODELS_PATH"] = str(models_path)
        self.export = str(export)
        self.log_path = home / "engine.log"
        self._log = self.log_path.open("wb")

        def start(port: int) -> subprocess.Popen[bytes]:
            return subprocess.Popen(
                [
                    str(opencode_binary()),
                    "serve",
                    "--hostname",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--print-logs",
                ],
                env=environment,
                cwd=str(export),
                stdin=subprocess.DEVNULL,
                stdout=self._log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )

        def wait(process: subprocess.Popen[bytes], port: int) -> None:
            self.process = process
            self.base = f"http://127.0.0.1:{port}"
            self._wait_until_healthy()

        try:
            # An engine that finds its port taken exits; under xdist the taker is another worker.
            start_on_free_port(start, wait, self._stop_process)
        except BaseException:
            # A constructor that fails leaves no `with` block to stop the process: the failed
            # attempt was stopped, and the log is ours to close.
            self._log.close()
            raise

    def _wait_until_healthy(self) -> None:
        deadline = time.monotonic() + HEALTH_SECONDS
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise EngineExitedEarly("the engine exited: " + self.log_path.read_text()[-1500:])
            document: Any = None
            status = 0
            with contextlib.suppress(OSError):
                status, document = _call("GET", f"{self.base}/global/health", None, None, 2.0)
            healthy = cast("dict[str, Any]", document) if isinstance(document, dict) else {}
            if status == 200 and healthy.get("healthy") is True:
                return
            time.sleep(0.2)
        raise AssertionError("the engine did not become healthy")

    @staticmethod
    def _stop_process(process: subprocess.Popen[bytes]) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)

    def stop(self) -> None:
        self._stop_process(self.process)
        self._log.close()

    def log(self) -> str:
        return self.log_path.read_text(errors="replace")


def _assistants(history: Any) -> list[Assistant]:
    steps: list[Assistant] = []
    messages: list[Any] = cast("list[Any]", history) if isinstance(history, list) else []
    for message in messages:
        info: dict[str, Any] = message.get("info") or {}
        if info.get("role") != "assistant":
            continue
        parts: list[dict[str, Any]] = message.get("parts") or []
        steps.append(
            Assistant(
                tokens=info.get("tokens") or {},
                cost=info.get("cost") or 0,
                finish=info.get("finish"),
                error=info.get("error"),
                tools=[p["tool"] for p in parts if p.get("type") == "tool"],
                text="".join(p.get("text", "") for p in parts if p.get("type") == "text"),
            )
        )
    return steps


class Front(Protocol):
    """What stands between the engine and a fake provider: the relay of the spike, or the
    passthrough proxy (#550). The engine only needs its address, and the outcome of a turn lists
    what it saw."""

    @property
    def url(self) -> str: ...

    seen: list[Seen]


@dataclass
class Running:
    """A provider of the engine with the fakes behind it."""

    provider: Provider
    upstream: ScriptedUpstream
    relay: Front


class NativeEngine:
    """One running engine with its providers; every turn is a session of its own."""

    def __init__(self, process: _Engine, running: Mapping[str, Running]) -> None:
        self._process = process
        self.running = dict(running)

    def log(self) -> str:
        return self._process.log()

    def listed(self, provider: str) -> dict[str, Any]:
        """The engine's view of a provider (`GET /config/providers`): its models by id."""
        base = self._process.base
        status, document = _call("GET", f"{base}/config/providers", None, self._process.export)
        assert status == 200, document
        found = next((p for p in document["providers"] if p["id"] == provider), None)
        return found["models"] if found else {}

    def resolved(self, provider: str, model: str) -> dict[str, Any]:
        """What the engine makes of a model entry, without any turn (`{}`: it does not offer it)."""
        return self.listed(provider).get(model, {})

    def turn(
        self,
        provider: str,
        model: str,
        *,
        title: str | None = SESSION_TITLE,
        variant: str | None = None,
        faults: Callable[[ScriptedUpstream], None] | None = None,
    ) -> Outcome:
        """One turn on a provider and a model (which the config may not know).

        The provider's script starts again from its first step and its faults are cleared, then
        `faults` sets the ones this turn is about.
        """
        base, export = self._process.base, self._process.export
        known = self.running.get(provider)
        if known is not None:
            known.upstream.restart()
            known.upstream.reset_faults()
            if faults is not None:
                faults(known.upstream)
        records_before = len(known.upstream.records) if known else 0
        seen_before = len(known.relay.seen) if known else 0
        status, session = _call(
            "POST", f"{base}/session", {"title": title} if title else {}, export
        )
        assert status == 200, (status, session)
        body: dict[str, Any] = {
            "agent": "review",
            "model": {"providerID": provider, "modelID": model},
            "parts": [{"type": "text", "text": "Review src and answer in JSON."}],
        }
        if variant:
            body["variant"] = variant
        url = f"{base}/session/{session['id']}/message"
        reply_status, reply = _call("POST", url, body, export, TURN_SECONDS)
        _, history = _call("GET", url, None, export)
        return Outcome(
            http_status=reply_status,
            reply=reply,
            assistants=_assistants(history),
            records=known.upstream.records[records_before:] if known else [],
            seen=known.relay.seen[seen_before:] if known else [],
        )


@dataclass(frozen=True)
class Step:
    """One turn of a plan: its key, the provider and model it asks, and the faults it needs."""

    key: str
    provider: str
    model: str
    faults: Callable[[ScriptedUpstream], None] | None = None
    title: str | None = SESSION_TITLE


def run_plan(engine: NativeEngine, steps: Sequence[Step], workers: int = 4) -> dict[str, Outcome]:
    """Run turns of different providers side by side (the turns of one provider in order).

    The engine answers many sessions at once; a provider's script and faults are its own, so only
    the turns that share a provider have to wait for each other.
    """
    groups: dict[str, list[Step]] = {}
    for step in steps:
        groups.setdefault(step.provider, []).append(step)

    def run_group(group: list[Step]) -> dict[str, Outcome]:
        return {
            step.key: engine.turn(step.provider, step.model, title=step.title, faults=step.faults)
            for step in group
        }

    outcomes: dict[str, Outcome] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for found in pool.map(run_group, groups.values()):
            outcomes.update(found)
    return outcomes


@contextmanager
def native_engine(
    scratch: Path, providers: Sequence[Provider], *, minimal_models_file: bool = False
) -> Generator[NativeEngine]:
    """Start the fakes of every provider and one engine that knows all of them.

    `minimal_models_file` moves the one provider and its model into a minimal
    `OPENCODE_MODELS_PATH` file and leaves only the options in the config.
    """
    export = make_export(scratch)
    with ExitStack() as stack:
        running: dict[str, Running] = {}
        blocks: dict[str, dict[str, Any]] = {}
        models_path: Path | None = None
        for provider in providers:
            upstream = stack.enter_context(
                ScriptedUpstream(
                    provider.family,
                    tool_script(export, provider.steps, provider.thinking),
                    provider.model_id,
                    real_key=REAL_KEY,
                    judge=provider.judge,
                    on_answer=provider.on_answer,
                    also_models=provider.served,
                )
            )
            if provider.tune is not None:
                provider.tune(upstream)
            relay = stack.enter_context(
                KeySwapRelay(
                    provider.family,
                    upstream.url,
                    dummy_key=DUMMY_KEY,
                    real_key=REAL_KEY,
                    pinned_model=provider.model_id if provider.pinned else None,
                )
            )
            running[provider.provider_id] = Running(provider, upstream, relay)
            if minimal_models_file:
                models_path = scratch / "models.json"
                models_path.write_text(
                    json.dumps(
                        models_file(provider.family, provider.provider_id, provider.model_id)
                    )
                )
                blocks[provider.provider_id] = {
                    "options": {
                        "baseURL": relay.url + BASE_PATH[provider.family],
                        "apiKey": DUMMY_KEY,
                    }
                }
            else:
                blocks[provider.provider_id] = provider_block(provider, relay.url)
        first = providers[0]
        config = engine_config(blocks, f"{first.provider_id}/{first.model_id}")
        process = _Engine(
            config,
            export,
            scratch / "home",
            next(iter(running.values())).relay.url,
            models_path,
        )
        stack.callback(process.stop)
        try:
            yield NativeEngine(process, running)
        finally:
            shutil.rmtree(export, ignore_errors=True)


def single_run(
    scratch: Path,
    provider: Provider,
    *,
    ask_provider: str | None = None,
    ask_model: str | None = None,
    title: str | None = SESSION_TITLE,
    variant: str | None = None,
    minimal_models_file: bool = False,
) -> Run:
    """One turn of the real engine on a provider of its own, and the engine's view afterwards."""
    with native_engine(scratch, [provider], minimal_models_file=minimal_models_file) as engine:
        outcome = engine.turn(
            ask_provider or provider.provider_id,
            ask_model or provider.model_id,
            title=title,
            variant=variant,
        )
        return Run(
            http_status=outcome.http_status,
            reply=outcome.reply,
            assistants=outcome.assistants,
            records=outcome.records,
            seen=outcome.seen,
            resolved=engine.resolved(provider.provider_id, provider.model_id),
            log=engine.log(),
        )
