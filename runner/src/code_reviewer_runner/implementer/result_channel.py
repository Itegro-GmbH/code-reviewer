# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where the agent's result travels (#843): a directory of the work volume that is not the
repository.

The finish tool in the agent's container writes the result file into `/work/result` (the Subpath
`result` of the work volume, the way the repository is the Subpath `repo`). Control never opens it:
the agent made it, and a link in it would be followed in Control's own file system. It is read in a
**reader** (`ReaderAccess.read_result`), a container with no network, no secret and a read-only
root, in which the volume's `result` directory is mounted read-only at `/result`; whatever a link
there points to is a file of the reader's image. What comes back are the bytes, at most one more
than the bound of a result, and `finish_tool.parse_result` judges them.
"""

import json
import os
import posixpath
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Final, Protocol, cast

from . import finish_tool

RESULT_SUBPATH: Final = "result"
RESULT_FILE: Final = "result.json"
# #920: where the finish tool writes a question, next to the result file.
ASK_FILE: Final = posixpath.basename(finish_tool.ASK_PATH)
ASK_ENABLED_FILE: Final = posixpath.basename(finish_tool.ASK_ENABLED_PATH)
# Where the agent's container and the reader see the directory.
AGENT_RESULT_DIRECTORY: Final = "/work/result"
READER_RESULT_DIRECTORY: Final = "/result"
# What the reader runs: a plain file that is not a link, the first bytes of it. Constants; the path
# and the bound are its arguments.
READ_RESULT_SCRIPT: Final = 'test -f "$1" && test ! -L "$1" && head -c "$2" "$1"'

# What Control writes into the engine's configuration directory in the agent's container: the
# finish tool as an executable (the command `factory-submit`, which the agent's PATH reaches, and
# the stdio MCP server `factory-submit mcp`), and the schema it checks against.
CONFIG_DIRECTORY: Final = posixpath.dirname(finish_tool.SCHEMA_PATH)
FACTORY_SUBMIT: Final = finish_tool.COMMAND_NAME
SCHEMA_FILE: Final = posixpath.basename(finish_tool.SCHEMA_PATH)
INTERPRETER: Final = "/usr/local/bin/python3"


class ResultReader(Protocol):
    """How the session reads the result file."""

    def read_result(self, max_bytes: int) -> bytes | None:
        """The first `max_bytes` bytes of the result file; None when there is none (or it is not a
        plain file, or the reader could not be asked)."""
        ...

    def read_ask(self, max_bytes: int) -> bytes | None:
        """#920: the same for the question file."""
        ...


def make_result_directory(work_dir: Path) -> None:
    """The directory both containers mount, made by Control before the agent's container exists
    (a Subpath of a directory that is not there is a failed `create`). Not following a link."""
    path = work_dir / RESULT_SUBPATH
    os.mkdir(path, 0o755)
    os.chmod(path, 0o755)


def result_mount(work_volume: str, target: str, *, read_only: bool) -> dict[str, Any]:
    """The mount of the result directory, in the agent's container (read-write) and in a reader
    (read-only): the Subpath `result` of the work volume, nothing else of it."""
    return {
        "Type": "volume",
        "Source": work_volume,
        "Target": target,
        "ReadOnly": read_only,
        "VolumeOptions": {"Subpath": RESULT_SUBPATH, "NoCopy": True},
    }


def finish_files(
    schema: Mapping[str, Any], *, can_ask: bool = False
) -> dict[str, tuple[bytes, int]]:
    """The files of the finish tool (name -> (bytes, mode)), to be written next to the engine's
    configuration: the module itself under a shebang that runs it isolated, and the schema. A turn
    that may end with a question (#920) also gets the marker file the tool looks for."""
    source = Path(finish_tool.__file__).read_bytes()
    files = {
        FACTORY_SUBMIT: (f"#!{INTERPRETER} -I\n".encode() + source, 0o755),
        SCHEMA_FILE: (json.dumps(schema).encode("utf-8"), 0o644),
    }
    if can_ask and finish_tool.ask_possible(schema, enabled=True):
        files[ASK_ENABLED_FILE] = (b"1\n", 0o644)
    return files


def finish_server_command() -> Sequence[str]:
    """The command the engine starts the MCP server with, inside the agent's container."""
    return (INTERPRETER, "-I", f"{CONFIG_DIRECTORY}/{FACTORY_SUBMIT}", "mcp")


def redacted_value(value: Any, redact: Callable[[str], str]) -> Any:
    """`value` with `redact` applied to every text in it, keys included. The agent wrote it, and
    anything it was shown can be in it: the job's secrets must not leave in a result."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redacted_value(item, redact) for item in cast("list[Any]", value)]
    if isinstance(value, dict):
        entries = cast("dict[Any, Any]", value)
        return {redact(str(key)): redacted_value(item, redact) for key, item in entries.items()}
    return value
