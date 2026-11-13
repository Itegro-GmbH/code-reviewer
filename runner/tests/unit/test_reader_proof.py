# SPDX-License-Identifier: LicenseRef-Proprietary

"""The golden snapshot's proof of the reader (#745, step 4): it makes the readers from the document
production sends, runs the commands production runs in them, and says which check failed."""

import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import IMAGE_ID, WORK_VOLUME, FakeDockerEngine, FakeExec

from code_reviewer_runner.implementer import reader_proof
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.reader import READER_DROP_CAPABILITIES, reader_document

CONTAINED_READER = """tools yes
caps 0000000000000002
read yes
write no
remount no
write-after no
remount-root no
write-root no
"""
CONTAINED_WRITER = """tools yes
caps 0000000000000002
read yes
write yes
remount no
write-after yes
remount-root no
write-root no
"""
LOOSE = """remount no
write-after no
"""


@pytest.fixture
def engine() -> Iterator[tuple[FakeDockerEngine, DockerApi]]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="proof-") as directory:
        socket_path = Path(directory) / "docker.sock"
        fake = FakeDockerEngine(socket_path).start()
        yield fake, DockerApi(str(socket_path), timeout=5.0)
        fake.stop()


def answer(
    reader: str = CONTAINED_READER, writer: str = CONTAINED_WRITER, loose: str = LOOSE
) -> Any:
    def behave(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        command: list[str] = made.document["Cmd"]
        script = command[-1]
        if script.startswith("rm -f"):
            return 0
        if command[: len(READER_DROP_CAPABILITIES)] != list(READER_DROP_CAPABILITIES):
            stdout.write(loose)
        elif made.container == reader_proof.WRITER_NAME:
            stdout.write(writer)
        else:
            stdout.write(reader)
        return 0

    return behave


def prove(engine: tuple[FakeDockerEngine, DockerApi]) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    failed = reader_proof.prove(engine[1], IMAGE_ID, WORK_VOLUME, report=lines.append)
    return failed, lines


# #745-T23
def test_the_proof_makes_the_readers_from_the_document_production_sends(
    engine: tuple[FakeDockerEngine, DockerApi],
) -> None:
    fake, _ = engine
    fake.exec_behaviour = answer()

    failed, lines = prove(engine)

    assert failed == [] and lines == ["READER_PROOF ok reader_contained", "READER_PROOF done"]
    reading = fake.container(reader_proof.READER_NAME)
    writing = fake.container(reader_proof.WRITER_NAME)
    assert reading.document == reader_document(IMAGE_ID, WORK_VOLUME)
    assert writing.document == reader_document(IMAGE_ID, WORK_VOLUME, writable=True)
    assert reading.removed and writing.removed, "the proof leaves nothing on the VM"


# #745-T23: what a planted program holds is judged with the bounding set production drops to
def test_the_probes_run_under_the_drop_of_production_and_once_without_it(
    engine: tuple[FakeDockerEngine, DockerApi],
) -> None:
    fake, _ = engine
    fake.exec_behaviour = answer()

    prove(engine)

    commands = [made.document["Cmd"] for made in fake.execs.values()]
    dropped = [
        c for c in commands if c[: len(READER_DROP_CAPABILITIES)] == list(READER_DROP_CAPABILITIES)
    ]
    loose = [c for c in commands if c not in dropped]
    assert len(dropped) >= 2 and len(loose) == 1
    assert fake.execs and all(
        made.document["WorkingDir"] == "/repo" for made in fake.execs.values()
    )


@pytest.mark.parametrize(
    ("reader", "writer", "loose", "name"),
    [
        (
            CONTAINED_READER.replace("write no", "write yes"),
            CONTAINED_WRITER,
            LOOSE,
            "reader_write",
        ),
        (
            CONTAINED_READER.replace("remount no", "remount yes"),
            CONTAINED_WRITER,
            LOOSE,
            "reader_remount",
        ),
        (CONTAINED_READER.replace("read yes", "read no"), CONTAINED_WRITER, LOOSE, "reader_read"),
        (
            CONTAINED_READER.replace("0000000000000002", "000001ffffffffff"),
            CONTAINED_WRITER,
            LOOSE,
            "reader_capabilities",
        ),
        (
            CONTAINED_READER.replace("tools yes", "tools no"),
            CONTAINED_WRITER,
            LOOSE,
            "reader_tools",
        ),
        (
            CONTAINED_READER,
            CONTAINED_WRITER.replace("write yes", "write no"),
            LOOSE,
            "writer_write",
        ),
        (
            CONTAINED_READER,
            CONTAINED_WRITER.replace("remount-root no", "remount-root yes"),
            LOOSE,
            "writer_root_remount",
        ),
        (
            CONTAINED_READER,
            CONTAINED_WRITER,
            "remount yes\nwrite-after yes\n",
            "reader_remount_all_capabilities",
        ),
        (CONTAINED_READER, CONTAINED_WRITER, "", "reader_remount_all_capabilities"),
        ("", CONTAINED_WRITER, LOOSE, "reader_capabilities"),
    ],
)
def test_a_reader_that_can_be_written_remounted_or_holds_more_fails_with_the_check_named(
    engine: tuple[FakeDockerEngine, DockerApi], reader: str, writer: str, loose: str, name: str
) -> None:
    fake, _ = engine
    fake.exec_behaviour = answer(reader, writer, loose)

    failed, lines = prove(engine)

    assert name in failed
    assert f"READER_PROOF fail {name}" in lines
    assert "READER_PROOF ok reader_contained" not in lines
    assert lines[-1] == "READER_PROOF done"


# #745-T23
def test_readers_that_cannot_be_made_fail_the_proof_instead_of_crashing(
    engine: tuple[FakeDockerEngine, DockerApi],
) -> None:
    fake, _ = engine
    fake.refuse["/containers/create"] = 500

    failed, lines = prove(engine)

    assert failed == ["reader_unavailable_500"]
    assert lines[-1] == "READER_PROOF done"


class _BrokenApi(DockerApi):
    """A daemon client that fails the way a bug does, not the way a daemon does."""

    def create_container(self, document: dict[str, Any], name: str) -> str:
        raise ValueError("the answer is not what the client expects")


# #745-T23: the snapshot's proof reads these lines and discards the standard error, so a crash of
# the proof must say what it was on the standard output, or it reads as "not contained"
def test_a_crash_of_the_proof_is_named_and_does_not_end_without_a_last_line() -> None:
    lines: list[str] = []

    status = reader_proof.main(
        ["--image", IMAGE_ID, "--volume", WORK_VOLUME],
        api=_BrokenApi("/nonexistent/docker.sock"),
        write=lines.append,
    )

    assert status == 0
    assert "READER_PROOF fail reader_crashed_valueerror" in lines
    assert any(line.startswith("READER_PROOF detail ValueError") for line in lines)
    assert "READER_PROOF ok reader_contained" not in lines
    assert lines[-1] == "READER_PROOF done"
