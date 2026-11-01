// SPDX-License-Identifier: LicenseRef-Proprietary

// Renders the hardened Worker container spec (contracts/worker-container.v1.json, #316, #325) to
// `docker run` arguments, and runs them through a host. One definition of the flags serves the
// container the Sandbox-Launcher (#329) starts inside a VM.
//
// The renderer does not trust its input. The schema is the floor, but a spec that reaches this code
// may not have been through the schema, so the checks are made again here: a forbidden key, a weaker
// value or an unknown key is refused with a stable code. Nothing in the output mounts anything,
// shares a namespace with the host, grants more than the spec's capabilities or lifts a default
// confinement. The per-job credential is not an input of the renderer at all: the launcher puts it
// on stdin and checks that no argument holds it.
//
// Profiles (#760): the spec is the hardening floor, and the Implementer's profile adds to it one work volume and
// room to build a repository (`ImplementerContainerSpec`); a spec with a `workVolume` key is checked as that profile,
// every other as the default one. Both profiles share every check of the floor.
//
// Host preparation: `docker run` with a memory or pids limit fails inside a Sandbox VM until a root
// script has made the cgroup v2 root a plain domain, before `dockerd` starts (docker/sandbox/vm-prepare.sh,
// spike #317, finding F1). It is the host's job, not part of the flags; the golden snapshot (#330)
// installs it and the Sandbox-Launcher (#329) runs it on every VM start.

import type { LaunchSpec } from "../core/types.ts";
import type {
  ImplementerContainerSpec,
  WorkerContainerLauncherAdditions,
  WorkerContainerOverrides,
  WorkerContainerSpec,
} from "../contracts/worker-container.ts";

/** A spec of the contract: the default one of Diff and Dynamic, or the profile of the Implementer (#760). */
export type ContainerSpec = WorkerContainerSpec | ImplementerContainerSpec;

export const CONTAINER_ERROR_CODES = [
  "spec_forbidden_key",
  "spec_unknown_key",
  "spec_not_hardened",
  "override_not_allowed",
  "override_invalid",
  "additions_not_allowed",
  "environment_not_allowed",
  "credential_in_arguments",
  "option_invalid",
] as const;
export type ContainerErrorCode = (typeof CONTAINER_ERROR_CODES)[number];

/** A refusal with a stable code. The message never holds a value that could be a secret. */
export class ContainerSpecError extends Error {
  readonly code: ContainerErrorCode;

  constructor(code: ContainerErrorCode, message: string) {
    super(message);
    this.name = "ContainerSpecError";
    this.code = code;
  }
}

function refuse(code: ContainerErrorCode, message: string): never {
  throw new ContainerSpecError(code, message);
}

// Entry modes of the Worker image. PLACEHOLDERS until the image has them (#324, "one entrypoint with
// the modes dispatch, worker-once and probe, selected by argument"): the renderer takes the mode as
// its `command`, so that nothing here changes when #324 fixes the names.
export const ENTRY_MODE_WORKER_ONCE = "worker-once";
export const ENTRY_MODE_PROBE = "probe";

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "privileged",
  "binds",
  "volumes",
  "devices",
  "networkMode",
  "pid",
  "ipc",
  "uts",
  "userns",
  "cgroupns",
  "dockerSocket",
]);
const WORK_VOLUME_KEY = "workVolume";
const SPEC_KEYS: ReadonlySet<string> = new Set([
  "version",
  "user",
  "capDrop",
  "capAdd",
  "securityOpt",
  "readOnly",
  "tmpfs",
  "memory",
  "pids",
  "stopTimeoutSeconds",
  "network",
  "allowedEnvironment",
  "forbiddenKeys",
  "overridable",
]);
const CAPABILITIES: ReadonlySet<string> = new Set([
  "SETUID",
  "SETGID",
  "KILL",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "NET_ADMIN",
  "SETPCAP",
]);
const STARTUP_ONLY: ReadonlySet<string> = new Set(["NET_ADMIN", "SETPCAP"]);
const TMPFS_PATHS: ReadonlySet<string> = new Set([
  "/tmp",
  "/run",
  "/home/runner",
]);
const TMPFS_OPTIONS: ReadonlySet<string> = new Set([
  "rw",
  "noexec",
  "nosuid",
  "nodev",
]);
const OVERRIDABLE: ReadonlySet<string> = new Set([
  "memory.limit",
  "memory.reservation",
  "memory.swap",
]);
const MEMORY_KEYS = ["limit", "reservation", "swap"] as const;

