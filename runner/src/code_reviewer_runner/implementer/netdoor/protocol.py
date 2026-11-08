# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Control container and the network door say to each other (#745, step 7): the same
channel as the model door's (`../door/protocol.py`), the standard streams of the door's container
and nothing else. **The door never calls Control.**

Control to door:

* the first line, the **start document**: `{"version": 1, "rule": {"mode", "hosts"}, "listenPort",
  "deadlineSeconds"}`. No secret is in it; it travels on stdin and not in an argument because the
  rule is the job's text, which no command line may carry;
* `{"op": "stop"}`: stop serving, report the final state and exit.

Door to Control:

* `{"t": "ready"}` once the port answers; when the rule names a package registry (`registries.py`,
  #784) it has `"ca"`, the PEM of the public certificate of the door's authority (`authority.py`),
  which Control puts into the agent's container so that its tools trust the door for the registries.
  The authority's private key is never sent;
* `{"t": "status", "seq", "final", ...}` (the log of `connections.py`) whenever it changed, at most
  once a second, and a last one with `final` true when the door stops;
* `{"t": "refused", "reason": <word>}` instead of `ready` when the door cannot start.
"""

from typing import Final

VERSION: Final = 1
MAX_START_BYTES: Final = 64 * 1024
MAX_COMMAND_BYTES: Final = 4096

REFUSED_START_INVALID: Final = "start_invalid"
REFUSED_RULE_INVALID: Final = "rule_invalid"
REFUSED_LISTEN_FAILED: Final = "listen_failed"
REFUSED_CA_FAILED: Final = "ca_failed"

OP_STOP: Final = "stop"
MESSAGE_READY: Final = "ready"
MESSAGE_STATUS: Final = "status"
MESSAGE_REFUSED: Final = "refused"
