# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where the Implementer's model door is (#745, step 3): one fixed address on one fixed network.

The door is a container of its own that holds the model key and the cost limit
(`implementer/door/`).
The Control container (the Worker) creates the network the door sits on, and the agent's container
(step 4) sits on it too. Control is **not** on it: it talks to the door over the door's standard
streams and to the agent through the Docker daemon, so the agent has no address of Control's to
connect to. The addresses are constants (the agent's inner containers reach the door by its address,
a name does not resolve there). Nothing about them comes from a job.

The network is `--internal` with `com.docker.network.bridge.gateway_mode_ipv4=isolated`: no exit and
no route to the VM, so whoever sits on it reaches the other members of that network and nothing
else.
"""

from typing import Final

# The variable the Dispatcher sets on an Implementer container that may start the door (the profile
# of the container carries the VM's Docker socket then). Unset: the proxy runs in the Worker, as it
# did before step 3.
MODEL_DOOR_VARIABLE: Final = "RUNNER_IMPLEMENTER_MODEL_DOOR"
MODEL_DOOR_MODE: Final = "docker"

# A /29 of 10.0.0.0/8 that nothing else on a VM uses (the Docker bridge pool is 172.16/12, the
# platform's own network is not 10.213.77/29): .1 the network's own, .2 the model door, .3 the
# network door (step 7), .4 the agent.
MODEL_NETWORK_NAME: Final = "code-reviewer-model"
MODEL_NETWORK_SUBNET: Final = "10.213.77.0/29"
MODEL_NETWORK_GATEWAY: Final = "10.213.77.1"
MODEL_DOOR_ADDRESS: Final = "10.213.77.2"
MODEL_AGENT_ADDRESS: Final = "10.213.77.4"
# The network door (#745, step 7): the HTTP and HTTPS proxy the environment's network rule is
# enforced in. It sits on the model network at its own fixed address; the agent and the containers
# it starts reach it by this address (a name does not resolve there).
NETWORK_DOOR_ADDRESS: Final = "10.213.77.3"
NETWORK_DOOR_PORT: Final = 3128
