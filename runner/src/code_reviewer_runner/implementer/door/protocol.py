# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Control container and the model door say to each other (#745, step 3).

One channel, and it is the standard streams of the door container, which only the Docker daemon
and the one process that started it hold: no port, no file, no volume. Control writes lines to the
door's stdin, the door writes lines to its stdout; each line is one JSON object. **The door never
calls Control**: it answers on the pipe that Control opened, and a door that is cut off (stdin
closed) ends itself. The agent reaches the door by one other way only, the model port, which has
no route to this channel.

Control to door:

* the first line, the **start document** (`version`, `modelAccess`, `capability`, `deadlineSeconds`,
  `listenPort`, `environment`): the key is in it, and in no argument, no environment variable and no
  file of the container;
* `{"op": "stop"}`: stop serving, report the final state and exit.

Door to Control:

* `{"t": "ready"}` once the model port answers;
* `{"t": "status", ...}` whenever the state changed (the cost and the tokens so far, whether a
  model call is open, what stopped the turn, `final` on the last one);
* `{"t": "refused", "reason": <word>}` instead of `ready` when the door cannot start. A word,
  never a value.

The state is the ledger of the turn (`budget.py`) as the door counts it: the one place money is
counted. Control reads it; the agent can neither read nor write it.
"""

from dataclasses import dataclass, field
from typing import Any, Final

VERSION: Final = 1
# The start document holds the key and the cost policy (the price book): far below this.
MAX_START_BYTES: Final = 256 * 1024
MAX_COMMAND_BYTES: Final = 4096

# The words of a refusal to start (`{"t": "refused", "reason": ...}`).
REFUSED_START_INVALID: Final = "start_invalid"
REFUSED_ACCESS_INVALID: Final = "model_access_invalid"
REFUSED_CONFIG_INVALID: Final = "config_invalid"
REFUSED_LISTEN_FAILED: Final = "listen_failed"
REFUSALS: Final = (
    REFUSED_START_INVALID,
    REFUSED_ACCESS_INVALID,
    REFUSED_CONFIG_INVALID,
    REFUSED_LISTEN_FAILED,
)

OP_STOP: Final = "stop"
MESSAGE_READY: Final = "ready"
MESSAGE_STATUS: Final = "status"
MESSAGE_REFUSED: Final = "refused"


class DoorRefused(Exception):
    """The door cannot start. Carries a word of `REFUSALS`, never a value."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class DoorFailure:
    """What stopped the turn at the door, as the ledger recorded it: a stable code and a sentence
    of ours (`LimitError`)."""

    code: str
    detail: str


@dataclass(frozen=True)
class DoorStatus:
    """The state of the door's ledger at one moment, read back by Control."""

    seq: int
    final: bool
    model_used: bool
    open_calls: int
    failure: DoorFailure | None
    upstream_error: str | None
    usage: dict[str, Any]
    model_calls: list[dict[str, Any]] = field(default_factory=lambda: [])
    truncated: bool = False