/** Where the work volume of the Implementer's profile is mounted, and what the Worker is told (`RUNNER_IMPLEMENTER_WORK_DIR`). */
export const WORK_VOLUME_PATH = "/work";
const WORK_VOLUME_OPTIONS = ["rw", "nosuid", "nodev"] as const;
const WORK_VOLUME_SOURCE = "named-volume";
const IMPLEMENTER_PIDS_LIMIT = 2048;
const IMPLEMENTER_ENVIRONMENT_NAMES = [
  "RUNNER_IMPLEMENTER_WORK_DIR",
  "RUNNER_IMPLEMENTER_EGRESS_PORT",
  "RUNNER_IMPLEMENTER_NETWORK",
] as const;

const SIZE = /^[0-9]+[mg]$/;
const MODE = /^[0-7]{4}$/;
const NO_NEW_PRIVILEGES = "no-new-privileges:true";
const SECCOMP_OPTION = /^seccomp=(?!unconfined$)[A-Za-z0-9_./-]+$/;
// The same rule as the schema: no name that looks like it holds a secret.
const ENVIRONMENT_NAME =
  /^(?![A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL))[A-Z][A-Z0-9_]{0,63}$/;
const IMAGE = /^[a-z0-9][A-Za-z0-9._/:@-]*$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PROFILE_PATH = /^[A-Za-z0-9/][A-Za-z0-9_./-]*$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
// A directory of the VM, absolute and plain: no dot segment, no space, nothing a command could read as an option.
const HOST_ROOT = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/** Whether `value` holds a control character: a line break, a NUL or the like. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytesOf(size: string): number {
  const amount = Number(size.slice(0, -1));
  return amount * (size.endsWith("g") ? 1024 : 1) * 1024 * 1024;
}

function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function notHardened(what: string): never {
  return refuse("spec_not_hardened", `the spec is not hardened: ${what}`);
}

function assertCapabilities(spec: Record<string, unknown>): void {
  if (!Array.isArray(spec.capDrop) || !same(spec.capDrop, ["ALL"]))
    notHardened("capDrop is not [ALL]");
  const grants: unknown = spec.capAdd;
  if (!Array.isArray(grants) || grants.length < 1 || grants.length > 8)
    notHardened("capAdd");
  const seen = new Set<string>();
  for (const grant of grants as unknown[]) {
    if (!isRecord(grant)) return notHardened("a capability grant");
    const { name, startupOnly, ...rest } = grant;
    if (typeof name !== "string" || !CAPABILITIES.has(name))
      return notHardened("a capability outside the list");
    if (Object.keys(rest).length > 0 || seen.has(name))
      return notHardened("a capability grant");
    if (startupOnly !== STARTUP_ONLY.has(name))
      return notHardened(`the startup-only marker of ${name}`);
    seen.add(name);
  }
}

function assertSecurityOptions(spec: Record<string, unknown>): void {
  const options: unknown = spec.securityOpt;
  if (!Array.isArray(options) || options.length > 2) notHardened("securityOpt");
  const list = options as unknown[];
  if (!list.includes(NO_NEW_PRIVILEGES))
    notHardened("no-new-privileges is missing");
  if (new Set(list).size !== list.length) notHardened("securityOpt repeats");
  for (const option of list) {
    if (
      option !== NO_NEW_PRIVILEGES &&
      !(typeof option === "string" && SECCOMP_OPTION.test(option))
    )
      notHardened(
        "a security option other than no-new-privileges or a named seccomp profile",
      );
  }
}

function assertTmpfs(spec: Record<string, unknown>): void {
  const mounts: unknown = spec.tmpfs;
  if (!Array.isArray(mounts) || mounts.length !== 3) notHardened("tmpfs");
  const paths = new Set<string>();
  for (const mount of mounts as unknown[]) {
    if (!isRecord(mount)) return notHardened("a tmpfs entry");
    const { path, options, size, mode, uid, gid, ...rest } = mount;
    if (typeof path !== "string" || !TMPFS_PATHS.has(path) || paths.has(path))
      return notHardened("a tmpfs path");
    paths.add(path);
    if (Object.keys(rest).length > 0) return notHardened("a tmpfs key");
    if (
      !Array.isArray(options) ||
      !options.every((o) => typeof o === "string" && TMPFS_OPTIONS.has(o)) ||
      new Set(options).size !== options.length ||
      !["noexec", "nosuid", "nodev"].every((o) => options.includes(o))
    )
      return notHardened(`the options of ${path}`);
    if (typeof size !== "string" || !SIZE.test(size))
      return notHardened(`the size of ${path}`);
    if (typeof mode !== "string" || !MODE.test(mode))
      return notHardened(`the mode of ${path}`);
    for (const id of [uid, gid])
      if (id !== undefined && !(Number.isInteger(id) && (id as number) >= 0))
        return notHardened(`the owner of ${path}`);
  }
}

function assertMemory(memory: unknown, fail: (what: string) => never): void {
  if (!isRecord(memory)) return fail("memory");
  const { limit, reservation, swap, ...rest } = memory;
  if (Object.keys(rest).length > 0) return fail("a memory key");
  for (const size of [limit, reservation, swap])
    if (typeof size !== "string" || !SIZE.test(size))
      return fail("a memory size");
  const [l, r, s] = [limit, reservation, swap].map((size) =>
    bytesOf(size as string),
  ) as [number, number, number];
  // No swap: the peak of a job must show as an out-of-memory kill. A reservation above the limit
  // is refused by Docker; refusing it here gives a reason instead of a daemon error.
  // Docker reads 0 as "no limit": a zero size is no limit at all, not a small one.
  if (l === 0 || r === 0 || s === 0) return fail("a memory size is zero");
  if (s !== l) return fail("swap is not equal to the limit");
  if (r > l) return fail("the reservation is above the limit");
}

function assertEnvironmentNames(
  spec: Record<string, unknown>,
  implementer: boolean,
): void {
  const names: unknown = spec.allowedEnvironment;
  if (
    !Array.isArray(names) ||
    !names.every((n) => typeof n === "string" && ENVIRONMENT_NAME.test(n)) ||
    new Set(names).size !== names.length
  )
    notHardened("allowedEnvironment");
  if (
    implementer &&
    !IMPLEMENTER_ENVIRONMENT_NAMES.every((name) =>
      (names as string[]).includes(name),
    )
  )
    notHardened("allowedEnvironment lacks a name of the Implementer");
}

/** The one volume of the Implementer's profile: exactly `/work`, `rw,nosuid,nodev`, a named volume. Nothing else. */
function assertWorkVolume(volume: unknown): void {
  if (!isRecord(volume)) return notHardened("the work volume");
  const { path, options, source, ...rest } = volume;
  if (Object.keys(rest).length > 0) return notHardened("a work volume key");
  if (path !== WORK_VOLUME_PATH) return notHardened("the work volume path");
  if (!Array.isArray(options) || !same(options, WORK_VOLUME_OPTIONS))
    return notHardened("the work volume options");
  if (source !== WORK_VOLUME_SOURCE)
    return notHardened("the work volume source");
}

