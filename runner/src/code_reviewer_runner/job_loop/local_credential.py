# SPDX-License-Identifier: LicenseRef-Proprietary

"""The one credential that exists only on the dispatcher's device and that a job needs (#980, ADR 0005,
decision 4): a Claude Code subscription token, handed to the Worker on its standard input, never
through the app.

There is **one shape** and **one allow-list** for both ways a dispatcher starts a Worker: the start
document of the Worker's process (`factory_runner/sandbox.py`) and the `localCredential` of
vm-init's start (`contracts/vm-init.v1.json`, which vm-init puts on Control's standard input) carry
`{"name": "<VARIABLE>", "value": "<token>"}`. The Worker (Control in a VM, the local Worker of a
process) reads it with `worker.parse_local_credential` and refuses every name it does not know before
it puts the value into any environment: vm-init and the dispatcher check the shape, this list decides
the names. The host side (`firecracker/control_run.py`) checks the same list again.
"""

import re
from dataclasses import dataclass, field
from typing import Final

from code_reviewer_runner.implementer.claude_code.login import OAUTH_VARIABLE

# The variables a device may hand a Worker. The job process gets `{**env, name: value}`, so any other
# name would let a start document override what the machine decided (PATH, LD_PRELOAD, RUNNER_*).
LOCAL_CREDENTIAL_NAMES: Final = frozenset({OAUTH_VARIABLE})
# What the value may be: one printable token, like the login of Claude Code.
LOCAL_CREDENTIAL_VALUE: Final = re.compile(r"[\x21-\x7e]{1,4096}")


@dataclass(frozen=True)
class LocalCredential:
    """The credential of one job: a variable name of the allow-list and its value. Nothing prints
    the value: `repr` and `str` show the name only."""

    name: str
    value: str = field(repr=False)

    def environment(self) -> dict[str, str]:
        """The variable the job process reads."""
        return {self.name: self.value}

    def __str__(self) -> str:
        return f"<local credential: {self.name}>"
