# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer turn on a real Docker daemon (#745, step 4). Not a test file.

`ImplementerSession` runs unchanged: the real agent image with the pinned OpenCode in a container of
its own, the real reader (git in a container of its own, driven through the Engine API), the real
model door code, the production ledger, the git workspace and the final push over a bare repository
on the file system standing in for GitHub. What is a double:

* **the runtime.** CI has no Sysbox, so the agent and the reader run under `runc`
  (`LANE_RUNTIME`, default `runc`; a VM with Sysbox sets `sysbox-runc` and the lane then runs the
  real thing), and under `runc` the image's init is replaced by an entry point that skips the inner
  `dockerd` (`AgentSeams.entrypoint`). So the lane proves the turn's flow, the reader and the
  volume; it does **not** prove the Sysbox wall, the id mapping of the volume or the isolated
  network. Those only a VM with Sysbox proves (the golden snapshot's proof and the run on a spike
  VM, `docs/implementer.md`);
* **the model.** The door is the real door code (`run_door`) in a thread of this process, behind a
  relay container at the door's address on the model network; its last hop is the strict generic
  fake of `fakes/wire`, which plays one tool call or one text per request. Nothing here reaches
  beyond this machine and the containers it starts.

The tests run as root, like Control does: the files Control makes are the root's, as the agent's
root sees them. Needs `LANE_WORKER_IMAGE` (the `sandbox` target of `runner/Dockerfile`) and
`LANE_AGENT_IMAGE` (its `agent` target) in the daemon.
"""

import contextlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Generator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from fakes.wire.formats import Family, Turn
from fakes.wire.upstream import Refusal, ScriptedUpstream
from native_full_job import ENTRIES, MANAGED
from opencode_native import BASE_PATH, REAL_KEY

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_GATEWAY,
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
)
from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.implementer import session as session_module
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    OPENCODE,
    AgentContainer,
    AgentSeams,
)
from code_reviewer_runner.implementer.door import service as door_service
from code_reviewer_runner.implementer.door.protocol import (
    MESSAGE_READY,
    MESSAGE_REFUSED,
    MESSAGE_STATUS,
    OP_STOP,
)
from code_reviewer_runner.implementer.door.status import parse_status
from code_reviewer_runner.implementer.door_launcher import start_document
from code_reviewer_runner.implementer.door_state import DoorEnd, DoorState
from code_reviewer_runner.implementer.environment_setup import (
    EnvironmentSetup,
    run_environment_setup,
)
from code_reviewer_runner.implementer.git_workspace import (
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.host_rules import HELPER_NAME
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_WRITER_CONTAINER_NAME,
    ReaderAccess,
    ReaderSeams,
)
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams
from code_reviewer_runner.implementer.setup_container import (
    SETUP_CONTAINER_NAME,
    SETUP_IMAGE_REPOSITORY,
    SETUP_IMAGE_TAG,
    SETUP_NETWORK_NAME,
    SetupSeams,
)
from code_reviewer_runner.implementer.turn_result import TurnResult
from code_reviewer_runner.job import (
    ImplementerEnvironment,
    ImplementerInput,
    parse_implementer_input,
)
from git_support import TOKEN, Origin, raw, system_git
from passthrough_loopback import LoopbackUpstream

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
INSTRUCTION = "Add a greeting file and commit it."
BRANCH = "implementer/a1b2c3"
IDENTITY = GitIdentity(name="Code Review Implementer", email="implementer@example.invalid")
REPO_IN_AGENT = Path("/work/repo")
# The relay between the model network and this process. One per lane.
RELAY_CONTAINER = "code-reviewer-lane-door-relay"
RELAY_CODE = r"""
import socket, sys, threading
host, port = sys.argv[1], int(sys.argv[2])
def pipe(a, b):
    try:
        while data := a.recv(65536):
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
def serve(client):
    try:
        upstream = socket.create_connection((host, port), timeout=10)
    except OSError:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("0.0.0.0", port))
