# SPDX-License-Identifier: LicenseRef-Proprietary

"""The spike of the follow-up turn on a real VM (#837, PR 5 of
`plans/implementer-live-and-followup.md`): what the plan assumes about keeping the conversation of
a session, settled before PRs 7 and 8 are built.

    sudo -E env LANE_RUNTIME=sysbox-runc LANE_WORKER_IMAGE=code-reviewer-worker:golden \\
        LANE_AGENT_IMAGE=code-reviewer-agent:golden \\
        .venv/bin/python scripts/follow_up_spike.py [--out DIR] [--bulk-steps N] [--skip LIST]

Run as root on a `spike-` VM with Sysbox (a snapshot built from the branch), against the VM's
Docker, the way the lane runs (`tests/lane`, `lane_support.py`: the real session, the real door
code, the real agent image, reader and workspace). The model is the strict scripted fake of
`fakes/wire` behind a made-up key; it refuses a request whose history is not well formed (a
`tool_result` without its `tool_use`, a first message that is not the user's), so a conversation
that the engine replays wrongly fails here. No real model, no real key, no network beyond the VM.
It prints one JSON line per check (`{"check": ..., "ok": ...}`) and per measured fact
(`{"fact": ...}`), no secret. Each phase is a whole turn through `ImplementerSession.run()`:

1. **Turn one.** About 60 tool calls over this repository's own source (reads, greps, bash,
   writes), one step that starts a long command beside two short ones, and a tree left dirty so
   that the runner sends its extra message. Just before the agent's container is stopped
   (`ImplementerAgent.stop`, where PR 7 will take the export), the script takes the export three
   ways and compares them: `GET /session/<id>` with the messages in one call, the same in pages
   of 50 (`limit` and the `x-next-cursor` header), and the CLI's `opencode export` run in the
   container. It times and measures each, redacts the document with the runner's `Redactor`
   (on the JSON text and on the string values), gzips it and says how large it is.
2. **Turn two**, the follow-up: a new container and a new clone cut at depth one **of the first
   turn's branch**, so its root commit is the first turn's tip and not the first turn's root.
   Before the engine starts, the snapshot is written into the container and `opencode import`
   runs there (step 5 of the plan); the engine serves the imported session and the runner's
   second user message goes to it. Checked: the session answers `GET /session/<id>`, the first
   request of the model carries the first turn's text, the message ids are the first turn's, and
   the export of the second turn holds both turns.
3. **Blank.** Two more follow-ups from the snapshot of turn two, one as it is and one with the
   outputs the engine's prune marked as compacted (and the long strings of tool metadata) emptied:
   the model must be sent the same history.
4. **Abort.** A long command, aborted over HTTP while it runs: what the event stream does.
5. **Bulk.** A transcript of the worst kind (every tool answers 44 KB of incompressible text, the
   engine's cut being 50 KB) to see where the 8 MiB cap of the plan is reached, what the export
   costs there, and what the import of it costs.

The events of every turn are recorded by a feeder that rides on the same stream as the tool
audit. `--skip` takes `two`, `blank`, `abort`, `bulk` and `bulk-import`.
"""

import argparse
import gzip
import http.client
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import tracemalloc
from collections import Counter
from collections.abc import Callable, Mapping
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from unittest import mock
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "lane"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "engine"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import lane_support
from fakes.wire.formats import Turn
from fakes.wire.upstream import Refusal
from lane_support import (
    BRANCH,
    LaneConfig,
    Turned,
    bash,
    commit,
    lane_config,
    lane_turn,
    preflight,
    remove_leftovers,
    says,
    unmount,
    write_file,
)
from opencode_native import REAL_KEY

from code_reviewer_runner.implementer import agent as agent_module
from code_reviewer_runner.implementer.agent import ImplementerAgent
from code_reviewer_runner.implementer.agent_container import (
    AGENT_REPO,
    OPENCODE,
    PYTHON,
    AgentContainer,
)
from code_reviewer_runner.implementer.exec_run import run_exec
from code_reviewer_runner.redaction import Redactor
from git_support import TOKEN, raw

REPO = Path(__file__).resolve().parents[2]
SESSION_BRANCH_FILE = "SPIKE_NOTES.md"
ONE = "SPIKE-ONE-MARKER: read the code of this repository, then add a notes file."
ANSWER_ONE = "SPIKE-ANSWER-ONE: I read the code and wrote the notes."
TWO = "SPIKE-TWO-MARKER: add one more line to the notes file."
ANSWER_TWO = "SPIKE-ANSWER-TWO: the line is added."
PAGE = 50
RESUME_FILE = "/etc/code-reviewer/resume.json"
MEASURE_FILE = "/tmp/spike-measure.json"
# The 8 MiB of the plan: the most a stored conversation may weigh, gzipped.
CAP_BYTES = 8 * 1024 * 1024
# The grace of the session and what its parts use of it (`session.py`): read from there, not copied.
MIB = 1024 * 1024


class Report:
    def __init__(self) -> None:
        self.ok = True
        self.facts: dict[str, Any] = {}

    def say(self, check: str, ok: bool, **details: Any) -> bool:
        self.ok = self.ok and ok
        print(json.dumps({"check": check, "ok": ok, **details}, default=str), flush=True)
        return ok

    def fact(self, name: str, **details: Any) -> None:
        self.facts[name] = details
        print(json.dumps({"fact": name, **details}, default=str), flush=True)


REPORT = Report()


# -- what runs in the container -------------------------------------------------------------------

# Runs a command with its standard output left as it is and writes how long it took and the peak
# resident memory of the command (not of this wrapper) to a file.
MEASURE = r"""
import json, resource, subprocess, sys, time
out, mode, into = sys.argv[1], sys.argv[2], sys.argv[3]
started = time.monotonic()
sink = open(into, "wb") if into != "-" else None
done = subprocess.run(
    sys.argv[4:], stdin=subprocess.DEVNULL, stdout=sink,
    stderr=subprocess.STDOUT if mode == "merge" else subprocess.DEVNULL,
)
if sink is not None:
    sink.close()
open(out, "w").write(json.dumps({
    "rc": done.returncode,
    "seconds": round(time.monotonic() - started, 3),
    "peak_kb": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
}))
"""

