# SPDX-License-Identifier: LicenseRef-Proprietary

"""Doubles for the tests of the Firecracker launcher (not a test file): a short state directory (a
Unix socket path holds at most 107 bytes), the fake Firecracker (`fake_firecracker.py`) behind a
shell wrapper, a disk maker that copies, and cgroups that record."""

import json
import shutil
import stat
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from code_reviewer_runner.factory_runner.firecracker.cgroups import VmLimits
from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.settings import FirecrackerSettings
from code_reviewer_runner.factory_runner.sandbox import WorkerStart

CREDENTIAL = "crj_credential-that-must-never-leak-0123456789"
LOCAL_CREDENTIAL = "local-credential-that-must-never-leak-0123456789"
IMAGE_ID = "sha256:" + "ab" * 32
FAKE = Path(__file__).with_name("fake_firecracker.py")


def start_for(number: int = 1, *, local: bool = False) -> WorkerStart:
    return WorkerStart(
        "http://172.31.0.1:8080",
        f"00000000-0000-4000-8000-{number:012d}",
        CREDENTIAL,
        {"CLAUDE_CODE_OAUTH_TOKEN": LOCAL_CREDENTIAL} if local else {},
    )


@dataclass
class RecordingCgroups:
    """The cgroup tree of a test: nothing real, everything noted."""

    created: list[tuple[str, VmLimits]] = field(default_factory=list[tuple[str, VmLimits]])
    killed: list[str] = field(default_factory=list[str])
    removed: list[str] = field(default_factory=list[str])
    prepared: int = 0
    root: Path = Path("/nonexistent-cgroup")

    def prepare(self) -> None:
        self.prepared += 1

    def create(self, name: str, limits: VmLimits) -> Path:
        self.created.append((name, limits))
        return self.root / name

    def kill(self, path: Path) -> None:
        self.killed.append(path.name)

    def remove(self, path: Path) -> bool:
        self.removed.append(path.name)
        return True

    def vm_cgroups(self) -> list[Path]:
        return []


def copying_disk(base: Path, destination: Path, quota: int) -> bool:
    shutil.copyfile(base, destination)
    destination.write_bytes(destination.read_bytes() + b"\0" * 16)
    return False


@contextmanager
def short_directory() -> Iterator[Path]:
    path = Path(tempfile.mkdtemp(prefix="fc"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class Rig:
    """A machine with a fake Firecracker whose behavior the test names."""

    def __init__(self, root: Path, **settings: Any) -> None:
        self.root = root
        artifacts = root / "artifacts"
        artifacts.mkdir()
        for name in ("vmlinux", "rootfs.ext4", "dockerdata.ext4"):
            (artifacts / name).write_bytes(b"x" * 64)
        self.behavior_file = root / "behavior.json"
        self.behavior(mode="good")
        wrapper = root / "firecracker"
        wrapper.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE} {self.behavior_file} "$@"\n')
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        values: dict[str, Any] = {
            "kernel": artifacts / "vmlinux",
            "rootfs": artifacts / "rootfs.ext4",
            "base_disk": artifacts / "dockerdata.ext4",
            "image_id": IMAGE_ID,
            "state_dir": root,
            "firecracker": wrapper,
            "outer_wall": OuterWallMode.INNER_ONLY,
            "boot_connect_seconds": 10.0,
            "start_ack_seconds": 10.0,
            "kill_grace_seconds": 3.0,
        }
        values.update(settings)
        self.settings = FirecrackerSettings(**values)
        self.cgroups = RecordingCgroups()
        (root / "vms").mkdir()

    def behavior(self, **behavior: Any) -> None:
        self.behavior_file.write_text(json.dumps(behavior))

    def seen(self) -> dict[str, Any]:
        return json.loads(self.behavior_file.with_suffix(".seen").read_text())

    def sandbox(self, **changes: Any) -> FirecrackerSandbox:
        values: dict[str, Any] = {
            "settings": self.settings,
            "cgroups": self.cgroups,
            "make_disk": copying_disk,
        }
        values.update(changes)
        return FirecrackerSandbox(**values)

    def vm_directories(self) -> list[str]:
        return sorted(path.name for path in (self.root / "vms").iterdir())
