# SPDX-License-Identifier: LicenseRef-Proprietary

"""The other half of a release for the program lane (#1002): small VM artifacts and the two channel
files, signed with the lane's key (a PEM file made by `openssl ecparam`, as the release key is).

    lane_vm.py --served DIR --keyfile PEM --vm M [--vm K]... [--channels DIR --base URL]

The installer takes the program and the VM artifacts release it names (`share/release.json`,
exact) as a pair (docs/runner.md, "Updates"); the program in this lane is the real one the build
made, the VM artifacts are the stand-ins of the installer's tests
(`runner/tests/unit/host_install_support.py`, whose manifest has the shape
`dispatcher/src/vm-artifacts/manifest.ts`). Each VM release goes to `DIR/vm/<release>/`, the
address per release of the channel written to `--channels` (`<base>vm/{release}/`). No VM boots
here: the KVM lane has the real artifacts.
"""

import argparse
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "tests" / "unit"))

from host_install_support import Release  # noqa: E402  (the path above makes it importable)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--served", type=Path, required=True)
    parser.add_argument("--keyfile", type=Path, required=True)
    parser.add_argument("--vm", type=int, action="append", required=True)
    parser.add_argument("--channels", type=Path)
    parser.add_argument("--base")
    arguments = parser.parse_args()
    key = serialization.load_pem_private_key(arguments.keyfile.read_bytes(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    for vm in arguments.vm:
        Release(program=1, vm=vm, key=key).publish_vm(arguments.served / "vm" / str(vm))
    if arguments.channels is not None:
        assert arguments.base is not None
        Release(program=1, vm=arguments.vm[0], key=key).write_channels(
            arguments.channels, arguments.base, vm_base=f"{arguments.base}vm/{{release}}/"
        )


if __name__ == "__main__":
    main()