# The engine's own memory and the container's, read from /proc and the cgroup.
LOOK = r"""
import json, os
found = []
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        status = open(f"/proc/{pid}/status").read()
    except OSError:
        continue
    if b"serve" in cmd and any(b"opencode" in part for part in cmd[:2]):
        kv = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
        found.append({"pid": int(pid), "rss_kb": int(kv["VmRSS"].split()[0]),
                      "hwm_kb": int(kv["VmHWM"].split()[0])})
cgroup = {}
for name in ("memory.current", "memory.peak", "memory.max"):
    try:
        cgroup[name] = open("/sys/fs/cgroup/" + name).read().strip()
    except OSError:
        pass
print(json.dumps({"engine": found, "cgroup": cgroup}))
"""

ROOT_COMMITS = (
    "git -C {repo} rev-list --max-parents=0 --all; git -C {repo} rev-parse HEAD; "
    "git -C {repo} rev-parse --is-shallow-repository"
)


@dataclass
class Phase:
    """What one turn left behind: the container and the agent the hooks saw, the events, the
    exports."""

    name: str
    container: AgentContainer | None = None
    agent: ImplementerAgent | None = None
    argv: list[str] = field(default_factory=lambda: [])
    environment: dict[str, str] = field(default_factory=lambda: {})
    events: list[tuple[float, dict[str, Any]]] = field(default_factory=lambda: [])
    deltas: Counter[str] = field(default_factory=lambda: Counter[str]())
    started: float = field(default_factory=time.monotonic)
    # Taken just before the container is stopped.
    snapshot_raw: bytes = b""
    document: dict[str, Any] | None = None
    facts: dict[str, Any] = field(default_factory=lambda: {})
    # What the turn is told to do while it runs (the abort phase).
    on_event: Callable[[dict[str, Any]], None] | None = None

    def exec(
        self,
        argv: list[str],
        *,
        stdin: bytes | None = None,
        consume: Callable[[bytes], None] | None = None,
        timeout: float = 120.0,
        env: Mapping[str, str] | None = None,
    ) -> tuple[int, str]:
        container = self.container
        assert container is not None
        done = run_exec(
            container._api,  # pyright: ignore[reportPrivateUsage]
            container._container or "",  # pyright: ignore[reportPrivateUsage]
            argv,
            stdin=stdin,
            consume=consume,
            timeout=timeout,
            env=env,
            workdir=AGENT_REPO,
        )
        return done.returncode, done.stdout

    def measured(
        self,
        argv: list[str],
        *,
        merge: bool = False,
        into: str | None = None,
        timeout: float = 300.0,
    ) -> tuple[bytes, dict[str, Any]]:
        """Run `argv` in the container with the engine's environment; its output and what the
        wrapper measured (seconds, peak resident kilobytes). With `into`, the command's standard
        output goes to that file in the container, and what is returned is the file read back: a
        command that writes a large document to a pipe and exits may lose the end of it
        (`opencode export`, measured below)."""
        out = bytearray()
        code, _ = self.exec(
            [
                PYTHON,
                "-I",
                "-c",
                MEASURE,
                MEASURE_FILE,
                "merge" if merge else "plain",
                into or "-",
                *argv,
            ],
            consume=out.extend,
            timeout=timeout,
            env=self.environment,
        )
        if into is not None:
            out = bytearray()
            self.exec(["/bin/cat", into], consume=out.extend, timeout=timeout)
        _, text = self.exec(["/bin/cat", MEASURE_FILE])
        measured: dict[str, Any] = json.loads(text) if text.startswith("{") else {}
        measured["exec_rc"] = code
        return bytes(out), measured

    def look(self) -> dict[str, Any]:
        _, text = self.exec([PYTHON, "-I", "-c", LOOK], timeout=20.0)
        found: dict[str, Any] = json.loads(text) if text.startswith("{") else {}
        return found


def summarise(event: Mapping[str, Any]) -> dict[str, Any]:
    """The few fields of an engine event that say what happened, in what order."""
    row: dict[str, Any] = {"type": str(event.get("type"))}
    properties = event.get("properties")
    if not isinstance(properties, dict):
        return row
    props = cast("dict[str, Any]", properties)
    part: Any = props.get("part")
    if isinstance(part, dict):
        found = cast("dict[str, Any]", part)
        row.update(part=found.get("type"), id=found.get("id"), message=found.get("messageID"))
        if found.get("type") == "tool":
            state: Any = found.get("state")
            row.update(
                tool=found.get("tool"),
                call=found.get("callID"),
                status=cast("dict[str, Any]", state).get("status")
                if isinstance(state, dict)
                else None,
            )
        if found.get("type") == "step-finish":
            row["reason"] = found.get("reason")
    info: Any = props.get("info")
    if event.get("type") == "message.updated" and isinstance(info, dict):
        data = cast("dict[str, Any]", info)
        moments: Any = data.get("time")
        error: Any = data.get("error")
        row.update(
            role=data.get("role"),
            message=data.get("id"),
            finish=data.get("finish"),
            completed=bool(cast("dict[str, Any]", moments).get("completed"))
            if isinstance(moments, dict)
            else False,
            error=cast("dict[str, Any]", error).get("name") if isinstance(error, dict) else None,
        )
    status: Any = props.get("status")
    if isinstance(status, dict):
        row["session_status"] = cast("dict[str, Any]", status).get("type")
    if "error" in props:
        error_value: Any = props["error"]
        row["error"] = (
            cast("dict[str, Any]", error_value).get("name")
            if isinstance(error_value, dict)
            else str(error_value)[:80]
        )
    return row


class Recorder:
    """The feeder that records the events of a phase with the time they arrived at."""

    def __init__(self, phase: Phase) -> None:
        self._phase = phase

    def feed(self, event: Mapping[str, Any]) -> None:
        phase = self._phase
        kind = str(event.get("type"))
        if kind == "message.part.delta":
            phase.deltas[kind] += 1
            return
        row = summarise(event)
        phase.events.append((round(time.monotonic() - phase.started, 3), row))
        if phase.on_event is not None:
            phase.on_event(row)


# -- the HTTP export, the CLI export, the import ------------------------------------------


def http_get(
    connection: http.client.HTTPConnection, path: str, directory: str
) -> tuple[int, dict[str, str], bytes]:
    connection.request("GET", path, headers={"x-opencode-directory": directory})
    response = connection.getresponse()
    body = response.read()
    return response.status, {k.lower(): v for k, v in response.getheaders()}, body


