# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the environment's script leaves running, for a turn whose login lives in the container
(#1126, ADR 0007 decision 11).

The agent runs in the very container the script ran in. A process the script (or a package it
installed: a `postinstall` hook) left behind is root, or the agent's own user, in that container, so
it can read `/proc/<claude>/environ` the moment the harness is started with the login, replace the
program, or write the agent's settings. Before the container is frozen for the hand-over the setup
therefore ends **every process that is not the container's own**, looks again until none is left,
and ends the turn (`OUTCOME_NOT_HANDED_OVER`, `LEFTOVERS_CODE`) before any login exists when one
cannot be ended.

What stays: the processes that were there before the script was written (the init, the image's
`agent-init`, the inner `dockerd` and its helpers; identified by their start time, which the
script cannot move backwards: `snapshot` is taken before the script exists), whatever `dockerd`
and `containerd` of that start started since (`docker-proxy`), and the shims of the inner containers
and everything under them (`docker compose up -d` databases are what #1009 is for). The shims
reparent to the init, so they are found by the program they run (the image's own, in
`/usr/local/bin` or `/usr/bin`). A bare daemon (`pg_ctl start &`, `nohup server &`) does not
survive for this harness. It narrows the window; it is not a wall: the script is root and can
tamper with the tools this uses, copy a program to the shim's name, or start an inner container
with the host's PID namespace. The exits are what is guarded (ADR 0005, 0007).

The script is POSIX `sh` that reads `/proc` (no `ps`, no extra tool), run as root by an exec, with
the proc directory as an argument so that a test can give it a tree of its own.
"""

from collections.abc import Callable
from typing import Final

from .docker_api import DockerApi
from .exec_run import run_exec

LEFTOVERS_CODE: Final = "setup_leftovers"
# `snapshot`: print `marker <start time of the newest process>`. `list`: print `<pid> <name>` of
# every process that is not the container's own. `kill`: the same, and `kill -9` each. A process
# that is a zombie is not listed (its parent, the init, reaps it).
SNAPSHOT: Final = "snapshot"
LIST: Final = "list"
KILL: Final = "kill"
LEFTOVERS_SCRIPT: Final = r"""
proc=$1; mode=$2; marker=${3:-0}
nl='
'
table=""
for dir in "$proc"/[0-9]*; do
  pid=${dir##*/}
  name=""; ppid=""
  while read -r key value; do
    case $key in Name:) name=$value;; PPid:) ppid=$value;; esac
  done 2>/dev/null < "$dir/status"
  [ -n "$ppid" ] || continue
  stat=$(cat "$dir/stat" 2>/dev/null) || continue
  rest=${stat##*) }
  set -- $rest
  [ $# -ge 20 ] || continue
  state=$1
  shift 19
  exe=$(readlink "$dir/exe" 2>/dev/null)
  exe=${exe%% *}
  table="$table$pid $ppid $1 $state ${exe:--} $name$nl"
done
if [ "$mode" = snapshot ]; then
  newest=0
  while read -r pid ppid start state exe name; do
    [ -n "$pid" ] && [ "$start" -gt "$newest" ] && newest=$start
  done <<EOF
$table
EOF
  echo "marker $newest"
  exit 0
fi
# Ancestors of this process (the exec's own chain) and everything under it stay.
self=$$
keep=" "
walk=$self
while [ -n "$walk" ] && [ "$walk" != 0 ]; do
  case "$keep" in *" $walk "*) break;; esac
  keep="$keep$walk "
  next=""
  while read -r pid ppid start state exe name; do
    [ "$pid" = "$walk" ] && next=$ppid
  done <<EOF
$table
EOF
  walk=$next
done
# Roots whose whole tree stays: this process, the baseline `dockerd` and `containerd`, the shims.
tree=" $self "
while read -r pid ppid start state exe name; do
  [ -n "$pid" ] || continue
  case "$exe" in
    /usr/local/bin/containerd-shim*|/usr/bin/containerd-shim*) tree="$tree$pid ";;
  esac
  if [ "$start" -le "$marker" ]; then
    keep="$keep$pid "
    case "$name" in dockerd|containerd) tree="$tree$pid ";; esac
  fi
