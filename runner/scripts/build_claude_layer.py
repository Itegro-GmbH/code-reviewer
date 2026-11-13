# SPDX-License-Identifier: LicenseRef-Proprietary

"""What `docker/incus/build-golden.sh` needs of R3's Claude Code layer (#1023).

Claude Code is Anthropic's proprietary software and never ships with our repository or an image of
ours: the device that builds the Incus golden image installs it there, from the npm registry, with
the recipe of the Docker mode (`implementer/claude_code/layer.py`): the pinned version, the SHA-512
of the stub's tarball and of the platform program's, both checked before anything is installed, the
program unmodified, and its version checked after. This script only hands the shell that recipe, so
there is one pin and no second copy of it:

    build_claude_layer.py version
    build_claude_layer.py tag --base-id sha256:<agent image id>
    build_claude_layer.py context --base-id sha256:<agent image id> [--from REFERENCE]

`version` prints the pinned version, `tag` the tag the layer is stored under (the runner looks for
exactly that tag), `context` writes the build context (a tar with the one Dockerfile) to standard
output, for `docker build -`. `--from` builds the layer `FROM` an image reference (the agent's tag)
instead of the bare id: a Docker with the containerd image store resolves `FROM sha256:<id>` as a
name on Docker Hub and fails; the tag is the id that `--base-id` names (the caller read it just
before). Plain `python3` of the host, standard library and the runner's own
modules only; nothing is fetched here."""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_VERSION,
    LayerSpec,
    build_context,
    dockerfile,
    layer_tag,
)

_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
_REFERENCE = re.compile(r"[a-z0-9][a-zA-Z0-9._/:-]{0,200}")


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version")
    for name in ("tag", "context"):
        command = commands.add_parser(name)
        command.add_argument("--base-id", required=True)
        if name == "context":
            command.add_argument("--from", dest="reference")
    given = parser.parse_args(arguments)
    if given.command == "version":
        print(CLAUDE_CODE_VERSION)
        return 0
    if not _IMAGE_ID.fullmatch(given.base_id):
        print(
            "build_claude_layer: --base-id is an image id (sha256:<64 hex digits>)", file=sys.stderr
        )
        return 2
    spec = LayerSpec()
    if given.command == "tag":
        print(layer_tag(given.base_id, spec))
        return 0
    text = dockerfile(given.base_id, spec)
    if given.reference is not None:
        if not _REFERENCE.fullmatch(given.reference):
            print("build_claude_layer: --from is an image reference", file=sys.stderr)
            return 2
        text = text.replace(f"FROM {given.base_id}\n", f"FROM {given.reference}\n", 1)
    sys.stdout.buffer.write(build_context(text))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
