// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox-Launcher (#316, #329): starts the Worker of one job as our hardened container inside a fresh
// Sandbox VM. Vercel's firewall is not part of the security boundary; everything security-relevant comes from
// the container, which is the one spec of container-spec.ts rendered by `ContainerLauncher`.
//
// Per job, in this order (the core has claimed the job and holds the credential):
//   1. create a VM from the golden snapshot: `persistent: false`, region fra1, no failover region, a VM size per
//      Worker kind, a timeout of the job's plus a margin as the backstop, a name nobody had before
//   2. vm-prepare.sh as root (cgroup fix, dockerd), then the image in the VM must be the configured id; for the
//      Implementer's profile sysbox-prepare.sh makes the VM able to run a Sysbox container and the job's work volume is
//      made in the VM (#760)
//   3. `docker run --interactive` with the rendered flags; the start document goes through stdin only
//   4. resolve once the Worker has taken over (sandbox-host.ts); the core heartbeats until then
// After the hand-over the Launcher holds nothing (#487): no wait for the container, no supervision in `waitUntil`, no
// stop. The Worker owns the lease; the App tells the Dispatcher when the job's claim ends (`POST /stop`), and the
// reaper and the VM timeout are the safety nets.
// Every failure before the hand-over stops the VM by name and ends in a `LaunchError` with a stable code. A VM is
// never reused. The port to the platform is sandbox-service.ts; `vercel-sandbox.ts` is the one file that knows
// the SDK.
import {
  LaunchError,
  type Clock,
  type Engine,
  type LaunchConfig,
  type LaunchSpec,
  type Launcher,
  type Logger,
  type ReviewKind,
} from "../core/types.ts";
import { systemClock } from "../core/clock.ts";
import type { WorkerContainerOverrides } from "../contracts/worker-container.ts";
import {
  ContainerLauncher,
  ContainerSpecError,
  WORK_VOLUME_PATH,
  WORK_VOLUME_STEP_COUNT,
  CLOUDFLARE_RESERVE_DISK_GIB,
  applyOverrides,
  workVolumeCommands,
  workVolumeName,
} from "./container.ts";
import {
  CLOUDFLARE_LAUNCHER_ADDITIONS,
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";
import {
  IPV6_OFF_COMMANDS,
  IPV6_OFF_STEP_TIMEOUT_MS,
  RUN_DIRECTORY_COMMANDS,
  RUN_DIRECTORY_STEP_TIMEOUT_MS,
  SYSBOX_PREPARE_TIMEOUT_MS,
  SandboxDockerHost,
  WORK_VOLUME_STEP_TIMEOUT_MS,
} from "./sandbox-host.ts";
import type { NetworkRule } from "../network/rule.ts";
import {
  SandboxServiceError,
  type SandboxFailureKind,
  type SandboxService,
  type SandboxVm,
} from "./sandbox-service.ts";
import type { CfHealth } from "./cf-sandbox.ts";
import { cloudflareSuffix } from "./placement.ts";

/** Snapshots are region-bound and there is no failover region: fixed, not an option. */
export const SANDBOX_REGION = "fra1";
/** #1158: the Cloudflare placement has no snapshot and no region (the image is the snapshot); the port wants values, and its client reads neither. */
export const CLOUDFLARE_IMAGE = "cloudflare-image";
export const CLOUDFLARE_REGION = "cloudflare";
/**
 * How much longer than the job a VM may live if nobody stops it. The platform counts from the creation of the VM,
 * the Worker's own job timer from the start of the container, so the margin has to cover create, `vm-prepare.sh`, the
 * image check and the hand-over besides the Worker's delivery of a `timeout` result.
 */
export const VM_TIMEOUT_MARGIN_SECONDS = 300;
/** The longest the steps before `docker run` may take besides the hand-over: create 60, prepare 60, image check 30. */
export const LAUNCH_STEPS_SECONDS = 150;
const MIN_VM_TIMEOUT_MARGIN_SECONDS = 180;

/** The smallest margin that still covers the launch phase with this hand-over time. */
export function minimumVmTimeoutMargin(handoverSeconds: number): number {
  return Math.max(
    MIN_VM_TIMEOUT_MARGIN_SECONDS,
    handoverSeconds + LAUNCH_STEPS_SECONDS,
  );
}
/**
 * What the steps of the Implementer's work volume may take at most: each has `WORK_VOLUME_STEP_TIMEOUT_MS`. They come on top
 * of `LAUNCH_STEPS_SECONDS` for that kind alone, so that the launch of Diff and Dynamic, and the checks of a deployment that
 * serves only them, stay as they were: the VM of an implementer job lives that much longer (`vmLifetimeSeconds`), and the
 * launch deadline of the core has room for it (a test pins that).
 */
export const WORK_VOLUME_STEPS_SECONDS =
  (WORK_VOLUME_STEP_COUNT * WORK_VOLUME_STEP_TIMEOUT_MS) / 1000;
/** The three steps that put Docker's runtime directories on memory, before `vm-prepare.sh` on the Implementer's VM. */
export const RUN_DIRECTORY_STEPS_SECONDS =
  (RUN_DIRECTORY_COMMANDS.length * RUN_DIRECTORY_STEP_TIMEOUT_MS) / 1000;
/** The step that switches IPv6 off in the Implementer's VM, before the daemon starts. */
export const IPV6_OFF_STEPS_SECONDS =
  (IPV6_OFF_COMMANDS.length * IPV6_OFF_STEP_TIMEOUT_MS) / 1000;
/** The Implementer's VM runs `sysbox-prepare.sh` too (at most its timeout); like the volume steps it is not part of Diff's or Dynamic's launch. */
export const SYSBOX_PREPARE_SECONDS = SYSBOX_PREPARE_TIMEOUT_MS / 1000;
/** Everything an implementer launch takes beyond a review's: the Sysbox boot and the steps of the work volume. */
export const IMPLEMENTER_LAUNCH_EXTRA_SECONDS =
  RUN_DIRECTORY_STEPS_SECONDS +
  IPV6_OFF_STEPS_SECONDS +
  SYSBOX_PREPARE_SECONDS +
  WORK_VOLUME_STEPS_SECONDS;
/** How long the container must run for the Worker to count as having taken over (sandbox-host.ts). */
export const SANDBOX_HANDOVER_SECONDS = 20;
/** The tag the golden snapshot pipeline (#330) gives the Worker image in the snapshot. */
export const SANDBOX_IMAGE_REFERENCE = "code-reviewer-worker:golden";

/** The VM sizes the platform has: 1 or an even number up to 8 vCPUs, 2 GB of memory per vCPU (spike #317). */
export const SANDBOX_VCPUS = [1, 2, 4, 6, 8] as const;
export const SANDBOX_MEMORY_PER_VCPU_MB = 2048;

/**
 * The memory of the Vercel VM of this size: 2048 MB per vCPU. The Cloudflare placement does not use it (#1178): its memory is the
 * instance type's (`CloudflarePlacement.memoryMb`), 12 GiB (`cloudflareVmMemoryMb`) for the 4 vCPU of standard-4 and not 8 GiB.
 */
export function vercelVmMemoryMb(vcpus: number): number {
  return vcpus * SANDBOX_MEMORY_PER_VCPU_MB;
}
/**
 * The share of an instance type's memory that the VM's kernel shows as `MemTotal` and the Dispatcher plans with (#1178). Measured in the spike #1149 on the
 * instance types: standard-4 (12 GiB) shows 12,650 MB, 98.2 %; standard-3 98.8 %, standard-2 99.4 %. The rest is the kernel's and the hypervisor's, not the VM's:
 * planning with the nominal memory would leave the guard (8 % of `MemTotal`) less than its floor when the agent uses its whole limit. 98 is the cautious round figure.
 */
export const CLOUDFLARE_USABLE_MEMORY_PERCENT = 98;

/** The memory a Cloudflare VM of an instance type with `instanceMemoryMib` has for the plan of its containers (`CLOUDFLARE_USABLE_MEMORY_PERCENT` of it, rounded down). */
export function cloudflareVmMemoryMb(instanceMemoryMib: number): number {
  return Math.floor(
    (instanceMemoryMib * CLOUDFLARE_USABLE_MEMORY_PERCENT) / 100,
  );
}

/** What the OS, dockerd and containerd need besides the container (the spike measured about 140 MB). */
const VM_HEADROOM_MB = 256;
/**
 * What an implementer VM keeps for the OS, dockerd, containerd and the two Sysbox daemons (measured on a platform VM, 2026-11-02:
 * 480 MB in use with all of them idle).
 */
export const IMPLEMENTER_VM_HEADROOM_MB = 512;
/**
 * The memory limit of the model door, the second container of an implementer turn (#745, step 3;
 * `DOOR_MEMORY_BYTES` of runner/src/code_reviewer_runner/implementer/door_launcher.py). The VM holds it beside the Worker.
 */
export const MODEL_DOOR_MEMORY_MB = 256;
/**
 * The memory limit of the network door, the third container of an implementer turn (#745, step 7; `NETDOOR_MEMORY_MB` of
 * runner/src/code_reviewer_runner/implementer/netdoor_launcher.py). It exists only for a rule other than `off`, but it is counted for
 * every turn: the size the person chose and the memory the page shows do not depend on the rule, and the sum of the limits never
 * exceeds the VM.
 */
export const NETWORK_DOOR_MEMORY_MB = 96;
/** Seconds added to the VM's lifetime for the expiry of the switch token (another instance's clock may be a little behind). */
export const NETWORK_SWITCH_CLOCK_MARGIN_SECONDS = 60;
/**
 * The memory limit of one reader, a container in which Control looks at the agent's repository (`READER_MEMORY_BYTES` of
 * runner/src/code_reviewer_runner/implementer/reader.py). There are **two** of them (`READER_COUNT`): the one every look uses, which
 * runs while the agent runs (the look at the tree), and the one that writes (the set-up, the rescue of a detached HEAD and the
 * leftover commit). Both exist from the start of the turn (`ReaderAccess.warm`), so both limits are counted in full, like every other
 * one: the limits of the containers and the OS never add up to more than the VM.
 */
export const READER_MEMORY_MB = 256;
export const READER_COUNT = 2;

/**
 * The floor of the memory guard: Control kills the agent's container when the VM has less memory left than this
 * (`floor_bytes` of runner/src/code_reviewer_runner/implementer/vm_memory.py: 512 MiB or 8% of the VM's memory, whichever is more).
 * The figures are in `contracts/environment-sizes.v1.json` (`memoryGuard`), which a test holds to the runner's too.
 */
export const MEMORY_GUARD_MIN_FLOOR_MB = 512;
export const MEMORY_GUARD_FLOOR_PERCENT = 8;

/** The guard's floor for a VM with this much memory, in MB (rounded up). The guard reads the VM's own `MemTotal`, so it is a share of the real memory. */
export function memoryGuardFloorOfMb(vmMemoryMb: number): number {
  return Math.max(
    MEMORY_GUARD_MIN_FLOOR_MB,
    Math.ceil((vmMemoryMb * MEMORY_GUARD_FLOOR_PERCENT) / 100),
  );
}

/** The guard's floor for a Vercel VM of this many vCPUs, in MB (rounded up). */
export function memoryGuardFloorMb(vcpus: number): number {
  return memoryGuardFloorOfMb(vercelVmMemoryMb(vcpus));
}

/**
 * What is left of an implementer VM for the agent's container (#745, step 4): the VM's memory (2 GB per vCPU) less the OS and the
 * daemons, Control (its container's limit), the model door, the network door and the two readers, **and less the part of the guard's floor above the
 * 512 MiB that the OS's room already holds**. The guard kills the agent when the VM has less than `memoryGuardFloorMb` left; at 4, 6
 * and 8 vCPU that is 656, 984 and 1,311 MB, and an agent inside its own limit must not be able to bring the VM below it. Every figure
 * is in the table of "The agent's container" in docs/implementer.md, with the measurements behind the limits. The Worker refuses a
 * value below its minimum (`MIN_AGENT_MEMORY_MB` of the runner's job_run.py) with the free `sandbox_size_unsupported`; this function
 * only does the sum. `vmMemoryMb` is the VM's memory, 2 GB per vCPU unless the placement has its own (#1178: a Cloudflare Container has the memory
 * of its instance type, 12 GiB at 4 vCPU); every deduction is the same for both.
 */
export function agentMemoryMb(
  vcpus: number,
  controlMb: number,
  vmMemoryMb: number = vercelVmMemoryMb(vcpus),
): number {
  return Math.max(
    0,
    vmMemoryMb -
      IMPLEMENTER_VM_HEADROOM_MB -
      (memoryGuardFloorOfMb(vmMemoryMb) - MEMORY_GUARD_MIN_FLOOR_MB) -
      controlMb -
      MODEL_DOOR_MEMORY_MB -
      NETWORK_DOOR_MEMORY_MB -
      READER_COUNT * READER_MEMORY_MB,
  );
}

/**
 * The size of the VM and the memory of the container per Worker kind when the operator configures nothing: the smallest
 * VM and 1.5 GB for the container for a review; 2 vCPU / 4 GB for the Implementer, whose Control container takes 768 MB
 * (reservation 512 MB) and leaves the agent's container the rest (`agentMemoryMb`, #745 step 4). Configuration
 * (`DISPATCHER_WORKER_CONFIG`) wins value by value.
 */
export const SANDBOX_KIND_DEFAULTS: Readonly<
  Record<
    ReviewKind,
    { vcpus: number; memory: { limit: string; reservation: string } }
  >
> = {
  diff: { vcpus: 1, memory: { limit: "1536m", reservation: "1280m" } },
  dynamic: { vcpus: 1, memory: { limit: "1536m", reservation: "1280m" } },
  implementer: { vcpus: 2, memory: { limit: "768m", reservation: "512m" } },
};

function isSandboxVcpus(
  value: unknown,
): value is (typeof SANDBOX_VCPUS)[number] {
  return (SANDBOX_VCPUS as readonly unknown[]).includes(value);
}

/**
 * The least memory the agent's container is worth starting with (`MIN_AGENT_MEMORY_MB` of the runner's job_run.py; a test holds the two
 * together). A size of an Implementer job that leaves it less is refused before a VM is created: 1 vCPU, where nothing is left.
 */
export const IMPLEMENTER_MIN_AGENT_MEMORY_MB = 1024;

/** The directory of the VM below which the work volume of a job gets its own (a mount of its own, `workVolumeCommands`). */
export const WORK_VOLUME_ROOT = "/var/lib/code-reviewer-work";

/**
 * What the Worker of an implementer job is told besides the names of every container (`ImplementerEnvironmentName` of
 * runner-api.v1.json). The Dispatcher sets them, never the app and never a job: the work directory is the volume's, and the
 * Docker door is the VM's socket that Control starts the model door, the agent's container and the reader with. The two more
 * that depend on the launch (`RUNNER_IMPLEMENTER_SANDBOX_PROOF`, `RUNNER_IMPLEMENTER_AGENT_MEMORY_MB`) are added by
 * `implementerEnvironment`.
 */
export const IMPLEMENTER_ENVIRONMENT = {
  RUNNER_IMPLEMENTER_WORK_DIR: WORK_VOLUME_PATH,
  // The container carries the VM's Docker socket and starts the model door, the agent's container and the reader with it
  // (#745, steps 3 and 4).
  RUNNER_IMPLEMENTER_MODEL_DOOR: "docker",
} as const;

/** The container spec of a kind: the Implementer has its own profile, Diff and Dynamic the default one. */
function profileOf(kind: ReviewKind) {
  return kind === "implementer"
    ? IMPLEMENTER_CONTAINER_SPEC
    : WORKER_CONTAINER_SPEC;
}

/** What every container is given (names of the spec's allow-list). */
export const CONTAINER_ENVIRONMENT = {
  HOME: "/home/runner",
  RUNNER_DIFF_JOB_USER: "10001:10001",
} as const;

/**
 * #1158 (epic #1157): what the Launcher needs to place a job on a Cloudflare Container. The platform itself is the `service` of the options (the placement
 * router sends a create with `placement: "cloudflare"` to the Cloudflare client); this is what only the launch knows about it.
 */
export type CloudflarePlacement = {
  /**
   * The Worker's health as of now (cached briefly by the caller): the image id the VM's Worker image must have, and what the image can do.
   * Undefined when the Worker cannot be read or its answer cannot be used (no image id): the launch then fails, retryable, before a VM exists.
   */
  health(): Promise<CfHealth | undefined>;
  /** The sizes in vCPUs the Dispatcher has an instance type for (`CF_SANDBOX_INSTANCE_TYPES`). */
  sizes: readonly number[];
  /**
   * #1178: the memory in MiB of the instance type of each size (the type's own, `:<MiB>` of its entry in `CF_SANDBOX_INSTANCE_TYPES`, or 2048 per vCPU for a type
   * the Dispatcher does not know the memory of). The agent's share is planned from it, not from the Vercel ratio.
   */
  memoryMb: ReadonlyMap<number, number>;
  /** The Sysbox verdict for this placement (`CF_SANDBOX_SYSBOX_PROOF`): the image has no pipeline that records one. */
  sysboxProof: SysboxProof;
};

export type SandboxLauncherOptions = {
  service: SandboxService;
  /** Absent: the Cloudflare placement is off, and a job that names it is refused (`sandbox_placement_unavailable`). */
  cloudflare?: CloudflarePlacement;
  /** The golden snapshot every VM starts from (#330). */
  snapshotId: string;
  /** The id of the Worker image in that snapshot; the image in the VM must be this one. */
  imageDigest: string;
  /**
   * The snapshot's Sysbox verdict from its record (`SANDBOX_SYSBOX_PROOF`, #745 step 4). Only the Implementer reads it:
   * an `unproven` one makes the Worker end the turn `sandbox_unproven`, free, before it touches anything. Reviews never look
   * at it, so an unproven snapshot cannot hold them back. Absent is `unproven` (see `SysboxProof`).
   */
  sysboxProof?: SysboxProof;
  logger: Logger;
  clock?: Clock;
  imageReference?: string;
  handoverSeconds?: number;
  /** Seconds added to the job's timeout for the VM's own; at least `minimumVmTimeoutMargin(handoverSeconds)`. */
  vmTimeoutMarginSeconds?: number;
  /**
   * Whether this deployment serves the Implementer (an app of `DISPATCHER_APPS` names the kind, #765): then, and only then,
   * the default `capabilities` hold `implementer`. A deployment without the kind advertises what it always did, so the
   * canary of code-review.com does not depend on an engine it never serves.
   */
  servesImplementer?: boolean;
  /**
   * The engines this Launcher can run: both reviewer engines by default (#479), and `implementer` when the deployment
   * serves it (`servesImplementer`). Which of them a deployment serves is its
   * `DISPATCHER_ENGINES`, which the core applies; the proof that the Dynamic-Worker's container is hardened is the
   * deploy canary (`POST /probe`), not a check per instance or per job.
   */
  capabilities?: (signal: AbortSignal) => Promise<readonly Engine[]>;
  /** The unique part of a VM name; random unless a test brings its own. */
  newSuffix?: () => string;
  /** The clock of the start the App is told about (#493); the system clock unless a test brings its own. */
  now?: () => Date;
  /**
   * The operator's Dynamic configuration, given to the container of a Dynamic job only (#331):
   * `RUNNER_DYNAMIC_CAPABILITIES` and `RUNNER_DYNAMIC_MAX_COST_USD`. Non-secret; names of the container spec's allow-list.
   */
  dynamicEnvironment?: Readonly<Record<string, string>>;
  /**
   * #745, step 7: the document that goes to the Control container of an Implementer VM so that it can narrow the VM's network
   * policy (`RUNNER_IMPLEMENTER_NETWORK_SWITCH`), made from the app, the VM's name and the rule of the claim. Undefined: the
   * deployment has no way to be called back (no public address), and the Worker reports that the policy was not changed.
   */
  networkSwitch?: (input: {
    appId: string;
    vm: string;
    rule: NetworkRule;
    /** The model provider's host the App named in the claim answer. */
    modelHost: string;
    /** Unix time in seconds at which the VM is gone for certain (its lifetime from now, with a margin): the token's expiry. */
    expires: number;
  }) => string | undefined;

  /** Where the VM keeps the work volumes of the Implementer (`WORK_VOLUME_ROOT`); another directory only for a test. */
  workVolumeRoot?: string;
};

export type Plan = {
  vcpus: number;
  overrides: WorkerContainerOverrides;
  /** The memory left for the agent's container of an implementer VM (`agentMemoryMb`); 0 for the other kinds. */
  agentMemoryMb: number;
};

function configInvalid(): LaunchError {
  return new LaunchError("sandbox_config_invalid");
}

function megabytes(size: string): number {
  const amount = Number(size.slice(0, -1));
  return size.endsWith("g") ? amount * 1024 : amount;
}

/** The VM size and the container memory of a launch: the kind's defaults, then the configuration over them. */
function planOf(
  spec: LaunchSpec,
  /** The memory of the VM of a size on the placement of the job (#1178); Vercel's 2048 MB per vCPU unless the launch names another. */
  vmMemoryOf: (vcpus: number) => number = vercelVmMemoryMb,
): Plan {
  const defaults = SANDBOX_KIND_DEFAULTS[spec.kind];
  const config: LaunchConfig = spec.config;

  const options = config.launcher ?? {};
  for (const key of Object.keys(options))
    if (key !== "vcpus") throw configInvalid();
  // #818: the size an Implementer job asks for. Precedence: the job's size, then the kind's configuration
  // (`DISPATCHER_WORKER_CONFIG`), then the kind's default. A reviewer job never names a size, whatever the spec says. Only the
  // sizes of the platform are launched; any other is refused with its own code, before a VM is created.
  const jobSize = spec.kind === "implementer" ? spec.vcpus : undefined;
  if (jobSize !== undefined && !isSandboxVcpus(jobSize))
    throw new LaunchError("sandbox_size_unsupported");
  const vcpus = jobSize ?? options.vcpus ?? defaults.vcpus;
  if (!isSandboxVcpus(vcpus)) throw configInvalid();
  // The Control container keeps its own memory whatever the size: the size is the agent's, and the agent gets what the VM has left
  // (`agentMemoryMb`). A size the platform has but that leaves the agent less than it can start with (1 vCPU) is refused for a job.
  const memory = { ...defaults.memory, ...config.container?.memory };
  if (
    jobSize !== undefined &&
    agentMemoryMb(jobSize, megabytes(memory.limit), vmMemoryOf(jobSize)) <
      IMPLEMENTER_MIN_AGENT_MEMORY_MB
  )
    throw new LaunchError("sandbox_size_unsupported");

  const overrides: WorkerContainerOverrides = { memory };
  try {
    const rendered = applyOverrides(profileOf(spec.kind), overrides);
    // A container that cannot fit in the VM beside the OS would be killed by the VM's own memory limit; an implementer
    // turn also holds the model door and the two readers beside its Worker.
    const implementer = spec.kind === "implementer";
    const doorMb = implementer
      ? MODEL_DOOR_MEMORY_MB +
        NETWORK_DOOR_MEMORY_MB +
        READER_COUNT * READER_MEMORY_MB
      : 0;
    const headroomMb = implementer
      ? IMPLEMENTER_VM_HEADROOM_MB
      : VM_HEADROOM_MB;
    const controlMb = megabytes(rendered.memory.limit);
    const vmMemoryMb = vmMemoryOf(vcpus);
    if (controlMb > vmMemoryMb - headroomMb - doorMb) throw configInvalid();
    return {
      vcpus,
      overrides,
      agentMemoryMb: implementer
        ? agentMemoryMb(vcpus, controlMb, vmMemoryMb)
        : 0,
    };
  } catch (error) {
    if (error instanceof ContainerSpecError) throw configInvalid();
    throw error;
  }
}

/**
 * Throws a `LaunchError` (`sandbox_config_invalid`) when the configuration of a Worker kind cannot be run: a VM
 * size the platform does not have, an option this Launcher does not know, a memory limit the spec refuses or one
 * that leaves the VM no room. Run at start so that a wrong value fails the deployment, not the first job.
 */
export function validateKindConfig(
  kind: ReviewKind,
  config: LaunchConfig,
): void {
  planForKind(kind, config);
}

/** The VM size and container memory a Worker kind gets (what a launch of that kind uses; the canary of #331 too). */
export function planForKind(kind: ReviewKind, config: LaunchConfig): Plan {
  return planOf({
    appId: "validation",
    appUrl: "https://app.invalid",
    jobId: "validation",
    credential: "validation",
    kind,
    timeoutSeconds: 60,
    config,
  });
}

/**
 * The container's environment by kind: Dynamic gets the operator's Dynamic configuration, the Implementer the names of its profile.
 * Exported for the local Control spec (`local-control.ts`, #977), which adds one name to it and never writes a second list.
 */
export function environmentOf(
  kind: ReviewKind,
  dynamicEnvironment: Readonly<Record<string, string>> | undefined,
  plan: Plan,
  sysboxProof: SysboxProof,
  networkSwitch?: string,
): Readonly<Record<string, string>> {
  if (kind === "dynamic")
    return { ...CONTAINER_ENVIRONMENT, ...dynamicEnvironment };
  if (kind === "implementer")
    return {
      ...CONTAINER_ENVIRONMENT,
      ...IMPLEMENTER_ENVIRONMENT,
      ...implementerEnvironment(plan, sysboxProof),
      // #745, step 7: how the Control container narrows this VM's network policy once the setup is done. Absent, it does not.
      ...(networkSwitch === undefined
        ? {}
        : { RUNNER_IMPLEMENTER_NETWORK_SWITCH: networkSwitch }),
    };
  return CONTAINER_ENVIRONMENT;
}

/**
 * The golden snapshot's Sysbox verdict (the record's `sysbox`, `SANDBOX_SYSBOX_PROOF` of the Dispatcher, a member of the
 * snapshot pair). Only `proven` lets the Implementer start; a Dispatcher that was never told a verdict has `unproven`.
 */
export type SysboxProof = "proven" | "unproven";

/**
 * The two names that depend on the launch (#745, step 4): the snapshot's Sysbox verdict, which the Worker turns into a free
 * `sandbox_unproven` unless it is `proven`, and the memory of the agent's container, which it turns into a free
 * `sandbox_size_unsupported` when it is too little to start with.
 */
export function implementerEnvironment(
  plan: Plan,
  sysboxProof: SysboxProof,
): Readonly<Record<string, string>> {
  return {
    RUNNER_IMPLEMENTER_SANDBOX_PROOF: sysboxProof,
    RUNNER_IMPLEMENTER_AGENT_MEMORY_MB: String(plan.agentMemoryMb),
  };
}

function slug(value: string, length: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, length);
}

