# SPDX-License-Identifier: LicenseRef-Proprietary

"""The other half of a release for the program lane (#1002): small VM artifacts and the two channel
files, signed with the lane's key (a PEM file made by `openssl ecparam`, as the release key is).

    lane_vm.py --served DIR --keyfile PEM --vm M --channels DIR --base URL

The installer takes the program and the VM artifacts as a pair (docs/runner.md, "Updates"); the
program in this lane is the real one the build made, the VM artifacts are the stand-ins of the
installer's tests (`runner/tests/unit/host_install_support.py`, whose manifest has the shape
`dispatcher/src/vm-artifacts/manifest.ts`). No VM boots here: the KVM lane has the real artifacts.
"""

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "tests" / "unit"))

from host_install_support import Release  # noqa: E402  (the path above makes it importable)

VM_FILES = (
    "vmlinux",
    "rootfs.ext4.zst",
    "dockerdata.ext4.zst",
    "vm-artifacts-manifest.json",
    "vm-artifacts-manifest.sig",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--served", type=Path, required=True)
    parser.add_argument("--keyfile", type=Path, required=True)
    parser.add_argument("--vm", type=int, required=True)
    parser.add_argument("--channels", type=Path, required=True)
    parser.add_argument("--base", required=True)
    arguments = parser.parse_args()
    key = serialization.load_pem_private_key(arguments.keyfile.read_bytes(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    release = Release(program=1, vm=arguments.vm, key=key)
    arguments.served.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as made:
        release.publish(Path(made))
        for name in VM_FILES:
            shutil.copy(Path(made) / name, arguments.served / name)
    release.write_channels(arguments.channels, arguments.base)


if __name__ == "__main__":
    main()