/**
 * Refuses a spec that is not the hardened container: a forbidden or unknown key, or a value weaker
 * than the schema allows. Throws `ContainerSpecError`.
 */
export function assertHardenedSpec(
  spec: unknown,
): asserts spec is ContainerSpec {
  if (!isRecord(spec)) return notHardened("not an object");
  for (const key of Object.keys(spec)) {
    if (FORBIDDEN_KEYS.has(key))
      refuse("spec_forbidden_key", `the spec has the forbidden key ${key}`);
  }
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.has(key) && key !== WORK_VOLUME_KEY)
      refuse("spec_unknown_key", `the spec has the unknown key ${key}`);
  }
  const implementer = WORK_VOLUME_KEY in spec;
  if (implementer) assertWorkVolume(spec[WORK_VOLUME_KEY]);
  if (spec.version !== 1) notHardened("version");
  if (spec.user !== "0:0") notHardened("user");
  assertCapabilities(spec);
  assertSecurityOptions(spec);
  if (spec.readOnly !== true) notHardened("the root filesystem is writable");
  assertTmpfs(spec);
  assertMemory(spec.memory, notHardened);
  const pids: unknown = spec.pids;
  if (
    !isRecord(pids) ||
    Object.keys(pids).length !== 1 ||
    !Number.isInteger(pids.limit) ||
    (pids.limit as number) < 1 ||
    (pids.limit as number) > 4096 ||
    (implementer && pids.limit !== IMPLEMENTER_PIDS_LIMIT)
  )
    notHardened("pids");
  const stop = spec.stopTimeoutSeconds;
  if (!Number.isInteger(stop) || (stop as number) < 1 || (stop as number) > 600)
    notHardened("stopTimeoutSeconds");
  const network: unknown = spec.network;
  if (
    !isRecord(network) ||
    Object.keys(network).length !== 1 ||
    network.mode !== "bridge"
  )
    notHardened("the network is not the default bridge");
  assertEnvironmentNames(spec, implementer);
  const forbidden: unknown = spec.forbiddenKeys;
  if (
    !Array.isArray(forbidden) ||
    !forbidden.every((k) => FORBIDDEN_KEYS.has(k as string))
  )
    notHardened("forbiddenKeys");
  const overridable: unknown = spec.overridable;
  if (
    !Array.isArray(overridable) ||
    !overridable.every((k) => OVERRIDABLE.has(k as string))
  )
    notHardened("overridable");
}

