# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fixtures of the KVM lane (#978): a job in a real Firecracker VM, started by the launcher of the
local Dispatcher. The lane needs `/dev/kvm`, the VM artifacts of the build, a TAP device for the
slot and a delegated cgroup (`.github/workflows/vm-artifacts.yml` makes them)."""

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from runner_app import FakeRunnerApp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kvm_support import Machine, load_machine


@pytest.fixture(scope="session")
def machine() -> Machine:
    return load_machine()


@pytest.fixture
def app() -> Iterator[FakeRunnerApp]:
    """The App on every address, so that the VM reaches it through its TAP device."""
    fake = FakeRunnerApp(bind_host="0.0.0.0").start()
    fake.credentials["crc_" + "K" * 43] = "runner-kvm"
    try:
        yield fake
    finally:
        fake.stop()
