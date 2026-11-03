# SPDX-License-Identifier: LicenseRef-Proprietary

"""What an untrusted workload tries from inside its container (#745, step 6, the attack test).

Run **inside** the agent's container or the Setup container, as root, by
`sandbox_boundary_check.py` (which owns the expectations and never trusts this program: it only
reads the facts this one prints). Standard library only, because the image it runs in has nothing
else, and nothing here reaches beyond the addresses and files the configuration names, all of them
ours on the VM under test.

    python3 -I boundary_probe.py '<configuration as JSON>' | <path of a JSON file>

The configuration is `{"sections": [...], ...}`; each section prints nothing, and the last line of
standard output is `PROBE_RESULT <one JSON object, one key per section>`. A section that fails
reports `{"error": ...}` and the next one runs.

Every connect attempt is a plain `connect()` with a short timeout. The word for the outcome:

* `connected`: the three-way handshake finished;
* `refused`: a host answered with a reset, so the packet got there and nothing listens;
* `timeout`: nothing came back, which is what a drop looks like;
* `error:<ERRNO>`: the kernel had no route (`ENETUNREACH`, `EHOSTUNREACH`) or refused locally.

`reached` is `connected` or `refused`; everything else means the packet did not get an answer.
"""

import contextlib
import errno
import json
import os
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast

Json = dict[str, Any]
CONNECT_SECONDS = 2.0


def _describe(error: OSError) -> str:
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, ConnectionRefusedError):
        return "refused"
    return "error:" + errno.errorcode.get(error.errno or 0, str(error.errno))


def connect(
    host: str,
    port: int,
    *,
    timeout: float = CONNECT_SECONDS,
    family: int = socket.AF_INET,
    scope: int = 0,
) -> str:
    probe = socket.socket(family, socket.SOCK_STREAM)
    probe.settimeout(timeout)
    try:
        if family == socket.AF_INET6:
            probe.connect((host, port, 0, scope))
        else:
            probe.connect((host, port))
        return "connected"
    except OSError as error:
        return _describe(error)
    finally:
        probe.close()


def _many(jobs: list[tuple[str, Callable[[], str]]], workers: int = 48) -> dict[str, str]:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [(label, pool.submit(job)) for label, job in jobs]
        return {label: future.result() for label, future in futures}


def section_net(config: Json) -> Json:
    """`targets`: [{"l": label, "h": host, "p": port}] -> {label: outcome}. With `routes`
    (`ip route` arguments), root first tries to give itself those routes, as a workload that
    does not trust its own routing table would, and the answer to each is under `_routes`."""
    targets = cast("list[Json]", config.get("targets", []))
    routed: Json = {}
    for device in cast("list[str]", config.get("flush", [])):
        # A workload that takes the addresses of its own inner bridges away, so that the address
        # of the VM's gateway they shadowed is no longer its own.
        for argv in (["addr", "flush", "dev", device], ["link", "set", device, "down"]):
            try:
                done = subprocess.run(
                    ["ip", *argv], capture_output=True, text=True, timeout=5, check=False
                )
                routed[f"flush {device} {argv[0]}"] = done.returncode
            except (OSError, subprocess.TimeoutExpired) as error:
                routed[f"flush {device} {argv[0]}"] = f"error:{error.__class__.__name__}"
    for route in cast("list[str]", config.get("routes", [])):
        try:
            done = subprocess.run(
                ["ip", "route", "replace", *route.split()],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            routed[route] = done.returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            routed[route] = f"error:{error.__class__.__name__}"
    jobs: list[tuple[str, Callable[[], str]]] = []
    timeout = float(config.get("timeout", CONNECT_SECONDS))
    warm = cast("Json | None", config.get("until"))
    if warm is not None:
        # A fresh container behind a bridge of its own needs a moment before its first packet
        # leaves (the bridge's link, the neighbour lookup): wait for the control to connect.
        end = time.monotonic() + float(warm["seconds"])
        while time.monotonic() < end and connect(str(warm["h"]), int(warm["p"])) != "connected":
            time.sleep(0.5)
    for target in targets:
        jobs.append(
            (str(target["l"]), lambda t=target: connect(str(t["h"]), int(t["p"]), timeout=timeout))
        )
    outcomes = cast("Json", _many(jobs))
    for item in cast("list[Json]", config.get("restore", [])):
        # Put back what the attempt took away (the agent's own Docker needs its bridge).
        for argv in (
            ["addr", "add", str(item["addr"]), "dev", str(item["dev"])],
            ["link", "set", str(item["dev"]), "up"],
        ):
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                subprocess.run(["ip", *argv], capture_output=True, timeout=5, check=False)
    if routed:
        outcomes["_routes"] = routed
    return outcomes


def section_scan(config: Json) -> Json:
    """`scan`: {"host": h, "ports": [[first, last], ...]} -> which ports connected or were reset."""
    scan = cast("Json", config["scan"])
    host = str(scan["host"])
    ports: list[int] = []
    for first, last in cast("list[list[int]]", scan["ports"]):
        ports.extend(range(first, last + 1))
    jobs: list[tuple[str, Callable[[], str]]] = [
        (str(port), lambda p=port: connect(host, p, timeout=1.0)) for port in ports
    ]
    outcomes = _many(jobs, workers=128)
    return {
        "connected": sorted(int(p) for p, o in outcomes.items() if o == "connected"),
        "refused": sum(1 for o in outcomes.values() if o == "refused"),
        "silent": sum(1 for o in outcomes.values() if o not in ("connected", "refused")),
        "scanned": len(ports),
    }


def _dns_query(name: str) -> bytes:
    header = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0)
    question = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0"
    return header + question + struct.pack(">HH", 1, 1)


