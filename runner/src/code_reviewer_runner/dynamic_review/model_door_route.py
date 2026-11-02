# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where the Implementer's model door is (#745, step 3): one fixed address on one fixed network.

The door is a container of its own that holds the model key and the cost limit
(`implementer/door/`).
The Control container (the Worker) creates the network it sits on and the agent reaches it there.
The address is a constant so that the engine user's network rules, which are installed once at
container start and cannot change afterwards (`static_isolation.py`), can name it. Nothing about it
comes from a job.

The network is `--internal` with `com.docker.network.bridge.gateway_mode_ipv4=isolated`: no exit and
no route to the VM, so whoever sits on it reaches the other members of that network and nothing
else. Step 4 puts the agent container there instead of the Worker; the address stays.
"""

from typing import Final

# The variable the Dispatcher sets on an Implementer container that may start the door (the profile
# of the container carries the VM's Docker socket then). Unset: the proxy runs in the Worker, as it
# did before step 3.
MODEL_DOOR_VARIABLE: Final = "RUNNER_IMPLEMENTER_MODEL_DOOR"
MODEL_DOOR_MODE: Final = "docker"

# A /29 of 10.0.0.0/8 that nothing else on a VM uses (the Docker bridge pool is 172.16/12, the
# platform's own network is not 10.213.77/29): .1 the network's own, .2 the door, .3 Control.
MODEL_NETWORK_NAME: Final = "code-reviewer-model"
MODEL_NETWORK_SUBNET: Final = "10.213.77.0/29"
MODEL_NETWORK_GATEWAY: Final = "10.213.77.1"
MODEL_DOOR_ADDRESS: Final = "10.213.77.2"
MODEL_CONTROL_ADDRESS: Final = "10.213.77.3"
