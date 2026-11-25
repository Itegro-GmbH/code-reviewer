# SPDX-License-Identifier: LicenseRef-Proprietary

"""The VM's intercept CA bundle for the containers Control makes (#1158, epic #1157).

On the Cloudflare placement the outbound handler terminates TLS for every request the VM makes, so
a container that does not trust its authority reaches nothing over https. The Dispatcher binds the
VM's one bundle (`/etc/cr-sandbox/ca-bundle.crt`: the system's roots plus that authority, made by
the image's boot) read-only into Control's own container and sets the variables there. Control
makes the other containers of the VM (the doors, the readers, the setup and agent container) with
the VM's Docker, so it gives them the same file at the same path and the same variables: the path
is a host path of the VM, which is also where Control sees it.

Where the file does not exist (every other placement) nothing is added: documents are sent as they
were made. The agent's own variables win: a document that sets one of the names keeps its value (the
agent's trust bundle of the network door, #784, is built from these roots, `system_roots`)."""

import copy
import os
from typing import Any, Final

INTERCEPT_CA_BUNDLE: Final = "/etc/cr-sandbox/ca-bundle.crt"
INTERCEPT_CA_VARIABLES: Final = (
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
)


def with_intercept_ca(document: dict[str, Any], *, path: str | None = None) -> dict[str, Any]:
    """The create document of a container with the VM's bundle bound read-only at its own path and
    the five variables set to it. The same document where the bundle does not exist; a variable
    the document already sets keeps its value. The caller's document is not changed."""
    bundle = INTERCEPT_CA_BUNDLE if path is None else path
    if not os.path.isfile(bundle):
        return document
    result = copy.deepcopy(document)
    host_config = result.setdefault("HostConfig", {})
    host_config["Binds"] = [*host_config.get("Binds", []), f"{bundle}:{bundle}:ro"]
    environment: list[str] = list(result.get("Env", []))
    named = {entry.split("=", 1)[0] for entry in environment}
    environment.extend(f"{name}={bundle}" for name in INTERCEPT_CA_VARIABLES if name not in named)
    result["Env"] = environment
    return result


def system_roots(*, path: str | None = None, fallback: str) -> bytes:
    """The roots the agent's trust bundle starts with: the VM's bundle (the system's roots and the
    intercept authority) where it exists, else the image's own file."""
    bundle = INTERCEPT_CA_BUNDLE if path is None else path
    return open(bundle if os.path.isfile(bundle) else fallback, "rb").read()
