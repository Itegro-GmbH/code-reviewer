# SPDX-License-Identifier: LicenseRef-Proprietary

"""A stand-in for the `incus` program (not a test file), run by `test_incus_client.py`.

It records how it was called (argv, what its stdin held, the environment it got) and answers from
`behavior.json` next to it: `{"exit": 0, "stdout": "...", "stderr": "...", "sleep": 0,
"hang_on_stdin": false}`. With `hang_on_stdin` it reads its stdin to the end first,
as the real `incus init` does when its stdin is not a terminal: a caller that left a pipe open
hangs."""

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

here = Path(__file__).with_name("incus-calls")
behavior_file = Path(os.environ.get("FAKE_INCUS_DIR", ".")) / "behavior.json"
behavior: dict[str, Any] = json.loads(behavior_file.read_text()) if behavior_file.exists() else {}
stdin_data = b""
if behavior.get("hang_on_stdin") or "--stdin" in sys.argv:
    stdin_data = sys.stdin.buffer.read()
calls = Path(behavior.get("record", "/dev/null"))
with calls.open("a") as handle:
    handle.write(
        json.dumps(
            {
                "argv": sys.argv[1:],
                "stdin": stdin_data.decode(errors="replace"),
                "env": sorted(os.environ),
                "conf": os.environ.get("INCUS_CONF"),
                "project": os.environ.get("INCUS_PROJECT"),
                "pid": os.getpid(),
            }
        )
        + "\n"
    )
time.sleep(float(behavior.get("sleep", 0)))
sys.stdout.write(behavior.get("stdout", ""))
sys.stderr.write(behavior.get("stderr", ""))
sys.exit(int(behavior.get("exit", 0)))
