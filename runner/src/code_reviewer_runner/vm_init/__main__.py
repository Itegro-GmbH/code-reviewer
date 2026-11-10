# SPDX-License-Identifier: LicenseRef-Proprietary

"""`vm-init`: the entry point (`python3 vm-init.pyz`, or `python3 -m vm_init` from a directory that
holds the package). The guest's init runs it once Docker's files are in place and waits for it; when
it returns, the VM did not end and the init has to."""

import logging
import sys
from collections.abc import Sequence

from .agent import Environment, VmInit
from .control import spawn_docker
from .steps import SubprocessRunner
from .transport import RealVsock
from .wire import (
    HOST_CID,
    MAX_FRAME_BYTES,
    PROTOCOL_VERSION,
    REPORT_PORT,
    START_PORT,
)

USAGE = "usage: vm-init [--version]"


def _version() -> str:
    return (
        f"vm-init protocol {PROTOCOL_VERSION} start-port {START_PORT} report-port {REPORT_PORT} "
        f"host-cid {HOST_CID} max-frame {MAX_FRAME_BYTES}"
    )


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments == ["--version"]:
        print(_version())
        return 0
    if arguments:
        print(USAGE, file=sys.stderr)
        return 64
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="vm-init: %(message)s")
    ended = VmInit(
        Environment(vsock=RealVsock(), runner=SubprocessRunner(), spawn=spawn_docker)
    ).run()
    # Only a VM that did not end gets here.
    return 0 if ended else 1


def run() -> None:
    """The entry the zipapp calls (`zipapp` ignores what its entry function returns)."""
    sys.exit(main())


if __name__ == "__main__":
    run()
