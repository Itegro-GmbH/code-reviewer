# SPDX-License-Identifier: LicenseRef-Proprietary

"""The proof of the model door on a real VM (#745, step 3; reworked for step 4): run as the Control
container of the Implementer's profile, against the VM's own Docker.

    docker run <the flags of the Implementer's profile> --entrypoint /usr/bin/tini <image> -- \\
        /opt/venv/bin/python /driver/model_door_check.py

It does what a turn does with the door and then what a hostile agent would try, and prints one JSON
line per check (`{"check": ..., "ok": ..., ...}`), no value that is secret: the key here is a
made-up one (the provider answers it with a refusal, which is how the way to the provider is shown
without a cost), and the key is searched for in the places the agent could look.

Since step 4 the agent is not in this container: it is in a container of its own on the model
network. A Sysbox container cannot run in the CI lane, so a **stand-in** takes its place here: a
plain container of the Worker image on the model network, at the agent's address, with no
capability and no network but that one. What is proven of the door does not depend on the runtime.

1. the Docker socket answers, and the engine user (still in this container) cannot open it;
2. the door: how long each step of the start takes, what the daemon says the door is (user, root
   file system, capabilities, mounts, environment), what it weighs, that it has no IPv6;
3. from the stand-in: the door is reachable and nothing else is (another port, the internet, the
   VM's gateway and its control port), a call through the door reaches the provider and comes back
   refused for its key, the key is nowhere the stand-in can read;
4. a call over the cost limit is refused at the door and Control reads why;
5. the door is killed: the turn's end is named and the cost class is the one the model use decides;
6. the door answers the model network and opens nothing into it: a process in the door's network
   namespace cannot open a connection to the agent's address (DNS port included) or the VM, and one
   on the model network outside the door's rules can, so that the refusal is the rules and not a
   missing route.

`--offline` (the CI lane with a real Docker daemon, no provider and no internet): the same run with
the checks that need a real provider left out (a call that reaches it, the ledger read back after
its refusal).

It pauses once (`PAUSE`) until `/work/resume` exists, so that the host can look at the door's
container from outside (`docker top`, `docker exec`, `docker stats`) while it runs.
"""

import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_NAME,
)
from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.implementer import docker_api
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import (
    DOOR_CONTAINER_NAME,
    RunningDoor,
    start_door,
)
from code_reviewer_runner.implementer.exec_run import run_exec
from code_reviewer_runner.implementer.session import classify
from code_reviewer_runner.implementer.startup import engine_user_can_open
from code_reviewer_runner.job import JobError

ENGINE_UID = ENGINE_GID = 10101
PYTHON = "/usr/local/bin/python3"
VENV_PYTHON = "/opt/venv/bin/python"
OFFLINE = "--offline" in sys.argv[1:]
# Built, so that no secret scan sees a key; it is made up for the run and the provider refuses it.
KEY = "sk-ant-" + "api03-spike-" + secrets.token_hex(16)
ENTRY: dict[str, Any] = {
    "version": 1,
    "providerId": "anthropic",
    "npm": "@ai-sdk/anthropic",
    "family": "anthropic-messages",
    "authHeader": "x-api-key",
    "upstreamBaseUrl": "https://api.anthropic.com/v1",
    "modelId": "claude-sonnet-5-5",
    "model": {
        "name": "Claude Sonnet 5.5",
        "status": "active",
        "tool_call": True,
        "reasoning": False,
        "temperature": True,
        "limit": {"context": 200000, "output": 8192},
        "modalities": {"input": ["text"], "output": ["text"]},
    },
}
BOOK: dict[str, Any] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": "6000000",
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}
REFUSED_STATUSES = (401, 403)


def access(max_cost: float, provider: str = "anthropic") -> dict[str, Any]:
    return {
        "llm": {
            "provider": provider,
            "model": ENTRY["modelId"],
            "apiKey": KEY,
            "maxCostUsd": max_cost,
        },
        "modelEntry": ENTRY,
        "cost": {"keyMode": "managed", "priceBook": BOOK, "maxTotalTokens": None},
    }


class Checks:
    def __init__(self) -> None:
        self.ok = True

    def say(self, check: str, ok: bool, **details: Any) -> bool:
        self.ok = self.ok and ok
        print(json.dumps({"check": check, "ok": ok, **details}, default=str), flush=True)
        return ok


