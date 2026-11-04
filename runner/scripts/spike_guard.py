# SPDX-License-Identifier: LicenseRef-Proprietary

"""The guard of `follow_up_spike.py` (#837): the script removes Docker containers by fixed names
and unmounts and deletes directories as root, so it runs on a `spike-` VM only, or where the one
who runs it says so."""

import tempfile
from collections.abc import Mapping
from pathlib import Path

OVERRIDE = "FOLLOW_UP_SPIKE_I_AM_ON_A_SPIKE_VM"
HOST_PREFIX = "spike-"


def refuse_unless_spike_vm(hostname: str, environ: Mapping[str, str]) -> None:
    if hostname.startswith(HOST_PREFIX) or environ.get(OVERRIDE) == "1":
        return
    raise SystemExit(
        f"refused: this host is {hostname!r}, not a {HOST_PREFIX}* VM, and the script removes "
        f"containers by fixed names and deletes directories as root. Set {OVERRIDE}=1 to run it "
        "here anyway."
    )


def fresh_out_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="follow-up-spike-"))
