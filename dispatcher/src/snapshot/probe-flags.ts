// SPDX-License-Identifier: LicenseRef-Proprietary

// The flags of the self-check probe container (#330): the arguments of `docker run` that the shared renderer of
// the hardened container spec (#325) makes for the Sandbox variant, never flags written here. That is the
// hardening of the example spec of the hardened container contract plus the two IPv6 sysctls that the reduced
// egress ruleset needs (#345, SANDBOX_LAUNCHER_ADDITIONS). The probe is given no token, URL or credential, only the
// two variables its settings read, and the image's `probe` mode (#324) as its command.
import {
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "../launchers/container-spec.ts";
import { renderDockerRunArguments } from "../launchers/container.ts";

/** The arguments after `docker`. Throws `ContainerSpecError` for a memory limit the spec does not allow. */
export function probeRunArguments(config: {
  imageTag: string;
  probeMemory: string;
}): string[] {
  return renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
    image: config.imageTag,
    environment: {
      HOME: "/home/runner",
      RUNNER_DIFF_JOB_USER: "10001:10001",
    },
    command: ["probe"],
    overrides: {
      memory: { limit: config.probeMemory, swap: config.probeMemory },
    },
    additions: SANDBOX_LAUNCHER_ADDITIONS,
  });
}

/** The name of the container of the features step: fixed, so that the script can kill it when its timeout hits (#1098). */
export const FEATURES_CONTAINER_NAME = "code-reviewer-worker-features";

/**
 * The arguments after `docker` of the features step (#1098): the same renderer and the same Worker spec as the probe and
 * the real Worker (tmpfs `/tmp` and `/home/runner`, `HOME`, pids and memory limits, read-only root, dropped capabilities),
 * so that an import that writes somewhere fails here as it would in a job. Exactly two things differ from a Worker: the
 * network is `none` (the step needs none and no job content is near it) and the entrypoint is the image's interpreter
 * running the given one line of code. Throws `ContainerSpecError` for a memory limit the spec does not allow.
 */
export function featuresRunArguments(config: {
  imageTag: string;
  probeMemory: string;
  entrypoint: string;
  code: string;
}): string[] {
  const args = renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
    image: config.imageTag,
    name: FEATURES_CONTAINER_NAME,
    environment: {
      HOME: "/home/runner",
      RUNNER_DIFF_JOB_USER: "10001:10001",
    },
    command: ["-c", config.code],
    overrides: {
      memory: { limit: config.probeMemory, swap: config.probeMemory },
    },
    additions: SANDBOX_LAUNCHER_ADDITIONS,
  });
  const network = args.indexOf("--network");
  if (network === -1 || args[network + 1] !== "bridge")
    throw new Error("the rendered arguments have no bridge network to remove");
  args[network + 1] = "none";
  // The image comes just before the two command arguments; the entrypoint belongs in front of it.
  args.splice(args.length - 3, 0, "--entrypoint", config.entrypoint);
  return args;
}