listener.listen(64)
while True:
    connection, _ = listener.accept()
    threading.Thread(target=serve, args=(connection,), daemon=True).start()
"""
# Under runc the image's init (which starts the inner Docker) is replaced by one that only says it
# is ready.
RUNC_ENTRYPOINT = (
    "/usr/bin/tini",
    "--",
    "/bin/sh",
    "-c",
    "mkdir -p /run && touch /run/agent-ready && exec sleep infinity",
)


@dataclass(frozen=True)
class LaneConfig:
    worker_image: str
    agent_image: str
    runtime: str

    @property
    def under_sysbox(self) -> bool:
        return self.runtime == "sysbox-runc"

    @property
    def entrypoint(self) -> tuple[str, ...] | None:
        return None if self.under_sysbox else RUNC_ENTRYPOINT


def lane_config() -> LaneConfig:
    return LaneConfig(
        worker_image=os.environ.get("LANE_WORKER_IMAGE", "code-reviewer-worker:golden"),
        agent_image=os.environ.get("LANE_AGENT_IMAGE", "code-reviewer-agent:golden"),
        runtime=os.environ.get("LANE_RUNTIME", "runc"),
    )


def docker(
    *args: str, check: bool = True, timeout: float = 120.0
) -> subprocess.CompletedProcess[str]:
    done = subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=False, timeout=timeout
    )
    if check and done.returncode != 0:
        raise AssertionError(f"docker {' '.join(args)}: {done.stderr.strip()}")
    return done


def preflight(config: LaneConfig) -> None:
    """Everything the lane needs, or a failure that names what is missing (never a skip)."""
    if shutil.which("docker") is None:
        raise AssertionError("docker is not installed: the lane needs a Docker daemon")
    if os.geteuid() != 0:
        raise AssertionError(
            "the lane runs as root, as Control does (sudo -E .venv/bin/python -m pytest)"
        )
    done = docker("version", "--format", "{{.Server.Version}}", check=False)
    if done.returncode != 0:
        raise AssertionError("there is no Docker daemon this user may use")
    for image in (config.worker_image, config.agent_image):
        if docker("image", "inspect", image, check=False).returncode != 0:
            raise AssertionError(
                f"the image {image} is not in the daemon: build the targets `sandbox` "
                "(LANE_WORKER_IMAGE) and `agent` (LANE_AGENT_IMAGE) of runner/Dockerfile"
            )
    runtimes = docker("info", "--format", "{{json .Runtimes}}").stdout
    if config.runtime not in json.loads(runtimes):
        raise AssertionError(f"the daemon has no {config.runtime} runtime")


def remove_fixed() -> None:
    """The containers of the turn's model side that the turn names by constants, and the network.
    Not the readers: they are made when the workspace is prepared, before the network is."""
    for name in (AGENT_CONTAINER_NAME, RELAY_CONTAINER, SETUP_CONTAINER_NAME, HELPER_NAME):
        docker("rm", "-f", name, check=False)
    docker("network", "rm", MODEL_NETWORK_NAME, check=False)
    docker("network", "rm", SETUP_NETWORK_NAME, check=False)


def remove_setup_leftovers(config: LaneConfig) -> None:
    """The image a Setup container was committed to, and the firewall table in the host's
    namespace that its network got (the table only names the Setup bridge; it is removed so that
    the machine is as the lane found it)."""
    docker("image", "rm", f"{SETUP_IMAGE_REPOSITORY}:{SETUP_IMAGE_TAG}", check=False)
    docker(
        "run", "--rm", "--user", "0:0", "--network", "host", "--cap-drop", "ALL",
        "--cap-add", "NET_ADMIN", "--entrypoint", "/usr/sbin/nft", config.worker_image,
        "delete table ip setup_egress", check=False,
    )  # fmt: skip


def remove_leftovers() -> None:
    """What a lane that died left: the fixed names, the network and the stand-ins of Control."""
    remove_setup_leftovers(lane_config())
    for name in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
        docker("rm", "-f", name, check=False)
    remove_fixed()
    for container in docker(
        "ps", "-aq", "--filter", "label=code-reviewer.lane=1", check=False
    ).stdout.split():
        docker("rm", "-f", container, check=False)


def bridge_gateway() -> str:
    return docker(
        "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"
    ).stdout.strip()


@contextmanager
def model_network(config: LaneConfig, port: int) -> Generator[None]:
    """The model network of the turn and the relay container that stands at the door's address on
    it. Under Sysbox the network is the production one (`--internal`, isolated gateway), so the
    agent reaches nothing but the relay; under runc it is a plain bridge."""
    remove_fixed()
    options = (
        ["--internal", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated"]
        if config.under_sysbox
        else []
    )
    docker(
        "network", "create", *options, "--subnet", MODEL_NETWORK_SUBNET,
        "--gateway", MODEL_NETWORK_GATEWAY, MODEL_NETWORK_NAME,
    )  # fmt: skip
    docker(
        "create", "--name", RELAY_CONTAINER, "--label", "code-reviewer.lane=1",
        "--network", MODEL_NETWORK_NAME, "--ip", MODEL_DOOR_ADDRESS, "--user", "0:0",
        "--entrypoint", "/opt/venv/bin/python", config.worker_image,
        "-I", "-c", RELAY_CODE, bridge_gateway(), str(port),
    )  # fmt: skip
    # The relay also sits on the VM's default bridge, where this process listens.
    docker("network", "connect", "bridge", RELAY_CONTAINER)
    docker("start", RELAY_CONTAINER)
    try:
        yield
    finally:
        remove_fixed()


class LaneDoor:
    """The real model door (`run_door`) in a thread, started the way `start_door` starts the
    container's process: the start document on its stdin, its status lines on its stdout. It
    listens on all addresses of this machine; the relay container forwards the door's address on
    the model network to it. What the agent sees is `url`, the address of a door."""

    def __init__(
        self,
        *,
        model_access: Mapping[str, Any],
        capability: str,
        deadline_seconds: float,
        port: int,
        environment: Mapping[str, str],
        hop: LoopbackUpstream,
    ) -> None:
        self.state = DoorState()
        self.url = f"http://{MODEL_DOOR_ADDRESS}:{port}"
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        self._stdin = os.fdopen(in_write, "w", encoding="utf-8")
        door_in = os.fdopen(in_read, "r", encoding="utf-8")
        door_out = os.fdopen(out_write, "w", encoding="utf-8")
        self._stopped = False

        def run() -> None:
            door_service.run_door(
                door_in,
                door_out,
                bind=("0.0.0.0", port),
                upstream_for=lambda _destination: hop,
                poll_seconds=0.05,
            )
            door_out.close()

        def read() -> None:
            reader = os.fdopen(out_read, "r", encoding="utf-8")
            for line in reader:
                self._take(line)
            self.state.ended(DoorEnd(None, False, unexpected=not self._stopped))

        self._reader = threading.Thread(target=read, daemon=True)
        self._thread = threading.Thread(target=run, daemon=True)
        self._reader.start()
        self._thread.start()
        self._stdin.write(
            start_document(
                model_access=model_access,
                capability=capability,
                deadline_seconds=deadline_seconds,
                port=port,
                environment=environment,
            ).decode()
        )
        self._stdin.flush()
        self.state.wait_ready(30.0)
        if not self.state.is_ready:
            raise AssertionError(f"the door did not say ready ({self.state.refusal})")

    def _take(self, raw_line: str) -> None:
        try:
            decoded: Any = json.loads(raw_line)
        except ValueError:
            return
        if not isinstance(decoded, dict):
            return
        line = cast("dict[str, Any]", decoded)
        kind = line.get("t")
        if kind == MESSAGE_READY:
            self.state.ready()
        elif kind == MESSAGE_REFUSED:
            self.state.refused(str(line.get("reason")))
        elif kind == MESSAGE_STATUS:
            status = parse_status(line)
            if status is not None:
                self.state.update(status)

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        with contextlib.suppress(OSError):
            self._stdin.write(json.dumps({"op": OP_STOP}) + "\n")
            self._stdin.flush()
            self._stdin.close()
        self._thread.join(10.0)
        self._reader.join(10.0)


def implementer_job(
    family: Family = "messages",
    *,
    time_limit: int = 3600,
    max_cost_usd: float | None = None,
    instruction: str = INSTRUCTION,
) -> ImplementerInput:
    """The contract's example job with the provider, model and cost policy of the lane."""
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    entry = ENTRIES[family]
    spec = document["implementer"]
    spec["instruction"] = instruction
    spec["limits"]["timeLimitSeconds"] = time_limit
    spec["cost"] = dict(MANAGED)
    model_entry = spec["modelEntry"]
    model_entry.update(
        providerId=entry["provider"],
        npm=entry["npm"],
        family=entry["family"],
        authHeader=entry["authHeader"],
        upstreamBaseUrl=entry["upstreamBaseUrl"],
        modelId=entry["model"],
    )
    model_entry["model"]["limit"] = {"context": 1_000_000, "output": 64_000}
    model_entry["model"]["reasoning"] = False
    model_entry["model"].pop("interleaved", None)
    document["git"]["token"] = TOKEN
    document["llm"] = {
        "provider": entry["provider"].replace("-", "_"),
        "model": entry["model"],
        "apiKey": REAL_KEY,
        **({} if max_cost_usd is None else {"maxCostUsd": max_cost_usd}),
    }
    return parse_implementer_input(json.dumps(document))