def http_export(
    base_url: str, directory: str, session_id: str, *, page: int | None
) -> tuple[bytes, int]:
    """The export as Control builds it: `{"info", "messages"}` from `GET /session/<id>` and the
    messages (all in one call, or newest pages first with `limit` and the cursor of the
    `x-next-cursor` header, put back in order). Returns the document's bytes and the number of
    calls. The messages are not parsed more than needed to join them: each page is a JSON array,
    whose text is kept."""
    parts = urlsplit(base_url)
    connection = http.client.HTTPConnection(parts.hostname or "127.0.0.1", parts.port, timeout=120)
    try:
        status, _, info = http_get(connection, f"/session/{session_id}", directory)
        assert status == 200, ("session", status, info[:200])
        calls = 1
        if page is None:
            status, _, body = http_get(connection, f"/session/{session_id}/message", directory)
            assert status == 200, ("messages", status, body[:200])
            return b'{"info":' + info + b',"messages":' + body + b"}", calls + 1
        pages: list[bytes] = []
        query = f"limit={page}"
        while True:
            status, headers, body = http_get(
                connection, f"/session/{session_id}/message?{query}", directory
            )
            calls += 1
            assert status == 200, ("messages", status, body[:200])
            pages.append(body)
            cursor = headers.get("x-next-cursor")
            if not cursor:
                break
            query = f"limit={page}&before={cursor}"
        # Each page is `[a,b,c]` oldest to newest, and the pages come newest first.
        joined = b",".join(
            p.strip()[1:-1] for p in reversed(pages) if p.strip() not in (b"[]", b"")
        )
        return b'{"info":' + info + b',"messages":[' + joined + b"]}", calls
    finally:
        connection.close()


class LowestAvailable:
    """The least memory the VM had available (`MemAvailable`, MiB) while a block ran, sampled every
    50 ms: the VM's own look at its memory, the way the runner's guard reads it."""

    def __init__(self) -> None:
        self.lowest = float("inf")
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    @staticmethod
    def available_mib() -> float:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024
        return float("nan")

    def _run(self) -> None:
        while not self._stop.is_set():
            self.lowest = min(self.lowest, self.available_mib())
            time.sleep(0.05)

    def __enter__(self) -> "LowestAvailable":
        self.lowest = self.available_mib()
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(2.0)
        self.lowest = min(self.lowest, self.available_mib())


def valid_json(data: bytes) -> bool:
    try:
        json.loads(data)
    except ValueError:
        return False
    return True


def differences(a: Any, b: Any, path: str = "", found: list[str] | None = None) -> list[str]:
    """Where two parsed documents differ (the first twenty places)."""
    found = [] if found is None else found
    if len(found) >= 20:
        return found
    if type(a) is not type(b):
        found.append(f"{path}: type {type(a).__name__} / {type(b).__name__}")
    elif isinstance(a, dict):
        left, right = cast("dict[str, Any]", a), cast("dict[str, Any]", b)
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                found.append(f"{path}/{key}: only in {'first' if key in left else 'second'}")
            else:
                differences(left[key], right[key], f"{path}/{key}", found)
    elif isinstance(a, list):
        first, second = cast("list[Any]", a), cast("list[Any]", b)
        if len(first) != len(second):
            found.append(f"{path}: {len(first)} / {len(second)} items")
        for index, (x, y) in enumerate(zip(first, second, strict=False)):
            differences(x, y, f"{path}[{index}]", found)
    elif a != b:
        found.append(f"{path}: {str(a)[:50]!r} / {str(b)[:50]!r}")
    return found


def timed(work: Callable[[], Any]) -> tuple[Any, float]:
    """The result of `work` and the seconds it took (tracemalloc off: it slows allocation down)."""
    started = time.monotonic()
    result = work()
    return result, round(time.monotonic() - started, 2)


def peak_mib(work: Callable[[], Any]) -> float:
    """The peak of Python's allocations while `work` runs, in MiB (a run of its own)."""
    tracemalloc.start()
    try:
        work()
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    return round(peak / MIB, 1)


def take_exports(phase: Phase, *, compare: bool = True, with_cli: bool = True) -> None:
    """The export, three ways, just before the container is stopped: in one call, in pages, and by
    the CLI (a second OpenCode process in the container: only when `with_cli`, and to a file)."""
    agent, container = phase.agent, phase.container
    assert agent is not None and container is not None and agent.session_id is not None
    client = agent._client  # pyright: ignore[reportPrivateUsage]
    assert client is not None
    name, session_id = phase.name, agent.session_id
    before = phase.look()
    vm_before = LowestAvailable.available_mib()

    def fetch(page: int | None) -> tuple[bytes, int]:
        return http_export(client.base_url, agent.directory, session_id, page=page)

    with LowestAvailable() as during_paged:
        (paged, calls_paged), seconds_paged = timed(lambda: fetch(PAGE))
    with LowestAvailable() as during_whole:
        (whole, calls_whole), seconds_whole = timed(lambda: fetch(None))
    after_http = phase.look()
    peak_whole = peak_mib(lambda: fetch(None))
    peak_paged = peak_mib(lambda: fetch(PAGE))
    cli = piped = b""
    cli_measure: dict[str, Any] = {}
    piped_measure: dict[str, Any] = {}
    during_cli = LowestAvailable()
    if with_cli:
        # To a pipe, as a first version read it: the output is cut (see the fact below).
        if not phase.facts.get("pipe_tried"):
            phase.facts["pipe_tried"] = True
            piped, piped_measure = phase.measured([OPENCODE, "export", session_id])
        with during_cli:
            cli, cli_measure = phase.measured(
                [OPENCODE, "export", session_id], into="/tmp/spike-export.json"
            )
    after_cli = phase.look()
    REPORT.fact(
        f"{name}_export_http_and_cli",
        http_whole_seconds=seconds_whole,
        http_whole_calls=calls_whole,
        http_whole_python_peak_mib=peak_whole,
        http_whole_bytes=len(whole),
        http_paged_seconds=seconds_paged,
        http_paged_calls=calls_paged,
        http_paged_page=PAGE,
        http_paged_python_peak_mib=peak_paged,
        http_paged_bytes=len(paged),
        vm_available_mib_before=round(vm_before),
        vm_lowest_available_mib_during_paged=round(during_paged.lowest),
        vm_lowest_available_mib_during_whole=round(during_whole.lowest),
        vm_lowest_available_mib_during_cli=round(during_cli.lowest) if with_cli else None,
        cli_seconds=cli_measure.get("seconds"),
        cli_peak_rss_mib=round(cli_measure.get("peak_kb", 0) / 1024, 1),
        cli_stdout_bytes=len(cli),
        cli_rc=cli_measure.get("rc"),
        cli_to_a_pipe_bytes=len(piped) if piped_measure else None,
        cli_to_a_pipe_valid_json=valid_json(piped) if piped_measure else None,
        cli_to_a_pipe_seconds=piped_measure.get("seconds"),
        engine_before=before.get("engine"),
        engine_after_http=after_http.get("engine"),
        engine_after_cli=after_cli.get("engine"),
        cgroup_before=before.get("cgroup"),
        cgroup_after_http=after_http.get("cgroup"),
        cgroup_after_cli=after_cli.get("cgroup"),
    )
    parsed_whole = json.loads(whole)
    parsed_paged, seconds_parse = timed(lambda: json.loads(paged))
    phase.facts["fetch_seconds"] = seconds_paged
    phase.facts["parse_seconds"] = seconds_parse
    if compare and with_cli:
        parsed_cli = json.loads(cli)
        REPORT.say(
            f"{name}_http_export_equals_cli_export",
            parsed_whole == parsed_cli and parsed_paged == parsed_cli,
            whole=differences(parsed_whole, parsed_cli),
            paged=differences(parsed_paged, parsed_cli),
            messages=len(parsed_cli["messages"]),
            session=session_id,
        )
        phase.facts["cli_bytes"] = len(cli)
    else:
        REPORT.say(
            f"{name}_paged_http_export_equals_the_export_in_one_call",
            parsed_whole == parsed_paged,
            messages=len(parsed_paged["messages"]),
            session=session_id,
        )
    phase.snapshot_raw = paged
    phase.document = parsed_paged


