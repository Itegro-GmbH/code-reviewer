# SPDX-License-Identifier: LicenseRef-Proprietary

"""What `factory-runner run` is in the installer lane (#982): it runs under the unit the installer
wrote and tries, as the service user inside its sandbox, every thing the real dispatcher and its
Firecracker VMs do on the host. The result goes to `vms/lane-probe.json` (the one directory the
service may write besides its home), and then it waits for a staged release as the dispatcher
does: when the marker file exists it ends with exit code 10 and the unit's start switches
releases."""

import fcntl
import json
import os
import resource
import struct
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

STATE = Path(os.environ["FACTORY_RUNNER_VM_STATE_DIR"])
HOME = Path(os.environ["FACTORY_RUNNER_HOME"])
PENDING = Path(os.environ["FACTORY_RUNNER_PENDING_FILE"])
TUNSETIFF = 0x400454CA
IFF_TAP, IFF_NO_PI, IFF_VNET_HDR = 0x0002, 0x1000, 0x4000


def attempt(checks: dict[str, str], name: str, action: Callable[[], str | None]) -> None:
    try:
        problem: str | None = action()
    except Exception as error:  # the lane wants the reason of every failure
        problem = f"{type(error).__name__}: {error}"
    checks[name] = "ok" if problem is None else str(problem)


def kvm() -> None:
    os.close(os.open("/dev/kvm", os.O_RDWR))


def tap() -> None:
    descriptor = os.open("/dev/net/tun", os.O_RDWR)
    try:
        request = struct.pack("16sH22x", b"fctap0", IFF_TAP | IFF_NO_PI | IFF_VNET_HDR)
        fcntl.ioctl(descriptor, TUNSETIFF, request)
    finally:
        os.close(descriptor)


def cgroups() -> None:
    own = Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1]
    root = Path("/sys/fs/cgroup") / own.lstrip("/")
    leaf = root / "service"
    leaf.mkdir(exist_ok=True)
    (leaf / "cgroup.procs").write_text(str(os.getpid()))
    (root / "cgroup.subtree_control").write_text("+cpu +memory +pids")
    vm = root / "vm-0-lane0000"
    vm.mkdir()
    try:
        (vm / "cpu.max").write_text("200000 100000")
        (vm / "memory.max").write_text(str(2500 * 1024 * 1024))
        (vm / "pids.max").write_text("256")
    finally:
        vm.rmdir()


def cannot_write(path: Path) -> str | None:
    try:
        path.write_text("x")
    except OSError:
        return None
    path.unlink()
    return f"{path} could be written"


def can_write(path: Path) -> None:
    path.write_text("x")
    path.unlink()


def capabilities() -> str | None:
    status = Path("/proc/self/status").read_text()
    effective = next(line for line in status.splitlines() if line.startswith("CapEff")).split()[1]
    no_new = next(line for line in status.splitlines() if line.startswith("NoNewPrivs")).split()[1]
    if int(effective, 16) != 0:
        return f"CapEff {effective}"
    return None if no_new == "1" else "NoNewPrivs is not set"


def limits() -> str | None:
    soft = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    return None if soft >= 8192 else f"LimitNOFILE is {soft}"


def firecracker() -> str | None:
    done = subprocess.run(
        [os.environ["FACTORY_RUNNER_FIRECRACKER"], "--version"], capture_output=True, check=False
    )
    return None if done.returncode == 0 else f"exit {done.returncode}"


def environment() -> str | None:
    wanted = {"FACTORY_RUNNER_SANDBOX": "firecracker", "FACTORY_RUNNER_OUTER_WALL": "proxy"}
    for name, value in wanted.items():
        if os.environ.get(name) != value:
            return f"{name} is {os.environ.get(name)!r}"
    if not os.environ.get("FACTORY_RUNNER_VM_IMAGE_ID", "").startswith("sha256:"):
        return "FACTORY_RUNNER_VM_IMAGE_ID is not an image id"
    return None


def main() -> None:
    checks: dict[str, str] = {}
    attempt(checks, "kvm opens", lambda: kvm() or None)
    attempt(checks, "tap attaches", lambda: tap() or None)
    attempt(checks, "cgroup per vm", lambda: cgroups() or None)
    attempt(checks, "vms is writable", lambda: can_write(STATE / "vms" / "probe") or None)
    attempt(checks, "home is writable", lambda: can_write(HOME / "probe") or None)
    attempt(checks, "artifacts are read-only", lambda: cannot_write(STATE / "artifacts" / "probe"))
    attempt(checks, "state dir is read-only", lambda: cannot_write(STATE / "probe"))
    attempt(checks, "program is read-only", lambda: cannot_write(Path("/opt/code-reviewer/probe")))
    attempt(checks, "etc is read-only", lambda: cannot_write(Path("/etc/code-reviewer/probe")))
    attempt(checks, "no capability, no new privileges", capabilities)
    attempt(checks, "file descriptors", limits)
    attempt(checks, "firecracker runs", firecracker)
    attempt(checks, "environment", environment)
    result = {"release": os.environ.get("FACTORY_RUNNER_RELEASE", ""), "checks": checks}
    target = STATE / "vms" / "lane-probe.json"
    target.write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    while True:
        if PENDING.exists():
            sys.exit(10)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
