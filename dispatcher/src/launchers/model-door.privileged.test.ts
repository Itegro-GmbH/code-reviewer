// SPDX-License-Identifier: LicenseRef-Proprietary

// The model door on a real Docker daemon with the real Worker image (#745, step 3). Part of the privileged lane (`make
// test-sandbox-local`, CI job `sandbox-local`), which has what the fake Docker of the other suites does not: a daemon
// that starts the door's container from the real image with the real flags, a kernel that loads the door's nft ruleset
// in its network namespace, and the model network.
//
// It runs `runner/scripts/model_door_check.py --offline` as the Control container of the Implementer's profile (the
// flags the Launcher renders, the VM's Docker socket mounted) and reads one JSON line per check. What it proves: the
// door's container as the daemon starts it (user, read-only root, capabilities, no mount, no key in `docker inspect`),
// the ruleset in effect (the door cannot open a connection into the model network or to the VM, a stand-in for the agent
// on the model network reaches the door and nothing else), a call through the door refused at the door for the cost limit, a call without the
// capability refused, the kill of the door named in the turn's outcome.
//
// What it cannot prove, and the VM check (`model_door_check.py` without `--offline`, on a `spike-` VM) does: a call that
// reaches the real provider and comes back, because the door dials only the provider's public address on port 443 and a
// test must not reach a real one. The in-process door tests (`runner/tests/unit/test_model_door_*.py`) run a whole call
// against a scripted provider.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
} from "./container-spec.ts";
import { renderDockerRunArguments } from "./container.ts";
import { CONTAINER_ENVIRONMENT, IMPLEMENTER_ENVIRONMENT } from "./sandbox.ts";

const IMAGE = process.env.SANDBOX_LOCAL_IMAGE;
const DRIVER = fileURLToPath(
  new URL("../../../runner/scripts", import.meta.url),
);
const CHECK_TIMEOUT_MS = 240_000;
// The names the door's launcher gives what it makes: a run that was killed leaves them behind.
const LEFTOVERS = [
  "code-reviewer-model-door",
  "code-reviewer-model-door-rules",
  "code-reviewer-door-check-helper",
  "code-reviewer-door-check-agent",
  "code-reviewer-door-check",
];

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

function sweep(): void {
  for (const name of LEFTOVERS)
    spawnSync("docker", ["rm", "--force", "--volumes", name], {
      stdio: "ignore",
    });
  spawnSync("docker", ["network", "rm", "code-reviewer-model"], {
    stdio: "ignore",
  });
}

const volume = `code-reviewer-work-doorcheck-${randomBytes(4).toString("hex")}`;

beforeAll(() => {
  if (IMAGE === undefined || IMAGE === "")
    throw new Error(
      "SANDBOX_LOCAL_IMAGE is not set: build the image (docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-worker:local .) and name it",
    );
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("There is no Docker daemon this user may use.");
  }
  sweep();
  docker("volume", "create", volume);
});
afterAll(() => {
  sweep();
  spawnSync("docker", ["volume", "rm", "--force", volume], { stdio: "ignore" });
});

/** The Implementer's `docker run` with the check as its command: the profile's flags, the driver directory mounted. */
function controlArguments(image: string): string[] {
  const args = renderDockerRunArguments(IMPLEMENTER_CONTAINER_SPEC, {
    image,
    name: "code-reviewer-door-check",
    environment: {
      ...CONTAINER_ENVIRONMENT,
      ...IMPLEMENTER_ENVIRONMENT,
      RUNNER_IMPLEMENTER_SANDBOX_PROOF: "proven",
      RUNNER_IMPLEMENTER_AGENT_MEMORY_MB: "2560",
    },
    command: [
      "--",
      "/opt/venv/bin/python",
      "/driver/model_door_check.py",
      "--offline",
    ],
    additions: SANDBOX_LAUNCHER_ADDITIONS,
    workVolume: volume,
  });
  const at = args.indexOf(image);
  return [
    ...args.slice(0, at),
    "--entrypoint",
    "/usr/bin/tini",
    "--mount",
    `type=bind,source=${DRIVER},target=/driver,readonly`,
    ...args.slice(at),
  ];
}

describe("the model door in a real container", () => {
  // #745-T13
  it("starts from the real image with the real flags and every check of the offline VM check holds", () => {
    const image = docker(
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE ?? "",
    ).trim();

    const run = spawnSync("docker", controlArguments(image), {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
    });

    const checks = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { check: string; ok: boolean });
    const failed = checks.filter((check) => !check.ok);
    // The message names the checks that failed and the end of the container's own log, never a value.
    expect(
      failed,
      `failed: ${JSON.stringify(failed)} exit ${String(run.status)} stderr ${run.stderr.slice(-1500)}`,
    ).toStrictEqual([]);
    expect(run.status).toBe(0);
    const names = checks.map((check) => check.check);
    for (const wanted of [
      "door_start",
      "door_definition",
      "door_has_no_ipv6",
      "engine_user_cannot_open_the_docker_socket",
      "agent_reaches_the_door",
      "agent_refused_internet",
      "agent_refused_vm_gateway",
      "door_namespace_cannot_open_a_connection_to_the_agent_a_port",
      "door_namespace_cannot_open_a_connection_to_the_agent_dns_port",
      "door_namespace_cannot_reach_the_vm",
      "call_without_the_capability_is_refused",
      "key_is_nowhere_the_agent_can_read",
      "cost_limit_refuses_at_the_door_and_control_reads_why",
      "killed_door_is_named_and_the_class_follows_the_model_use",
    ])
      expect(names).toContain(wanted);
    expect(names).not.toContain("call_through_the_door_reaches_the_provider");
    // The container ended, and with it everything the check made.
    expect(
      docker(
        "ps",
        "--all",
        "--quiet",
        "--filter",
        "name=code-reviewer-model-door",
      ).trim(),
    ).toBe("");
  });
});