def redact_strings(value: Any, redactor: Redactor, counter: list[int]) -> Any:
    """The same document with the redactor applied to every string value (and key), so that the
    redaction never sees the JSON's own quotes and escapes."""
    if isinstance(value, str):
        clean = redactor.redact(value)
        counter[0] += clean != value
        return clean
    if isinstance(value, list):
        return [redact_strings(item, redactor, counter) for item in cast("list[Any]", value)]
    if isinstance(value, dict):
        return {
            redactor.redact(str(key)): redact_strings(item, redactor, counter)
            for key, item in cast("dict[str, Any]", value).items()
        }
    return value


def snapshot_sizes(phase: Phase, secrets: tuple[str, ...]) -> bytes:
    """What the runner would upload: the export with the job's secrets taken out, compact, gzipped.
    Times and sizes of each step. The redaction is run both ways: on the JSON text (as a first
    version would) and on the string values."""
    document = phase.document
    assert document is not None
    redactor = Redactor(secrets)

    def dump(value: Any = document) -> bytes:
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()

    compact, seconds_dump = timed(dump)
    text = compact.decode()
    on_text, seconds_text = timed(lambda: redactor.redact(text))
    changed = [0]
    clean, seconds_values = timed(lambda: redact_strings(document, redactor, changed))
    redacted = dump(clean)
    packed, seconds_gzip = timed(lambda: gzip.compress(redacted, compresslevel=6))
    fast, seconds_fast = timed(lambda: gzip.compress(redacted, compresslevel=1))
    peak_dump = peak_mib(dump)
    peak_values = peak_mib(lambda: redact_strings(document, redactor, [0]))
    sizes: Counter[str] = Counter()
    outputs = compacted = 0
    for message in cast("list[dict[str, Any]]", document["messages"]):
        sizes["info"] += len(json.dumps(message.get("info")))
        for part in cast("list[dict[str, Any]]", message.get("parts", [])):
            state: Any = part.get("state")
            if part.get("type") != "tool" or not isinstance(state, dict):
                sizes[f"part_{part.get('type')}"] += len(json.dumps(part))
                continue
            found = cast("dict[str, Any]", state)
            output: Any = found.get("output")
            size = len(output.encode()) if isinstance(output, str) else 0
            outputs += size
            sizes["tool_output"] += size
            sizes["tool_input"] += len(json.dumps(found.get("input")))
            sizes["tool_metadata"] += len(json.dumps(found.get("metadata")))
            moments: Any = found.get("time")
            if isinstance(moments, dict) and cast("dict[str, Any]", moments).get("compacted"):
                compacted += size
    parts = sum(len(cast("list[Any]", m.get("parts", []))) for m in document["messages"])
    REPORT.fact(
        f"{phase.name}_snapshot",
        messages=len(document["messages"]),
        parts=parts,
        compact_json_bytes=len(compact),
        cli_json_bytes=phase.facts.get("cli_bytes"),
        redacted_bytes=len(redacted),
        redaction_on_the_json_text_leaves_valid_json=valid_json(on_text.encode()),
        redaction_on_the_json_text_changed_bytes=len(text.encode()) - len(on_text.encode()),
        redaction_on_the_text_seconds=seconds_text,
        redaction_on_the_values_seconds=seconds_values,
        redaction_on_the_values_python_peak_mib=peak_values,
        strings_redacted=changed[0],
        gzip6_bytes=len(packed),
        gzip6_ratio=round(len(packed) / max(1, len(compact)), 3),
        gzip1_bytes=len(fast),
        dump_seconds=seconds_dump,
        dump_python_peak_mib=peak_dump,
        gzip6_seconds=seconds_gzip,
        gzip1_seconds=seconds_fast,
        tool_output_bytes=outputs,
        tool_output_bytes_compacted=compacted,
        bytes_by_kind=dict(sizes),
        pipeline_seconds=round(
            float(phase.facts.get("fetch_seconds", 0))
            + float(phase.facts.get("parse_seconds", 0))
            + seconds_values
            + seconds_dump
            + seconds_gzip,
            2,
        ),
        cap_bytes=CAP_BYTES,
        under_cap=len(packed) <= CAP_BYTES,
    )
    return redacted


# -- the hooks -----------------------------------------------------------------------------------


