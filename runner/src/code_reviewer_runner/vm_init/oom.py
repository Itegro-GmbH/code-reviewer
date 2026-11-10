# SPDX-License-Identifier: LicenseRef-Proprietary

"""vm-init protects itself from the guest's OOM killer: it is the one process that tells the host
how the VM ended, so the kernel must pick anything else first. `-1000` is "never" (it needs root,
which vm-init is, and no capability the container's agent has)."""

import logging
from typing import Final

_log = logging.getLogger(__name__)

OOM_SCORE_ADJ_PATH: Final = "/proc/self/oom_score_adj"
OOM_SCORE_ADJ_NEVER: Final = "-1000"


def protect_from_oom(path: str = OOM_SCORE_ADJ_PATH) -> bool:
    """Sets the process's `oom_score_adj` to -1000. True when it is set; False (and a log line) when
    it could not be: vm-init then still runs, a little less safe."""
    try:
        with open(path, "w", encoding="ascii") as handle:
            handle.write(OOM_SCORE_ADJ_NEVER)
    except OSError:
        _log.warning("vm-init: oom_score_adj could not be set")
        return False
    return True