/**
 * The spec with the memory values of `overrides` applied: the one thing a launcher may change per
 * Worker kind, and only the keys the spec lists as overridable. The swap follows the limit unless
 * it is given; the result must still have no swap and a reservation within the limit.
 */
export function applyOverrides(
  spec: unknown,
  overrides: WorkerContainerOverrides,
): ContainerSpec {
  assertHardenedSpec(spec);
  if (!isRecord(overrides))
    return refuse("override_not_allowed", "the overrides are not an object");
  for (const key of Object.keys(overrides)) {
    if (key !== "memory")
      refuse("override_not_allowed", `${key} cannot be overridden`);
  }
  const memory: unknown = overrides.memory;
  if (memory === undefined) return spec;
  if (!isRecord(memory))
    return refuse("override_not_allowed", "memory is not an object");
  for (const key of Object.keys(memory)) {
    if (!(MEMORY_KEYS as readonly string[]).includes(key))
      refuse("override_not_allowed", `memory.${key} cannot be overridden`);
    if (!spec.overridable.includes(`memory.${key}` as never))
      refuse("override_not_allowed", `memory.${key} is not overridable`);
  }
  for (const key of MEMORY_KEYS) {
    const value = memory[key];
    if (value !== undefined && !(typeof value === "string" && SIZE.test(value)))
      refuse("override_invalid", `memory.${key} is not a size`);
  }

  const merged = { ...spec.memory, ...(memory as Partial<typeof spec.memory>) };
  if (memory.limit !== undefined && memory.swap === undefined)
    merged.swap = merged.limit;
  assertMemory(merged, (what) =>
    refuse("override_invalid", `the memory override is invalid: ${what}`),
  );
  return { ...spec, memory: merged };
}

const IPV6_SWITCHES = [
  "net.ipv6.conf.all.disable_ipv6",
  "net.ipv6.conf.default.disable_ipv6",
] as const;

/**
 * Refuses additions other than the contract's: no key but `sysctls`, and in it exactly the two IPv6
 * switches with the value 1, together. A launcher variant cannot add a flag through this.
 */
export function assertLauncherAdditions(
  additions: unknown,
): asserts additions is WorkerContainerLauncherAdditions {
  if (!isRecord(additions))
    return refuse("additions_not_allowed", "the additions are not an object");
  for (const key of Object.keys(additions)) {
    if (key !== "sysctls")
      refuse("additions_not_allowed", `${key} cannot be added`);
  }
  const sysctls = additions.sysctls;
  if (sysctls === undefined) return;
  if (
    !isRecord(sysctls) ||
    Object.keys(sysctls).length !== IPV6_SWITCHES.length ||
    !IPV6_SWITCHES.every((name) => sysctls[name] === "1")
  )
    refuse(
      "additions_not_allowed",
      "sysctls are exactly the two IPv6 switches, both set to 1",
    );
}