def hooks(
    phase: Phase,
    *,
    export_at_end: bool,
    snapshot: bytes | None = None,
    report_secrets: tuple[str, ...] = (),
    before_stop: Callable[[Phase], None] | None = None,
    with_cli: bool = True,
) -> ExitStack:
    """The patches that put the spike into the production flow of a turn: the recorder on the
    event stream, the capture of the container and the agent, the import before the engine starts
    (turn two), and the export just before the container is stopped. Nothing else is changed."""
    stack = ExitStack()
    real_reader = agent_module.EventReader
    real_start_engine = AgentContainer.start_engine
    real_start = ImplementerAgent.start
    real_stop = ImplementerAgent.stop
    real_create = agent_module.EngineClient.create_session
    imported: dict[str, str] = {}

    def reader(open_stream: Any, feeders: Any, ledger: Any) -> Any:
        return real_reader(open_stream, [*feeders, Recorder(phase)], ledger)

    def start_engine(self: AgentContainer, argv: list[str], environment: Mapping[str, str]) -> str:
        phase.container, phase.argv, phase.environment = self, list(argv), dict(environment)
        if snapshot is not None:
            try:
                imported["id"] = import_snapshot(phase, snapshot)
            except Exception as error:
                REPORT.say("import_failed", False, error=f"{type(error).__name__}: {error}")
                raise
        return real_start_engine(self, argv, environment)

    def start(self: ImplementerAgent, port: int) -> None:
        phase.agent = self
        real_start(self, port)
        code, text = phase.exec(["/bin/sh", "-c", ROOT_COMMITS.format(repo=AGENT_REPO)])
        lines = text.split()
        phase.facts["agent_repo"] = {
            "rc": code,
            "root_commits": lines[:-2],
            "head": lines[-2] if len(lines) >= 2 else None,
            "shallow": lines[-1] if lines else None,
        }

    def stop(self: ImplementerAgent) -> bool:
        if before_stop is not None and not phase.facts.get("stopped_once"):
            phase.facts["stopped_once"] = True
            try:
                before_stop(phase)
            except Exception as error:
                REPORT.say(
                    f"{phase.name}_before_stop", False, error=f"{type(error).__name__}: {error}"
                )
        if export_at_end and phase.document is None:
            try:
                take_exports(phase, with_cli=with_cli)
                phase.snapshot_raw = snapshot_sizes(phase, report_secrets)
            except Exception as error:
                REPORT.say(f"{phase.name}_export", False, error=f"{type(error).__name__}: {error}")
        return real_stop(self)

    def create_session(client: Any) -> str:
        if snapshot is None:
            return real_create(client)
        session_id = imported["id"]
        status, body = client._call("GET", f"/session/{session_id}")  # pyright: ignore[reportPrivateUsage]
        answer: dict[str, Any] = json.loads(body) if status == 200 else {}
        phase.facts["imported_session"] = {
            "status": status,
            "id": answer.get("id"),
            "projectID": answer.get("projectID"),
            "directory": answer.get("directory"),
            "title": answer.get("title"),
        }
        return session_id

    stack.enter_context(mock.patch.object(agent_module, "EventReader", reader))
    stack.enter_context(mock.patch.object(AgentContainer, "start_engine", start_engine))
    stack.enter_context(mock.patch.object(ImplementerAgent, "start", start))
    stack.enter_context(mock.patch.object(ImplementerAgent, "stop", stop))
    stack.enter_context(
        mock.patch.object(agent_module.EngineClient, "create_session", create_session)
    )
    return stack


def import_snapshot(phase: Phase, snapshot: bytes) -> str:
    """Step 5 of the plan: the snapshot into the container (0600, with the config), `opencode
    import` by exec with the engine's environment, the id from its output, time boxed. Before the
    engine starts."""
    container = phase.container
    assert container is not None
    started = time.monotonic()
    container.write_files({"resume.json": (snapshot, 0o600)})
    written = time.monotonic() - started
    output, measure = phase.measured([OPENCODE, "import", RESUME_FILE], merge=True, timeout=60.0)
    text = output.decode("utf-8", "replace")
    identifier = ""
    for line in text.splitlines():
        if "Imported session" in line:
            identifier = line.split(":", 1)[1].strip().split()[0]
    document = json.loads(snapshot)
    phase.facts["import"] = {
        "write_seconds": round(written, 2),
        "snapshot_bytes": len(snapshot),
        "import_seconds": measure.get("seconds"),
        "import_peak_rss_mib": round(measure.get("peak_kb", 0) / 1024, 1),
        "rc": measure.get("rc"),
        "printed": text.strip()[-120:],
        "id_printed": identifier,
        "id_in_file": document["info"]["id"],
        "cgroup": phase.look().get("cgroup"),
    }
    return identifier or str(document["info"]["id"])


# -- the scripts of the fake model -----------------------------------------------------------------


def seed_repository(seed: Path) -> None:
    """The repository of the task: this repository's runner source, as real code."""
    source = REPO / "runner" / "src"
    shutil.copytree(
        source, seed / "src", ignore=shutil.ignore_patterns("__pycache__"), dirs_exist_ok=True
    )


def seed_paths() -> list[str]:
    root = REPO / "runner" / "src"
    found = sorted(
        (path for path in root.rglob("*.py") if "__pycache__" not in path.parts),
        key=lambda path: -path.stat().st_size,
    )
    return [str(path.relative_to(root)) for path in found]


def read(repo: Path, relative: str) -> Turn:
    return Turn(tool="read", args={"filePath": str(repo / "src" / relative)})


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


def script_one(repo: Path) -> list[Turn]:
    """The first turn: a long command beside a short one first, then reads, greps and listings of
    real code, notes written, a tree left dirty on purpose, and the answer to the extra message."""
    files = seed_paths()
    turns: list[Turn] = [
        Turn(
            tool="bash",
            args={"command": "sleep 12 && echo long-command-done", "description": "a long command"},
            also=(
                ("read", {"filePath": str(repo / "src" / files[5])}),
                ("glob", {"pattern": "**/test_*.py"}),
            ),
        ),
        bash("git log --oneline | head -20 && git status --short | head -20"),
    ]
    turns += [read(repo, name) for name in files[:44]]
    for pattern in ("def ", "class ", "import ", "raise ", "TODO", "return None"):
        turns.append(Turn(tool="grep", args={"pattern": pattern, "path": str(repo / "src")}))
    turns += [
        bash("find . -name '*.py' | xargs wc -l | sort -n | tail -60"),
        bash("ls -R src | head -300"),
        bash("sed -n '1,400p' src/code_reviewer_runner/implementer/session.py"),
        write_file(
            repo, SESSION_BRANCH_FILE, "# Notes\n" + "".join(f"- {n}\n" for n in files[:30])
        ),
        commit("Add notes"),
        # The tree is left dirty: the runner sends its extra message, and this answers it.
        write_file(repo, "UNCOMMITTED.md", "left behind\n"),
        says(ANSWER_ONE),
        commit("Add the rest"),
        says("committed"),
    ]
    return turns


def script_two(repo: Path) -> list[Turn]:
    return [
        read(repo, seed_paths()[0]),
        write_file(repo, "SECOND.md", "second turn\n"),
        commit("Add the second turn file"),
        write_file(repo, "UNCOMMITTED2.md", "left behind again\n"),
        says(ANSWER_TWO),
        commit("Add the rest of the second turn"),
        says("committed"),
    ]


def script_abort(_repo: Path) -> list[Turn]:
    return [bash("sleep 60 && echo never-reached"), says("not reached")]