def section_dns(config: Json) -> Json:
    """`dns`: {"servers": [...], "name": n} -> what a plain UDP query to each got back."""
    spec = cast("Json", config["dns"])
    answers: Json = {}
    for server in cast("list[str]", spec["servers"]):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.settimeout(2.0)
        try:
            probe.sendto(_dns_query(str(spec["name"])), (server, 53))
            data, _ = probe.recvfrom(2048)
            _, flags, _, answer_count, _, _ = struct.unpack(">HHHHHH", data[:12])
            answers[server] = {"reply": True, "rcode": flags & 0xF, "answers": answer_count}
        except OSError as error:
            answers[server] = {"reply": False, "why": _describe(error)}
        finally:
            probe.close()
    return answers


def section_resolve(config: Json) -> Json:
    """`resolve`: [names] -> addresses or the error, through the container's own resolver."""
    results: Json = {}

    def look(name: str) -> None:
        try:
            found = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
            results[name] = sorted({str(item[4][0]) for item in found})
        except OSError as error:
            results[name] = f"error:{error.__class__.__name__}"

    threads = [
        threading.Thread(target=look, args=(n,)) for n in cast("list[str]", config["resolve"])
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10.0)
    return results


def section_ping(config: Json) -> Json:
    """`ping`: [addresses] -> exit status of one echo request each (0: an answer came)."""
    results: Json = {}
    for address in cast("list[str]", config["ping"]):
        try:
            done = subprocess.run(
                ["ping", "-c", "1", "-W", "2", address],
                capture_output=True,
                timeout=8,
                check=False,
            )
            results[address] = done.returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            results[address] = f"error:{error.__class__.__name__}"
    return results


def _inet6() -> list[Json]:
    """`/proc/net/if_inet6`: address, interface and scope of every IPv6 address here."""
    found: list[Json] = []
    try:
        lines = open("/proc/net/if_inet6").read().split("\n")  # noqa: SIM115
    except OSError:
        return found
    for line in lines:
        fields = line.split()
        if len(fields) < 6:
            continue
        raw = fields[0]
        text = ":".join(raw[i : i + 4] for i in range(0, 32, 4))
        found.append(
            {
                "address": socket.inet_ntop(socket.AF_INET6, bytes.fromhex(raw)),
                "text": text,
                "scope": fields[3],
                "interface": fields[5],
            }
        )
    return found


