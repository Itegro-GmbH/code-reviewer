# SPDX-License-Identifier: LicenseRef-Proprietary

"""The steps of the hosted launcher that vm-init makes in the VM (`dispatcher/src/launchers/`:
`sandbox.ts` runs them through the Sandbox API, `sandbox-host.ts` and `container.ts` define them).

They are data, in the order the hosted launcher runs them, as root (so no `sudo`):

* before the daemon: the Docker runtime directories on memory (`RUN_DIRECTORY_COMMANDS`) and IPv6
  off for new interfaces (`IPV6_OFF_COMMANDS`);
* `vm-prepare.sh` (cgroup root, dockerd) with `TMPDIR` on that memory, then `sysbox-prepare.sh`;
* after the start: the image check, then the job's work volume (`workVolumeCommands`).

A test holds the commands equal to what the Dispatcher's code renders
(`dispatcher/src/launchers/testdata/vm-steps.golden.json`, written by the Dispatcher's test and
read by
this one), so a change on one side without the other fails a suite. Nothing here runs a command: a
`CommandRunner` does.
"""

import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol

VM_PREPARE_PATH: Final = "/usr/local/sbin/vm-prepare.sh"
SYSBOX_PREPARE_PATH: Final = "/usr/local/sbin/sysbox-prepare.sh"
DOCKER_TMPDIR: Final = "/run/containerd"
WORK_VOLUME_ROOT: Final = "/var/lib/code-reviewer-work"
WORK_VOLUME_OPTIONS: Final = ("rw", "nosuid", "nodev")

RUN_DIRECTORY_STEP_SECONDS: Final = 3.0
IPV6_OFF_STEP_SECONDS: Final = 3.0
VM_PREPARE_SECONDS: Final = 60.0
SYSBOX_PREPARE_SECONDS: Final = 40.0
IMAGE_CHECK_SECONDS: Final = 30.0
WORK_VOLUME_STEP_SECONDS: Final = 9.0
DOCKER_INFO_SECONDS: Final = 10.0


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str = ""


class CommandRunner(Protocol):
    """Runs a command to its end and says how it ended. A command that cannot be started or that
    takes longer than `timeout` seconds is an exit code of 255 and an empty `stdout`."""

    def run(self, argv: tuple[str, ...], *, timeout: float, capture: bool) -> CommandResult: ...


class SubprocessRunner:
    """The real one. The output of a command that is not captured is dropped: the steps print
    nothing a job needs, and what they print on failure is not worth a log line that could hold a
    path."""

    def run(self, argv: tuple[str, ...], *, timeout: float, capture: bool) -> CommandResult:
        try:
            done = subprocess.run(
                argv,
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
                text=True,
            )
        except (OSError, subprocess.SubprocessError):
            return CommandResult(255)
        return CommandResult(done.returncode, done.stdout if capture else "")


@dataclass(frozen=True)
class Step:
    """One command. `check` (steps that only look) says whether what it printed is what is
    needed."""

    label: str
    argv: tuple[str, ...]
    timeout: float
    check: Callable[[str], bool] | None = None


class StepFailed(Exception):
    """A step ended in a non-zero status, took too long or printed what its check refuses. Names the
    step, never its output."""

    def __init__(self, label: str, why: str) -> None:
        super().__init__(f"{label}: {why}")
        self.label = label


def run_steps(runner: CommandRunner, steps: tuple[Step, ...]) -> None:
    """Runs `steps` in order and stops at the first that fails."""
    for step in steps:
        done = runner.run(step.argv, timeout=step.timeout, capture=step.check is not None)
        if done.exit_code != 0:
            raise StepFailed(step.label, f"exit status {done.exit_code}")
        if step.check is not None and not step.check(done.stdout):
            raise StepFailed(step.label, "the check refused what it printed")


