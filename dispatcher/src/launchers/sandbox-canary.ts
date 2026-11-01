// SPDX-License-Identifier: LicenseRef-Proprietary

// The canary VM of the capability probe (#331): the way the Sandbox-Launcher runs the Worker image's `probe` mode
// to learn whether the Dynamic-Worker's hardening can be established here. It is a job VM without a job:
//
//   1. a VM from the golden snapshot (`persistent: false`, fra1, the VM size a Dynamic job gets), named and tagged
//      as a canary, with a timeout beyond the probe's own as the backstop
//   2. vm-prepare.sh and the image check, exactly like a job VM (a probe of another image proves nothing)
//   3. `docker run` of the image by id with the flags the shared renderer makes for a Dynamic-Worker (the hardened
//      container spec, the memory of the Dynamic kind, the two IPv6 switches of the Sandbox variant, the Dynamic
//      environment of a job) and the entry mode `probe`: no stdin, no App URL, no token, no credential
//   4. the stdout is the verdict, handed on unread (`probe/verdict.ts` reads it)
//   4b. a deployment that serves the Implementer (`implementer` option, #765) runs the probe a second time in the same
//       VM, in the Implementer's profile: its work volume made the way a job's is, its flags and environment, the
//       `probe` mode. Only that container can prove `implementer`; the two verdicts are united into one
//       (`mergeVerdictOutputs`), so a failure of either leaves its engine out.
//   5. the VM is stopped by name, whatever happened
//
// It returns the output or rejects with a `ProbeRunError` whose code is stable: the launch error codes of a job VM
// (`sandbox_unavailable`, `docker_not_ready`, `image_mismatch`, ...), `probe_exit_nonzero`, `probe_exec_failed`,
// `probe_aborted`. The text of the platform's error and the container's stderr are never logged.
import {
  LaunchError,
  type Clock,
  type LaunchConfig,
  type Logger,
} from "../core/types.ts";
import { ProbeRunError, type ProbeRunner } from "../probe/capability-probe.ts";
import { mergeVerdictOutputs } from "../probe/verdict.ts";
import { systemClock } from "../core/clock.ts";
import {
  ContainerSpecError,
  renderDockerRunArguments,
  workVolumeCommands,
  workVolumeName,
} from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";
import { SandboxDockerHost } from "./sandbox-host.ts";
import {
  CONTAINER_ENVIRONMENT,
  CREATE_FAILURES,
  IMPLEMENTER_ENVIRONMENT,
  SANDBOX_IMAGE_REFERENCE,
  WORK_VOLUME_ROOT,
  SANDBOX_REGION,
  VM_TIMEOUT_MARGIN_SECONDS,
  WORK_VOLUME_STEPS_SECONDS,
  planForKind,
} from "./sandbox.ts";
import {
  SandboxServiceError,
  type SandboxService,
  type SandboxVm,
} from "./sandbox-service.ts";

/** How long the probe container may run: the self-check takes seconds. */
const PROBE_RUN_TIMEOUT_MS = 60_000;
/**
 * What the Implementer's half adds to the time of the probe: the steps of the work volume and a second container, each at
 * most its timeout (`vmLifetimeSeconds` adds the volume steps to the VM of a job in the same way).
 */
export const IMPLEMENTER_PROBE_EXTRA_SECONDS =
  WORK_VOLUME_STEPS_SECONDS + PROBE_RUN_TIMEOUT_MS / 1000;

