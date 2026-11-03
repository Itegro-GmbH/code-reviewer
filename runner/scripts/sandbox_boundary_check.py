# SPDX-License-Identifier: LicenseRef-Proprietary

"""The attack test of the Implementer's sandbox on a real VM (#745, step 6): run as the Control
container of the Implementer's profile, against the VM's own Docker and the real Sysbox.

    docker run <the flags of the Implementer's profile> --entrypoint /usr/bin/tini \\
        --mount type=bind,source=<runner/scripts>,target=/driver,readonly <image> -- \\
        /opt/venv/bin/python /driver/sandbox_boundary_check.py [--skip-abuse]

It starts what a turn starts (the model door with a made-up key, the agent's container, the readers
and, for the network checks, the Setup container) with the production code, and then does from
inside what an untrusted workload would try: `boundary_probe.py` runs as root in the agent's
container and in the Setup container and prints facts, this script holds the expectations. Each check
names the **expected denial** and asserts it; a denial is always paired with a control (the same
attempt reaching what it is allowed to reach), so that "blocked" cannot mean "the probe cannot
reach anything". Nothing here targets anything but addresses and files of this VM; the only
outside address is the one connection each to a few public IPs the networks are expected to refuse
(or, for the Setup container, to allow).

It prints one JSON line per check (`{"area", "check", "expected", "ok", "observed"}`) and, last, a
table. No value that is secret is printed: the key of the door is made up for the run.

`--skip-abuse` leaves out the checks that stress the VM (a memory hog, a process flood, an open-file
flood, a processor burn, the VM's disk filled). `--offline` leaves out the one call that reaches the
real provider (a request with another Host header, which the provider answers with a 401 for the
made-up key). The exit status is 0 when every check holds.
"""

import contextlib
import json
import os
import secrets
import shutil
import signal
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, cast

from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_GATEWAY,
    MODEL_NETWORK_NAME,
)
from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    PYTHON,
    AgentContainer,
)
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.door_launcher import (
    DOOR_CONTAINER_NAME,
    RunningDoor,
    start_door,
)
from code_reviewer_runner.implementer.exec_run import run_exec
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_DROP_CAPABILITIES,
    READER_WRITER_CONTAINER_NAME,
    ReaderAccess,
)
from code_reviewer_runner.implementer.setup_container import (
    SETUP_ADDRESS,
    SETUP_CONTAINER_NAME,
    SETUP_NETWORK_GATEWAY,
    SETUP_NETWORK_NAME,
    SetupContainer,
)
from code_reviewer_runner.implementer.vm_memory import read_memory