def script_bulk(steps: int) -> Callable[[Path], list[Turn]]:
    def script(repo: Path) -> list[Turn]:
        _ = repo
        turns = [bash(f"head -c 33000 /dev/urandom | base64 -w 120 # {n}") for n in range(steps)]
        return [*turns, write_file(repo, "BULK.md", "bulk\n"), commit("Bulk"), says("bulk done")]

    return script


# -- the phases ----------------------------------------------------------------------------------


def secrets_of(turned: Turned) -> tuple[str, ...]:
    return turned.session.secrets()


def requests_text(turned: Turned) -> str:
    return json.dumps(turned.requests)


def event_order(phase: Phase) -> dict[str, Any]:
    """What the recorded events say about order: when each tool part started and ended, when the
    step of its message was finished, and whether a step finished before one of its tools did."""
    started: dict[str, float] = {}
    ended: dict[str, float] = {}
    tool_of: dict[str, tuple[str, str]] = {}
    finish: dict[str, float] = {}
    for at, row in phase.events:
        if row.get("part") == "tool":
            call = str(row.get("call"))
            tool_of[call] = (str(row.get("tool")), str(row.get("message")))
            if row.get("status") == "running":
                started.setdefault(call, at)
            if row.get("status") in ("completed", "error"):
                ended[call] = at
        if row.get("part") == "step-finish":
            finish[str(row.get("message"))] = at
    early: list[dict[str, Any]] = []
    for call, (tool, message) in tool_of.items():
        if call in ended and message in finish and finish[message] < ended[call]:
            early.append({"tool": tool, "step_finish": finish[message], "tool_end": ended[call]})
    longest = max(
        ((ended[c] - started[c], c) for c in ended if c in started),
        default=(0.0, ""),
        key=lambda x: x[0],
    )
    slowest = tool_of.get(longest[1], ("", ""))[1]
    story = [
        {
            "at": at,
            "what": f"{row.get('part') or row['type']}"
            + (f":{row.get('tool')}:{row.get('status')}" if row.get("part") == "tool" else ""),
        }
        for at, row in phase.events
        if slowest and row.get("message") == slowest and row["type"] == "message.part.updated"
    ]
    return {
        "longest_step_events": story[:24],
        "events": len(phase.events),
        "deltas": dict(phase.deltas),
        "types": dict(Counter(str(row["type"]) for _, row in phase.events)),
        "tool_calls": len(tool_of),
        "step_finish_parts": len(finish),
        "step_finish_before_a_tool_ended": early,
        "longest_tool_seconds": round(longest[0], 2),
        "longest_tool": tool_of.get(longest[1], ("", ""))[0],
    }


def phase_one(config: LaneConfig, scratch: Path) -> tuple[Phase, Path]:
    phase = Phase("turn_one")
    with (
        hooks(phase, export_at_end=True, report_secrets=(TOKEN, REAL_KEY)),
        lane_turn(
            scratch,
            script_one,
            seed=seed_repository,
            instruction=ONE,
            limit="5.00",
            judge=strict_history,
        ) as turned,
    ):
        result = turned.result
        REPORT.say(
            "turn_one_ends_ok",
            result.ok and result.pushed and len(turned.messages) == 2,
            error=None if result.error_code is None else result.error_code.value,
            detail=result.error_detail,
            notes=list(result.notes)[:12],
            messages=len(turned.messages),
            session=result.opencode_session_id,
            requests=len(turned.requests),
        )
        origin_path = turned.origin.path
        phase.facts["session_id"] = result.opencode_session_id
        phase.facts["model_requests"] = len(turned.requests)
    REPORT.fact("turn_one_events", **event_order(phase))
    _ = config
    return phase, origin_path


def phase_two(one: Phase, one_origin: Path, scratch: Path) -> tuple[Phase, Path]:
    assert one.snapshot_raw, "turn one has no snapshot"
    phase = Phase("turn_two")

    def make_main_the_first_turns_branch(origin: Any) -> None:
        """The origin of turn two: its `main` is the branch the first turn pushed, so that the
        clone of depth one has a root commit that the first turn's clone did not have."""
        raw(
            "fetch",
            "-q",
            str(one_origin),
            f"+{BRANCH}:refs/heads/main",
            cwd=origin.path,
            git=origin.git,
        )

    with (
        hooks(phase, export_at_end=True, snapshot=one.snapshot_raw),
        lane_turn(
            scratch,
            script_two,
            origin_setup=make_main_the_first_turns_branch,
            seed=None,
            instruction=TWO,
            limit="5.00",
            judge=strict_history,
        ) as turned,
    ):
        result = turned.result
        two_origin = turned.origin.path
        first = turned.requests[0] if turned.requests else {}
        text = json.dumps(first)
        carries = {
            "instruction_one": ONE in text,
            "answer_one": ANSWER_ONE in text,
            "a_tool_result_of_turn_one": "long-command-done" in text,
            "instruction_two": TWO in text,
        }
        REPORT.say(
            "turn_two_continues_the_imported_session",
            result.ok
            and result.opencode_session_id == one.facts.get("session_id")
            and all(carries.values())
            and len(turned.messages) == 2,
            carries=carries,
            session=result.opencode_session_id,
            first_session=one.facts.get("session_id"),
            error=None if result.error_code is None else result.error_code.value,
            notes=list(result.notes)[:12],
            messages_sent=turned.messages and [m[1][:40] for m in turned.messages],
            first_request_messages=len(cast("list[Any]", first.get("messages", []))),
            first_request_bytes=len(text),
            requests=len(turned.requests),
        )
        compacted = text.count("Old tool result content cleared")
        phase.facts["compacted_markers_in_first_request"] = compacted
        later = json.dumps(turned.requests[-1]) if turned.requests else ""
        phase.facts["compacted_markers_in_last_request"] = later.count(
            "Old tool result content cleared"
        )
    phase.facts["resume"] = {
        "first_turn_agent_repo": one.facts.get("agent_repo"),
        "second_turn_agent_repo": phase.facts.get("agent_repo"),
        "first_turn_project": cast("dict[str, Any]", (one.document or {}).get("info", {})).get(
            "projectID"
        ),
        "imported": phase.facts.get("imported_session"),
        "import": phase.facts.get("import"),
    }
    first_document = one.document or {}
    second_document = phase.document or {}
    first_ids = [m["info"]["id"] for m in first_document.get("messages", [])]
    second_ids = [m["info"]["id"] for m in second_document.get("messages", [])]
    REPORT.say(
        "turn_two_export_holds_both_turns_with_the_same_message_ids",
        bool(first_ids)
        and second_ids[: len(first_ids)] == first_ids
        and len(second_ids) > len(first_ids),
        first_turn_messages=len(first_ids),
        second_export_messages=len(second_ids),
    )
    REPORT.fact(
        "turn_two_resume",
        **cast("dict[str, Any]", phase.facts["resume"]),
        compacted_markers_in_first_request=phase.facts["compacted_markers_in_first_request"],
        compacted_markers_in_last_request=phase.facts["compacted_markers_in_last_request"],
    )
    REPORT.fact("turn_two_events", **event_order(phase))
    return phase, two_origin