STAND_IN_NAME = "code-reviewer-door-check-agent"


class StandIn:
    """The agent's place in this check: a plain container of the Worker image on the model network
    at the agent's address (a Sysbox container cannot run in the CI lane), no capability, no mount,
    no network but that one."""

    def __init__(self, api: DockerApi, image: str) -> None:
        self.api = api
        self.container = api.create_container(
            {
                "Image": image,
                "Entrypoint": ["/usr/bin/tini", "--", "/usr/bin/sleep", "infinity"],
                "Cmd": [],
                "User": "10001:10001",
                "Env": [],
                "NetworkingConfig": {
                    "EndpointsConfig": {
                        MODEL_NETWORK_NAME: {"IPAMConfig": {"IPv4Address": MODEL_AGENT_ADDRESS}}
                    }
                },
                "HostConfig": {
                    "NetworkMode": MODEL_NETWORK_NAME,
                    "Privileged": False,
                    "ReadonlyRootfs": True,
                    "CapDrop": ["ALL"],
                    "SecurityOpt": ["no-new-privileges:true"],
                    "Memory": 128 * 1024 * 1024,
                    "MemorySwap": 128 * 1024 * 1024,
                    "PidsLimit": 64,
                    "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=8m"},
                    "RestartPolicy": {"Name": "no"},
                },
            },
            STAND_IN_NAME,
        )
        api.start_container(self.container)

    def python(
        self, code: str, *arguments: str, text: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        done = run_exec(
            self.api,
            self.container,
            [VENV_PYTHON, "-I", "-c", code, *arguments],
            stdin=None if text is None else text.encode(),
            timeout=120.0,
        )
        return subprocess.CompletedProcess([], done.returncode, done.stdout, "")

    def remove(self) -> None:
        self.api.remove_container(self.container)


def answer(done: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    """The JSON a snippet printed, or what its error said."""
    text = done.stdout.strip()
    if text.startswith("{"):
        parsed: dict[str, Any] = json.loads(text)
        return parsed
    return {"error": done.stderr[-200:]}


CALL = r"""
import http.client, json, sys, time
host, port, capability = sys.argv[1:4]
body = json.dumps({"model": "claude-sonnet-5-5", "stream": True, "max_tokens": 100,
                   "messages": [{"role": "user", "content": "hi"}]}).encode()
started = time.monotonic()
connection = http.client.HTTPConnection(host, int(port), timeout=60)
connection.request("POST", "/v1/messages", body, {
    "x-api-key": capability, "anthropic-version": "2023-06-01",
    "content-type": "application/json", "content-length": str(len(body))})
response = connection.getresponse()
data = response.read(2000)
print(json.dumps({"status": response.status, "seconds": round(time.monotonic() - started, 2),
                  "body": data[:160].decode("utf-8", "replace")}))
"""

REACH = r"""
import socket, sys
try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3).close()
    print("reached")
except OSError as error:
    print("refused:" + type(error).__name__)
"""

LOOK = r"""
import json, os, sys
# The needle comes on stdin: an argument would be in the command line this very process shows.
needle = sys.stdin.read().strip().encode()
found, processes, files = [], 0, 0
for entry in os.listdir("/proc"):
    if not entry.isdigit() or entry == str(os.getpid()):
        continue
    for name in ("environ", "cmdline"):
        try:
            data = open(f"/proc/{entry}/{name}", "rb").read()
        except OSError:
            continue
        processes += 1
        if needle in data:
            found.append(f"/proc/{entry}/{name}")
roots = ("/tmp", "/run", "/work", "/home", "/etc", "/opt", "/var", "/usr/local", "/srv", "/mnt")
for root in roots:
    for directory, _, names in os.walk(root, followlinks=False):
        for name in names:
            path = os.path.join(directory, name)
            try:
                if os.path.islink(path) or os.path.getsize(path) > 8_000_000:
                    continue
                data = open(path, "rb").read()
            except OSError:
                continue
            files += 1
            if needle in data:
                found.append(path)
print(json.dumps({"found": found, "processes_read": processes, "files_read": files}))
"""

# Runs in a helper container that shares the door's network namespace: whether IPv6 is switched off
# there, read from the kernel (the sysctl of the door's definition is only what was asked for).
NO_IPV6 = r"""
import sys
for name in ("all", "default"):
    if open(f"/proc/sys/net/ipv6/conf/{name}/disable_ipv6").read().strip() != "1":
        sys.exit(5)
"""

# Runs in a helper container: one connection. The exit code says what happened to it.
CONNECT = r"""
import socket, sys
probe = socket.socket()
probe.settimeout(4)
try:
    probe.connect((sys.argv[1], int(sys.argv[2])))
except TimeoutError:
    sys.exit(7)  # nothing came back: dropped
except ConnectionRefusedError:
    sys.exit(8)  # answered with a refusal: not dropped, nobody listens
except OSError:
    sys.exit(9)
sys.exit(0)
"""
CONNECTED, DROPPED, REFUSED = 0, 7, 8
HELPER_NAME = "code-reviewer-door-check-helper"

STEPS: list[tuple[str, float]] = []
_request = DockerApi.request


def _timed(
    self: DockerApi, method: str, path: str, body: object | None = None, **options: Any
) -> Any:
    started = time.monotonic()
    try:
        return _request(self, method, path, body, **options)
    finally:
        STEPS.append((f"{method} {path.split('?')[0]}", round(time.monotonic() - started, 3)))


DockerApi.request = _timed  # type: ignore[method-assign]


def start(max_cost: float, port: int, provider: str = "anthropic") -> tuple[RunningDoor, str]:
    capability = new_proxy_capability()
    door = start_door(
        model_access=access(max_cost, provider),
        capability=capability,
        deadline_seconds=1800.0,
        port=port,
        environment={},
    )
    return door, capability


def call(agent: StandIn, capability: str, port: int) -> dict[str, Any]:
    return answer(agent.python(CALL, MODEL_DOOR_ADDRESS, str(port), capability))


def the_container(checks: Checks, api: DockerApi, capability: str) -> None:
    document = api.inspect_container(DOOR_CONTAINER_NAME)
    config, host = document["Config"], document["HostConfig"]
    flat = json.dumps(document)
    checks.say(
        "door_definition",
        KEY not in flat
        and capability not in flat
        and config["User"] == "10001:10001"
        and host["ReadonlyRootfs"] is True
        and host["CapDrop"] == ["ALL"]
        and not host.get("Binds")
        and not host.get("Privileged"),
        user=config["User"],
        env=config.get("Env"),
        readonly=host["ReadonlyRootfs"],
        cap_drop=host["CapDrop"],
        security_opt=host["SecurityOpt"],
        memory=host["Memory"],
        pids=host["PidsLimit"],
        networks=sorted(document["NetworkSettings"]["Networks"]),
        mounts=[mount["Destination"] for mount in document["Mounts"]],
    )
    stats = api.request("GET", f"/containers/{document['Id']}/stats?stream=false&one-shot=true")
    usage = stats["memory_stats"]
    checks.say(
        "door_memory",
        True,
        usage_mb=round(usage.get("usage", 0) / 2**20, 1),
        limit_mb=round(usage.get("limit", 0) / 2**20),
    )


def the_stand_in(
    checks: Checks, agent: StandIn, door: RunningDoor, capability: str, port: int
) -> None:
    elsewhere = (
        ("door_other_port", MODEL_DOOR_ADDRESS, 8080),
        ("door_ssh_port", MODEL_DOOR_ADDRESS, 22),
        ("internet", "1.1.1.1", 443),
        ("vm_gateway", "172.17.0.1", 23456),
        ("model_network_gateway", "10.213.77.1", 22),
    )
    got = agent.python(REACH, MODEL_DOOR_ADDRESS, str(port)).stdout.strip()
    checks.say("agent_reaches_the_door", got == "reached", got=got)
    for label, address, where in elsewhere:
        got = agent.python(REACH, address, str(where)).stdout.strip()
        checks.say(f"agent_refused_{label}", got.startswith("refused"), got=got)
    if not OFFLINE:
        outcome = call(agent, capability, port)
        # The provider answers the made-up key with a refusal: out and back works, at no cost.
        checks.say(
            "call_through_the_door_reaches_the_provider",
            outcome.get("status") in REFUSED_STATUSES,
            **outcome,
        )
        time.sleep(0.5)
        seen = door.state.status
        checks.say(
            "ledger_read_back_after_a_refused_call",
            seen is not None and not seen.model_used and seen.upstream_error is not None,
            upstream_error=None if seen is None else seen.upstream_error,
            calls=None if seen is None else seen.usage["aiCalls"],
        )
    wrong = call(agent, "not-the-capability-" + "x" * 30, port)
    checks.say(
        "call_without_the_capability_is_refused", wrong.get("status") in REFUSED_STATUSES, **wrong
    )
    looked = answer(agent.python(LOOK, text=KEY))
    checks.say(
        "key_is_nowhere_the_agent_can_read",
        looked.get("found") == [],
        **looked,
    )


def connect_from(api: DockerApi, image: str, network: str, address: str, port: int) -> int:
    """Open one connection to `address:port` from a one-shot container that shares `network`
    (`container:<name>` is the door's namespace, with the door's rules) and return its exit code."""
    helper = api.create_container(
        {
            "Image": image,
            "Entrypoint": [VENV_PYTHON, "-I", "-c", CONNECT, address, str(port)],
            "Cmd": [],
            "User": "10001:10001",
            "Env": [],
            "HostConfig": {
                "NetworkMode": network,
                "Privileged": False,
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "Memory": 64 * 1024 * 1024,
                "MemorySwap": 64 * 1024 * 1024,
                "PidsLimit": 16,
                "RestartPolicy": {"Name": "no"},
            },
        },
        HELPER_NAME,
    )
    try:
        api.start_container(helper)
        return api.wait_container(helper, timeout=60.0)
    finally:
        api.remove_container(helper)


def helper_exit(api: DockerApi, image: str, network: str, code: str, *arguments: str) -> int:
    """Run `code` in a one-shot container that shares `network` and return its exit code."""
    helper = api.create_container(
        {
            "Image": image,
            "Entrypoint": [VENV_PYTHON, "-I", "-c", code, *arguments],
            "Cmd": [],
            "User": "10001:10001",
            "Env": [],
            "HostConfig": {
                "NetworkMode": network,
                "Privileged": False,
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "Memory": 64 * 1024 * 1024,
                "MemorySwap": 64 * 1024 * 1024,
                "PidsLimit": 16,
                "RestartPolicy": {"Name": "no"},
            },
        },
        HELPER_NAME,
    )
    try:
        api.start_container(helper)
        return api.wait_container(helper, timeout=60.0)
    finally:
        api.remove_container(helper)


def the_door_has_no_ipv6(checks: Checks, api: DockerApi) -> None:
    """The door's rules are an `ip` table, which does not see IPv6: a door with an IPv6 address
    or a switch left on would have a way round them."""
    document = api.inspect_container(DOOR_CONTAINER_NAME)
    networks = document["NetworkSettings"]["Networks"].values()
    addressed = [network.get("GlobalIPv6Address") for network in networks]
    image = str(api.inspect_container(socket.gethostname()).get("Image", ""))
    in_the_kernel = helper_exit(api, image, f"container:{DOOR_CONTAINER_NAME}", NO_IPV6)
    checks.say(
        "door_has_no_ipv6",
        not any(addressed) and in_the_kernel == 0,
        addresses=addressed,
        sysctl_in_the_door_namespace=in_the_kernel,
    )


LISTEN = r"""
import socket, sys, time
listener = socket.socket()
listener.bind((sys.argv[1], int(sys.argv[2])))
listener.listen(8)
time.sleep(60)
"""


def the_door_opens_nothing_into_the_model_network(
    checks: Checks, api: DockerApi, agent: StandIn
) -> None:
    image = str(api.inspect_container(socket.gethostname()).get("Image", ""))
    for label, port in (("a_port", 18080), ("dns_port", 53)):
        # A listener at the agent's address, started in the stand-in (detached).
        made = api.create_exec(
            agent.container,
            {
                "Cmd": [VENV_PYTHON, "-I", "-c", LISTEN, MODEL_AGENT_ADDRESS, str(port)],
                "AttachStdin": False,
                "AttachStdout": False,
                "AttachStderr": False,
            },
        )
        api.start_exec_detached(made)
        time.sleep(0.8)
        reaches = connect_from(api, image, MODEL_NETWORK_NAME, MODEL_AGENT_ADDRESS, port)
        from_door = connect_from(
            api, image, f"container:{DOOR_CONTAINER_NAME}", MODEL_AGENT_ADDRESS, port
        )
        checks.say(
            f"door_namespace_cannot_open_a_connection_to_the_agent_{label}",
            reaches == CONNECTED and from_door == DROPPED,
            outside_the_rules=reaches,
            in_the_door=from_door,
        )
    # Not a model network: the VM's gateway has no listener on this port, so a refusal would
    # mean the packet got there, and a drop means the rules stopped it.
    vm = connect_from(api, image, f"container:{DOOR_CONTAINER_NAME}", "172.17.0.1", 23456)
    checks.say("door_namespace_cannot_reach_the_vm", vm == DROPPED, in_the_door=vm)


def main() -> int:
    checks = Checks()
    ports = slot_ports(dict(os.environ))
    started = time.monotonic()
    path = docker_api.DOCKER_SOCKET
    checks.say("docker_socket", DockerApi().ping(), path=path, mode=oct(os.stat(path).st_mode))
    # The production function of the start-up check, not a copy of its probe.
    checks.say(
        "engine_user_cannot_open_the_docker_socket",
        not engine_user_can_open(ENGINE_UID, ENGINE_GID),
    )

    began = time.monotonic()
    door, capability = start(2.5, ports.proxy)
    checks.say(
        "door_start",
        True,
        seconds=round(time.monotonic() - began, 2),
        url=door.url,
        steps=STEPS[:],
    )
    api = DockerApi()
    image = str(api.inspect_container(socket.gethostname()).get("Image", ""))
    agent = StandIn(api, image)
    the_container(checks, api, capability)
    the_door_has_no_ipv6(checks, api)
    the_stand_in(checks, agent, door, capability, ports.proxy)
    the_door_opens_nothing_into_the_model_network(checks, api, agent)

    if not OFFLINE:
        # The host looks at the door from outside while it runs (`docker top`, `docker exec`, ...).
        print("PAUSE", flush=True)
        end = time.monotonic() + 600
        while not Path("/work/resume").exists() and time.monotonic() < end:
            time.sleep(0.5)
    # The agent goes first, as in a turn: a network with a member is not removed.
    agent.remove()
    door.stop()
    checks.say("door_stop", door.state.end is not None and not door.state.end.unexpected)

    low, capability = start(0.000001, ports.proxy)
    agent = StandIn(api, image)
    refusal = call(agent, capability, ports.proxy)
    time.sleep(0.5)
    failure = low.state.failure()
    checks.say(
        "cost_limit_refuses_at_the_door_and_control_reads_why",
        int(refusal.get("status", 0)) >= 400
        and failure is not None
        and failure.detail == "the cost limit is used up",
        status=refusal.get("status"),
        failure=None if failure is None else [failure.code.value, failure.detail],
        model_used=low.state.model_used,
    )
    agent.remove()
    low.stop()

    victim, capability = start(2.5, ports.proxy)
    api.request("POST", f"/containers/{DOOR_CONTAINER_NAME}/kill?signal=KILL")
    deadline = time.monotonic() + 10
    while victim.state.lost is None and time.monotonic() < deadline:
        time.sleep(0.1)
    lost = victim.state.failure()
    code = None if lost is None else classify(lost, used_model=victim.state.model_used)[0]
    checks.say(
        "killed_door_is_named_and_the_class_follows_the_model_use",
        lost is not None and "model door" in lost.detail and code is not None,
        failure=None if lost is None else lost.detail,
        model_used=victim.state.model_used,
        code=None if code is None else code.value,
    )
    victim.stop()

    try:
        start(2.5, ports.proxy, provider="openrouter")
        checks.say("a_model_the_door_refuses_is_the_jobs_settings", False)
    except JobError as error:
        checks.say(
            "a_model_the_door_refuses_is_the_jobs_settings",
            error.code.value == "implementer_config_invalid",
            code=error.code.value,
            detail=error.detail[:120],
        )
    seconds = round(time.monotonic() - started, 1)
    checks.say("total", checks.ok, seconds=seconds, hostname=socket.gethostname()[:12])
    return 0 if checks.ok else 1


if __name__ == "__main__":
    sys.exit(main())