export interface RenderOptions {
  /** The image reference, a digest in production. Never an option. */
  image: string;
  /** A name for the container, so that a launcher can stop it. */
  name?: string;
  /** Names of `spec.allowedEnvironment` only. Never a secret: see `ContainerLauncher`. */
  environment?: Readonly<Record<string, string>>;
  /** The arguments after the image: the entry mode of the image (#324), for example `worker-once`. */
  command?: readonly string[];
  /** What this Worker kind may change: the memory limit. */
  overrides?: WorkerContainerOverrides;
  /**
   * What this launcher variant adds to the spec (the Sandbox: IPv6 off, `SANDBOX_LAUNCHER_ADDITIONS`).
   * Nothing when absent.
   */
  additions?: WorkerContainerLauncherAdditions;
  /** A seccomp profile derived from the default one (seccomp.ts), by path on the host. Off when absent. */
  seccompProfile?: string;
  /**
   * The name of the Docker volume mounted at /work: required by the Implementer's profile and refused by every other,
   * because only that profile has a work volume (#760). The Launcher makes the volume first (`workVolumeCommands`).
   */
  workVolume?: string;
}

function checkOption(
  value: unknown,
  pattern: RegExp,
  what: string,
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value))
    refuse("option_invalid", `${what} is not valid`);
}

function tmpfsArgument(mount: ContainerSpec["tmpfs"][number]): string {
  const parts = [
    ...mount.options,
    `size=${mount.size}`,
    ...(mount.uid === undefined ? [] : [`uid=${mount.uid}`]),
    ...(mount.gid === undefined ? [] : [`gid=${mount.gid}`]),
    `mode=${mount.mode}`,
  ];
  return `${mount.path}:${parts.join(",")}`;
}

/**
 * The arguments of `docker run` (without the `docker` word) for the spec: in the foreground with
 * stdin attached, removed when it ends, and with every flag of the hardened container. Throws
 * `ContainerSpecError` for a spec, an override or an option that weakens it.
 */
export function renderDockerRunArguments(
  spec: unknown,
  options: RenderOptions,
): string[] {
  const hardened =
    options.overrides === undefined
      ? (assertHardenedSpec(spec), spec)
      : applyOverrides(spec, options.overrides);

  if (options.additions !== undefined)
    assertLauncherAdditions(options.additions);
  const workVolume =
    WORK_VOLUME_KEY in hardened ? hardened.workVolume : undefined;
  if (workVolume === undefined) {
    if (options.workVolume !== undefined)
      refuse(
        "option_invalid",
        "only the Implementer's profile has a work volume",
      );
  } else {
    checkOption(options.workVolume, VOLUME_NAME, "the work volume");
  }
  checkOption(options.image, IMAGE, "the image");
  if (options.name !== undefined)
    checkOption(options.name, CONTAINER_NAME, "the container name");
  const command = options.command ?? [];
  for (const part of command) {
    if (typeof part !== "string" || part === "" || hasControlCharacter(part))
      refuse("option_invalid", "a command argument is not valid");
  }

  const securityOptions: string[] = [...hardened.securityOpt];
  if (options.seccompProfile !== undefined) {
    checkOption(options.seccompProfile, PROFILE_PATH, "the seccomp profile");
    if (options.seccompProfile.toLowerCase() === "unconfined")
      refuse("option_invalid", "the seccomp profile is not valid");
    if (securityOptions.some((option) => option.startsWith("seccomp=")))
      refuse("option_invalid", "the spec already names a seccomp profile");
    securityOptions.push(`seccomp=${options.seccompProfile}`);
  }

  const environment = Object.entries(options.environment ?? {}).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const allowed = new Set<string>(hardened.allowedEnvironment);
  for (const [name, value] of environment) {
    if (!allowed.has(name))
      refuse("environment_not_allowed", "an environment name is not allowed");
    if (typeof value !== "string" || hasControlCharacter(value))
      refuse("option_invalid", "an environment value is not valid");
  }

  const { memory } = hardened;
  return [
    "run",
    "--interactive",
    "--rm",
    ...(options.name === undefined ? [] : ["--name", options.name]),
    "--user",
    hardened.user,
    ...hardened.capDrop.flatMap((name) => ["--cap-drop", name]),
    ...hardened.capAdd.flatMap((grant) => ["--cap-add", grant.name]),
    ...securityOptions.flatMap((option) => ["--security-opt", option]),
    "--read-only",
    ...hardened.tmpfs.flatMap((mount) => ["--tmpfs", tmpfsArgument(mount)]),
    ...(workVolume === undefined
      ? []
      : [
          "--mount",
          `type=volume,source=${options.workVolume},target=${workVolume.path}`,
        ]),
    "--memory",
    memory.limit,
    "--memory-reservation",
    memory.reservation,
    "--memory-swap",
    memory.swap,
    "--pids-limit",
    String(hardened.pids.limit),
    "--stop-timeout",
    String(hardened.stopTimeoutSeconds),
    "--network",
    hardened.network.mode,
    ...IPV6_SWITCHES.flatMap((name) =>
      options.additions?.sysctls === undefined
        ? []
        : ["--sysctl", `${name}=${options.additions.sysctls[name]}`],
    ),
    ...environment.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    options.image,
    ...command,
  ];
}

