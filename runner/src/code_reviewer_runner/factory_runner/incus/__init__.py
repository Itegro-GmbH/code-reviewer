# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Incus launcher of the local Dispatcher (#1007, Runner v2, epic #969, spike #1005): every job
runs in two unprivileged Incus instances on this machine, started by the dispatcher as a user of the
group `incus-admin`.

`docs/runner.md`, "The Incus launcher (#1007)", describes the parts: slots and their two bridges
(`slots.py`), the settings (`settings.py`), the client of the `incus` program (`client.py`), the
inner wall and the instances' network files (`walls.py`), Control's `docker run` for the unix
transport (`control_run.py`), the launcher itself (`launcher.py`), the objects of a machine
(`provision.py`) and the checks `run` makes (`prepare.py`)."""