def _write(path: str, value: str) -> str:
    try:
        with open(path, "w") as handle:
            handle.write(value)
        return "written"
    except OSError as error:
        return "error:" + errno.errorcode.get(error.errno or 0, str(error.errno))


def section_ipv6(config: Json) -> Json:
    """Root switches IPv6 on in its own namespace, looks for neighbours on every interface and
    tries each one's control port, then tries two public IPv6 addresses (the class of hole found
    in #818: the VM's link-local address on the bridge)."""
    spec = cast("Json", config["ipv6"])
    interfaces = sorted(n for n in os.listdir("/sys/class/net") if n != "lo")
    before = {
        name: _read(f"/proc/sys/net/ipv6/conf/{name}/disable_ipv6")
        for name in ("all", "default", *interfaces)
    }
    before_addresses = _inet6()
    switched = {
        name: _write(f"/proc/sys/net/ipv6/conf/{name}/disable_ipv6", "0")
        for name in ("all", "default", *interfaces)
    }
    time.sleep(2.5)
    after_addresses = _inet6()
    own = {a["address"] for a in after_addresses}
    neighbours: set[str] = set()
    for name in interfaces:
        try:
            done = subprocess.run(
                ["ping", "-6", "-c", "2", "-W", "2", f"ff02::1%{name}"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            for token in done.stdout.replace("(", " ").replace(")", " ").split():
                head = token.split("%")[0].rstrip(":")
                if head.lower().startswith("fe80") and head not in own:
                    neighbours.add(f"{head}%{name}")
        except (OSError, subprocess.TimeoutExpired):
            continue
    try:
        listing = subprocess.run(
            ["ip", "-6", "neigh", "show"], capture_output=True, text=True, timeout=5, check=False
        ).stdout
        for line in listing.splitlines():
            fields = line.split()
            if fields and fields[0].lower().startswith("fe80") and "dev" in fields:
                neighbours.add(f"{fields[0]}%{fields[fields.index('dev') + 1]}")
    except (OSError, subprocess.TimeoutExpired):
        pass
    reached: Json = {}
    ports = [int(p) for p in cast("list[int]", spec["ports"])]
    for neighbour in sorted(neighbours):
        address, _, name = neighbour.partition("%")
        scope = socket.if_nametoindex(name)
        for port in ports:
            reached[f"{neighbour}:{port}"] = connect(
                address, port, timeout=2.0, family=socket.AF_INET6, scope=scope
            )
    public = {
        f"{address}:443": connect(address, 443, timeout=3.0, family=socket.AF_INET6)
        for address in cast("list[str]", spec["public"])
    }
    return {
        "disable_ipv6_before": before,
        "addresses_before": [f"{a['interface']}={a['address']}" for a in before_addresses],
        "switched_on": switched,
        "addresses_after": [f"{a['interface']}={a['address']}" for a in after_addresses],
        "neighbours": sorted(neighbours),
        "neighbour_connects": reached,
        "public": public,
    }


def _read(path: str, limit: int = 4096) -> str:
    try:
        with open(path) as handle:
            return handle.read(limit).strip()
    except OSError as error:
        return "error:" + errno.errorcode.get(error.errno or 0, str(error.errno))


def _http_over_unix(path: str, target: str) -> str | None:
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(2.0)
    try:
        probe.connect(path)
        probe.sendall(f"GET {target} HTTP/1.0\r\nHost: probe\r\n\r\n".encode())
        data = b""
        while chunk := probe.recv(65536):
            data += chunk
            if len(data) > 1_000_000:
                break
        return data.decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        probe.close()


def section_sockets(config: Json) -> Json:
    """Every unix socket this container can see, asked `GET /info` as a Docker daemon: the daemon
    each belongs to, by id. A socket of the VM's daemon among them is the finding."""
    candidates: set[str] = {"/var/run/docker.sock", "/run/docker.sock"}
    for source in (_read("/proc/net/unix", 1_000_000), ""):
        for line in source.splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 8 and fields[7].startswith("/"):
                candidates.add(fields[7])
    for root in cast(
        "list[str]", config.get("socket_roots", ["/run", "/var/run", "/tmp", "/work"])
    ):
        for directory, _, names in os.walk(root, followlinks=False):
            for name in names:
                path = os.path.join(directory, name)
                try:
                    if stat.S_ISSOCK(os.lstat(path).st_mode):
                        candidates.add(path)
                except OSError:
                    continue
    answers: list[Json] = []
    for path in sorted(candidates):
        if not os.path.exists(path):
            continue
        body = _http_over_unix(path, "/info")
        entry: Json = {"path": path, "answered": body is not None}
        if body and "\r\n\r\n" in body:
            try:
                document = json.loads(body.split("\r\n\r\n", 1)[1])
                entry.update(daemon_id=document.get("ID"), name=document.get("Name"))
            except ValueError:
                entry["not_docker"] = True
        answers.append(entry)
    return {"sockets": answers}


def _ids() -> Json:
    status = _read("/proc/self/status", 8192)
    fields = {
        line.split(":", 1)[0]: line.split(":", 1)[1].strip()
        for line in status.splitlines()
        if ":" in line
    }
    return {
        key: fields.get(key)
        for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp")
    }


def _local_addresses() -> list[str]:
    """The IPv4 addresses of this container's namespace (an inner Docker's bridge among them)."""
    try:
        listing = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line.split()[3].split("/")[0] for line in listing.splitlines() if len(line.split()) > 3]


def _visible_commands() -> list[str]:
    """The command line (first 100 characters) of every process this container can see."""
    found: list[str] = []
    for entry in sorted(os.listdir("/proc")):
        if entry.isdigit():
            line = _read(f"/proc/{entry}/cmdline", 400).replace("\0", " ")
            found.append(f"{entry}:{line[:100]}")
    return found


def section_ids(_config: Json) -> Json:
    return {
        "processes": _visible_commands(),
        "addresses": _local_addresses(),
        "uid": os.getuid(),
        "uid_map": _read("/proc/self/uid_map"),
        "gid_map": _read("/proc/self/gid_map"),
        "self": _ids(),
        "pid1_cmdline": _read("/proc/1/cmdline").replace("\0", " ")[:120],
        "hostname": socket.gethostname(),
        "interfaces": sorted(os.listdir("/sys/class/net")),
        "resolv": _read("/etc/resolv.conf"),
    }


def section_mounts(_config: Json) -> Json:
    rows: list[Json] = []
    for line in _read("/proc/self/mountinfo", 1_000_000).splitlines():
        left, _, right = line.partition(" - ")
        fields = left.split()
        tail = right.split()
        if len(fields) < 6 or len(tail) < 2:
            continue
        rows.append(
            {
                "point": fields[4],
                "root": fields[3],
                "options": fields[5],
                "type": tail[0],
                "source": tail[1],
            }
        )
    return {"mounts": rows}


def _try_open(path: str, mode: str, size: int = 4) -> Json:
    try:
        with open(path, mode + "b") as handle:
            if "r" in mode:
                return {"opened": True, "head": handle.read(size).hex()}
            handle.write(b"h")
            return {"opened": True, "written": True}
    except OSError as error:
        return {"opened": False, "why": errno.errorcode.get(error.errno or 0, str(error.errno))}


def _privileged_syscalls() -> Json:
    """Calls that need a capability in the VM's own user namespace, made in ways that change
    nothing if they are let through: the clock is set to the time it has, a module is asked for
    with no image, a BPF map is created and closed."""
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    answers: Json = {}

    def code(result: int) -> str:
        return "allowed" if result >= 0 else errno.errorcode.get(ctypes.get_errno(), "?")

    try:
        time.clock_settime(time.CLOCK_REALTIME, time.time())
        answers["clock_settime"] = "allowed"
    except OSError as error:
        answers["clock_settime"] = errno.errorcode.get(error.errno or 0, "?")
    answers["init_module"] = code(libc.syscall(175, None, 0, b""))
    answers["kexec_load"] = code(libc.syscall(246, 0, 0, None, 0))
    attribute = struct.pack("IIIII", 2, 4, 4, 1, 0).ljust(128, b"\0")  # an array map of one entry
    descriptor = libc.syscall(321, 0, ctypes.create_string_buffer(attribute), 128)
    answers["bpf_map_create"] = code(descriptor)
    if descriptor >= 0:
        os.close(descriptor)
    answers["swapoff"] = code(libc.syscall(168, b"/nonexistent"))
    answers["sethostname_is_namespaced"] = code(libc.syscall(170, b"agent", 5))
    return answers


def section_proc(config: Json) -> Json:
    """/proc and /sys: what is masked, what a write does. Writes are of a value that changes
    nothing when it lands (the value read, or a harmless word), and a changed value is put back."""
    results: Json = {}
    results["kcore"] = _try_open("/proc/kcore", "r", 4)
    results["keys"] = _try_open("/proc/keys", "r", 64)
    results["kmsg"] = _try_open("/proc/kmsg", "r", 4)
    results["sysrq_trigger"] = _try_open("/proc/sysrq-trigger", "w")
    results["mem"] = _try_open("/dev/mem", "r", 4)
    results["kmem"] = _try_open("/dev/kmem", "r", 4)
    results["port"] = _try_open("/dev/port", "r", 4)
    writes: Json = {}
    for path in cast("list[str]", config.get("sysctls", [])):
        original = _read(path)
        sentinel = original if path.endswith("modprobe") else str(config.get("sentinel", "x"))
        outcome = _write(path, sentinel)
        after = _read(path)
        writes[path] = {"original": original[:60], "result": outcome, "changed": after != original}
        if after != original:
            _write(path, original)
    results["sysctl_writes"] = writes
    results["binfmt_misc"] = {
        "exists": os.path.isdir("/proc/sys/fs/binfmt_misc"),
        "register": _write("/proc/sys/fs/binfmt_misc/register", ":x:E::x::/bin/true:")
        if os.path.exists("/proc/sys/fs/binfmt_misc/register")
        else "absent",
    }
    results["sys_kernel_uevent_helper"] = _write("/sys/kernel/uevent_helper", "")
    try:
        results["syscalls"] = _privileged_syscalls()
    except ImportError as error:  # a container made of a few files may lack ctypes
        results["syscalls"] = {"error": f"ImportError: {error}"}
    return results


def section_devices(config: Json) -> Json:
    present = {
        name: os.path.exists(f"/dev/{name}") for name in cast("list[str]", config["devices"])
    }
    nodes: Json = {}
    for label, kind, major, minor in (
        ("block_vm_disk", stat.S_IFBLK, 254, 16),
        ("char_mem", stat.S_IFCHR, 1, 1),
        ("char_kmem", stat.S_IFCHR, 1, 2),
        ("char_port", stat.S_IFCHR, 1, 4),
    ):
        path = f"/dev/boundary-probe-{label}"
        try:
            os.mknod(path, 0o600 | kind, os.makedev(major, minor))
            nodes[label] = "created"
            os.unlink(path)
        except OSError as error:
            nodes[label] = "error:" + errno.errorcode.get(error.errno or 0, str(error.errno))
    listing = sorted(os.listdir("/dev"))
    return {"present": present, "mknod": nodes, "listing": listing}


def section_cgroup(config: Json) -> Json:
    """The limits as the container sees them, and whether root can lift them."""
    root = "/sys/fs/cgroup"
    values = {
        name: _read(f"{root}/{name}")
        for name in ("memory.max", "memory.swap.max", "pids.max", "cpu.max", "cgroup.type")
    }
    lifted: Json = {}
    for name in cast(
        "list[str]", config.get("lift", ["memory.max", "pids.max", "memory.swap.max"])
    ):
        original = values.get(name, _read(f"{root}/{name}"))
        outcome = _write(f"{root}/{name}", "max")
        changed = _read(f"{root}/{name}") != original
        lifted[name] = {"result": outcome, "changed": changed}
        if changed:
            _write(f"{root}/{name}", original)
    return {
        "values": values,
        "lifted": lifted,
        "own_cgroup": _read("/proc/self/cgroup"),
        "controllers": _read(f"{root}/cgroup.controllers"),
    }


def section_look(config: Json) -> Json:
    """Search the places a workload could read for the secrets the checker names. Prints where,
    never what."""
    needles = [bytes.fromhex(n) for n in cast("list[str]", config["needles_hex"])]
    found: list[str] = []
    processes = files = 0
    me = str(os.getpid())
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or entry == me:
            continue
        for name in ("environ", "cmdline"):
            try:
                with open(f"/proc/{entry}/{name}", "rb") as handle:
                    data = handle.read()
            except OSError:
                continue
            processes += 1
            if any(n in data for n in needles):
                found.append(f"/proc/{entry}/{name}")
    roots = cast(
        "list[str]", config.get("roots", ["/tmp", "/run", "/work", "/home", "/root", "/etc"])
    )
    for root in roots:
        for directory, _, names in os.walk(root, followlinks=False):
            for name in names:
                path = os.path.join(directory, name)
                try:
                    # Regular files only: a FIFO opened for reading waits for ever.
                    info = os.lstat(path)
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 8_000_000:
                        continue
                    with open(path, "rb") as handle:
                        data = handle.read()
                except OSError:
                    continue
                files += 1
                if any(n in data for n in needles):
                    found.append(path)
    own = any(n.decode("utf-8", "replace") in str(dict(os.environ)) for n in needles)
    return {"found": found, "processes_read": processes, "files_read": files, "in_own_env": own}


def section_listen(config: Json) -> Json:
    """Listeners on given ports, kept for `seconds`, so that another party's attempt to reach this
    container is a reset or a handshake when the network lets it through, and a silence when it
    does not."""
    spec = cast("Json", config["listen"])
    listeners: list[socket.socket] = []
    opened: list[int] = []
    for port in cast("list[int]", spec["ports"]):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("0.0.0.0", port))
            listener.listen(16)
            listeners.append(listener)
            opened.append(port)
        except OSError:
            listener.close()
    if os.fork() == 0:
        os.setsid()
        # Let go of the command's pipes, or the caller waits for the listeners to end.
        null = os.open(os.devnull, os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        end = time.monotonic() + float(spec["seconds"])
        for listener in listeners:
            listener.settimeout(0.5)
        while time.monotonic() < end:
            for listener in listeners:
                try:
                    listener.accept()[0].close()
                except OSError:
                    continue
        os._exit(0)
    return {"listening": opened}


def section_http(config: Json) -> Json:
    """`http`: [{"l": label, "h": host, "p": port, "raw": request text}] -> the status line and
    the first bytes of the answer, for requests written by hand (so that a method, a target or a
    Host the library would not send can be sent). `connected` says whether the connection was made
    at all: an `error` before it is a door that is not there, not a door that refuses."""
    answers: Json = {}
    for item in cast("list[Json]", config["http"]):
        label = str(item["l"])
        connected = False
        try:
            probe = socket.create_connection((str(item["h"]), int(item["p"])), timeout=5.0)
            connected = True
            probe.settimeout(15.0)
            probe.sendall(str(item["raw"]).encode("latin-1"))
            data = b""
            while len(data) < 600:
                chunk = probe.recv(600)
                if not chunk:
                    break
                data += chunk
            probe.close()
            text = data.decode("latin-1")
            status = text.split(" ", 2)[1] if text.startswith("HTTP/") else "none"
            answers[label] = {"status": status, "head": text[:240], "connected": connected}
        except OSError as error:
            answers[label] = {"status": "error", "why": _describe(error), "connected": connected}
    return answers


def section_volume(config: Json) -> Json:
    """The repository volume as the agent sees it: what exists beyond it, and what the agent
    leaves in it for Control to meet (a symlink out, a setuid file, a FIFO, a hard link, a file
    with another owner). Control reads these as untrusted; nothing here is read back by this
    program."""
    root = str(config["volume"]["root"])
    reachable: Json = {}
    for path in cast("list[str]", config["volume"]["beyond"]):
        reachable[path] = os.path.exists(path)
    made: Json = {}
    plant = os.path.join(root, "planted")
    os.makedirs(plant, exist_ok=True)

    def attempt(label: str, action: Callable[[], object]) -> None:
        try:
            action()
            made[label] = "made"
        except OSError as error:
            made[label] = "error:" + errno.errorcode.get(error.errno or 0, str(error.errno))

    attempt("symlink_to_root", lambda: os.symlink("/", os.path.join(plant, "to-root")))
    attempt("symlink_dotdot", lambda: os.symlink("../..", os.path.join(plant, "to-dotdot")))
    attempt("symlink_to_volume_parent", lambda: os.symlink("/work", os.path.join(plant, "to-work")))

    def setuid() -> None:
        path = os.path.join(plant, "suid-sh")
        with open("/bin/sh", "rb") as source, open(path, "wb") as target:
            target.write(source.read())
        os.chmod(path, 0o4755)

    attempt("setuid_file", setuid)
    attempt("fifo", lambda: os.mkfifo(os.path.join(plant, "fifo")))

    def foreign_owner() -> None:
        path = os.path.join(plant, "other-owner")
        with open(path, "w") as handle:
            handle.write("x")
        os.chown(path, 4321, 4321)

    attempt("foreign_owner", foreign_owner)
    attempt("hardlink_out", lambda: os.link("/etc/hostname", os.path.join(plant, "hard")))
    attempt(
        "hardlink_in",
        lambda: os.link(os.path.join(plant, "other-owner"), os.path.join(plant, "hard2")),
    )
    attempt(
        "device_node",
        lambda: os.mknod(os.path.join(plant, "dev"), 0o600 | stat.S_IFCHR, os.makedev(1, 3)),
    )
    return {
        "reachable_beyond_the_volume": reachable,
        "plant": made,
        "listing_work": sorted(os.listdir("/work")),
    }


def _bump(original: str) -> str:
    numbers = original.split()
    value = int(numbers[-1])
    numbers[-1] = str(value - 1 if value >= 7 else value + 1)
    return "\t".join(numbers)


def section_sysctl(config: Json) -> Json:
    """`sysctl`: {"mode": "write"|"restore", "paths": {...}}. `write` changes each given parameter
    to a valid, harmless neighbour of its value and reports what it read back; the checker then
    asks the VM whether the parameter changed there, and `restore` puts the old values back."""
    spec = cast("Json", config["sysctl"])
    results: Json = {}
    if spec["mode"] == "restore":
        for path, value in cast("Json", spec["paths"]).items():
            results[path] = _write(path, str(value))
        return results
    for path in cast("list[str]", spec["paths"]):
        original = _read(path)
        outcome = (
            _write(path, _bump(original)) if not original.startswith("error:") else "unreadable"
        )
        results[path] = {"original": original, "result": outcome, "after": _read(path)}
    return results


SECTIONS: dict[str, Callable[[Json], Json]] = {
    "http": section_http,
    "volume": section_volume,
    "sysctl": section_sysctl,
    "net": section_net,
    "scan": section_scan,
    "dns": section_dns,
    "resolve": section_resolve,
    "ping": section_ping,
    "ipv6": section_ipv6,
    "sockets": section_sockets,
    "ids": section_ids,
    "mounts": section_mounts,
    "proc": section_proc,
    "devices": section_devices,
    "cgroup": section_cgroup,
    "look": section_look,
    "listen": section_listen,
}


def main() -> int:
    argument = sys.argv[1]
    text = argument if argument.lstrip().startswith("{") else open(argument).read()  # noqa: SIM115
    config = cast("Json", json.loads(text))
    result: Json = {}
    for name in cast("list[str]", config["sections"]):
        try:
            result[name] = SECTIONS[name](config)
        except Exception as error:  # a probe that breaks is a finding of the probe, not a crash
            result[name] = {"error": f"{error.__class__.__name__}: {str(error)[:160]}"}
    print("PROBE_RESULT " + json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