done <<EOF
$table
EOF
changed=1
while [ "$changed" = 1 ]; do
  changed=0
  while read -r pid ppid start state exe name; do
    [ -n "$pid" ] || continue
    case "$tree" in *" $ppid "*)
      case "$tree" in *" $pid "*) ;; *) tree="$tree$pid "; changed=1;; esac;;
    esac
  done <<EOF
$table
EOF
done
while read -r pid ppid start state exe name; do
  [ -n "$pid" ] || continue
  case "$keep" in *" $pid "*) continue;; esac
  case "$tree" in *" $pid "*) continue;; esac
  [ "$state" = Z ] && continue
  echo "$pid $name"
  [ "$mode" = kill ] && kill -9 "$pid" 2>/dev/null
done <<EOF
$table
EOF
exit 0
"""

PROC: Final = "/proc"
SH: Final = "/bin/sh"
# The passes of a sweep: a process that is ended can leave a child that was forking at the time.
MAX_PASSES: Final = 5
PASS_SECONDS: Final = 15.0
PAUSE_SECONDS: Final = 0.2
SWEEP_SECONDS: Final = PASS_SECONDS * (MAX_PASSES + 1)
# The most names a note carries.
MAX_NAMES: Final = 20
MAX_NAME_CHARS: Final = 40


class Leftovers(Exception):
    """The sweep could not make the container its own again; `str()` is the sentence, which starts
    with `LEFTOVERS_CODE`."""


def _argv(mode: str, marker: str = "0") -> list[str]:
    return [SH, "-c", LEFTOVERS_SCRIPT, "leftovers", PROC, mode, marker]


def take_marker(api: DockerApi, container: str) -> str:
    """The start time of the newest process of the container, before the script exists. Raises
    `Leftovers` when it cannot be read: no script then runs."""
    done = run_exec(api, container, _argv(SNAPSHOT), timeout=PASS_SECONDS, name="the process mark")
    words = done.stdout.split()
    if done.returncode != 0 or done.unanswered or len(words) != 2 or words[0] != "marker":
        raise Leftovers(f"{LEFTOVERS_CODE}: the container's processes could not be read")
    if not words[1].isdigit():
        raise Leftovers(f"{LEFTOVERS_CODE}: the container's processes could not be read")
    return words[1]


def sweep(
    api: DockerApi,
    container: str,
    marker: str,
    *,
    pause: Callable[[float], None],
) -> list[str]:
    """End every process that is not the container's own and see that none is left: a pass that
    ends some is followed by another, until one finds nothing. The names (never arguments or
    environments) of what was ended, in the order found, once each. Raises `Leftovers` when a pass
    cannot run or something is still there after `MAX_PASSES`."""
    ended: list[str] = []
    found: list[str] = []
    for _ in range(MAX_PASSES):
        done = run_exec(api, container, _argv(KILL, marker), timeout=PASS_SECONDS, name="the sweep")
        if done.returncode != 0 or done.unanswered:
            raise Leftovers(f"{LEFTOVERS_CODE}: the container's processes could not be ended")
        found = [_clean(line.split(" ", 1)[1]) for line in done.stdout.splitlines() if " " in line]
        if not found:
            return ended
        for name in found:
            if name not in ended:
                ended.append(name)
        pause(PAUSE_SECONDS)
    raise Leftovers(
        f"{LEFTOVERS_CODE}: processes of the script could not be ended ({_names(found)})"
    )


def _clean(name: str) -> str:
    """A process name as the notes show it: printable characters only, bounded (the script chose
    it)."""
    kept = "".join(c for c in name.strip() if c.isprintable())
    return kept[:MAX_NAME_CHARS] or "?"


def _names(names: list[str]) -> str:
    shown = ", ".join(names[:MAX_NAMES])
    return shown + (f" and {len(names) - MAX_NAMES} more" if len(names) > MAX_NAMES else "")


def note(ended: list[str]) -> str:
    """The sentence for the setup's notes: what was ended, by name only."""
    return f"{LEFTOVERS_CODE}: ended processes the script left ({_names(ended)})"


__all__ = [
    "KILL",
    "LEFTOVERS_CODE",
    "LEFTOVERS_SCRIPT",
    "LIST",
    "SNAPSHOT",
    "SWEEP_SECONDS",
    "Leftovers",
    "note",
    "sweep",
    "take_marker",
]
