# SPDX-License-Identifier: LicenseRef-Proprietary

"""The labels every container and network of Control carries (#854, R1b).

`code-reviewer.role` says what a thing is (the door, the agent, the reader ...); it is how a runner
finds what an earlier run left behind. `code-reviewer.runner` says whose it is: a customer's runner
names its id in `RUNNER_ID_VARIABLE` of the job process, and everything that job creates carries it,
so the runner removes its own leftovers and no other runner's. The hosted Control sets no id and
its labels are the role alone.
"""

import os
from collections.abc import Mapping
from typing import Final

ROLE_LABEL: Final = "code-reviewer.role"
RUNNER_LABEL: Final = "code-reviewer.runner"
RUNNER_ID_VARIABLE: Final = "RUNNER_IMPLEMENTER_RUNNER_ID"


def role_labels(role: str, environment: Mapping[str, str] | None = None) -> dict[str, str]:
    """The labels of a container or a network in `role`; `environment` is the process's own."""
    labels = {ROLE_LABEL: role}
    runner = (os.environ if environment is None else environment).get(RUNNER_ID_VARIABLE, "")
    if runner.strip():
        labels[RUNNER_LABEL] = runner.strip()
    return labels