Json = dict[str, Any]
SKIP_ABUSE = "--skip-abuse" in sys.argv[1:]
DRIVER = Path(__file__).resolve().parent
PROBE_TEXT = (DRIVER / "boundary_probe.py").read_text(encoding="utf-8")
MEMORY_MB = int(os.environ.get("RUNNER_IMPLEMENTER_AGENT_MEMORY_MB", "2048"))
VENV_PYTHON = "/opt/venv/bin/python"
# Made up for the run, built so that no scan of the source sees a key; the provider refuses it.
KEY = "sk-ant-" + "api03-boundary-" + secrets.token_hex(16)
MIB = 1024 * 1024
DOOR_PORT = slot_ports(dict(os.environ)).proxy
LISTEN_PORT = 9999
SETUP_LISTEN_PORT = 9998
INTERNET = (("1.1.1.1", 443), ("8.8.8.8", 443), ("9.9.9.9", 80), ("1.1.1.1", 53))
# Public IPv6 addresses the agent must not reach (a connect each, port 443).
PUBLIC_V6 = ("2606:4700:4700::1111", "2001:4860:4860::8888")
# The VM's control service and the platform's own addresses: the things an untrusted workload must
# never reach.
CONTROL_PORT = 23456
ENTRY: Json = {
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
BOOK: Json = {
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


class Checks:
    """The rows of the table. A check is `ok` only if its denial held; `observed` is short and
    never holds a secret."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, bool, str]] = []

    @property
    def ok(self) -> bool:
        return all(row[3] for row in self.rows)

    def say(self, area: str, check: str, expected: str, ok: bool, **observed: Any) -> bool:
        text = json.dumps(observed, default=str, separators=(",", ":"))[:600]
        self.rows.append((area, check, expected, bool(ok), text))
        print(
            json.dumps(
                {
                    "area": area,
                    "check": check,
                    "expected": expected,
                    "ok": bool(ok),
                    "observed": text,
                }
            ),
            flush=True,
        )
        return bool(ok)

    def table(self) -> str:
        width = max(len(row[1]) for row in self.rows)
        lines = [f"{'RESULT':6}  {'AREA':10} {'CHECK':{width}}  EXPECTED"]
        for area, check, expected, ok, _ in self.rows:
            lines.append(f"{'PASS' if ok else 'FAIL':6}  {area:10} {check:{width}}  {expected}")
        failed = sum(1 for row in self.rows if not row[3])
        lines.append(f"{len(self.rows) - failed} passed, {failed} failed")
        return "\n".join(lines)


def reached(outcome: str | None) -> bool:
    """A connect that got an answer: the handshake finished or a reset came back."""
    return outcome in ("connected", "refused")


def any_resolved(values: Json) -> bool:
    """Whether any name resolved to at least one address (a list), not to an error word."""
    return any(isinstance(v, list) and len(cast("list[Any]", v)) > 0 for v in values.values())


def owned_as_planted(seen: Json) -> bool:
    """What Control sees of the planted files: root-made ones are uid 0, the foreign-owned one has the
    uid the agent gave it."""
    for name, info in seen.items():
        if name == "dev" or not isinstance(info, dict):
            continue
        owner = cast("Json", info)["uid"]
        if owner != (4321 if name in ("other-owner", "hard2") else 0):
            return False
    return True


def last_json(stdout: str, marker: str = "PROBE_RESULT ") -> Json:
    for line in reversed(stdout.splitlines()):
        if line.startswith(marker):
            return cast("Json", json.loads(line[len(marker) :]))
    return {"error": "no result: " + stdout[-200:]}


class Rig:
    """What the checks stand on: the daemon, the made-up door, the agent's container."""

    def __init__(self, checks: Checks) -> None:
        self.checks = checks
        self.api = DockerApi()
        self.me = self.api.inspect_container(socket.gethostname())
        self.image = str(self.me.get("Image", ""))
        self.vm_daemon_id = str(self.api.request("GET", "/info").get("ID", ""))
        self.agent = AgentContainer(MEMORY_MB)
        self.door: RunningDoor | None = None
        self.capability = new_proxy_capability()
        self.host: Json = {}
        self.neighbour = ""
        self.control_address = ""

    # -- running things ----------------------------------------------------------------------

    def in_agent(self, config: Json, *, timeout: float = 240.0) -> Json:
        return self.probe(AGENT_CONTAINER_NAME, config, timeout)

    def probe(self, container: str, config: Json, timeout: float) -> Json:
        done = run_exec(
            self.api,
            container,
            [PYTHON, "-I", "-c", PROBE_TEXT, json.dumps(config)],
            timeout=timeout,
            name="probe",
        )
        return last_json(done.stdout)

    def agent_run(self, argv: list[str], *, timeout: float = 60.0) -> tuple[int, str]:
        done = run_exec(self.api, AGENT_CONTAINER_NAME, argv, timeout=timeout)
        return done.returncode, done.stdout

    def host_json(self, code: str, *, timeout: float = 60.0) -> Json:
        """A one-shot container in the VM's own network namespace (no capability, no mount) that
        prints one JSON line: the VM's addresses, listeners and IPv6 state."""
        helper = self.api.create_container(
            {
                "Image": "code-reviewer-agent:golden",
                "Entrypoint": [PYTHON, "-I", "-c", code],
                "Cmd": [],
                "User": "0:0",
                "Env": [],
                "HostConfig": {
                    "NetworkMode": "host",
                    "Privileged": False,
                    "ReadonlyRootfs": True,
                    "CapDrop": ["ALL"],
                    "SecurityOpt": ["no-new-privileges:true"],
                    "Memory": 64 * MIB,
                    "MemorySwap": 64 * MIB,
                    "PidsLimit": 32,
                    "RestartPolicy": {"Name": "no"},
                },
            },
            "code-reviewer-boundary-host-view",
        )
        try:
            streams = self.api.attach(helper)
            self.api.start_container(helper)
            out = b"".join(streams.chunks())
            self.api.wait_container(helper, timeout=timeout)
        finally:
            with contextlib.suppress(DockerError):
                self.api.remove_container(helper)
        return last_json(out.decode("utf-8", "replace"), "HOST_RESULT ")

    # -- the setup ---------------------------------------------------------------------------

    def start_door(self) -> None:
        self.door = start_door(
            model_access={
                "llm": {
                    "provider": "anthropic",
                    "model": ENTRY["modelId"],
                    "apiKey": KEY,
                    "maxCostUsd": 2.5,
                },
                "modelEntry": ENTRY,
                "cost": {"keyMode": "managed", "priceBook": BOOK, "maxTotalTokens": None},
            },
            capability=self.capability,
            deadline_seconds=3600.0,
            port=DOOR_PORT,
            environment={},
        )


HOST_VIEW = r"""
import json, os, socket, subprocess
def listeners():
    found = []
    for path, family in (("/proc/net/tcp", 4), ("/proc/net/tcp6", 6)):
        try:
            lines = open(path).read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if fields[3] != "0A":
                continue
            address, port = fields[1].split(":")
            text = socket.inet_ntoa(bytes.fromhex(address)[::-1]) if family == 4 else "::"
            found.append({"family": family, "address": text, "port": int(port, 16)})
    return found
def run(argv):
    return subprocess.run(argv, capture_output=True, text=True, timeout=10).stdout
addresses = []
for line in run(["ip", "-4", "-o", "addr", "show"]).splitlines():
    fields = line.split()
    addresses.append({"interface": fields[1], "address": fields[3].split("/")[0]})
inet6 = []
for line in open("/proc/net/if_inet6").read().splitlines():
    fields = line.split()
    inet6.append({"interface": fields[5], "scope": fields[3], "prefix": fields[0][:4]})
def read(path):
    try:
        return open(path).read().strip()
    except OSError as error:
        return "error:" + str(error.errno)
result = {
    "addresses": addresses,
    "listeners": listeners(),
    "inet6": inet6,
    "interfaces": sorted(os.listdir("/sys/class/net")),
    "disable_ipv6": {n: read(f"/proc/sys/net/ipv6/conf/{n}/disable_ipv6") for n in ("all", "default")},
    "forwarding6": read("/proc/sys/net/ipv6/conf/all/forwarding"),
    "core_pattern": read("/proc/sys/kernel/core_pattern"),
    "sysctls": {n: read("/proc/sys/" + n) for n in ("kernel/panic", "kernel/printk", "kernel/sysrq")},
}
print("HOST_RESULT " + json.dumps(result), flush=True)
"""


def vm_targets(host: Json, own: set[str]) -> list[Json]:
    """Every address of the VM on every bridge, with every port the VM listens on and the ports a
    service might be on: connecting to one is what an untrusted workload would do first."""
    addresses = sorted({a["address"] for a in host["addresses"] if a["interface"] != "lo"} - own)
    ports = sorted(
        {x["port"] for x in host["listeners"]} | {22, 53, 80, 443, 2375, 2376, 8080, CONTROL_PORT}
    )
    return [
        {"l": f"vm:{address}:{port}", "h": address, "p": port}
        for address in addresses
        for port in ports
    ]


def section_boundary_of_the_container(lab: Rig) -> None:
    """The agent's container as the daemon made it: what is not in it, and what it has."""
    checks, api = lab.checks, lab.api
    document = api.inspect_container(AGENT_CONTAINER_NAME)
    host = document["HostConfig"]
    mounts = [m["Destination"] for m in document.get("Mounts", [])]
    networks = sorted(document["NetworkSettings"]["Networks"])
    checks.say(
        "container",
        "agent_container_as_asked",
        "not privileged, no bind/device/host pid/ipc/userns, one mount (/work/repo), the model network only, sysbox-runc",
        host["Privileged"] is False
        and not host.get("Binds")
        and not host.get("Devices")
        and host.get("PidMode", "") == ""
        and host.get("IpcMode", "") != "host"
        and host.get("UsernsMode", "") != "host"
        and not host.get("CapAdd")
        and mounts == ["/work/repo"]
        and networks == [MODEL_NETWORK_NAME]
        and host["Runtime"] == "sysbox-runc",
        mounts=mounts,
        networks=networks,
        runtime=host["Runtime"],
        privileged=host["Privileged"],
    )
    checks.say(
        "container",
        "agent_limits_are_the_size_of_the_vm",
        f"memory {MEMORY_MB} MiB without swap, 16384 processes",
        host["Memory"] == MEMORY_MB * MIB
        and host["MemorySwap"] == MEMORY_MB * MIB
        and host["PidsLimit"] == 16384,
        memory_mib=host["Memory"] // MIB,
        swap_mib=host["MemorySwap"] // MIB,
        pids=host["PidsLimit"],
    )
    # The limits of everything on the VM, counted in full, leave the VM its 512 MiB.
    limits = {"agent": host["Memory"]}
    for label, name in (
        ("control", socket.gethostname()),
        ("door", DOOR_CONTAINER_NAME),
        ("reader", READER_CONTAINER_NAME),
        ("reader-rw", READER_WRITER_CONTAINER_NAME),
    ):
        limits[label] = api.inspect_container(name)["HostConfig"]["Memory"]
    total = int(
        next(
            line.split()[1]
            for line in Path("/proc/meminfo").read_text().splitlines()
            if line.startswith("MemTotal")
        )
    )
    reserve_left = total // 1024 - sum(limits.values()) // MIB
    checks.say(
        "container",
        "memory_limits_of_all_containers_fit_the_vm",
        "sum of the limits leaves the OS at least 400 MiB (512 reserved, kernel overhead)",
        reserve_left >= 400,
        limits_mib={k: v // MIB for k, v in limits.items()},
        vm_mib=total // 1024,
        left_mib=reserve_left,
    )
    # The readers, as the daemon made them.
    for name in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
        reader = api.inspect_container(name)
        config = reader["HostConfig"]
        reader_mounts = sorted(m["Destination"] for m in reader.get("Mounts", []))
        checks.say(
            "container",
            f"{name}_as_asked",
            "sysbox-runc, no network, read-only root, CapDrop ALL + DAC_OVERRIDE, no-new-privileges, one mount (/repo)",
            config["Runtime"] == "sysbox-runc"
            and config["NetworkMode"] == "none"
            and config["ReadonlyRootfs"] is True
            and config["CapDrop"] == ["ALL"]
            and config["CapAdd"] == ["DAC_OVERRIDE"]
            and "no-new-privileges:true" in config["SecurityOpt"]
            and reader_mounts == ["/repo"]
            and not config.get("Privileged"),
            mounts=reader_mounts,
            network=config["NetworkMode"],
            caps=config["CapAdd"],
        )


STATUS_FIELDS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs")


def reader_status(lab: Rig, name: str, *, production: bool) -> Json:
    """`/proc/self/status` of a command in a reader: the way the runner starts every command
    (`setpriv`), or a plain exec (which holds what the runtime gives the container's root)."""
    argv = ["/bin/cat", "/proc/self/status"]
    if production:
        argv = [*READER_DROP_CAPABILITIES, *argv]
    done = run_exec(lab.api, name, argv, timeout=20.0)
    fields: Json = {}
    for line in done.stdout.splitlines():
        key, _, value = line.partition(":")
        if key in STATUS_FIELDS:
            fields[key] = value.strip()
    return fields


def section_readers(lab: Rig) -> None:
    checks = lab.checks
    for name in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
        status = reader_status(lab, name, production=True)
        checks.say(
            "reader",
            f"{name}_command_caps",
            "CapEff 0x2 (DAC_OVERRIDE only), CapBnd 0x2, CapAmb 0, CapInh 0, NoNewPrivs 1",
            int(status.get("CapEff", "-1"), 16) == 0x2
            and int(status.get("CapBnd", "-1"), 16) == 0x2
            and int(status.get("CapAmb", "-1"), 16) == 0
            and int(status.get("CapInh", "-1"), 16) == 0
            and status.get("NoNewPrivs") == "1",
            **status,
        )
    plain = reader_status(lab, READER_CONTAINER_NAME, production=False)
    checks.say(
        "reader",
        "plain_exec_is_informational",
        "Sysbox ignores CapDrop: a plain exec holds the user namespace's capabilities, which is why every command starts through setpriv",
        "CapEff" in plain,
        **plain,
    )
    for name in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
        done = run_exec(
            lab.api,
            name,
            [
                "/bin/sh",
                "-c",
                "cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' ' | tr '\\n' ' '; echo;"
                " ls /var/run/docker.sock /run/docker.sock /work 2>&1 | head -3;"
                " cat /proc/self/uid_map",
            ],
            timeout=20.0,
        )
        text = done.stdout
        checks.say(
            "reader",
            f"{name}_isolation",
            "only lo, no Docker socket, no /work, root maps to an unprivileged host uid",
            text.split("\n")[0].strip() == "lo"
            and text.count("No such file") >= 3
            and len(text.split()) >= 3
            and int(text.split()[-2]) >= 100000,
            output=text[:300],
        )


def section_agent_identity(lab: Rig) -> None:
    checks = lab.checks
    facts = lab.in_agent(
        {
            "sections": ["ids", "mounts", "devices", "cgroup"],
            "devices": [
                "null",
                "zero",
                "full",
                "random",
                "urandom",
                "tty",
                "net/tun",
                "fuse",
                "mem",
                "kmem",
                "port",
                "vda",
                "vdb",
                "sda",
                "nvme0n1",
                "loop0",
                "loop-control",
                "kvm",
                "dm-0",
            ],
        }
    )
    ids = facts["ids"]
    first = ids["uid_map"].split()
    checks.say(
        "container",
        "agent_root_maps_to_an_unprivileged_host_uid",
        "uid_map '0 <host uid >= 100000> <size <= 65536>', not the identity map",
        len(first) == 3 and int(first[1]) >= 100000 and int(first[2]) <= 65536 and ids["uid"] == 0,
        uid_map=ids["uid_map"],
        gid_map=ids["gid_map"],
    )
    top = lab.api.request(
        "GET", f"/containers/{AGENT_CONTAINER_NAME}/top?ps_args=-eo%20uid,pid,comm"
    )
    users = {row[0] for row in top.get("Processes", [])}
    checks.say(
        "container",
        "agent_processes_run_as_unprivileged_host_uids",
        "no process of the agent's container has host uid 0",
        bool(users) and "0" not in users and "root" not in users,
        host_uids=sorted(users)[:5],
        count=len(top.get("Processes", [])),
    )
    self_caps = ids["self"]
    checks.say(
        "container",
        "agent_caps_exist_inside_its_user_namespace_only",
        "root holds caps in a user namespace of its own (uid_map above); NoNewPrivs is not set (the agent is free)",
        self_caps.get("NoNewPrivs") in ("0", None),
        **self_caps,
    )
    mounts = facts["mounts"]["mounts"]
    suspicious = [
        m
        for m in mounts
        if m["point"]
        not in ("/work/repo", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts", "/var/lib/docker")
        and any(
            word in (m["source"] + m["root"] + m["point"])
            for word in ("docker.sock", "code-reviewer-work", "reserve", "mirror")
        )
    ]
    checks.say(
        "volume",
        "agent_sees_the_repository_mount_only",
        "no mount of the Docker socket, the reserve disk or the mirror; /work/repo is the one volume mount",
        not suspicious and any(m["point"] == "/work/repo" for m in mounts),
        suspicious=suspicious[:3],
        repo_mount=[m for m in mounts if m["point"] == "/work/repo"][:1],
    )
    devices = facts["devices"]
    present = devices["present"]
    missing = [n for n in ("null", "zero", "full", "random", "urandom", "tty") if not present[n]]
    leaked = [
        n
        for n in ("mem", "kmem", "port", "vda", "vdb", "sda", "nvme0n1", "loop0", "kvm", "dm-0")
        if present[n]
    ]
    checks.say(
        "devices",
        "device_nodes_available_and_no_host_devices",
        "null/zero/full/random/urandom/tty present; no mem, kmem, port, block device, kvm",
        not missing and not leaked,
        missing=missing,
        leaked=leaked,
        net_tun=present["net/tun"],
        listing=devices["listing"][:40],
    )
    nodes = devices["mknod"]
    checks.say(
        "devices",
        "agent_cannot_make_device_nodes",
        "mknod of a block device and of /dev/mem, kmem, port fails",
        all(v.startswith("error:") for v in nodes.values()),
        **nodes,
    )
    cgroup = facts["cgroup"]
    values = cgroup["values"]
    checks.say(
        "cgroup",
        "agent_cgroup_limits_as_set",
        f"memory.max {MEMORY_MB * MIB}, memory.swap.max 0, pids.max 16384",
        values["memory.max"] == str(MEMORY_MB * MIB)
        and values["memory.swap.max"] == "0"
        and values["pids.max"] == "16384",
        **{k: values[k] for k in ("memory.max", "memory.swap.max", "pids.max")},
    )
    lifted = cgroup["lifted"]
    checks.say(
        "cgroup",
        "agent_root_cannot_lift_its_own_limits",
        "a write of 'max' to its own memory.max, memory.swap.max and pids.max fails and changes nothing",
        all(not v["changed"] and v["result"] != "written" for v in lifted.values()),
        **lifted,
    )


def section_proc_and_sys_extras(lab: Rig, facts: Json, ids: Json) -> None:
    checks = lab.checks
    syscalls = facts["syscalls"]
    checks.say(
        "proc",
        "privileged_syscalls_are_refused",
        "clock_settime, init_module, kexec_load, bpf(MAP_CREATE) and swapoff fail with EPERM/EACCES (the capabilities exist in the agent's user namespace only)",
        all(
            syscalls[name] in ("EPERM", "EACCES")
            for name in ("clock_settime", "init_module", "kexec_load", "bpf_map_create", "swapoff")
        ),
        **syscalls,
    )
    words = (
        "code_reviewer_runner",
        "sandbox_boundary",
        "sysbox",
        "tini -- /opt/venv",
    )
    seen = [p for p in ids["processes"] if any(w in p for w in words)]
    checks.say(
        "container",
        "agent_sees_only_its_own_processes",
        "its /proc lists its own init, dockerd and probes: no process of Control, the door, the readers, sysbox or the VM's dockerd",
        not seen and len(ids["processes"]) < 40,
        visible=len(ids["processes"]),
        sample=[p[:60] for p in ids["processes"][:6]],
        foreign=seen,
    )


def section_proc_and_sys(lab: Rig) -> None:
    checks = lab.checks
    host_before = lab.host["core_pattern"]
    ids = lab.in_agent({"sections": ["ids"]})["ids"]
    facts = lab.in_agent(
        {
            "sections": ["proc"],
            "sentinel": "core.boundary.check",
            "sysctls": [
                "/proc/sys/kernel/core_pattern",
                "/proc/sys/kernel/modprobe",
                "/proc/sys/kernel/printk",
                "/proc/sys/kernel/panic",
                "/proc/sys/vm/panic_on_oom",
                "/proc/sys/kernel/randomize_va_space",
            ],
        }
    )["proc"]
    section_proc_and_sys_extras(lab, facts, ids)
    kcore = facts["kcore"]
    checks.say(
        "proc",
        "kcore_is_masked",
        "opening /proc/kcore fails, or it returns no ELF header",
        not kcore["opened"] or not kcore["head"].startswith("7f454c46"),
        **kcore,
    )
    keys = facts["keys"]
    checks.say(
        "proc",
        "keys_are_masked",
        "/proc/keys fails to open or lists no key of the VM's other users",
        not keys["opened"] or len(bytes.fromhex(keys["head"]).splitlines()) <= 1,
        **keys,
    )
    checks.say(
        "proc",
        "sysrq_trigger_cannot_be_written",
        "opening /proc/sysrq-trigger for writing fails",
        not facts["sysrq_trigger"]["opened"],
        **facts["sysrq_trigger"],
    )
    checks.say(
        "proc",
        "dev_mem_kmem_port_cannot_be_opened",
        "the three device nodes are absent or refuse to open",
        not any(facts[k]["opened"] for k in ("mem", "kmem", "port")),
        mem=facts["mem"].get("why"),
        kmem=facts["kmem"].get("why"),
        port=facts["port"].get("why"),
    )
    writes = facts["sysctl_writes"]
    after = lab.host_json(HOST_VIEW)
    checks.say(
        "proc",
        "kernel_parameters_cannot_be_written",
        "writes to core_pattern, modprobe, panic_on_oom, randomize_va_space fail and the VM's core_pattern is unchanged",
        all(
            writes[f"/proc/sys/kernel/{name}"]["result"] != "written"
            for name in ("core_pattern", "modprobe")
        )
        and writes["/proc/sys/vm/panic_on_oom"]["result"] != "written"
        and writes["/proc/sys/kernel/randomize_va_space"]["result"] != "written"
        and after.get("core_pattern") == host_before,
        writes={k.rsplit("/", 1)[1]: v["result"] for k, v in writes.items()},
        vm_core_pattern_unchanged=after.get("core_pattern") == host_before,
    )
    # A parameter the container may write must be the container's own copy (Sysbox emulates some):
    # write a valid neighbour of the value, ask the VM, put the old value back.
    paths = ["/proc/sys/kernel/panic", "/proc/sys/kernel/printk", "/proc/sys/kernel/sysrq"]
    changed = lab.in_agent({"sections": ["sysctl"], "sysctl": {"mode": "write", "paths": paths}})
    originals = {p: v["original"] for p, v in changed["sysctl"].items()}
    on_the_vm = lab.host_json(HOST_VIEW)["sysctls"]
    lab.in_agent({"sections": ["sysctl"], "sysctl": {"mode": "restore", "paths": originals}})
    back = lab.host_json(HOST_VIEW)["sysctls"]
    names = {
        "/proc/sys/kernel/panic": "kernel/panic",
        "/proc/sys/kernel/printk": "kernel/printk",
        "/proc/sys/kernel/sysrq": "kernel/sysrq",
    }
    leaked_to_vm = {
        p: [lab.host["sysctls"][n], on_the_vm[n]]
        for p, n in names.items()
        if on_the_vm[n] != lab.host["sysctls"][n]
    }
    checks.say(
        "proc",
        "a_global_kernel_parameter_written_in_the_container_does_not_reach_the_vm",
        "panic, printk and sysrq written with a valid neighbour of their value: the container may see its own copy (Sysbox emulates them), the VM's value stays",
        not leaked_to_vm and back == lab.host["sysctls"],
        container_saw={
            p.rsplit("/", 1)[1]: [v["original"], v["after"]] for p, v in changed["sysctl"].items()
        },
        reached_the_vm=leaked_to_vm,
        vm_restored=back == lab.host["sysctls"],
    )
    checks.say(
        "proc",
        "sys_uevent_helper_and_binfmt_register_refuse",
        "writing /sys/kernel/uevent_helper and the binfmt_misc register file fails",
        facts["sys_kernel_uevent_helper"] != "written"
        and facts["binfmt_misc"]["register"] != "written",
        uevent=facts["sys_kernel_uevent_helper"],
        binfmt=facts["binfmt_misc"],
    )


NEIGHBOUR = "code-reviewer-boundary-neighbour"
NEIGHBOUR_PORT = 8080
LISTENER = (
    "import socket,time\n"
    "s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n"
    f"s.bind(('0.0.0.0',{NEIGHBOUR_PORT}));s.listen(8)\n"
    "end=time.time()+900\n"
    "while time.time()<end:\n"
    "    s.settimeout(1)\n"
    "    try: s.accept()[0].close()\n"
    "    except OSError: pass\n"
)


def start_neighbour(lab: Rig) -> str:
    """A plain container on the VM's default bridge, next to Control, that listens: what the agent
    must not reach even though it would answer."""
    container = lab.api.create_container(
        {
            "Image": "code-reviewer-agent:golden",
            "Entrypoint": [PYTHON, "-I", "-c", LISTENER],
            "Cmd": [],
            "User": "0:0",
            "Env": [],
            "HostConfig": {
                "NetworkMode": "bridge",
                "Privileged": False,
                "CapDrop": ["ALL"],
                "Memory": 64 * MIB,
                "MemorySwap": 64 * MIB,
                "PidsLimit": 16,
                "RestartPolicy": {"Name": "no"},
            },
        },
        NEIGHBOUR,
    )
    lab.api.start_container(container)
    address = ""
    for _ in range(50):
        document = lab.api.inspect_container(NEIGHBOUR)
        address = document["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
        if address:
            break
        time.sleep(0.1)
    return address


def own_addresses(lab: Rig, name: str) -> dict[str, str]:
    networks = lab.api.inspect_container(name)["NetworkSettings"]["Networks"]
    return {n: v["IPAddress"] for n, v in networks.items() if v.get("IPAddress")}


def fixed_targets(lab: Rig, neighbour: str, control: str) -> list[Json]:
    """The addresses that are ours on this VM, each with the ports something would be on."""
    targets: list[Json] = []

    def add(label: str, host: str, *ports: int) -> None:
        targets.extend({"l": f"{label}:{host}:{p}", "h": host, "p": p} for p in ports)

    add("model_gateway", MODEL_NETWORK_GATEWAY, 22, 53, 80, 443, CONTROL_PORT, DOOR_PORT)
    add("docker0_gateway", "172.17.0.1", 22, 53, 80, 2375, 2376, CONTROL_PORT)
    add("control", control, 22, 80, 8080, DOOR_PORT, CONTROL_PORT)
    add("neighbour_on_default_bridge", neighbour, NEIGHBOUR_PORT, 22, 80)
    add(
        "door_on_default_bridge",
        own_addresses(lab, DOOR_CONTAINER_NAME).get("bridge", "172.17.0.99"),
        DOOR_PORT,
        22,
    )
    add("setup_gateway", SETUP_NETWORK_GATEWAY, 22, 53, 80, CONTROL_PORT, SETUP_LISTEN_PORT)
    add("setup_address", SETUP_ADDRESS, SETUP_LISTEN_PORT, 22, 80)
    add("platform_link_local", "169.254.169.254", 80, 443)
    add("platform_gateway", "169.254.0.1", 53, 80, 443, 22)
    for host in (
        "10.0.0.1",
        "192.168.0.1",
        "172.16.0.1",
        "100.64.0.1",
        "10.213.77.3",
        "10.213.77.5",
        "10.213.77.6",
    ):
        add("private", host, 22, 80, 443)
    return targets


def section_agent_network(lab: Rig) -> None:
    checks = lab.checks
    neighbour = start_neighbour(lab)
    control = own_addresses(lab, socket.gethostname()).get("bridge", "")
    host_now = lab.host_json(HOST_VIEW)
    lab.host = host_now
    # The agent's own Docker puts a bridge on 172.17.0.1/16, the VM's docker0 address: that address
    # is the agent's own, so a connect to it never leaves the container. It is left out here and
    # attacked below, after root has taken the inner bridge's address away.
    local = set(lab.in_agent({"sections": ["ids"]})["ids"]["addresses"])
    own = set(own_addresses(lab, AGENT_CONTAINER_NAME).values()) | local
    vm = vm_targets(host_now, own)
    door_target = {"l": "door", "h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT}
    others = [x for x in fixed_targets(lab, neighbour, control) if x["h"] not in local]
    internet = [{"l": f"internet:{h}:{p}", "h": h, "p": p} for h, p in INTERNET]
    got = lab.in_agent(
        {
            "sections": ["net", "scan", "dns", "resolve", "ping", "listen"],
            "targets": [door_target, *vm, *others, *internet],
            "scan": {"host": MODEL_DOOR_ADDRESS, "ports": [[1, 1024], [10100, 10200]]},
            "dns": {
                "servers": [
                    "1.1.1.1",
                    "8.8.8.8",
                    MODEL_NETWORK_GATEWAY,
                    "172.17.0.1",
                    "127.0.0.11",
                ],
                "name": "example.com",
            },
            "resolve": ["example.com", "github.com", "registry-1.docker.io"],
            "ping": [a for a in ("1.1.1.1", "172.17.0.1", MODEL_NETWORK_GATEWAY) if a not in local],
            "listen": {"ports": [LISTEN_PORT], "seconds": 600},
        }
    )
    net = got["net"]
    the_door = net["door"]
    scan = got["scan"]
    checks.say(
        "network",
        "agent_reaches_the_door_and_only_the_doors_port",
        f"{MODEL_DOOR_ADDRESS}:{DOOR_PORT} connects (control); of ports 1-1024 and 10100-10200 of the door's address only that one does",
        the_door == "connected" and scan["connected"] == [DOOR_PORT],
        door=the_door,
        connected_ports=scan["connected"],
        scanned=scan["scanned"],
    )
    vm_reached = {k: v for k, v in net.items() if k.startswith("vm:") and reached(v)}
    checks.say(
        "network",
        "agent_cannot_reach_the_vms_own_services",
        f"no address of the VM (every bridge, eth0) answers on any of its listening ports or the usual ones, control port {CONTROL_PORT} included: {len(vm)} attempts, all silent",
        not vm_reached and len(vm) > 0,
        attempts=len(vm),
        reached=vm_reached,
        listeners=[x["port"] for x in lab.host["listeners"]],
    )
    other_groups = {
        "model_gateway": "the model network's gateway",
        "docker0_gateway": "the default bridge's gateway",
        "control": "Control's address on the default bridge",
        "neighbour_on_default_bridge": "a container on the default bridge that listens",
        "door_on_default_bridge": "the door's other address (default bridge)",
        "setup_gateway": "the setup bridge's gateway",
        "setup_address": "the setup container's address",
        "platform_link_local": "169.254.169.254 (metadata address)",
        "platform_gateway": "169.254.0.1 (the platform)",
        "private": "private neighbours (10/8, 192.168/16, 172.16/12, 100.64/10, unused model-net addresses)",
    }
    for key, what in other_groups.items():
        if key == "docker0_gateway":
            continue
        hits = {k: v for k, v in net.items() if k.startswith(key + ":") and reached(v)}
        total = sum(1 for k in net if k.startswith(key + ":"))
        # the model gateway's door port is the door's own address range, not the door
        checks.say(
            "network",
            f"agent_cannot_reach_{key}",
            f"{what}: every attempt is silent (a reset would mean a host answered)",
            not hits and total > 0,
            attempts=total,
            reached=hits,
        )
    through = {k: v for k, v in net.items() if k.startswith("internet:")}
    checks.say(
        "network",
        "agent_cannot_reach_the_internet",
        "1.1.1.1:443, 8.8.8.8:443, 9.9.9.9:80, 1.1.1.1:53 are not reachable",
        len(through) == len(INTERNET) and not any(reached(v) for v in through.values()),
        **through,
    )
    dns = got["dns"]
    resolve = got["resolve"]
    ping = got["ping"]
    checks.say(
        "network",
        "agent_has_no_outside_dns_and_no_ping",
        "UDP queries to 1.1.1.1, 8.8.8.8, the gateways get no answer; the embedded resolver does not resolve outside names; ping gets no reply",
        not any(
            dns[s]["reply"]
            for s in ("1.1.1.1", "8.8.8.8", MODEL_NETWORK_GATEWAY, "172.17.0.1")
            if s not in local
        )
        and not (dns["127.0.0.11"]["reply"] and dns["127.0.0.11"].get("answers", 0) > 0)
        and all(
            isinstance(v, str) and v.startswith("error")
            for v in resolve.values()
            if not isinstance(v, list)
        )
        and not any_resolved(resolve)
        and all(code != 0 for code in ping.values()),
        dns=dns,
        resolve=resolve,
        ping=ping,
    )
    # a workload that changes its own routing table: still no way out.
    probes = [
        ("internet", "1.1.1.1", 443),
        ("vm_control_link_local", "169.254.0.2", CONTROL_PORT),
        ("vm_control_model_gateway", MODEL_NETWORK_GATEWAY, CONTROL_PORT),
        ("control", control, 8080),
        ("neighbour", neighbour, NEIGHBOUR_PORT),
        ("door", MODEL_DOOR_ADDRESS, DOOR_PORT),
    ]
    routed = lab.in_agent(
        {
            "sections": ["net"],
            "routes": [
                f"default via {MODEL_NETWORK_GATEWAY}",
                "172.17.0.0/16 via 10.213.77.1",
                "1.1.1.1/32 via 10.213.77.1",
            ],
            "targets": [{"l": label, "h": host, "p": port} for label, host, port in probes],
        }
    )["net"]
    checks.say(
        "network",
        "agent_with_its_own_routes_still_reaches_only_the_door",
        "after 'ip route replace default via <model gateway>' (and host routes) the door connects (control), nothing else answers",
        routed.get("door") == "connected"
        and not any(reached(v) for k, v in routed.items() if k not in ("door", "_routes")),
        **{k: v for k, v in routed.items() if k != "_routes"},
        routes=routed.get("_routes"),
    )
    # Root takes the inner bridge (the VM's docker0 address, 172.17.0.1) away from itself so that the
    # VM's gateway address is no longer shadowed, then tries the VM's default bridge for real.
    unshadowed = lab.in_agent(
        {
            "sections": ["net"],
            "flush": ["docker0"],
            "restore": [{"dev": "docker0", "addr": "172.17.0.1/16"}],
            "routes": [f"default via {MODEL_NETWORK_GATEWAY}"],
            "targets": [
                {"l": f"docker0_gateway:172.17.0.1:{p}", "h": "172.17.0.1", "p": p}
                for p in (22, 53, 80, 2375, 2376, CONTROL_PORT)
            ]
            + [
                {"l": f"control:{control}:{p}", "h": control, "p": p}
                for p in (22, 8080, CONTROL_PORT)
            ]
            + [
                {
                    "l": f"neighbour:{neighbour}:{NEIGHBOUR_PORT}",
                    "h": neighbour,
                    "p": NEIGHBOUR_PORT,
                },
                {"l": "door", "h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT},
            ],
        }
    )["net"]
    checks.say(
        "network",
        "agent_unshadowing_the_vms_docker0_address_still_reaches_nothing_there",
        "with the inner docker0 flushed and a default route via the model gateway: 172.17.0.1 (every port, 23456 included), Control and the neighbour on the VM's default bridge stay silent; the door still connects",
        unshadowed.get("door") == "connected"
        and not any(reached(v) for k, v in unshadowed.items() if k not in ("door", "_routes")),
        **{k: v for k, v in unshadowed.items() if k != "_routes"},
    )
    lab.neighbour = neighbour
    lab.control_address = control


def section_ipv6(lab: Rig) -> None:
    checks = lab.checks
    host = lab.host
    on_bridges = [row for row in host["inet6"] if row["interface"] not in ("lo", "eth0")]
    checks.say(
        "ipv6",
        "vm_makes_no_ipv6_address_on_any_container_bridge_or_veth",
        "default.disable_ipv6 = 1 and no inet6 address on docker0, a br-* bridge or a veth; the VM does not forward IPv6",
        host["disable_ipv6"]["default"] == "1" and not on_bridges and host["forwarding6"] == "0",
        disable_ipv6=host["disable_ipv6"],
        bridge_and_veth_inet6=on_bridges,
        interfaces=host["interfaces"],
        forwarding6=host["forwarding6"],
    )
    got = lab.in_agent(
        {
            "sections": ["ipv6"],
            "ipv6": {"ports": [CONTROL_PORT, 22, 80, 8080, 53], "public": list(PUBLIC_V6)},
        }
    )["ipv6"]
    before = got["addresses_before"]
    eth0_before = [a for a in before if a.startswith("eth0=")]
    checks.say(
        "ipv6",
        "agent_starts_with_no_ipv6_address_on_its_interface",
        "no inet6 address on eth0 (not even link-local) and disable_ipv6 is 1 on eth0 until root changes it",
        not eth0_before and got["disable_ipv6_before"].get("eth0") == "1",
        before=before,
        disable_ipv6=got["disable_ipv6_before"],
    )
    own_after = got["addresses_after"]
    switched_on = any(a.startswith("eth0=fe80") for a in own_after)
    connects = got["neighbour_connects"]
    checks.say(
        "ipv6",
        "agent_switching_ipv6_on_finds_no_neighbour_to_connect_to",
        "with IPv6 on (control: eth0 gets a link-local address), ff02::1 finds no host but itself, and no connect to a neighbour's port 23456, 22, 80, 8080 or 53 succeeds",
        switched_on and not any(reached(v) for v in connects.values()),
        eth0_after=[a for a in own_after if a.startswith("eth0=")],
        neighbours=got["neighbours"],
        connects=connects,
    )
    checks.say(
        "ipv6",
        "agent_has_no_ipv6_route_to_the_internet",
        "connects to 2606:4700:4700::1111:443 and 2001:4860:4860::8888:443 are not answered",
        not any(reached(v) for v in got["public"].values()),
        **got["public"],
    )


def section_sockets_and_volume(lab: Rig) -> None:
    checks = lab.checks
    got = lab.in_agent(
        {
            "sections": ["sockets", "volume"],
            "volume": {
                "root": "/work/repo",
                "beyond": [
                    "/work/reserve",
                    "/work/mirror.git",
                    "/work/reserve/mirror.git",
                    "/work/repo/../reserve",
                    "/var/lib/code-reviewer-work",
                    "/proc/1/root/var/lib/code-reviewer-work",
                    "/host",
                ],
            },
        }
    )
    sockets = got["sockets"]["sockets"]
    answering = [s for s in sockets if s.get("daemon_id")]
    vm_daemon = [s for s in answering if s["daemon_id"] == lab.vm_daemon_id]
    checks.say(
        "socket",
        "no_socket_in_the_agent_belongs_to_the_vms_docker_daemon",
        "every unix socket the agent can see that answers as a Docker daemon is its own inner daemon (a different id from the VM's)",
        not vm_daemon and len(answering) >= 1,
        own_inner_daemons=[{"path": s["path"], "name": s.get("name")} for s in answering],
        visible=[s["path"] for s in sockets],
        vm_daemon_sockets=vm_daemon,
    )
    beyond = got["volume"]["reachable_beyond_the_volume"]
    checks.say(
        "volume",
        "agent_cannot_see_the_mirror_the_reserve_or_the_volumes_parent",
        "/work holds only repo; none of the reserve disk, the mirror, /var/lib/code-reviewer-work, /var/lib/docker/volumes exists",
        got["volume"]["listing_work"] == ["repo"] and not any(beyond.values()),
        listing_work=got["volume"]["listing_work"],
        existing=[p for p, e in beyond.items() if e],
    )
    plant = got["volume"]["plant"]
    seen: Json = {}
    base = Path("/work/repo/planted")
    for name in (
        "to-root",
        "to-dotdot",
        "to-work",
        "suid-sh",
        "fifo",
        "other-owner",
        "hard2",
        "dev",
    ):
        try:
            info = (base / name).lstat()
            seen[name] = {"uid": info.st_uid, "mode": oct(info.st_mode)}
        except OSError as error:
            seen[name] = f"error:{error.errno}"
    checks.say(
        "volume",
        "what_the_agent_leaves_in_the_volume_is_the_vms_root_and_inert_for_control",
        "the agent makes symlinks, a setuid file, a FIFO (Control sees them as uid 0, idmapped) and a file with a uid of its choosing; a device node and a hard link out of the volume fail",
        plant["symlink_to_root"] == "made"
        and plant["device_node"].startswith("error")
        and plant["hardlink_out"].startswith("error")
        and owned_as_planted(seen),
        plant=plant,
        seen_by_control=seen,
    )
    mountinfo = Path("/proc/self/mountinfo").read_text()
    work_options = ""
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) > 5 and fields[4] == "/work":
            work_options = fields[5]
    checks.say(
        "volume",
        "control_mounts_the_work_volume_nosuid_nodev",
        "the mount options of /work in Control include nosuid and nodev, and not noexec (the reserve disk is below it)",
        "nosuid" in work_options.split(",") and "nodev" in work_options.split(","),
        options=work_options,
    )
    mine = lab.api.inspect_container(socket.gethostname())
    networks = sorted(mine["NetworkSettings"]["Networks"])
    door_networks = sorted(
        lab.api.inspect_container(DOOR_CONTAINER_NAME)["NetworkSettings"]["Networks"]
    )
    checks.say(
        "network",
        "control_is_not_on_the_model_network_and_the_door_is_on_both",
        "Control: default bridge only; door: default bridge (its way to the provider) and the model network; agent: model network only",
        networks == ["bridge"] and door_networks == sorted(["bridge", MODEL_NETWORK_NAME]),
        control=networks,
        door=door_networks,
    )


def section_inner_docker(lab: Rig) -> None:
    """The agent's own Docker is the agent's; the containers it starts, even privileged, host
    network, with the agent's root file system mounted, are still inside the Sysbox boundary."""
    checks = lab.checks
    build = (
        "set -e; cd /tmp; "
        "libs=$(ldd /usr/local/bin/python3 | awk '/=>/ {print $3} /ld-linux/ {print $1}' | sort -u); "
        "tar -h -C / -cf - --exclude='*/test' --exclude='*/idlelib' --exclude='*/tkinter' --exclude='*/site-packages' "
        "--exclude='*/__pycache__' usr/local/bin/python3 usr/local/bin/python3.13 usr/local/lib/python3.13 "
        "$(echo $libs | sed 's#^/##; s# /# #g') "
        "| docker import - boundary-inner >/dev/null; docker image ls boundary-inner --format '{{.Repository}}'"
    )
    code, out = lab.agent_run(["/bin/sh", "-c", build], timeout=180.0)
    if code != 0 or "boundary-inner" not in out:
        checks.say(
            "inner",
            "inner_docker_image_could_be_made",
            "an image from the agent's own files",
            False,
            code=code,
            out=out[-300:],
        )
        return
    config: Json = {
        "sections": ["net", "ids", "sockets", "proc", "cgroup", "devices"],
        # The first packet through the agent's NAT waits for ARP: more than two seconds is not a drop.
        "timeout": 6.0,
        "until": {"h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT, "seconds": 20},
        # (Control and the neighbour on the VM's default bridge are 172.17.0.x, an address range the
        # inner bridge owns itself: they are attacked from the agent, with its bridge flushed.)
        "targets": [
            {"l": "internet", "h": "1.1.1.1", "p": 443},
            {"l": "vm_control_link_local", "h": "169.254.0.2", "p": CONTROL_PORT},
            {"l": "model_gateway", "h": MODEL_NETWORK_GATEWAY, "p": CONTROL_PORT},
            {"l": "door", "h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT},
        ],
        "devices": ["mem", "kmem", "vda", "vdb", "sda"],
        "sysctls": ["/proc/sys/kernel/core_pattern", "/proc/sys/kernel/modprobe"],
        "sentinel": "core.boundary.check",
    }
    results: dict[str, Json] = {}
    for label, flags in (
        ("default_bridge", []),
        (
            "privileged_host_network_and_pid",
            ["--privileged", "--network", "host", "--pid", "host", "-v", "/:/host"],
        ),
    ):
        argv = [
            "/bin/sh", "-c",
            "docker run -i --rm " + " ".join(flags) + " boundary-inner /usr/local/bin/python3 -I - \"$1\" 2>&1",
            "sh", json.dumps(config),
        ]  # fmt: skip
        done = run_exec(
            lab.api, AGENT_CONTAINER_NAME, argv, stdin=PROBE_TEXT.encode(), timeout=170.0
        )
        results[label] = last_json(done.stdout)
    for label, got in results.items():
        if "error" in got:
            checks.say(
                "inner",
                f"inner_{label}_ran",
                "the probe ran in a container of the agent's Docker",
                False,
                **got,
            )
            continue
        net = got["net"]
        outside = {k: v for k, v in net.items() if k != "door" and reached(v)}
        checks.say(
            "inner",
            f"inner_container_{label}_reaches_only_the_door",
            "from a container of the agent's own Docker ("
            + (
                "default bridge"
                if label == "default_bridge"
                else "--privileged --network host --pid host -v /:/host"
            )
            + "): the door connects, nothing else answers",
            net.get("door") == "connected" and not outside,
            door=net.get("door"),
            reached=outside,
        )
        mapping = got["ids"]["uid_map"].split()
        vm_ids = [s for s in got["sockets"]["sockets"] if s.get("daemon_id") == lab.vm_daemon_id]
        writes = got["proc"]["sysctl_writes"]
        checks.say(
            "inner",
            f"inner_container_{label}_is_still_inside_the_user_namespace",
            "uid_map is the agent's mapping to an unprivileged host uid, no VM Docker socket, core_pattern/modprobe writes fail, no host devices",
            len(mapping) == 3
            and int(mapping[1]) >= 100000
            and not vm_ids
            and all(v["result"] != "written" for v in writes.values())
            and not any(got["devices"]["present"].values())
            and "4294967295" not in got["ids"]["uid_map"],
            uid_map=got["ids"]["uid_map"],
            sysctl_writes={k.rsplit("/", 1)[1]: v["result"] for k, v in writes.items()},
            devices={k: v for k, v in got["devices"]["present"].items() if v},
        )


def section_door(lab: Rig) -> None:
    checks = lab.checks
    api, door = lab.api, lab.door
    assert door is not None
    needles = [KEY]
    everything = json.dumps(
        [
            api.inspect_container(n)
            for n in (
                AGENT_CONTAINER_NAME,
                DOOR_CONTAINER_NAME,
                READER_CONTAINER_NAME,
                READER_WRITER_CONTAINER_NAME,
            )
        ],
        default=str,
    ) + json.dumps(
        [
            api.request("GET", f"/containers/{n}/top?ps_args=aux")
            for n in (AGENT_CONTAINER_NAME, DOOR_CONTAINER_NAME)
        ]
    )
    looked = lab.in_agent(
        {
            "sections": ["look"],
            "needles_hex": [n.encode().hex() for n in needles],
            "roots": [
                "/tmp",
                "/run",
                "/work",
                "/home",
                "/root",
                "/etc",
                "/opt",
                "/srv",
                "/mnt",
                "/var/tmp",
                "/var/log",
            ],
        }
    )["look"]
    checks.say(
        "door",
        "agent_cannot_find_the_key",
        "the made-up key is in no environment, command line or file the agent can read, not in its own environment, and in no `docker inspect`/`top` of the containers",
        looked["found"] == [] and not looked["in_own_env"] and KEY not in everything,
        processes_read=looked["processes_read"],
        files_read=looked["files_read"],
        found=looked["found"],
    )
    top = api.request("GET", f"/containers/{DOOR_CONTAINER_NAME}/top?ps_args=-eo%20pid,uid,args")
    processes = [row[-1] for row in top.get("Processes", [])]
    tcp = run_exec(api, DOOR_CONTAINER_NAME, ["/bin/cat", "/proc/net/tcp"], timeout=15.0).stdout
    sockets = [
        (
            socket.inet_ntoa(bytes.fromhex(line.split()[1].split(":")[0])[::-1]),
            int(line.split()[1].split(":")[1], 16),
        )
        for line in tcp.splitlines()[1:]
        if line.split()[3] == "0A"
    ]
    shell = run_exec(
        api, DOOR_CONTAINER_NAME, ["/bin/sh", "-c", "command -v git sh bash"], timeout=15.0
    )
    checks.say(
        "door",
        "door_runs_only_the_door_and_listens_on_one_port",
        "the door's process list is its Python process (no shell, no git, no sshd); one listening port",
        len(processes) >= 1
        and all("code_reviewer_runner.implementer.door" in p or "tini" in p for p in processes)
        and [port for address, port in sockets if not address.startswith("127.")] == [DOOR_PORT],
        processes=[p[:80] for p in processes],
        listening=sockets,
        binaries_in_the_image=shell.stdout.split(),
    )
    cap = lab.capability
    baseline = (
        "POST /v1/messages HTTP/1.1\r\nHost: {host}\r\nx-api-key: {key}\r\nanthropic-version: 2023-06-01\r\n"
        "content-type: application/json\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n{body}"
    )

    def request(
        model: str = "claude-sonnet-5-5",
        *,
        host: str = "x",
        key: str = cap,
        target: str | None = None,
    ) -> str:
        body = json.dumps(
            {
                "model": model,
                "max_tokens": 10,
                "stream": True,
                "messages": [{"role": "user", "content": "hi"}],
            }
        )
        text = baseline.format(host=host, key=key, length=len(body), body=body)
        return text if target is None else text.replace("POST /v1/messages", target, 1)

    refused = {
        "wrong_capability": request(key="not-the-capability-" + "x" * 30),
        "other_model": request("claude-opus-5-5"),
        "absolute_url": request(target="POST https://evil.example/v1/messages"),
        "path_traversal": request(target="POST /v1/messages/../models"),
        "other_path": request(target="POST /v1/organizations"),
        "get_method": request(target="GET /v1/messages"),
        "connect_method": "CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n",
        "metadata_via_door": "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
    }
    send = [{"l": k, "h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT, "raw": v} for k, v in refused.items()]
    answers = lab.in_agent({"sections": ["http"], "http": send})["http"]
    time.sleep(0.5)
    status = door.state.status
    # A refusal is an answer of the door: a 4xx/5xx, or a connection the door took and closed on the
    # request. A connect that fails ("error" before `connected`) is a door that is not there, and
    # counts for nothing.
    ok_refusals = {
        k: v["status"]
        for k, v in answers.items()
        if v.get("connected")
        and (
            v["status"] in ("none", "error") or (v["status"].isdigit() and int(v["status"]) >= 400)
        )
    }
    door_up = whole_and_running(lab)
    checks.say(
        "door",
        "door_refuses_what_is_not_exactly_the_pinned_call",
        "a wrong capability, another model, an absolute URL, '..', another path, another method, CONNECT and a request for the metadata address are all refused (4xx/5xx or closed after the connection was made) by a door that is up",
        len(answers) == len(refused)
        and len(ok_refusals) == len(refused)
        and all(door_up.values())
        and (status is None or (not status.model_used and status.upstream_error is None)),
        door_up=door_up,
        statuses={k: v["status"] for k, v in answers.items()},
        connected={k: bool(v.get("connected")) for k, v in answers.items()},
        model_used=None if status is None else status.model_used,
        upstream_error=None if status is None else status.upstream_error,
    )
    if "--offline" not in sys.argv[1:]:
        evil_host = lab.in_agent(
            {
                "sections": ["http"],
                "http": [
                    {
                        "l": "pinned",
                        "h": MODEL_DOOR_ADDRESS,
                        "p": DOOR_PORT,
                        "raw": request(host="evil.example"),
                    }
                ],
            }
        )["http"]["pinned"]
        time.sleep(1.0)
        status = door.state.status
        checks.say(
            "door",
            "a_request_with_another_host_header_goes_to_the_pinned_provider_or_nowhere",
            "the Host header is not forwarded: the call that is admitted is answered by the pinned provider (a 401 for the made-up key, at no cost), never by the host the agent named",
            evil_host["status"] in ("401", "403") and "evil" not in evil_host["head"].lower(),
            status=evil_host["status"],
            head=evil_host["head"][:120],
            upstream_error=None if status is None else status.upstream_error,
        )
    after = lab.in_agent(
        {"sections": ["net"], "targets": [{"l": "door", "h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT}]}
    )["net"]
    checks.say(
        "door",
        "door_is_still_up_after_the_hostile_requests",
        "the door still accepts a connection",
        after["door"] == "connected",
        door=after["door"],
    )


SETUP_SCRIPT = """cat > /tmp/probe.py <<'PROBE_END'
{probe}
PROBE_END
cat > /tmp/probe.json <<'CONFIG_END'
{config}
CONFIG_END
python3 -I /tmp/probe.py /tmp/probe.json
for _ in $(seq 1 120); do [ -e /tmp/go ] && break; sleep 1; done
exit 7
"""


def section_setup_container(lab: Rig) -> None:
    """The Setup container, root with the full internet and no secret: it may reach the internet and
    nothing of ours."""
    checks = lab.checks
    host_now = lab.host
    setup_vm = [
        {"l": f"vm:{a}:{p}", "h": a, "p": p}
        for a in ("169.254.0.2", "172.17.0.1", "10.213.78.1")
        for p in sorted(
            {x["port"] for x in host_now["listeners"]} | {22, 53, 80, 443, 2375, CONTROL_PORT}
        )
    ]
    others = [
        {
            "l": f"agent:{MODEL_AGENT_ADDRESS}:{LISTEN_PORT}",
            "h": MODEL_AGENT_ADDRESS,
            "p": LISTEN_PORT,
        },
        {"l": f"door:{MODEL_DOOR_ADDRESS}:{DOOR_PORT}", "h": MODEL_DOOR_ADDRESS, "p": DOOR_PORT},
        {
            "l": f"model_gateway:{MODEL_NETWORK_GATEWAY}:{CONTROL_PORT}",
            "h": MODEL_NETWORK_GATEWAY,
            "p": CONTROL_PORT,
        },
        {"l": f"control:{lab.control_address}:8080", "h": lab.control_address, "p": 8080},
        {
            "l": f"control_port:{lab.control_address}:{CONTROL_PORT}",
            "h": lab.control_address,
            "p": CONTROL_PORT,
        },
        {
            "l": f"neighbour:{lab.neighbour}:{NEIGHBOUR_PORT}",
            "h": lab.neighbour,
            "p": NEIGHBOUR_PORT,
        },
        {"l": "metadata:169.254.169.254:80", "h": "169.254.169.254", "p": 80},
        {"l": "platform:169.254.0.1:80", "h": "169.254.0.1", "p": 80},
        {"l": "private:10.0.0.1:80", "h": "10.0.0.1", "p": 80},
        {"l": "private:192.168.0.1:80", "h": "192.168.0.1", "p": 80},
    ]
    outside = [
        {"l": f"internet:{h}:{p}", "h": h, "p": p}
        for h, p in (
            ("1.1.1.1", 443),
            ("8.8.8.8", 443),
            ("1.1.1.1", 80),
            ("1.1.1.1", 53),
            ("1.1.1.1", 8443),
        )
    ]
    config = {
        "sections": [
            "listen",
            "net",
            "dns",
            "resolve",
            "ping",
            "ipv6",
            "sockets",
            "ids",
            "devices",
            "cgroup",
            "proc",
            "look",
        ],
        # The Setup's own Docker has a bridge on 172.17.0.1 too, the VM's docker0 address: root takes
        # it away first, so that the connects to the VM's gateway really leave the container.
        "flush": ["docker0"],
        "listen": {"ports": [SETUP_LISTEN_PORT], "seconds": 150},
        "targets": [*outside, *setup_vm, *others],
        "dns": {"servers": ["1.1.1.1", "8.8.8.8"], "name": "example.com"},
        "resolve": ["example.com", "registry-1.docker.io"],
        "ping": ["1.1.1.1"],
        "ipv6": {"ports": [CONTROL_PORT, 22, 80, 8080, 53], "public": list(PUBLIC_V6)},
        "devices": ["mem", "kmem", "vda", "vdb", "sda", "null", "zero"],
        "needles_hex": [KEY.encode().hex()],
        "roots": ["/tmp", "/run", "/work", "/home", "/root", "/etc", "/opt"],
        "sentinel": "core.boundary.check",
        "sysctls": ["/proc/sys/kernel/core_pattern", "/proc/sys/kernel/modprobe"],
    }
    script = SETUP_SCRIPT.replace("{probe}", PROBE_TEXT).replace("{config}", json.dumps(config))
    box: dict[str, Any] = {}

    def run() -> None:
        box["run"] = SetupContainer(MEMORY_MB).run(script, script_seconds=170.0)

    # A daemon: a Ctrl-C in the middle of this section must not wait for the Setup run (`main` removes the
    # container, which ends the run's calls).
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    listening = False
    for _ in range(300):
        time.sleep(0.5)
        if not thread.is_alive():
            break
        done = run_exec(
            lab.api,
            SETUP_CONTAINER_NAME,
            [
                PYTHON,
                "-I",
                "-c",
                f"import socket;socket.create_connection(('127.0.0.1',{SETUP_LISTEN_PORT}),1)",
            ],
            timeout=10.0,
        )
        if done.returncode == 0 and not done.unanswered:
            listening = True
            break
    back: Json = {}
    if listening:
        back = lab.in_agent(
            {
                "sections": ["net"],
                "targets": [
                    {"l": "setup_listener", "h": SETUP_ADDRESS, "p": SETUP_LISTEN_PORT},
                    {
                        "l": "setup_gateway_listener",
                        "h": SETUP_NETWORK_GATEWAY,
                        "p": SETUP_LISTEN_PORT,
                    },
                    {"l": "setup_gateway_control", "h": SETUP_NETWORK_GATEWAY, "p": CONTROL_PORT},
                ],
            }
        ).get("net", {})
        with contextlib.suppress(Exception):
            run_exec(lab.api, SETUP_CONTAINER_NAME, ["/usr/bin/touch", "/tmp/go"], timeout=10.0)
    thread.join(240.0)
    run_result = box.get("run")
    if run_result is None:
        checks.say(
            "setup",
            "setup_container_ran",
            "the probe ran in the Setup container (and its run ended inside 240 s)",
            False,
            listening=listening,
            still_running=thread.is_alive(),
        )
        return
    got = last_json(run_result.output.decode("utf-8", "replace"))
    if "error" in got:
        checks.say(
            "setup",
            "setup_container_ran",
            "the probe ran in the Setup container",
            False,
            outcome=run_result.outcome,
            **got,
        )
        return
    net = got["net"]
    checks.say(
        "setup",
        "setup_container_has_the_internet",
        "control: 1.1.1.1:443, 8.8.8.8:443, 1.1.1.1:80, 1.1.1.1:53 and 1.1.1.1:8443 connect; names resolve; ping answers",
        all(reached(v) for k, v in net.items() if k.startswith("internet:"))
        and any_resolved(got["resolve"])
        and got["ping"].get("1.1.1.1") == 0,
        **{k: v for k, v in net.items() if k.startswith("internet:")},
        resolve=got["resolve"],
    )
    vm_hits = {k: v for k, v in net.items() if k.startswith("vm:") and reached(v)}
    vm_attempts = sum(1 for k in net if k.startswith("vm:"))
    checks.say(
        "setup",
        "setup_container_cannot_reach_the_vms_services_or_control_port",
        f"no address of the VM (eth0, docker0, the setup bridge's own gateway) answers on any port, {CONTROL_PORT} included: all {len(setup_vm)} attempts were made",
        not vm_hits and len(setup_vm) > 0 and vm_attempts >= len(setup_vm),
        attempts=vm_attempts,
        reached=vm_hits,
    )
    other_hits = {
        k: v for k, v in net.items() if not k.startswith(("vm:", "internet:")) and reached(v)
    }
    other_attempts = sum(1 for k in net if not k.startswith(("vm:", "internet:")))
    checks.say(
        "setup",
        "setup_container_cannot_reach_the_agent_the_door_control_or_neighbours",
        f"the agent's listener, the door, the model gateway, Control (any port), a container on the default bridge, the metadata address, the platform and private neighbours are all silent: all {len(others)} attempts were made",
        not other_hits and len(others) > 0 and other_attempts >= len(others),
        attempts=other_attempts,
        reached=other_hits,
    )
    checks.say(
        "setup",
        "agent_cannot_reach_the_setup_container_or_its_bridge",
        "while the Setup container listens on its address, the agent gets no answer from it, its gateway or the control port through that gateway",
        listening and bool(back) and not any(reached(v) for v in back.values()),
        listening=listening,
        **back,
    )
    connects = got["ipv6"]["neighbour_connects"]
    checks.say(
        "setup",
        "setup_container_switching_ipv6_on_finds_no_vm",
        "with IPv6 on (control: eth0 gets a link-local address) no neighbour's control port answers; the public IPv6 addresses are not reached",
        any(a.startswith("eth0=fe80") for a in got["ipv6"]["addresses_after"])
        and not any(reached(v) for v in connects.values())
        and not any(reached(v) for v in got["ipv6"]["public"].values()),
        eth0_after=[a for a in got["ipv6"]["addresses_after"] if a.startswith("eth0=")],
        neighbours=got["ipv6"]["neighbours"],
        connects=connects,
        public=got["ipv6"]["public"],
    )
    sockets = got["sockets"]["sockets"]
    vm_daemon = [s for s in sockets if s.get("daemon_id") == lab.vm_daemon_id]
    mapping = got["ids"]["uid_map"].split()
    checks.say(
        "setup",
        "setup_container_is_sealed_like_the_agent",
        "no VM Docker socket, root maps to an unprivileged host uid, no host devices, no key anywhere, core_pattern/modprobe writes fail",
        not vm_daemon
        and len(mapping) == 3
        and int(mapping[1]) >= 100000
        and not any(got["devices"]["present"][n] for n in ("mem", "kmem", "vda", "vdb", "sda"))
        and got["look"]["found"] == []
        and all(v["result"] != "written" for v in got["proc"]["sysctl_writes"].values()),
        uid_map=got["ids"]["uid_map"],
        sockets=[s["path"] for s in sockets],
        found=got["look"]["found"],
    )


HOG = """
import sys, time
chunks = []
step = 64 * 1024 * 1024
while True:
    chunks.append(bytearray(b"\\xa5") * step)
    print("ALLOCATED_MIB", len(chunks) * 64, flush=True)
"""
FLOOD = """
import sys, threading, time
threading.stack_size(64 * 1024)
started = 0
reason = ""
def wait() -> None:
    time.sleep(40)
try:
    while started < 20000:
        threading.Thread(target=wait, daemon=True).start()
        started += 1
except RuntimeError as error:
    reason = str(error)
print("STARTED", started, reason, flush=True)
time.sleep(int(sys.argv[1]))
"""
BURN = """
import os, sys, time
end = time.time() + float(sys.argv[1])
pids = []
for _ in range(int(sys.argv[2])):
    pid = os.fork()
    if pid == 0:
        while time.time() < end:
            sum(range(10000))
        os._exit(0)
    pids.append(pid)
for pid in pids:
    os.waitpid(pid, 0)
print("BURNED", len(pids), flush=True)
"""
FDS = """
import ctypes, errno, json, mmap, os, resource, signal, socket, struct, sys, time
libc = ctypes.CDLL(None, use_errno=True)
hold, procs, cap = float(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
kinds = sys.argv[4].split(",")
def call(fd):
    if fd < 0:
        raise OSError(ctypes.get_errno(), "call")
    return (fd,)
def pair():
    first, second = socket.socketpair()
    return (first.detach(), second.detach())
MAKERS = {
    "null": lambda: (os.open("/dev/null", os.O_RDONLY),),
    "timerfd": lambda: call(libc.timerfd_create(1, 0)),
    "epoll": lambda: call(libc.epoll_create1(0)),
    "eventfd": lambda: call(libc.eventfd(0, 0)),
    "socketpair": pair,
}
shared = mmap.mmap(-1, 16 * procs)
children = []
for index in range(procs):
    pid = os.fork()
    if pid == 0:
        opened = 0
        reason = -1
        try:
            hard = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
            resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
            makers = [MAKERS[kind] for kind in kinds]
            cycles = 0
            while opened < cap:
                for make in makers:
                    opened += len(make())
                cycles += 1
                if cycles % 256 == 0:
                    struct.pack_into("qq", shared, 16 * index, opened, -1)
        except OSError as error:
            reason = error.errno or 0
        struct.pack_into("qq", shared, 16 * index, opened, reason)
        time.sleep(hold)
        os._exit(0)
    children.append(pid)
report = []
for index, pid in enumerate(children):
    _, status = os.waitpid(pid, 0)
    opened, reason = struct.unpack_from("qq", shared, 16 * index)
    report.append([opened, reason, os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0])
print("FLOOD", json.dumps({"children": report}), flush=True)
"""
FILL = """
import os, sys
written = 0
chunk = b"\\0" * (64 * 1024 * 1024)
with open("/fill.bin", "wb", buffering=0) as handle:
    try:
        while True:
            written += handle.write(chunk)
    except OSError as error:
        print("FULL", written // (1024 * 1024), "MiB", error.errno, flush=True)
"""


class Sampler:
    """Control's own health while the agent misbehaves: every half second one call to the daemon,
    one command in a reader, the door's state and the VM's free memory."""

    def __init__(self) -> None:
        self.api = DockerApi()
        self.latencies: list[float] = []
        self.failures = 0
        self.min_available_mib = 10**9
        # What is really left: free memory and the page cache of files. `MemAvailable` counts the structures
        # of open files as reclaimable, and an open file is not (it said 2.2 GB when the VM ran out).
        self.min_headroom_mib = 10**9
        self.most_files_open = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> "Sampler":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(10.0)

    def _run(self) -> None:
        while not self._stop.is_set():
            began = time.monotonic()
            try:
                done = run_exec(self.api, READER_CONTAINER_NAME, ["/bin/true"], timeout=15.0)
                if done.returncode != 0 or done.unanswered or not self.api.ping():
                    self.failures += 1
            except Exception:
                self.failures += 1
            self.latencies.append(time.monotonic() - began)
            with contextlib.suppress(OSError, ValueError):
                self.most_files_open = max(
                    self.most_files_open, int(Path("/proc/sys/fs/file-nr").read_text().split()[0])
                )
            left = read_memory()
            if left is not None:
                self.min_headroom_mib = min(self.min_headroom_mib, left[0] // MIB)
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable"):
                    self.min_available_mib = min(
                        self.min_available_mib, int(line.split()[1]) // 1024
                    )
            self._stop.wait(0.5)

    @property
    def worst(self) -> float:
        return round(max(self.latencies or [0.0]), 2)


def whole_and_running(lab: Rig) -> dict[str, bool]:
    """The things Control stands on are all still up."""
    running: dict[str, bool] = {}
    for name in (
        DOOR_CONTAINER_NAME,
        READER_CONTAINER_NAME,
        READER_WRITER_CONTAINER_NAME,
        socket.gethostname(),
    ):
        running[name[:24]] = bool(lab.api.inspect_container(name)["State"]["Running"])
    door = lab.door
    running["door_ok"] = door is not None and door.state.lost is None
    return running


def fresh_agent(lab: Rig) -> None:
    lab.agent.stop()
    lab.agent.remove()
    time.sleep(1.0)
    lab.agent = AgentContainer(MEMORY_MB)
    lab.agent.create()


# The kernel's default table of open files on a VM with 4 GB (what `fs.file-max` was before the
# Launcher raised it): the flood must get past it, or it proved nothing about the new limit.
OLD_FILE_MAX_4GB = 437_305
FLOOD_MIXED = "timerfd,epoll,eventfd,socketpair,null"
# The objects with the most memory the cgroup of the opener does not count (a context allocated
# without accounting, about as large as the accounted file next to it).
FLOOD_LEAKY = "timerfd,epoll"
FLOOD_CAP = 4_000_000
EMFILE, ENFILE, ENOMEM = 24, 23, 12


def fd_flood(lab: Rig, reader: ReaderAccess, label: str, kinds: str) -> None:
    """Twelve root processes of the agent open objects of these kinds as fast as they can, until
    each one is stopped (EMFILE of its own table, ENOMEM, or a kill by the memory cgroup's OOM
    killer), and hold what they have for a few seconds. The table of open files is one for the
    whole VM, a file costs memory and some kinds cost memory the cgroup of the opener does not
    count. Expected: the agent is what stops (its processes end with EMFILE or ENOMEM or are
    killed, the table never fills, which would be ENFILE for Control as well), and Control, the
    door and the readers never notice."""
    checks = lab.checks
    limit = int(Path("/proc/sys/fs/file-max").read_text())
    # Enough processes that their own tables (1,048,576 entries each) cannot hold what the memory limit
    # would allow: about 450 bytes of the limit per object of the leakiest kinds.
    processes = max(12, MEMORY_MB * MIB // (450 * 1_048_576) * 2 + 2)
    before = vm_oom_kills()
    began = time.monotonic()
    with Sampler() as sampler:
        done = run_exec(
            lab.api,
            AGENT_CONTAINER_NAME,
            [PYTHON, "-I", "-c", FDS, "8", str(processes), str(FLOOD_CAP), kinds],
            timeout=180.0,
            name="fds",
        )
        reader_ok = reader.run(["--version"], timeout=20.0)
    children = last_flood(done.stdout)
    # A container that was killed is gone a moment after the command in it ended.
    lab.agent.settle(10.0)
    state = lab.api.inspect_container(AGENT_CONTAINER_NAME)["State"]
    opened = sum(c[0] for c in children)
    stopped_by = sorted(
        {
            "EMFILE"
            if c[1] == EMFILE
            else "ENFILE"
            if c[1] == ENFILE
            else "ENOMEM"
            if c[1] == ENOMEM
            else f"signal {c[2]}"
            if c[2]
            else f"errno {c[1]}"
            for c in children
        }
    )
    # The agent was what stopped, in a way that is its own: its processes ended on their own table or on
    # the memory limit (EMFILE, ENOMEM, a kill), or the memory cgroup killed the program that held them
    # and said so. Never ENFILE (the VM's table was full, for Control as well) and never a process that
    # simply finished its cap.
    own_end = bool(children) and all(
        c[1] in (EMFILE, ENOMEM) or c[2] == signal.SIGKILL for c in children
    )
    end = lab.agent.end
    by_control = end is not None and end.vm_memory
    stopped = own_end or (not children and (state.get("OOMKilled") is True or by_control))
    peak = sampler.most_files_open
    checks.say(
        "abuse",
        "open_file_flood_in_the_agent_does_not_starve_control"
        if label == "mixed"
        else "open_file_flood_of_the_leakiest_objects_does_not_starve_control",
        f"twelve root processes open {kinds} until EMFILE, ENOMEM or the memory limit stops them (past the old table of {OLD_FILE_MAX_4GB}, table now {limit}): the table never fills, Control's calls and a command in a reader never fail, door and readers stay up, the VM keeps at least 300 MiB of free memory and file cache",
        stopped
        and peak > OLD_FILE_MAX_4GB
        and peak < limit
        and sampler.failures == 0
        and sampler.worst < 10.0
        and sampler.min_headroom_mib >= 300
        and reader_ok.returncode == 0
        and reader_ok.stdout.startswith("git version")
        and all(whole_and_running(lab).values()),
        kinds=kinds,
        file_max=limit,
        opened_by_the_agent=opened,
        children_stopped_by=stopped_by,
        most_files_open_system_wide=peak,
        vm_min_available_mib=sampler.min_available_mib,
        vm_min_headroom_mib=sampler.min_headroom_mib,
        vm_oom_kills=vm_oom_kills() - before,
        worst_latency_s=sampler.worst,
        failures=sampler.failures,
        agent_oom_killed=state.get("OOMKilled"),
        agent_killed_by_control_for_vm_memory=by_control,
        agent_running=state.get("Running"),
        exec_outcome=[
            done.returncode,
            done.unanswered,
            done.stdout[-80:],
            round(time.monotonic() - began, 1),
        ],
        reader_after=reader_ok.stdout.strip()[:30] or reader_ok.returncode,
    )


def last_flood(text: str) -> list[list[int]]:
    """The per-process lines of the flood: [opened, errno, signal]; empty when the program that held
    them was killed before it could say."""
    for line in reversed(text.splitlines()):
        if line.startswith("FLOOD "):
            with contextlib.suppress(ValueError):
                return cast("list[list[int]]", json.loads(line[6:])["children"])
    return []


def vm_oom_kills() -> int:
    """How many processes the kernel's OOM killer has killed since boot, in a cgroup or in the VM."""
    for line in Path("/proc/vmstat").read_text().splitlines():
        if line.startswith("oom_kill "):
            return int(line.split()[1])
    return 0


def section_abuse(lab: Rig, reader: ReaderAccess) -> None:
    checks = lab.checks
    # -- memory ------------------------------------------------------------------------------
    with Sampler() as sampler:
        began = time.monotonic()
        code, out = lab.agent_run([PYTHON, "-I", "-c", HOG], timeout=240.0)
        took = time.monotonic() - began
    allocated = max(
        [int(x.split()[1]) for x in out.splitlines() if x.startswith("ALLOCATED_MIB")] or [0]
    )
    state = lab.api.inspect_container(AGENT_CONTAINER_NAME)["State"]
    checks.say(
        "abuse",
        "memory_hog_in_the_agent_is_stopped_at_its_limit_and_control_is_unharmed",
        f"an allocation loop dies at about {MEMORY_MB} MiB (the cgroup's limit), the VM keeps at least 300 MiB available, Control's calls and a command in a reader never fail, door and readers stay up",
        code != 0
        and MEMORY_MB // 2 <= allocated <= MEMORY_MB
        and sampler.min_available_mib >= 300
        and sampler.failures == 0
        and sampler.worst < 10.0
        and all(whole_and_running(lab).values()),
        exit_code=code,
        allocated_mib=allocated,
        seconds=round(took, 1),
        vm_min_available_mib=sampler.min_available_mib,
        worst_latency_s=sampler.worst,
        failures=sampler.failures,
        agent_oom_killed=state.get("OOMKilled"),
        agent_running=state.get("Running"),
    )
    if not state.get("Running"):
        fresh_agent(lab)
    # -- processes ---------------------------------------------------------------------------
    with Sampler() as sampler:
        done = run_exec(
            lab.api,
            AGENT_CONTAINER_NAME,
            [PYTHON, "-I", "-c", FLOOD, "12"],
            timeout=90.0,
            name="flood",
        )
        flood_out = done.stdout
        killed_at = time.monotonic()
        lab.agent.stop()
        stop_seconds = time.monotonic() - killed_at
    started = 0
    for line in flood_out.splitlines():
        if line.startswith("STARTED"):
            started = int(line.split()[1])
    checks.say(
        "abuse",
        "process_flood_in_the_agent_is_stopped_by_the_pid_limit_and_control_is_unharmed",
        "threads and processes stop at pids.max (16384), Control's calls and a command in a reader never fail while they are running, the container is killed within 25 s",
        15000 <= started <= 16384
        and sampler.failures == 0
        and sampler.worst < 10.0
        and stop_seconds < 25.0
        and all(whole_and_running(lab).values()),
        started=started,
        worst_latency_s=sampler.worst,
        failures=sampler.failures,
        stop_seconds=round(stop_seconds, 1),
        output=flood_out[-120:],
    )
    fresh_agent(lab)

    # -- processor ---------------------------------------------------------------------------
    def work() -> float:
        """A fixed amount of computing in Control: the seconds it takes."""
        began = time.monotonic()
        sum(range(6_000_000))
        return time.monotonic() - began

    idle = min(work() for _ in range(3))
    started = threading.Thread(
        target=lambda: lab.agent_run([PYTHON, "-I", "-c", BURN, "12", "16"], timeout=90.0)
    )
    with Sampler() as sampler:
        started.start()
        time.sleep(3.0)
        busy = max(work() for _ in range(3))
        started.join(60.0)
    checks.say(
        "abuse",
        "cpu_burn_in_the_agent_leaves_control_its_share",
        "with sixteen busy processes in the agent a fixed piece of work in Control takes less than six times as long as on an idle VM, and none of Control's calls fails",
        busy < 6 * idle + 0.5 and sampler.failures == 0 and sampler.worst < 10.0,
        idle_seconds=round(idle, 3),
        busy_seconds=round(busy, 3),
        worst_latency_s=sampler.worst,
        failures=sampler.failures,
    )
    # -- open files (the system-wide table is one for all containers) --------------------------
    for label, kinds in (("mixed", FLOOD_MIXED), ("leaky", FLOOD_LEAKY)):
        fd_flood(lab, reader, label, kinds)
        fresh_agent(lab)
    # -- disk --------------------------------------------------------------------------------
    before = os.statvfs("/work")
    reserve_before = os.statvfs("/work/reserve")
    with Sampler() as sampler:
        began = time.monotonic()
        code, out = lab.agent_run([PYTHON, "-I", "-c", FILL], timeout=600.0)
        fill_seconds = time.monotonic() - began
        full = os.statvfs("/work")
        free_mib = full.f_bavail * full.f_frsize // MIB
        reserve_room = os.statvfs("/work/reserve")
        wrote = ""
        try:
            with open("/work/reserve/room.bin", "wb") as handle:
                handle.write(b"\0" * (256 * MIB))
            wrote = "256 MiB written"
        except OSError as error:
            wrote = f"failed: {error}"
        finally:
            with contextlib.suppress(OSError):
                os.unlink("/work/reserve/room.bin")
        git = reader.run(["--version"], timeout=20.0)
        stopping = time.monotonic()
        stopped = lab.agent.stop()
        stop_seconds = time.monotonic() - stopping
    still = whole_and_running(lab)
    checks.say(
        "abuse",
        "vm_disk_filled_by_the_agent_leaves_control_able_to_work",
        "with the VM's disk at about 0 free: a command in a reader still runs (git answers), the reserve disk takes 256 MiB, the agent is killed within 25 s, the door and readers stay up",
        free_mib < 64
        and wrote == "256 MiB written"
        and git.returncode == 0
        and git.stdout.startswith("git version")
        and stopped
        and stop_seconds < 25.0
        and sampler.failures == 0
        and all(still.values()),
        agent_wrote=out.strip()[-80:],
        free_mib=free_mib,
        free_before_mib=before.f_bavail * before.f_frsize // MIB,
        reserve_free_mib_before=reserve_before.f_bavail * reserve_before.f_frsize // MIB,
        reserve_free_mib_during=reserve_room.f_bavail * reserve_room.f_frsize // MIB,
        reserve_write=wrote,
        git=git.stdout.strip()[:30],
        stop_seconds=round(stop_seconds, 1),
        fill_seconds=round(fill_seconds, 1),
        worst_latency_s=sampler.worst,
        failures=sampler.failures,
        still_up=still,
    )
    removing = time.monotonic()
    lab.agent.remove()
    time.sleep(1.0)
    after = os.statvfs("/work")
    freed = after.f_bavail * after.f_frsize // MIB
    checks.say(
        "abuse",
        "removing_the_agents_container_gives_the_disk_back",
        "the filled disk is free again once the agent's container is removed",
        freed > 1024,
        free_after_mib=freed,
        remove_seconds=round(time.monotonic() - removing, 1),
    )


def main() -> int:
    checks = Checks()
    lab = Rig(checks)
    started = time.monotonic()
    reader = ReaderAccess()
    shutil.rmtree("/work/repo/planted", ignore_errors=True)
    try:
        lab.host = lab.host_json(HOST_VIEW)
        print(json.dumps({"host_view": lab.host}, default=str), flush=True)
        reader.warm()
        lab.start_door()
        notes = lab.agent.create()
        print(json.dumps({"agent_ready": True, "notes": notes}), flush=True)
        section_boundary_of_the_container(lab)
        section_readers(lab)
        section_agent_identity(lab)
        section_proc_and_sys(lab)
        # Before the network attacks: they change the agent's own routes and bridge.
        section_inner_docker(lab)
        section_agent_network(lab)
        section_ipv6(lab)
        section_sockets_and_volume(lab)
        section_door(lab)
        section_setup_container(lab)
        if not SKIP_ABUSE:
            section_abuse(lab, reader)
    finally:
        with contextlib.suppress(Exception):
            lab.api.remove_container(NEIGHBOUR)
        shutil.rmtree("/work/repo/planted", ignore_errors=True)
        with contextlib.suppress(Exception):
            lab.agent.stop()
            lab.agent.remove()
        with contextlib.suppress(Exception):
            if lab.door is not None:
                lab.door.stop()
        with contextlib.suppress(Exception):
            reader.close()
        # The Setup container and its network, when a Ctrl-C (or a failure) left them behind.
        with contextlib.suppress(Exception):
            lab.api.remove_container(SETUP_CONTAINER_NAME)
        with contextlib.suppress(Exception):
            lab.api.remove_network(SETUP_NETWORK_NAME)
        _ = (threading, MODEL_AGENT_ADDRESS, MODEL_DOOR_ADDRESS, MODEL_NETWORK_GATEWAY)
        _ = (SETUP_ADDRESS, SETUP_CONTAINER_NAME, SETUP_NETWORK_GATEWAY, SetupContainer)
        _ = (INTERNET, PUBLIC_V6, LISTEN_PORT, SETUP_LISTEN_PORT, SKIP_ABUSE)
    print(checks.table())
    print(json.dumps({"total": round(time.monotonic() - started, 1), "ok": checks.ok}))
    return 0 if checks.ok else 1


if __name__ == "__main__":
    sys.exit(main())
