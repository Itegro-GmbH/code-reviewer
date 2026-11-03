# SPDX-License-Identifier: LicenseRef-Proprietary

"""The golden snapshot's proof of the reader (#745, step 4): the reader that production makes, on
the runtime the snapshot proves, with the commands production runs in it.

The snapshot's Sysbox proof (`dispatcher/src/snapshot/scripts.ts`) used to start a reader of its
own making (`docker run --cap-drop ALL ...`), so what it proved was not what ships; and Sysbox
ignores `--cap-drop` (measured), so the flag proved nothing. This module makes the two readers from
`reader.reader_document`, the document `ReaderAccess` sends, over the proof's volume, and runs in
them the commands a planted program would face: what the capabilities of a command are (the
bounding set `READER_DROP_CAPABILITIES` cuts them to `DAC_OVERRIDE`), that the read-only reader
reads and does not write, that it cannot make its volume writable by a remount (with the commands'
capabilities and with every capability its container's root has), that the root file system stays
read-only in both, and that the reader that writes writes.

It runs in the Worker image with the Docker socket, as root, and prints one
`READER_PROOF ok <check>` or `READER_PROOF fail <check>` per check and `READER_PROOF done` last. It
exits 0 whatever it found: the script reads the lines.
"""

import argparse
import contextlib
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Final

from .docker_api import DockerApi, DockerError
from .exec_run import run_exec
from .reader import (
    READER_DROP_CAPABILITIES,
    READER_REPO,
    READER_RUNTIME,
    reader_document,
    reader_environment,
)

PROOF_PREFIX: Final = "READER_PROOF"
READER_NAME: Final = "sbxp-reader"
WRITER_NAME: Final = "sbxp-reader-rw"
# The capabilities a command in a reader holds: DAC_OVERRIDE (bit 1), nothing else.
EXPECTED_CAPABILITIES: Final = "0000000000000002"
STEP_SECONDS: Final = 30.0

# What a planted program finds out. One line per fact, `<fact> <value>`.
PROBE: Final = r"""
command -v mount > /dev/null 2>&1 && echo "tools yes" || echo "tools no"
echo "caps $(grep '^CapEff' /proc/self/status | cut -f2)"
cat /repo/from-control /repo/from-agent > /dev/null 2>&1 && echo "read yes" || echo "read no"
touch /repo/reader-wrote 2> /dev/null && echo "write yes" || echo "write no"
mount -o remount,rw /repo 2> /dev/null && echo "remount yes" || echo "remount no"
touch /repo/reader-wrote 2> /dev/null && echo "write-after yes" || echo "write-after no"
mount -o remount,rw / 2> /dev/null && echo "remount-root yes" || echo "remount-root no"
touch /reader-wrote-root 2> /dev/null && echo "write-root yes" || echo "write-root no"
rm -f /repo/reader-wrote
"""
# The same facts for the command with no drop: every capability the container's root has.
REMOUNT_ALL_CAPABILITIES: Final = r"""
mount -o remount,rw /repo 2> /dev/null && echo "remount yes" || echo "remount no"
touch /repo/reader-wrote 2> /dev/null && echo "write-after yes" || echo "write-after no"
rm -f /repo/reader-wrote
"""


def parse(text: str) -> dict[str, str]:
    """`<fact> <value>` lines to a mapping; the last of a fact wins."""
    facts: dict[str, str] = {}
    for line in text.splitlines():
        name, _, value = line.strip().partition(" ")
        if name:
            facts[name] = value.strip()
    return facts


def failures(
    reading: Mapping[str, str], writing: Mapping[str, str], unrestricted: Mapping[str, str]
) -> list[str]:
    """The names of the checks that failed, from the facts of the read-only reader, of the reader
    that writes and of the read-only reader's unrestricted command."""
    failed: list[str] = []

    def expect(name: str, facts: Mapping[str, str], fact: str, value: str, label: str) -> None:
        if facts.get(fact) != value:
            failed.append(f"{label}_{name}")

    for label, facts in (("reader", reading), ("writer", writing)):
        expect("tools", facts, "tools", "yes", label)
        expect("capabilities", facts, "caps", EXPECTED_CAPABILITIES, label)
        expect("root_remount", facts, "remount-root", "no", label)
        expect("root_write", facts, "write-root", "no", label)
    expect("read", reading, "read", "yes", "reader")
    expect("write", reading, "write", "no", "reader")
    expect("remount", reading, "remount", "no", "reader")
    expect("write_after_remount", reading, "write-after", "no", "reader")
    expect("write", writing, "write", "yes", "writer")
    expect("remount_all_capabilities", unrestricted, "remount", "no", "reader")
    expect("write_after_all_capabilities", unrestricted, "write-after", "no", "reader")
    return failed


def _facts(
    api: DockerApi,
    container: str,
    script: str,
    *,
    drop: bool,
    environment: Mapping[str, str],
) -> dict[str, str]:
    command = ["/bin/sh", "-c", script]
    done = run_exec(
        api,
        container,
        [*READER_DROP_CAPABILITIES, *command] if drop else command,
        env=environment,
        workdir=READER_REPO,
        timeout=STEP_SECONDS,
        name="the reader proof",
    )
    return {} if done.unanswered else parse(done.stdout)


def prove(
    api: DockerApi,
    image: str,
    volume: str,
    *,
    runtime: str = READER_RUNTIME,
    report: Callable[[str], None],
) -> list[str]:
    """Make both readers over `volume` as production does, run the probes and return the names of
    the checks that failed (also `report`ed). The readers are removed at the end."""
    environment = reader_environment()
    made: list[str] = []
    failed: list[str] = []
    try:
        reading = api.create_container(reader_document(image, volume, runtime=runtime), READER_NAME)
        made.append(reading)
        writing = api.create_container(
            reader_document(image, volume, writable=True, runtime=runtime), WRITER_NAME
        )
        made.append(writing)
        api.start_container(reading)
        api.start_container(writing)
        read_facts = _facts(api, reading, PROBE, drop=True, environment=environment)
        write_facts = _facts(api, writing, PROBE, drop=True, environment=environment)
        loose_facts = _facts(
            api, reading, REMOUNT_ALL_CAPABILITIES, drop=False, environment=environment
        )
        failed = failures(read_facts, write_facts, loose_facts)
        # The proof's own leftovers are the writer's to remove; nothing else touches the volume.
        _facts(api, writing, "rm -f /repo/reader-wrote", drop=True, environment=environment)
    except DockerError as error:
        failed = [f"reader_unavailable_{error.status}"]
    finally:
        for container in made:
            with contextlib.suppress(DockerError):
                api.remove_container(container)
    for name in failed:
        report(f"{PROOF_PREFIX} fail {name}")
    if not failed:
        report(f"{PROOF_PREFIX} ok reader_contained")
    report(f"{PROOF_PREFIX} done")
    return failed


def main(
    argv: Sequence[str], *, api: DockerApi | None = None, write: Callable[[str], None] | None = None
) -> int:
    parser = argparse.ArgumentParser(prog="reader_proof")
    parser.add_argument("--image", required=True)
    parser.add_argument("--volume", required=True)
    parser.add_argument("--runtime", default=READER_RUNTIME)
    options = parser.parse_args(list(argv))
    prove(
        api or DockerApi(),
        options.image,
        options.volume,
        runtime=options.runtime,
        report=write or (lambda line: print(line, flush=True)),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
