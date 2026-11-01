# SPDX-License-Identifier: LicenseRef-Proprietary

"""Runs one Dynamic review job through `worker-once` of an image, against fakes of one job (#761).

    dynamic_job_fakes.py <image> [docker run arguments of the Worker container...]

The job is a real one: the Worker claims it from the fake App, prepares the content of the pull
request from a real Git repository over smart HTTP, reads the pull request from the fake GitHub,
starts the pinned OpenCode as its engine user behind the network rules, lets it ask a scripted
model for the answer, and publishes the review to the fake GitHub. The extra arguments describe
the container (the smoke test passes the flags of the hardened container spec: root with the
eight capabilities, read-only root, the three tmpfs).

The runner accepts a plain http address for loopback only, so the fakes cannot be on the host:
they run in a container of their own, from the same image (`dynamic_job_fakes.ts`, with the
pinned Node.js, no network but loopback), and the Worker container joins its network namespace.
Checks: exit code 0, exactly one delivered result with `ok`, the review comment on the fake
GitHub, the engine's tool loop reached the model (only the engine calls it), and no credential of
the job in the output of the container.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def read_line(process: subprocess.Popen[str], seconds: float) -> str:
    """The next line the process prints, or an empty string when it prints none in time."""
    line: list[str] = []
    reader = threading.Thread(target=lambda: line.append(process.stdout.readline()))  # type: ignore[union-attr]
    reader.start()
    reader.join(seconds)
    return line[0] if line else ""


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: dynamic_job_fakes.py <image> [docker run arguments...]", file=sys.stderr)
        return 2
    image, docker_arguments = argv[0], argv[1:]
    name = f"smoke-dynamic-fakes-{os.getpid()}"
    with tempfile.TemporaryFile("w+") as fakes_errors:
        sidecar = subprocess.Popen(
            [
                "docker", "run", "--rm", "--interactive", "--name", name, "--network", "none",
                "--user", "10001:10001", "--read-only",
                "--tmpfs", "/tmp:rw,exec,nosuid,mode=1777",
                "--volume", f"{REPO_ROOT}:/repo:ro", "--env", "HOME=/tmp",
                "--entrypoint", "node", image, "/repo/docker/smoke/dynamic_job_fakes.ts",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=fakes_errors,
            text=True,
        )  # fmt: skip
        try:
            start_line = read_line(sidecar, 120)
            if not start_line:
                fakes_errors.seek(0)
                print(f"the fakes did not start:\n{fakes_errors.read()[-2000:]}", file=sys.stderr)
                return 1
            start: dict[str, Any] = json.loads(start_line)
            secrets: list[str] = start.pop("secrets")
            done = subprocess.run(
                [
                    "docker", "run", "--rm", "--interactive", "--network", f"container:{name}",
                    "--env", "RUNNER_JOB_TIMEOUT_SECONDS=240",
                    *docker_arguments, image, "worker-once",
                ],
                input=json.dumps(start),
                capture_output=True,
                text=True,
                timeout=420,
                check=False,
            )  # fmt: skip
            assert sidecar.stdin is not None
            sidecar.stdin.write("report\n")
            sidecar.stdin.flush()
            report_line = read_line(sidecar, 30)
            report: dict[str, Any] = json.loads(report_line) if report_line else {}
            return judge(done, report, secrets)
        finally:
            if sidecar.stdin is not None:
                sidecar.stdin.close()
            try:
                sidecar.wait(30)
            except subprocess.TimeoutExpired:
                subprocess.run(["docker", "rm", "--force", name], capture_output=True, check=False)
                sidecar.wait()


def judge(
    done: subprocess.CompletedProcess[str], report: dict[str, Any], secrets: list[str]
) -> int:
    problems: list[str] = []
    results: list[dict[str, Any]] = report.get("results", [])
    comments: list[dict[str, Any]] = report.get("comments", [])
    requests: list[dict[str, Any]] = report.get("modelRequests", [])
    if done.returncode != 0:
        problems.append(f"the Worker exited with {done.returncode}")
    if len(results) != 1 or results[0].get("ok") is not True:
        problems.append(f"the delivered results are {results!r}")
    if not comments:
        problems.append("the review was not published to the fake GitHub")
    # Only the engine calls the model: a request that offers the engine's own tools next to the
    # return tool is its tool loop, as the pinned OpenCode makes it.
    if not any(
        "StructuredOutput" in r.get("tools", []) and "read" in r.get("tools", []) for r in requests
    ):
        problems.append(f"no request of the engine reached the model: {requests!r}")
    if any(secret in done.stdout + done.stderr for secret in secrets):
        problems.append("a credential of the job is in the output of the container")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        print(done.stdout[-2000:], file=sys.stderr)
        print(done.stderr[-4000:], file=sys.stderr)
        return 1
    print(
        f"    a Dynamic job ran in the image: exit {done.returncode}, one result delivered, "
        f"{len(comments)} comment(s) published, {len(requests)} model request(s) from the engine"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