export type SandboxCanaryOptions = {
  service: SandboxService;
  /** The golden snapshot every VM starts from (#330). */
  snapshotId: string;
  /** The id of the Worker image in that snapshot. */
  imageDigest: string;
  logger: Logger;
  clock?: Clock;
  imageReference?: string;
  /** The Dynamic kind's part of `DISPATCHER_WORKER_CONFIG`: the VM size and the container memory of a Dynamic job. */
  config: LaunchConfig;
  /** What a Dynamic job's container is given besides the base: `RUNNER_DYNAMIC_CAPABILITIES`, `RUNNER_DYNAMIC_MAX_COST_USD`. */
  environment?: Readonly<Record<string, string>>;
  /**
   * Present for a deployment that serves the Implementer (#765): the part of `DISPATCHER_WORKER_CONFIG` for that kind
   * (the VM of the canary is as large as the larger of the two kinds, the container memory is the kind's own). The
   * canary then also runs the probe in the Implementer's profile.
   */
  implementer?: { config: LaunchConfig };
  /** Where the work volume of the Implementer's probe is made; the Launcher's own root unless a test brings one. */
  workVolumeRoot?: string;
  /** The time the probe is given (the VM timeout is this plus the margin). */
  timeoutSeconds?: number;
  vmTimeoutMarginSeconds?: number;
  newSuffix?: () => string;
};

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function createSandboxCanary(
  options: SandboxCanaryOptions,
): ProbeRunner {
  const { service, logger } = options;
  const clock = options.clock ?? systemClock;
  const timeoutSeconds = options.timeoutSeconds ?? 150;
  const marginSeconds =
    options.vmTimeoutMarginSeconds ?? VM_TIMEOUT_MARGIN_SECONDS;

  async function stopQuietly(name: string): Promise<void> {
    try {
      await service.stop(name);
    } catch {
      // Only that it failed: the platform's text is not ours to log. The VM timeout ends the VM.
      logger.warn("canary_stop_failed", { sandbox: name });
    }
  }

  function codeOf(
    error: unknown,
    signal: AbortSignal,
    fallback: string,
  ): ProbeRunError {
    if (error instanceof ProbeRunError) return error;
    if (signal.aborted || isAbort(error))
      return new ProbeRunError("probe_aborted");
    if (error instanceof LaunchError) return new ProbeRunError(error.code);
    if (error instanceof ContainerSpecError)
      return new ProbeRunError("sandbox_config_invalid");
    if (error instanceof SandboxServiceError)
      return new ProbeRunError(CREATE_FAILURES[error.kind].code);
    return new ProbeRunError(fallback);
  }

  /** The probe in the Implementer's profile: the work volume, then the container (#765). */
  async function probeImplementer(
    plan: ReturnType<typeof planForKind>,
    vm: SandboxVm,
    host: SandboxDockerHost,
    suffix: string,
    signal: AbortSignal,
  ): Promise<string> {
    const volume = workVolumeName(`canary-${suffix}`);
    try {
      await host.createWorkVolume(
        workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, {
          name: volume,
          root: options.workVolumeRoot ?? WORK_VOLUME_ROOT,
        }),
        signal,
      );
    } catch (error) {
      throw codeOf(error, signal, "work_volume_failed");
    }
    let args: string[];
    try {
      args = renderDockerRunArguments(IMPLEMENTER_CONTAINER_SPEC, {
        image: options.imageDigest,
        environment: { ...CONTAINER_ENVIRONMENT, ...IMPLEMENTER_ENVIRONMENT },
        command: ["probe"],
        overrides: plan.overrides,
        additions: SANDBOX_LAUNCHER_ADDITIONS,
        workVolume: volume,
      });
    } catch (error) {
      throw codeOf(error, signal, "sandbox_config_invalid");
    }
    let result;
    try {
      result = await vm.exec(
        {
          label: "probe-implementer",
          cmd: "docker",
          args,
          sudo: true,
          timeoutMs: PROBE_RUN_TIMEOUT_MS,
        },
        signal,
      );
    } catch (error) {
      throw codeOf(error, signal, "probe_exec_failed");
    }
    if (result.exitCode !== 0) {
      // The number only (a docker failure is 125, a settings failure of the probe 2): the text of the container is never logged.
      logger.warn("canary_implementer_probe_exit", {
        exitCode: result.exitCode,
      });
      throw new ProbeRunError("probe_exit_nonzero");
    }
    return result.stdout;
  }

  return async (signal) => {
    const plan = planForKind("dynamic", options.config);
    // A configuration of the Implementer the VM cannot hold (`DISPATCHER_WORKER_CONFIG.implementer`) does not stop the probe of
    // Dynamic: its half is missing, with a reason, and that blocks a deployment that serves the kind.
    let implementerPlan: ReturnType<typeof planForKind> | "invalid" | undefined;
    if (options.implementer !== undefined) {
      try {
        implementerPlan = planForKind(
          "implementer",
          options.implementer.config,
        );
      } catch {
        implementerPlan = "invalid";
      }
    }
    const suffix = (
      options.newSuffix ??
      (() => crypto.randomUUID().replace(/-/g, "").slice(0, 8))
    )();
    const requested = `cr-canary-${suffix}`;

    let vm: SandboxVm;
    try {
      vm = await service.create(
        {
          name: requested,
          snapshotId: options.snapshotId,
          region: SANDBOX_REGION,
          // The Implementer's probe runs in the same VM: it must hold the larger container.
          vcpus: Math.max(
            plan.vcpus,
            typeof implementerPlan === "object" ? implementerPlan.vcpus : 0,
          ),
          timeoutMs: (timeoutSeconds + marginSeconds) * 1000,
          tags: { app: "code-reviewer", kind: "canary", job: "canary" },
          persistent: false,
        },
        signal,
      );
    } catch (error) {
      // The call may have got through: stop by name, which is harmless for a VM that is not there.
      if (
        !(error instanceof SandboxServiceError) ||
        CREATE_FAILURES[error.kind].mayExist ||
        signal.aborted
      )
        await stopQuietly(requested);
      throw codeOf(error, signal, "sandbox_create_failed");
    }
    // The platform's own name is the one that stops the VM.
    const name = vm.name;
    try {
      const host = new SandboxDockerHost({
        vm,
        clock,
        logger,
        logFields: { canary: true },
        imageReference: options.imageReference ?? SANDBOX_IMAGE_REFERENCE,
        imageDigest: options.imageDigest,
        handoverSeconds: 0,
      });
      try {
        await host.prepare(signal);
      } catch (error) {
        throw codeOf(error, signal, "vm_prepare_failed");
      }
      let args: string[];
      try {
        args = renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
          image: options.imageDigest,
          environment: { ...CONTAINER_ENVIRONMENT, ...options.environment },
          command: ["probe"],
          overrides: plan.overrides,
          additions: SANDBOX_LAUNCHER_ADDITIONS,
        });
      } catch (error) {
        throw codeOf(error, signal, "sandbox_config_invalid");
      }
      let result;
      try {
        result = await vm.exec(
          {
            label: "probe",
            cmd: "docker",
            args,
            sudo: true,
            timeoutMs: PROBE_RUN_TIMEOUT_MS,
          },
          signal,
        );
      } catch (error) {
        throw codeOf(error, signal, "probe_exec_failed");
      }
      // The exit status says whether the probe ran (runner/README.md): 0 with a verdict, 2 without one.
      if (result.exitCode !== 0) throw new ProbeRunError("probe_exit_nonzero");
      if (implementerPlan === undefined) return result.stdout;
      // The Implementer's half never takes the Dynamic one down: when it cannot be run, the Dynamic verdict stands and
      // `implementer` is missing with a reason (`implementer_probe_failed`), which blocks a deployment that serves the kind.
      let second: string | undefined;
      try {
        if (implementerPlan === "invalid")
          throw new ProbeRunError("sandbox_config_invalid");
        second = await probeImplementer(
          implementerPlan,
          vm,
          host,
          suffix,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warn("canary_implementer_probe_failed", {
          sandbox: name,
          why: error instanceof ProbeRunError ? error.code : "probe_error",
        });
      }
      const merged = mergeVerdictOutputs(result.stdout, second);
      if (second !== undefined && !merged.implementerProven)
        logger.warn("canary_implementer_not_proven", {
          sandbox: name,
          half: "implementer",
        });
      return merged.line;
    } finally {
      await stopQuietly(name);
    }
  };
}