def blank_compacted(snapshot: bytes, *, all_metadata: bool = False) -> tuple[bytes, int, int]:
    """The snapshot with the output of every tool part the engine's prune marked as compacted
    (`state.time.compacted`) emptied, and the long strings of their metadata (a tool's metadata
    repeats its output). With `all_metadata`, the long strings of the metadata of every tool part.
    Returns it, the number of parts and the bytes blanked."""
    document = json.loads(snapshot)
    parts = size = 0
    for message in cast("list[dict[str, Any]]", document["messages"]):
        for part in cast("list[dict[str, Any]]", message.get("parts", [])):
            state: Any = part.get("state")
            if part.get("type") != "tool" or not isinstance(state, dict):
                continue
            found = cast("dict[str, Any]", state)
            moments: Any = found.get("time")
            old = isinstance(moments, dict) and cast("dict[str, Any]", moments).get("compacted")
            if not old and not all_metadata:
                continue
            output: Any = found.get("output")
            if old and isinstance(output, str):
                size += len(output.encode())
                found["output"] = ""
                parts += 1
            metadata: Any = found.get("metadata")
            if isinstance(metadata, dict):
                for key, value in list(cast("dict[str, Any]", metadata).items()):
                    if isinstance(value, str) and len(value) > 256:
                        size += len(value.encode())
                        cast("dict[str, Any]", metadata)[key] = ""
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode(), parts, size


def phase_blank(two: Phase, two_origin: Path, scratch: Path) -> None:
    """Whether the compacted outputs can be left out of the snapshot: the same follow-up from the
    snapshot as it is and from the snapshot with them emptied must send the model the same
    history."""
    variants: dict[str, bytes] = {"as_it_is": two.snapshot_raw}
    for name, everything in (("blanked", False), ("blanked_and_no_metadata", True)):
        blanked, parts, size = blank_compacted(two.snapshot_raw, all_metadata=everything)
        variants[name] = blanked
        REPORT.fact(
            f"snapshot_{name}",
            parts=parts,
            bytes_blanked=size,
            before_bytes=len(two.snapshot_raw),
            after_bytes=len(blanked),
            before_gzip=len(gzip.compress(two.snapshot_raw, compresslevel=6)),
            after_gzip=len(gzip.compress(blanked, compresslevel=6)),
        )
    first_requests: dict[str, list[Any]] = {}
    for name, snapshot in variants.items():
        phase = Phase(f"turn_three_{name}")

        def main_is_turn_twos_branch(origin: Any) -> None:
            raw(
                "fetch",
                "-q",
                str(two_origin),
                f"+{BRANCH}:refs/heads/main",
                cwd=origin.path,
                git=origin.git,
            )

        with (
            hooks(phase, export_at_end=False, snapshot=snapshot),
            lane_turn(
                scratch / name,
                lambda repo: [
                    write_file(repo, "THREE.md", "three\n"),
                    commit("Three"),
                    says("three"),
                ],
                origin_setup=main_is_turn_twos_branch,
                seed=None,
                instruction="SPIKE-THREE-MARKER: one more file.",
                limit="5.00",
                judge=strict_history,
            ) as turned,
        ):
            first = turned.requests[0] if turned.requests else {}
            first_requests[name] = cast("list[Any]", first.get("messages", []))
            REPORT.say(
                f"turn_three_{name}_continues",
                turned.result.ok and len(first_requests[name]) > 100,
                error=None if turned.result.error_code is None else turned.result.error_code.value,
                first_request_messages=len(first_requests[name]),
                first_request_bytes=len(json.dumps(first)),
                markers=json.dumps(first).count("Old tool result content cleared"),
                import_seconds=cast("dict[str, Any]", phase.facts.get("import", {})).get(
                    "import_seconds"
                ),
            )
    for name in ("blanked", "blanked_and_no_metadata"):
        same = first_requests["as_it_is"] == first_requests[name]
        REPORT.say(
            f"{name}_snapshot_sends_the_model_the_same_history",
            same,
            differences=[]
            if same
            else differences(first_requests["as_it_is"], first_requests[name]),
        )


def phase_abort(scratch: Path) -> Phase:
    phase = Phase("abort")
    state: dict[str, Any] = {"aborted_at": None}

    def on_event(row: dict[str, Any]) -> None:
        if (
            state["aborted_at"] is None
            and row.get("part") == "tool"
            and row.get("tool") == "bash"
            and row.get("status") == "running"
        ):
            state["aborted_at"] = round(time.monotonic() - phase.started, 3)

            def later() -> None:
                time.sleep(2.0)
                state["abort_sent"] = round(time.monotonic() - phase.started, 3)
                assert phase.agent is not None
                phase.agent.abort()
                state["abort_returned"] = round(time.monotonic() - phase.started, 3)

            threading.Thread(target=later, daemon=True).start()

    def after_the_abort(phase: Phase) -> None:
        """What the engine says about the aborted message, and whether its command still runs."""
        agent = phase.agent
        assert agent is not None and agent.session_id is not None
        client = agent._client  # pyright: ignore[reportPrivateUsage]
        assert client is not None
        document, _ = http_export(client.base_url, agent.directory, agent.session_id, page=None)
        messages = cast("list[dict[str, Any]]", json.loads(document)["messages"])
        last = messages[-1]
        _, running = phase.exec(["/bin/sh", "-c", "pgrep -fa 'sleep 60' | grep -v pgrep | head -3"])
        states = [
            {
                "type": part.get("type"),
                "status": cast("dict[str, Any]", part.get("state") or {}).get("status"),
                "error": str(cast("dict[str, Any]", part.get("state") or {}).get("error"))[:80],
            }
            for part in cast("list[dict[str, Any]]", last.get("parts", []))
        ]
        info = cast("dict[str, Any]", last["info"])
        REPORT.fact(
            "abort_state_in_the_export",
            role=info.get("role"),
            finish=info.get("finish"),
            error=info.get("error"),
            parts=states,
            the_command_still_runs=running.strip() != "",
        )

    phase.on_event = on_event
    with (
        hooks(phase, export_at_end=False, before_stop=after_the_abort),
        lane_turn(scratch, script_abort, instruction="abort me", limit="5.00") as turned,
    ):
        result = turned.result
        REPORT.say(
            "abort_ends_the_turn",
            state["aborted_at"] is not None,
            error=None if result.error_code is None else result.error_code.value,
            detail=result.error_detail,
            started_running_at=state["aborted_at"],
            abort_sent_at=state.get("abort_sent"),
            abort_returned_at=state.get("abort_returned"),
            turn_returned_at=round(time.monotonic() - phase.started, 3),
        )
    after = [(at, row) for at, row in phase.events if at >= state.get("abort_sent", 1e9)]
    REPORT.fact(
        "abort_events_after_the_abort",
        events=[{"at": at, **row} for at, row in after][:30],
        all_events=len(phase.events),
        **{"order": event_order(phase)},
    )
    return phase


