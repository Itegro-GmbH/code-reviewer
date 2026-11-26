# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the model door in its subscription mode (#1176) through the VM's Docker, against
the fake daemon of `test_model_door_launcher.py`: the token reaches the door on its stdin and is in
no request to the daemon. (A file of its own, after the network door's tests in the suite's order:
the launcher rig leaves a few file descriptors per test and the serial unit run is close to the
limit.)"""

import http.client
import json

from test_model_door_launcher import Rig, call_bodies, rig  # noqa: F401  # pyright: ignore[reportUnusedImport]

from code_reviewer_runner.dynamic_review.model_door_route import MODEL_DOOR_ADDRESS
from code_reviewer_runner.implementer.door.subscription import SUBSCRIPTION_PLACEHOLDER
from code_reviewer_runner.implementer.door_launcher import (
    DOOR_CONTAINER_NAME,
    start_subscription_door,
)


# #1176-T20
def test_the_token_of_a_subscription_turn_reaches_the_door_on_stdin_and_is_in_no_request(
    rig: Rig,  # noqa: F811
) -> None:
    token = "sk-" + "ant-" + "oat01-LAUNCHERTOKEN-0123456789abcdef"

    door = start_subscription_door(token=token, deadline_seconds=600.0, port=10180, seams=rig.seams)
    connection = http.client.HTTPConnection("127.0.0.1", rig.port, timeout=10)
    connection.request(
        "POST",
        "/v1/messages",
        b"{}",
        {"Authorization": f"Bearer {SUBSCRIPTION_PLACEHOLDER}", "Content-Length": "2"},
    )
    assert connection.getresponse().status == 200
    connection.close()
    door.stop()

    sent = call_bodies(rig.engine)
    assert token not in sent, "in no request to the daemon"
    container = rig.engine.container(DOOR_CONTAINER_NAME)
    assert token not in json.dumps(container.document) and container.document["Env"] == []
    assert token not in "".join(container.stderr_text)
    forwarded = {name.lower(): value for name, value in rig.upstream.requests[0].headers.items()}
    assert forwarded["authorization"] == f"Bearer {token}"
    assert door.url == f"http://{MODEL_DOOR_ADDRESS}:10180"