def pre_daemon_steps() -> tuple[Step, ...]:
    """What the hosted Implementer's VM does before the daemon starts (`prepareRunDirectories`,
    `disableIpv6`) and the script that starts it (`prepare`)."""
    return (
        Step(
            "run-directories",
            ("mkdir", "-p", "--", "/run/docker", "/run/containerd"),
            RUN_DIRECTORY_STEP_SECONDS,
        ),
        Step(
            "run-directory-docker",
            (
                "mount",
                "-t",
                "tmpfs",
                "-o",
                "size=64m,mode=0711,nosuid,nodev",
                "tmpfs",
                "/run/docker",
            ),
            RUN_DIRECTORY_STEP_SECONDS,
        ),
        Step(
            "run-directory-containerd",
            (
                "mount",
                "-t",
                "tmpfs",
                "-o",
                "size=64m,mode=1777,nosuid,nodev",
                "tmpfs",
                "/run/containerd",
            ),
            RUN_DIRECTORY_STEP_SECONDS,
        ),
        Step(
            "ipv6-off",
            (
                "sh",
                "-c",
                'f=/proc/sys/net/ipv6/conf/default/disable_ipv6; [ -e "$f" ] || exit 0; '
                'echo 1 > "$f" || exit 1; [ "$(cat "$f")" = 1 ] || exit 1',
            ),
            IPV6_OFF_STEP_SECONDS,
        ),
        Step(
            "vm-prepare",
            ("env", f"TMPDIR={DOCKER_TMPDIR}", VM_PREPARE_PATH),
            VM_PREPARE_SECONDS,
        ),
    )


def sysbox_step() -> Step:
    """`sysbox-prepare.sh`, after the daemon runs. It is idempotent."""
    return Step("sysbox-prepare", (SYSBOX_PREPARE_PATH,), SYSBOX_PREPARE_SECONDS)


def docker_answers_step() -> Step:
    """Whether a daemon already answers (the guest's init started one): `pre_daemon_steps` are
    then not
    run, because mounting over the runtime directories of a running daemon would break it."""
    return Step("docker-info", ("docker", "info"), DOCKER_INFO_SECONDS)


def image_step(reference: str) -> Step:
    """The image id of `reference`, which the agent compares with the manifest's."""
    return Step(
        "image-id",
        ("docker", "image", "inspect", "--format", "{{.Id}}", reference),
        IMAGE_CHECK_SECONDS,
    )


def mount_has_options(mountinfo: str, directory: str, options: tuple[str, ...]) -> bool:
    """Whether `mountinfo` (the text of `/proc/self/mountinfo`) shows a mount at `directory` that
    has
    all of `options` and no `noexec`. The options read are the mount's own (the sixth field), never
    the file system's behind it, and the last mount at the directory counts: it hides the others.
    This is `mountHasOptions` of the Dispatcher's `container.ts`."""
    found: list[str] | None = None
    for line in mountinfo.split("\n"):
        fields = line.split(" ")
        if len(fields) > 5 and fields[4] == directory:
            found = fields[5].split(",")
    return found is not None and all(o in found for o in options) and "noexec" not in found


def work_volume_steps(
    name: str, reserve_gib: int, root: str = WORK_VOLUME_ROOT
) -> tuple[Step, ...]:
    """The steps that make the job's work volume (`workVolumeCommands`): a directory of the VM's
    disk
    that is a mount of its own with the profile's options, a reserve disk below it that the agent
    cannot fill, and a Docker named volume over it."""
    directory = f"{root}/{name}"
    reserve_directory = f"{directory}/reserve"
    reserve_image = f"{root}/{name}.reserve.img"
    seconds = WORK_VOLUME_STEP_SECONDS

    def check(mountinfo: str) -> bool:
        return mount_has_options(mountinfo, directory, WORK_VOLUME_OPTIONS) and mount_has_options(
            mountinfo, reserve_directory, ("rw", "nosuid", "nodev")
        )

    return (
        Step("work-volume-dir", ("mkdir", "-p", "--", reserve_directory), seconds),
        Step(
            "work-volume-reserve-image",
            ("fallocate", "-l", f"{reserve_gib}G", reserve_image),
            seconds,
        ),
        Step(
            "work-volume-reserve-fs",
            (
                "mkfs.ext4",
                "-q",
                "-F",
                "-m",
                "0",
                "-O",
                "^has_journal",
                "-E",
                "lazy_itable_init=1,nodiscard",
                reserve_image,
            ),
            seconds,
        ),
        Step(
            "work-volume-reserve-mount",
            ("mount", "-o", "loop,nosuid,nodev", reserve_image, reserve_directory),
            seconds,
        ),
        Step("work-volume-mount", ("mount", "--rbind", directory, directory), seconds),
        Step(
            "work-volume-options",
            ("mount", "-o", f"remount,bind,{','.join(WORK_VOLUME_OPTIONS)}", directory),
            seconds,
        ),
        Step("work-volume-check", ("cat", "/proc/self/mountinfo"), seconds, check),
        Step(
            "work-volume-create",
            (
                "docker",
                "volume",
                "create",
                "--driver",
                "local",
                "--opt",
                "type=none",
                "--opt",
                f"device={directory}",
                "--opt",
                "o=rbind",
                name,
            ),
            seconds,
        ),
    )