@dataclass
class Turned:
    config: LaneConfig
    upstream: ScriptedUpstream
    origin: Origin
    workspace: GitWorkspace
    session: ImplementerSession
    scratch: Path
    volume: str
    result: TurnResult = field(init=False)
    # The messages the runner sent the engine: (session id, text of the one text part).
    messages: list[tuple[str, str]] = field(default_factory=lambda: [])
    doors: list[LaneDoor] = field(default_factory=lambda: [])
    # The environment's setup step, when the turn had one.
    setup: EnvironmentSetup | None = None

    @property
    def requests(self) -> list[dict[str, Any]]:
        """The bodies of the model calls that offered tools: the ones the script answered."""
        bodies: list[dict[str, Any]] = []
        for record in self.upstream.records:
            body: Any = record.body
            if isinstance(body, dict) and body.get("tools"):  # pyright: ignore[reportUnknownMemberType]
                bodies.append(dict(body))  # pyright: ignore[reportUnknownArgumentType]
        return bodies

    def tool_results(self) -> str:
        """What the tools of the agent answered, as the last request carried it to the model."""
        last = self.requests[-1]
        found: list[str] = []
        for message in last["messages"]:
            content: Any = message["content"]
            if not isinstance(content, list):
                continue
            for block in cast("list[dict[str, Any]]", content):
                if block.get("type") != "tool_result":
                    continue
                inner: Any = block.get("content")
                if isinstance(inner, list):
                    found.append(
                        "".join(
                            str(part.get("text", ""))
                            for part in cast("list[dict[str, Any]]", inner)
                        )
                    )
                else:
                    found.append(str(inner))
        return "\n".join(found)

    def origin_tip(self, branch: str = BRANCH) -> str | None:
        return self.origin.tip(branch)

    def exec_in(self, container: str, *argv: str) -> subprocess.CompletedProcess[str]:
        return docker("exec", container, *argv, check=False)


