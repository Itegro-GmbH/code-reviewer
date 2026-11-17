# SPDX-License-Identifier: LicenseRef-Proprietary

"""What Control and the MCP door say to each other (#1067): the same channel as the model door's and
the network door's, the standard streams of the door's container and nothing else. **The door never
calls Control**; it calls the app (`POST /api/workers/v1/jobs/{id}/mcp/{server}`) with the job's
credential and nothing else.

Control to door:

* the first line, the **start document**: `{"version": 1, "appUrl", "jobId", "credential",
  "servers": [<id>, ...], "listenPort", "deadlineSeconds"}` and, on a customer's machine,
  `"outerProxy"`.
  It holds the **job credential** (`crj_...`): it travels on stdin and nowhere else, so that `docker
  inspect`, the process list and the environment of the container show none of it;
* `{"op": "stop"}`: end the open MCP sessions (`DELETE`), report the final state and exit.

Door to Control:

* `{"t": "ready"}` once the port answers; `{"t": "refused", "reason": <word>}` instead when it
cannot
  start;
* `{"t": "status", "final": true, "calls": n, "sessionsOpened": n, "sessionsClosed": n,
  "sessionsLeft": n}` when the door stops (counts only: no server, tool, argument or answer).
"""

from typing import Final

VERSION: Final = 1
MAX_START_BYTES: Final = 64 * 1024
MAX_COMMAND_BYTES: Final = 4096
MAX_SERVERS: Final = 50

REFUSED_START_INVALID: Final = "start_invalid"
REFUSED_LISTEN_FAILED: Final = "listen_failed"

OP_STOP: Final = "stop"
MESSAGE_READY: Final = "ready"
MESSAGE_STATUS: Final = "status"
MESSAGE_REFUSED: Final = "refused"