/**
 * The name of a job VM: `cr-<kind>-<job id>-<suffix>`. The kind is whole, so that the stop route and the reaper
 * (reaper/vm-shape.ts, stop/job-stopper.ts) recognise the VM of every kind by the same name.
 */
export function jobVmName(
  kind: ReviewKind,
  jobId: string,
  suffix: string,
): string {
  return `cr-${slug(kind, 16)}-${slug(jobId, 36)}-${suffix}`;
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** The launch error for a failed platform call, and whether the VM may exist anyway (the call may have got through). */
export const CREATE_FAILURES: Readonly<
  Record<
    SandboxFailureKind,
    { code: string; retryable: boolean; mayExist: boolean }
  >
> = {
  rate_limited: {
    code: "sandbox_rate_limited",
    retryable: true,
    mayExist: false,
  },
  quota_exceeded: {
    code: "sandbox_quota_exceeded",
    retryable: true,
    mayExist: false,
  },
  network: { code: "sandbox_network", retryable: true, mayExist: true },
  unavailable: { code: "sandbox_unavailable", retryable: true, mayExist: true },
  not_ready: { code: "image_not_ready", retryable: true, mayExist: false },
  snapshot_missing: {
    code: "sandbox_snapshot_missing",
    retryable: false,
    mayExist: false,
  },
  region_mismatch: {
    code: "sandbox_region_mismatch",
    retryable: false,
    mayExist: false,
  },
  rejected: { code: "sandbox_rejected", retryable: false, mayExist: false },
  // An expired or wrong token (or OIDC token): the first thing an operator meets, and no retry fixes it.
  auth_failed: {
    code: "sandbox_auth_failed",
    retryable: false,
    mayExist: false,
  },
};

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function createSandboxLauncher(
  options: SandboxLauncherOptions,
): Launcher {
  const { service, logger } = options;
  const clock = options.clock ?? systemClock;
  const handoverSeconds = options.handoverSeconds ?? SANDBOX_HANDOVER_SECONDS;
  const vmTimeoutMarginSeconds =
    options.vmTimeoutMarginSeconds ?? VM_TIMEOUT_MARGIN_SECONDS;
  if (vmTimeoutMarginSeconds < minimumVmTimeoutMargin(handoverSeconds))
    throw new Error(
      `vmTimeoutMarginSeconds must be at least ${minimumVmTimeoutMargin(handoverSeconds)}`,
    );

  /** How long the VM of a job may live if nobody stops it: the job, the margin, and for the Implementer the steps of its work volume. */
  function vmLifetimeSeconds(spec: LaunchSpec): number {
    return (
      spec.timeoutSeconds +
      vmTimeoutMarginSeconds +
      (spec.kind === "implementer" ? IMPLEMENTER_LAUNCH_EXTRA_SECONDS : 0)
    );
  }

  /**
   * When the token of the network switch stops working: the VM lives at most `vmLifetimeSeconds` from its creation, which is
   * before this, and the margin covers the clock of another instance of the Dispatcher answering the call. The longest turn,
   * its setup included, is inside the lifetime (it is made from the job's own time limit), so the token never expires under a
   * turn that is still allowed to run.
   */
  function switchExpiry(spec: LaunchSpec): number {
    return (
      Math.floor((options.now ?? (() => new Date()))().getTime() / 1000) +
      vmLifetimeSeconds(spec) +
      NETWORK_SWITCH_CLOCK_MARGIN_SECONDS
    );
  }

  async function stopQuietly(name: string, jobId: string): Promise<void> {
    try {
      await service.stop(name);
    } catch {
      // Only that it failed: the platform's text is not ours to log. The VM timeout ends the VM.
      logger.warn("sandbox_stop_failed", { jobId, sandbox: name });
    }
  }

  async function createVm(
    plan: Plan,
    spec: LaunchSpec,
    name: string,
    signal: AbortSignal,
  ): Promise<SandboxVm> {
    const cloudflare = spec.placement === "cloudflare";
    try {
      return await service.create(
        {
          name,
          // On Cloudflare there is no snapshot and no region: the image is the snapshot, and the client reads neither value.
          ...(cloudflare ? { placement: "cloudflare" as const } : {}),
          snapshotId: cloudflare ? CLOUDFLARE_IMAGE : options.snapshotId,
          region: cloudflare ? CLOUDFLARE_REGION : SANDBOX_REGION,
          vcpus: plan.vcpus,
          timeoutMs: vmLifetimeSeconds(spec) * 1000,
          // `tenant` names the app that claimed the job (#730): a stop or a reap for one app never touches a VM of another.
          tags: {
            app: "code-reviewer",
            kind: spec.kind,
            job: spec.jobId,
            tenant: spec.appId,
          },
          persistent: false,
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted || isAbort(error)) {
        // The call may have got through before the abort: stop by name, which is harmless for a VM that is not there.
        await stopQuietly(name, spec.jobId);
        throw new LaunchError("launch_aborted");
      }
      const known =
        error instanceof SandboxServiceError
          ? CREATE_FAILURES[error.kind]
          : undefined;
      if (known === undefined || known.mayExist)
        await stopQuietly(name, spec.jobId);
      throw new LaunchError(known?.code ?? "sandbox_create_failed", {
        retryable: known?.retryable ?? false,
      });
    }
  }

  /** Every failure before the hand-over: stop the VM by name and end in a `LaunchError` with a stable code. */
  async function failLaunch(
    name: string,
    spec: LaunchSpec,
    signal: AbortSignal,
    error: unknown,
    fallbackCode: { code: string; retryable: boolean },
  ): Promise<LaunchError> {
    await stopQuietly(name, spec.jobId);
    if (error instanceof LaunchError) return error;
    if (signal.aborted || isAbort(error))
      return new LaunchError("launch_aborted");
    if (error instanceof ContainerSpecError) return configInvalid();
    if (error instanceof SandboxServiceError) {
      const known = CREATE_FAILURES[error.kind];
      return new LaunchError(known.code, { retryable: known.retryable });
    }
    return new LaunchError(fallbackCode.code, {
      retryable: fallbackCode.retryable,
    });
  }

  return {
    capabilities(signal) {
      return (
        options.capabilities?.(signal) ??
        Promise.resolve<readonly Engine[]>(
          options.servesImplementer === true
            ? ["pr-agent", "opencode", "implementer"]
            : ["pr-agent", "opencode"],
        )
      );
    },

    async launch(spec, signal) {
      // #1178: the memory of the VM is the placement's: a Cloudflare job is planned with its instance type's memory (a size without one is refused
      // below), everything else with Vercel's ratio.
      const cloudflareMemory = options.cloudflare?.memoryMb;
      const plan = planOf(
        spec,
        spec.placement === "cloudflare" && cloudflareMemory !== undefined
          ? (vcpus) => {
              const instance = cloudflareMemory.get(vcpus);
              return instance === undefined
                ? vercelVmMemoryMb(vcpus)
                : cloudflareVmMemoryMb(instance);
            }
          : vercelVmMemoryMb,
      );
      // #1158: the placement of the job. Vercel is everything that is not named; a Cloudflare job needs the configuration, the Implementer's kind
      // (a review is never placed there), a size the Dispatcher has an instance type for and a Worker whose health says which image the VM has.
      let cloudflareImage: string | undefined;
      if (spec.placement === "cloudflare") {
        if (options.cloudflare === undefined || spec.kind !== "implementer")
          throw new LaunchError("sandbox_placement_unavailable");
        if (!options.cloudflare.sizes.includes(plan.vcpus))
          throw new LaunchError("sandbox_size_unsupported");
        const health = await options.cloudflare.health().catch(() => undefined);
        if (health?.workerImageId === undefined)
          throw new LaunchError("sandbox_unavailable", { retryable: true });
        cloudflareImage = health.workerImageId;
        logger.info("cloudflare_image", {
          jobId: spec.jobId,
          imageVersion: health.imageVersion,
        });
      }
      const imageDigest = cloudflareImage ?? options.imageDigest;
      const requested = jobVmName(
        spec.kind,
        spec.jobId,
        cloudflareImage === undefined
          ? (options.newSuffix ?? randomSuffix)()
          : cloudflareSuffix((options.newSuffix ?? randomSuffix)()),
      );

      const vm = await createVm(plan, spec, requested, signal);
      const createdAt = (options.now ?? (() => new Date()))();
      // The platform's own name is the one that stops the VM; a normalised name must not make a stop a no-op.
      const name = vm.name;
      if (name !== requested)
        logger.warn("sandbox_name_mismatch", { jobId: spec.jobId });
      // #493: the core tells the App that the VM exists (its billable minutes start here). It returns at once and the
      // launch does not depend on it: a callback that throws is ignored.
      try {
        spec.onVmCreated?.({
          name,
          startedAt: createdAt,
          timeoutSeconds: vmLifetimeSeconds(spec),
          vcpus: plan.vcpus,
        });
      } catch {
        // Only that it failed.
      }
      const host = new SandboxDockerHost({
        vm,
        clock,
        logger,
        logFields: { jobId: spec.jobId },
        imageReference: options.imageReference ?? SANDBOX_IMAGE_REFERENCE,
        imageDigest,
        handoverSeconds,
      });
      try {
        if (spec.kind === "implementer")
          await host.prepareRunDirectories(signal);
        if (spec.kind === "implementer") await host.disableIpv6(signal);
        await host.prepare(signal);
        // Only the Implementer: the boot steps of Sysbox change the VM as a whole, and a review's VM stays as it was.
        if (spec.kind === "implementer") await host.prepareSysbox(signal);
        if (spec.kind === "implementer")
          await host.createWorkVolume(
            workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, {
              name: workVolumeName(spec.jobId),
              root: options.workVolumeRoot ?? WORK_VOLUME_ROOT,
              // The root of a Cloudflare Container is 20 GB, not 64: the reserve is the placement's.
              ...(cloudflareImage === undefined
                ? {}
                : { reserveGib: CLOUDFLARE_RESERVE_DISK_GIB }),
            }),
            signal,
          );
      } catch (error) {
        throw await failLaunch(name, spec, signal, error, {
          code: "vm_prepare_failed",
          retryable: true,
        });
      }
      try {
        const containers = new ContainerLauncher({
          host,
          spec: profileOf(spec.kind),
          // By id: exactly the image that was just verified, and a reference that cannot be pulled.
          image: imageDigest,
          environment: environmentOf(
            spec.kind,
            options.dynamicEnvironment,
            plan,
            (cloudflareImage === undefined
              ? options.sysboxProof
              : options.cloudflare?.sysboxProof) ?? "unproven",
            spec.kind === "implementer" &&
              spec.network !== undefined &&
              spec.modelHost !== undefined
              ? options.networkSwitch?.({
                  appId: spec.appId,
                  vm: name,
                  rule: spec.network,
                  modelHost: spec.modelHost,
                  expires: switchExpiry(spec),
                })
              : undefined,
          ),
          additions:
            cloudflareImage === undefined
              ? SANDBOX_LAUNCHER_ADDITIONS
              : CLOUDFLARE_LAUNCHER_ADDITIONS,
        });
        const running = containers.launch(
          { ...spec, config: { ...spec.config, container: plan.overrides } },
          signal,
        );
        running.catch((error: unknown) => host.fail(error));
        await host.handover;
      } catch (error) {
        throw await failLaunch(name, spec, signal, error, {
          code: "worker_start_failed",
          retryable: true,
        });
      }
    },
  };
}