def mount(*args: str) -> None:
    done = subprocess.run(["mount", *args], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise AssertionError(f"mount {' '.join(args)}: {done.stderr.strip()}")


def loop_filesystem(image: Path, megabytes: int, target: Path) -> None:
    """A file system of a fixed size over a loop device, as the Launcher makes the reserve disk:
    allocated, not sparse, so that nothing else can take its blocks."""
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(["fallocate", "-l", f"{megabytes}M", str(image)], check=True)
    options = ["-q", "-F", "-m", "0", "-O", "^has_journal", "-E", "lazy_itable_init=1,nodiscard"]
    subprocess.run(["mkfs.ext4", *options, str(image)], check=True)
    mount("-o", "loop,nosuid,nodev", str(image), str(target))


# The reserve disk of the lane is small (the real one is an eighth of the VM's disk).
RESERVE_MEGABYTES = 512


def _make_volume(scratch: Path, disk_megabytes: int | None) -> tuple[Path, str, str]:
    """The work volume the way the Launcher makes it (`workVolumeCommands`): a directory with the
    reserve disk mounted below it, bound onto itself recursively, and a local volume over it with
    `rbind`; then the stand-in of the Control container's name. With `disk_megabytes`, the
    directory lives on a file system of that size, the lane's stand-in for the VM's disk, which an
    agent can fill without taking anything from the machine."""
    token = uuid.uuid4().hex[:8]
    parent = scratch
    if disk_megabytes is not None:
        parent = scratch / "vmdisk"
        loop_filesystem(scratch / "vmdisk.img", disk_megabytes, parent)
    work = parent / "work"
    (work / "reserve").mkdir(parents=True)
    loop_filesystem(scratch / "reserve.img", RESERVE_MEGABYTES, work / "reserve")
    mount("--rbind", str(work), str(work))
    volume = f"code-reviewer-lane-work-{token}"
    control = f"code-reviewer-lane-control-{token}"
    docker(
        "volume", "create", "--driver", "local", "--opt", "type=none",
        "--opt", f"device={work}", "--opt", "o=rbind", volume,
    )  # fmt: skip
    return work, volume, control


def unmount(path: Path) -> None:
    """Everything mounted at and below the path. The recursive bind of the work directory stands on
    top of the mounts it copied, so one pass takes the copies and the next the originals."""
    for _ in range(3):
        if subprocess.run(["umount", "-R", str(path)], capture_output=True, check=False).returncode:
            break


@dataclass
class LaneWorkspace:
    """The prepared workspace of a turn: the origin, the work volume, the Control stand-in, the real
    reader over them, and the agent's repository made through the reader."""

    config: LaneConfig
    origin: Origin
    workspace: GitWorkspace
    reader: ReaderAccess
    scratch: Path
    volume: str
    control: str


@contextmanager
def lane_workspace(
    scratch: Path,
    *,
    seed: Callable[[Path], None] | None = None,
    origin_setup: Callable[[Origin], None] | None = None,
    disk_megabytes: int | None = None,
    origin_base: Path | None = None,
) -> Generator[LaneWorkspace]:
    """The origin (a bare repository standing in for GitHub), the work volume, the stand-in of the
    Control container and the real reader; the workspace is prepared (the mirror on the reserve
    directory, the agent's repository made and configured through the reader)."""
    config = lane_config()
    git = system_git()
    # GitHub is not on the VM's disk. A run that fills the real disk of a VM names a directory on
    # another file system (a tmpfs that allows hooks: the origin refuses some pushes with one).
    stand_in = origin_base or scratch
    origin = Origin(stand_in, git)
    if seed is not None:
        seed(origin.seed)
        raw("add", "-A", cwd=origin.seed, git=git)
        raw("commit", "-qm", "seed", cwd=origin.seed, git=git)
        raw("push", "-q", "origin", "main", cwd=origin.seed, git=git)
    if origin_setup is not None:
        origin_setup(origin)
    work, volume, control = _make_volume(scratch, disk_megabytes)
    docker(
        "create", "--name", control, "--label", "code-reviewer.lane=1",
        "--mount", f"type=volume,src={volume},dst=/work", config.worker_image, "probe",
    )  # fmt: skip
    # The runner's own files are on memory, as /run is in the container: a full disk is not theirs.
    run_dir = Path("/dev/shm") / f"code-reviewer-lane-run-{uuid.uuid4().hex[:8]}"
    layout = WorkspaceLayout(work_dir=work, run_dir=run_dir)
    reader = ReaderAccess(
        {
            "GIT_AUTHOR_NAME": IDENTITY.name,
            "GIT_AUTHOR_EMAIL": IDENTITY.email,
            "GIT_COMMITTER_NAME": IDENTITY.name,
            "GIT_COMMITTER_EMAIL": IDENTITY.email,
        },
        ReaderSeams(runtime=config.runtime, hostname=lambda: control, python=sys.executable),
    )
    workspace = GitWorkspace(
        WorkspaceSpec(origin.url, TOKEN, "main", BRANCH),
        layout,
        IDENTITY,
        reader,
        git=git,
        schemes=("file",),
    )
    with ExitStack() as stack:
        # In the order they are undone: the readers, the stand-in, the volume, the mounts.
        stack.callback(shutil.rmtree, run_dir, True)
        stack.callback(unmount, scratch / "vmdisk")
        stack.callback(unmount, work)
        stack.callback(docker, "volume", "rm", "-f", volume, check=False)
        stack.callback(docker, "rm", "-f", control, check=False)
        stack.callback(reader.close)
        workspace.prepare()
        yield LaneWorkspace(config, origin, workspace, reader, scratch, volume, control)


def setup_seams(lane: LaneWorkspace) -> SetupSeams:
    """The Setup container of the lane: the lane's images and runtime, Control's stand-in as the
    container the work volume is read from."""
    config = lane.config
    return SetupSeams(
        hostname=lambda: lane.control,
        image=config.agent_image,
        helper_image=config.agent_image,
        runtime=config.runtime,
        entrypoint=config.entrypoint,
        ready_seconds=180.0,
    )


def environment_step(
    lane: LaneWorkspace,
    script: str,
    *,
    memory_mb: int = 2048,
    time_limit: float = 3600.0,
    should_stop: Callable[[], bool] = lambda: False,
) -> EnvironmentSetup:
    """The environment's script as `job_run` runs it, against the lane's workspace."""
    return run_environment_setup(
        ImplementerEnvironment("lane environment", script),
        workspace=lane.workspace,
        memory_mb=memory_mb,
        time_limit=time_limit,
        elapsed=lambda: 0.0,
        should_stop=should_stop,
        secrets=(TOKEN, REAL_KEY),
        seams=setup_seams(lane),
    )


@contextmanager
def lane_environment(
    scratch: Path,
    script: str,
    *,
    seed: Callable[[Path], None] | None = None,
    disk_megabytes: int | None = None,
    memory_mb: int = 2048,
    time_limit: float = 3600.0,
    should_stop: Callable[[], bool] = lambda: False,
) -> Generator[tuple[LaneWorkspace, EnvironmentSetup]]:
    """Only the environment's step: the prepared workspace and what the script did. For the scripts
    that fail, run out of time or fill the disk, and the questions about the Setup container
    itself."""
    with lane_workspace(scratch, seed=seed, disk_megabytes=disk_megabytes) as lane:
        step = environment_step(
            lane, script, memory_mb=memory_mb, time_limit=time_limit, should_stop=should_stop
        )
        yield lane, step


@contextmanager
def lane_turn(
    scratch: Path,
    script: Callable[[Path], list[Turn]],
    *,
    family: Family = "messages",
    limit: str = "5.00",
    instruction: str = INSTRUCTION,
    time_limit: int = 3600,
    seed: Callable[[Path], None] | None = None,
    origin_setup: Callable[[Origin], None] | None = None,
    disk_megabytes: int | None = None,
    origin_base: Path | None = None,
    judge: Callable[[Mapping[str, str], Mapping[str, Any]], Refusal | None] | None = None,
    memory_mb: int = 2048,
    setup_script: str | None = None,
) -> Generator[Turned]:
    """Run one whole turn to its result against a model that follows `script(repo)` (the path of
    the repository in the agent's container). With `setup_script`, the environment's script runs
    first in a Setup container (`run_environment_setup`, as `job_run` runs it) and the agent's
    container starts from the image it made; a script that fails raises: use `lane_environment`
    for those."""
    job = implementer_job(family, time_limit=time_limit, instruction=instruction)
    port = slot_ports({}).proxy
    messages: list[tuple[str, str]] = []
    doors: list[LaneDoor] = []

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        if method == "POST" and body is not None and url.endswith("/message"):
            document = json.loads(body)
            session = url.rsplit("/session/", 1)[1].split("/", 1)[0]
            messages.append((session, document["parts"][0]["text"]))
        return session_module._http_request(method, url, body, headers, timeout)  # pyright: ignore[reportPrivateUsage]

    entry = ENTRIES[family]
    with ExitStack() as stack:
        lane = stack.enter_context(
            lane_workspace(
                scratch,
                seed=seed,
                origin_setup=origin_setup,
                disk_megabytes=disk_megabytes,
                origin_base=origin_base,
            )
        )
        config = lane.config
        prepared: EnvironmentSetup | None = None
        if setup_script is not None:
            prepared = environment_step(lane, setup_script, memory_mb=memory_mb)
            if prepared.error is not None:
                raise AssertionError(f"the setup failed: {prepared.error.detail}")
        stack.enter_context(model_network(config, port))
        upstream = stack.enter_context(
            ScriptedUpstream(
                family, script(REPO_IN_AGENT), entry["model"], real_key=REAL_KEY, judge=judge
            )
        )
        hop = LoopbackUpstream(upstream.url + BASE_PATH[family])

        def make_door(**options: Any) -> LaneDoor:
            door = LaneDoor(hop=hop, **{k: v for k, v in options.items() if k != "seams"})
            doors.append(door)
            return door

        def place() -> AgentContainer:
            return AgentContainer(
                memory_mb,
                AgentSeams(
                    hostname=lambda: lane.control,
                    image=config.agent_image if prepared is None else str(prepared.image),
                    helper_image=config.agent_image,
                    runtime=config.runtime,
                    entrypoint=config.entrypoint,
                    ready_seconds=180.0,
                ),
            )

        session = ImplementerSession(
            job,
            workspace=lane.workspace,
            command=[OPENCODE],
            place=place,
            environment={"RUNNER_DYNAMIC_MAX_COST_USD": limit},
            seams=SessionSeams(transport=transport),
        )
        turned = Turned(
            config=config,
            upstream=upstream,
            origin=lane.origin,
            workspace=lane.workspace,
            session=session,
            scratch=scratch,
            volume=lane.volume,
            messages=messages,
            doors=doors,
            setup=prepared,
        )
        with mock.patch.object(session_module, "start_door", make_door):
            turned.result = session.run()
        removal = session._removal  # pyright: ignore[reportPrivateUsage]
        if removal is not None:
            removal.join(60.0)
        yield turned
        for door in doors:
            door.stop()


# -- the turns a script is made of ---------------------------------------------------------------


def write_file(repo: Path, name: str, content: str = "hello\n") -> Turn:
    return Turn(tool="write", args={"filePath": str(repo / name), "content": content})


def bash(command: str) -> Turn:
    return Turn(tool="bash", args={"command": command, "description": "run a command"})


def commit(message: str = "Add a greeting") -> Turn:
    return bash(f"git add -A && git commit -qm '{message}'")


def says(text: str) -> Turn:
    return Turn(text=text)


def wait_for(condition: Callable[[], bool], seconds: float = 30.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.1)
    return condition()


__all__ = [
    "BRANCH",
    "INSTRUCTION",
    "MODEL_AGENT_ADDRESS",
    "LaneWorkspace",
    "Turned",
    "bash",
    "commit",
    "docker",
    "lane_config",
    "lane_environment",
    "lane_turn",
    "lane_workspace",
    "preflight",
    "says",
    "wait_for",
    "write_file",
]
