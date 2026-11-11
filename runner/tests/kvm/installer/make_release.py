# SPDX-License-Identifier: LicenseRef-Proprietary

"""Publishes a release of the installer lane (#982) into a directory the lane serves over https: the
program is the lane's own stand-in (`lane-runner.sh`, `lane_service.py`), the VM artifacts are
small files, both signed with a key that lives in a file (so that the second release has the first
one's key).

    make_release.py --served DIR --keyfile PEM --program N --vm M [--tamper NAME]...
        [--channels DIR --base URL]
"""

import argparse
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "unit"))

from host_install_support import Release  # noqa: E402  (the path above makes it importable)


def key(path: Path) -> ec.EllipticCurvePrivateKey:
    if path.exists():
        loaded = serialization.load_pem_private_key(path.read_bytes(), password=None)
        assert isinstance(loaded, ec.EllipticCurvePrivateKey)
        return loaded
    created = ec.generate_private_key(ec.SECP256R1())
    path.write_bytes(
        created.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return created


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--served", type=Path, required=True)
    parser.add_argument("--keyfile", type=Path, required=True)
    parser.add_argument("--program", type=int, required=True)
    parser.add_argument("--vm", type=int, required=True)
    parser.add_argument("--tamper", action="append", default=[])
    parser.add_argument("--channels", type=Path)
    parser.add_argument("--base")
    arguments = parser.parse_args()
    release = Release(
        program=arguments.program,
        vm=arguments.vm,
        key=key(arguments.keyfile),
        runner_script=(HERE / "lane-runner.sh").read_text(),
        extra_files={"share/lane_service.py": ((HERE / "lane_service.py").read_bytes(), 0o644)},
        tamper=set(arguments.tamper),
    )
    release.publish(arguments.served)
    if arguments.channels is not None:
        release.write_channels(arguments.channels, arguments.base)


if __name__ == "__main__":
    main()