def with_window(tokens: int) -> Any:
    """The lane's job with a larger model window: the ledger refuses a request that would not fit
    the window, which a long transcript of the worst kind reaches long before the 8 MiB of the plan
    (a real session reaches such a size through compaction, which keeps the old messages)."""
    real = lane_support.parse_implementer_input

    def parse(text: str) -> Any:
        document = json.loads(text)
        document["implementer"]["modelEntry"]["model"]["limit"]["context"] = tokens
        return real(json.dumps(document))

    return mock.patch.object(lane_support, "parse_implementer_input", parse)


def phase_bulk(scratch: Path, steps: int, window: int, *, with_cli: bool) -> tuple[Phase, Path]:
    phase = Phase("bulk")
    with (
        with_window(window),
        hooks(phase, export_at_end=True, report_secrets=(TOKEN, REAL_KEY), with_cli=with_cli),
        lane_turn(
            scratch,
            script_bulk(steps),
            instruction="bulk",
            limit="5.00",
            time_limit=7200,
            seed=None,
        ) as turned,
    ):
        result = turned.result
        REPORT.say(
            "bulk_turn_ends_ok",
            result.ok,
            error=None if result.error_code is None else result.error_code.value,
            detail=result.error_detail,
            steps=steps,
            seconds=round(time.monotonic() - phase.started, 1),
        )
        origin_path = turned.origin.path
    return phase, origin_path


def phase_bulk_import(bulk: Phase, bulk_origin: Path, scratch: Path, window: int) -> None:
    """The import of the largest transcript: what `opencode import` costs at the cap, and whether
    the engine goes on with it."""
    phase = Phase("bulk_follow_up")

    def main_is_the_bulk_branch(origin: Any) -> None:
        raw(
            "fetch",
            "-q",
            str(bulk_origin),
            f"+{BRANCH}:refs/heads/main",
            cwd=origin.path,
            git=origin.git,
        )

    with (
        with_window(window),
        hooks(phase, export_at_end=False, snapshot=bulk.snapshot_raw),
        lane_turn(
            scratch,
            lambda repo: [write_file(repo, "AFTER.md", "after\n"), commit("After"), says("after")],
            origin_setup=main_is_the_bulk_branch,
            seed=None,
            instruction="SPIKE-AFTER-BULK: one more file.",
            limit="5.00",
            time_limit=7200,
            judge=strict_history,
        ) as turned,
    ):
        first = turned.requests[0] if turned.requests else {}
        measured = cast("dict[str, Any]", phase.facts.get("import", {}))
        served = cast("dict[str, Any]", phase.facts.get("imported_session", {}))
        # The import and the engine's serving of the session are the check. What the first call of
        # the turn does is a fact: the door reserves the cost of a call before it is made, and the
        # history alone may be more than the person's cost limit.
        REPORT.say(
            "bulk_snapshot_is_imported_and_served",
            measured.get("rc") == 0 and served.get("status") == 200,
            snapshot_bytes=len(bulk.snapshot_raw),
            **{
                key: measured.get(key)
                for key in ("write_seconds", "import_seconds", "import_peak_rss_mib", "cgroup")
            },
            session_status=served.get("status"),
        )
        REPORT.fact(
            "bulk_follow_up_first_call",
            turn_ok=turned.result.ok,
            error=None if turned.result.error_code is None else turned.result.error_code.value,
            model_requests=len(turned.requests),
            first_request_messages=len(cast("list[Any]", first.get("messages", []))),
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/follow-up-spike")
    parser.add_argument("--bulk-steps", type=int, default=300)
    parser.add_argument(
        "--bulk-cli", action="store_true", help="also run the CLI's export on the bulk transcript"
    )
    parser.add_argument("--bulk-window", type=int, default=40_000_000, help="model window, tokens")
    parser.add_argument("--skip", default="", help="comma list of: two, abort, bulk")
    arguments = parser.parse_args()
    skip = set(arguments.skip.split(","))
    config = lane_config()
    preflight(config)
    remove_leftovers()
    out = Path(arguments.out)
    for name in ("one", "two", "blank", "abort", "bulk", "bulk-import"):
        # A run that died may have left its work directory mounted (`lane_support.unmount`).
        unmount(out / name / "work")
        unmount(out / name / "vmdisk")
        shutil.rmtree(out / name, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    one: Phase | None = None
    try:
        one, one_origin = phase_one(config, out / "one")
        (out / "turn-one-export.json.gz").write_bytes(gzip.compress(one.snapshot_raw))
        if "two" not in skip:
            two, two_origin = phase_two(one, one_origin, out / "two")
            (out / "turn-two-export.json.gz").write_bytes(gzip.compress(two.snapshot_raw))
            if "blank" not in skip:
                phase_blank(two, two_origin, out / "blank")
        if "abort" not in skip:
            phase_abort(out / "abort")
        if "bulk" not in skip:
            bulk, bulk_origin = phase_bulk(
                out / "bulk",
                arguments.bulk_steps,
                arguments.bulk_window,
                with_cli=arguments.bulk_cli,
            )
            if "bulk-import" not in skip:
                phase_bulk_import(bulk, bulk_origin, out / "bulk-import", arguments.bulk_window)
    finally:
        remove_leftovers()
    REPORT.say("total", REPORT.ok, seconds=round(time.monotonic() - started, 1), uid=os.geteuid())
    _ = (one, subprocess)
    return 0 if REPORT.ok else 1


if __name__ == "__main__":
    sys.exit(main())