/** The name of the Docker volume of a job: one per job, so that no job ever finds another's. */
export function workVolumeName(jobId: string): string {
  checkOption(jobId, JOB_ID, "the job id");
  return `code-reviewer-work-${jobId}`;
}

/** A command the Launcher runs as root in the VM before the container: an argument vector, never shell text. */
export interface HostCommand {
  /** A stable name of the step, for logs and for the doubles; never the command text. */
  label: string;
  cmd: string;
  args: readonly string[];
  sudo: true;
  /**
   * For a step that only looks: whether what it printed is what the Launcher needs. The step fails when this says no,
   * as it does for a non-zero exit status.
   */
  check?: (stdout: string) => boolean;
}

/** How many steps `workVolumeCommands` has: the Launcher budgets time for each (`WORK_VOLUME_STEPS_SECONDS`). */
export const WORK_VOLUME_STEP_COUNT = 5;

/**
 * Whether `mountinfo` (the text of `/proc/self/mountinfo`) shows a mount at `directory` that has all of `options` and no
 * `noexec`. The options read are the mount's own (the sixth field of a line), never the filesystem's behind it (the
 * last), and the last mount at the directory counts: it is the one that hides the others.
 */
export function mountHasOptions(
  mountinfo: string,
  directory: string,
  options: readonly string[],
): boolean {
  let found: string[] | undefined;
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields[4] === directory && fields[5] !== undefined)
      found = fields[5].split(",");
  }
  return (
    found !== undefined &&
    options.every((option) => found.includes(option)) &&
    !found.includes("noexec")
  );
}

/**
 * The steps that make the work volume of a job in its VM, in order (#760). Docker cannot give a named volume mount
 * options, so the volume is a bind of a directory of the VM's disk that is a mount of its own with the profile's
 * options (read-write, `nosuid`, `nodev`, and no `noexec`: the agent runs the repository's programs here). The options
 * are read back from the kernel before the volume is made, because a platform that ignored them would run the agent on a
 * mount that honours the setuid bit and nothing else would show it. A mount
 * made in the VM lives and dies with the VM, and so does the volume: no step leaves anything behind. `root` is a
 * plain absolute directory of the VM; the volume gets a directory below it named like itself.
 */
export function workVolumeCommands(
  spec: unknown,
  options: { name: string; root: string },
): HostCommand[] {
  assertHardenedSpec(spec);
  if (!(WORK_VOLUME_KEY in spec))
    return refuse(
      "option_invalid",
      "only the Implementer's profile has a work volume",
    );
  checkOption(options.name, VOLUME_NAME, "the work volume");
  checkOption(options.root, HOST_ROOT, "the work volume root");
  const directory = `${options.root}/${options.name}`;
  const step = (
    label: string,
    cmd: string,
    ...args: string[]
  ): HostCommand => ({
    label,
    cmd,
    args,
    sudo: true,
  });
  return [
    step("work-volume-dir", "mkdir", "-p", "--", directory),
    step("work-volume-mount", "mount", "--bind", directory, directory),
    step(
      "work-volume-options",
      "mount",
      "-o",
      `remount,bind,${spec.workVolume.options.join(",")}`,
      directory,
    ),
    {
      ...step("work-volume-check", "cat", "/proc/self/mountinfo"),
      check: (mountinfo) =>
        mountHasOptions(mountinfo, directory, spec.workVolume.options),
    },
    step(
      "work-volume-create",
      "docker",
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=none",
      "--opt",
      `device=${directory}`,
      "--opt",
      "o=bind",
      options.name,
    ),
  ];
}

/** What a host runs: `docker` with these arguments, `stdin` written to the container. */
export interface ContainerInvocation {
  args: string[];
  stdin: string;
  /** Aborts when the core gives up on the job (deadline, lost lease, shutdown): the host stops the container then. */
  signal?: AbortSignal;
}

