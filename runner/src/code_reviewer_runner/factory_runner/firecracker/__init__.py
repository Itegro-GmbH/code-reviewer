# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Firecracker launcher of the local Dispatcher (#978, Runner v2, epic #969, ADR 0005): the
`WorkerSandbox` that starts a job's Worker in a microVM on a customer's own Linux machine.

`docs/runner.md`, "The Firecracker launcher", describes the parts: slots and TAP devices
(`slots.py`), the job disk (`disks.py`), the delegated cgroup (`cgroups.py`), the Firecracker
process (`vmm.py`), Control's `docker run` (`control_run.py`), the host side of the vsock protocol
(`wire.py`, `session.py`, `endpoint.py`, `tokens.py`, `outer_wall.py`), the sandbox itself
(`launcher.py`) and the clean-up of what a crashed service left (`reaper.py`)."""