export interface ContainerRunResult {
  /** The exit code of the container, or null when the host stopped watching it at the hand-over (#487). */
  exitCode: number | null;
}

/**
 * Where `docker run` executes: the Sandbox VM (#329), the local Docker host of a test, later a host
 * of a container-per-job deployment. The host runs the invocation and resolves when the container
 * has ended, or, for a host that hands the job over to the Worker (the Sandbox VM), when the Worker has taken over.
 */
export interface ContainerHost {
  run(invocation: ContainerInvocation): Promise<ContainerRunResult>;
}

function hasWorkVolume(spec: unknown): boolean {
  return isRecord(spec) && WORK_VOLUME_KEY in spec;
}

export interface ContainerLauncherConfig<H extends ContainerHost> {
  host: H;
  /** The hardened spec; `WORKER_CONTAINER_SPEC` unless a test brings another. */
  spec: unknown;
  image: string;
  /** Names of `spec.allowedEnvironment` with their values, the same for every job. */
  environment?: Readonly<Record<string, string>>;
  /** The launcher variant's additions to the spec, for every container: the Sandbox sets IPv6 off. */
  additions?: WorkerContainerLauncherAdditions;
  seccompProfile?: string;
  /** The entry mode of the image (#324); a placeholder until the image has it. */
  entryMode?: string;
}

/**
 * Starts one Worker as a hardened container on a host. The flags are rendered from the spec with the
 * memory override of the job's Worker kind (`spec.config.container`, from the core's per-kind
 * configuration); the credential is written to stdin as `{appUrl, jobId, credential}` (the input of
 * `worker --once`, #323) and checked to be in no argument. The Sandbox-Launcher (#329) composes this
 * with the VM lifecycle; it is not a `Launcher` of the core itself, because it knows no host.
 */
export class ContainerLauncher<H extends ContainerHost = ContainerHost> {
  readonly host: H;
  readonly #config: ContainerLauncherConfig<H>;

  constructor(config: ContainerLauncherConfig<H>) {
    this.host = config.host;
    this.#config = config;
    // A spec, image or option that is wrong fails here, not on the first job.
    this.render("configuration-check", undefined, this.environmentFor(1));
  }

  /** The launcher's environment plus the job's timeout: what every container is given. */
  private environmentFor(timeoutSeconds: number): Record<string, string> {
    return {
      ...this.#config.environment,
      RUNNER_JOB_TIMEOUT_SECONDS: String(timeoutSeconds),
    };
  }

  private render(
    jobId: string,
    overrides: WorkerContainerOverrides | undefined,
    environment: Readonly<Record<string, string>> | undefined,
  ): string[] {
    const config = this.#config;
    return renderDockerRunArguments(config.spec, {
      image: config.image,
      name: `code-reviewer-worker-${jobId}`,
      ...(hasWorkVolume(config.spec)
        ? { workVolume: workVolumeName(jobId) }
        : {}),
      ...(environment === undefined ? {} : { environment }),
      command: [config.entryMode ?? ENTRY_MODE_WORKER_ONCE],
      ...(overrides === undefined ? {} : { overrides }),
      ...(config.additions === undefined
        ? {}
        : { additions: config.additions }),
      ...(config.seccompProfile === undefined
        ? {}
        : { seccompProfile: config.seccompProfile }),
    });
  }

  async launch(
    spec: LaunchSpec,
    signal?: AbortSignal,
  ): Promise<ContainerRunResult> {
    checkOption(spec.jobId, JOB_ID, "the job id");
    if (typeof spec.appUrl !== "string" || spec.appUrl === "")
      refuse("option_invalid", "the app URL is not valid");
    if (typeof spec.credential !== "string" || spec.credential === "")
      refuse("option_invalid", "the credential is not valid");
    if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1)
      refuse("option_invalid", "the timeout is not valid");

    // The Worker's own hard timeout is the job's; the launcher's environment names it first.
    const args = this.render(
      spec.jobId,
      spec.config.container,
      this.environmentFor(spec.timeoutSeconds),
    );
    if (args.some((argument) => argument.includes(spec.credential)))
      refuse(
        "credential_in_arguments",
        "an argument would hold the credential",
      );

    return this.host.run({
      args,
      stdin: `${JSON.stringify({
        appUrl: spec.appUrl,
        jobId: spec.jobId,
        credential: spec.credential,
      })}\n`,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
