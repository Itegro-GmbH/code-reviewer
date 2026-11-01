// SPDX-License-Identifier: LicenseRef-Proprietary

// Generated from contracts/worker-container.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * A size in the notation of docker: digits and m or g.
 */
export type MemorySize = string;
/**
 * The capabilities the Worker container may be created with, nothing else. SETUID SETGID KILL CHOWN DAC_OVERRIDE FOWNER stay for the life of the container (the root supervisor starts the engine as another user, seals and removes its tree); NET_ADMIN and SETPCAP are startup only: the entry point installs the engine user's static network rules and then drops both from every set, including the bounding set, before any job exists.
 */
export type Capability =
  | "SETUID"
  | "SETGID"
  | "KILL"
  | "CHOWN"
  | "DAC_OVERRIDE"
  | "FOWNER"
  | "NET_ADMIN"
  | "SETPCAP";
/**
 * no-new-privileges, or a named seccomp profile (never `unconfined`). No other option: AppArmor and SELinux labels are the daemon's.
 */
export type SecurityOption = "no-new-privileges:true" | string;
/**
 * A name the container may be given. Never one that looks like it holds a secret: the dispatcher token and the per-job credential do not reach a container through its environment.
 */
export type EnvironmentName = string;
/**
 * A key a spec never has, and the renderer never emits.
 */
export type ForbiddenKey =
  | "privileged"
  | "binds"
  | "volumes"
  | "devices"
  | "networkMode"
  | "pid"
  | "ipc"
  | "uts"
  | "userns"
  | "cgroupns"
  | "dockerSocket";

/*
 */
export interface CapabilityGrant {
  name: Capability;
  /**
   * true exactly for NET_ADMIN and SETPCAP.
   */
  startupOnly: boolean;
}
/**
 * A private memory filesystem. It can run no program, honour no setuid bit and hold no device; it is charged to the memory limit, hence the sizes.
 */
export interface TmpfsMount {
  path: "/tmp" | "/run" | "/home/runner";
  options: ("rw" | "noexec" | "nosuid" | "nodev")[];
  size: MemorySize;
  mode: string;
  uid?: number;
  gid?: number;
}
/*
 */
export interface MemoryLimits {
  limit: MemorySize;
  reservation: MemorySize;
  /**
   * A size in the notation of docker: digits and m or g.
   */
  swap: string;
}
/*
 */
export interface WorkerContainerSpec {
  version: 1;
  /**
   * The container starts as root: the job process of a Dynamic job is the supervisor that owns every credential and starts the engine as another user. Root holds exactly the capabilities of capAdd and no-new-privileges means nothing can regain more.
   */
  user: "0:0";
  capDrop: ["ALL"];
  /**
   * @minItems 1
   * @maxItems 8
   */
  capAdd:
    | [CapabilityGrant]
    | [CapabilityGrant, CapabilityGrant]
    | [CapabilityGrant, CapabilityGrant, CapabilityGrant]
    | [CapabilityGrant, CapabilityGrant, CapabilityGrant, CapabilityGrant]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ];
  /**
   * @maxItems 2
   */
  securityOpt: [] | [SecurityOption] | [SecurityOption, SecurityOption];
  readOnly: true;
  /**
   * @minItems 3
   * @maxItems 3
   */
  tmpfs: [TmpfsMount, TmpfsMount, TmpfsMount];
  memory: MemoryLimits;
  pids: {
    limit: number;
  };
  stopTimeoutSeconds: number;
  /**
   * The default bridge. Never the host's network and never none (the Worker must reach the app).
   */
  network: {
    mode: "bridge";
  };
  allowedEnvironment: EnvironmentName[];
  /**
   * Documentation that a tool can check: the keys that no spec has. The schema is closed, so none of them can be added.
   */
  forbiddenKeys: ForbiddenKey[];
  /**
   * The only values a launcher may change per Worker kind (WorkerContainerOverrides).
   */
  overridable: ("memory.limit" | "memory.reservation" | "memory.swap")[];
}
/**
 * The one writable volume of the Implementer's container: a Docker named volume the Sandbox-Launcher creates for the job on the VM's disk, over a directory of the VM that it mounts with these options (Docker cannot set mount options on a named volume itself): read-write, no setuid bit honoured, no device node, and no `noexec`, because the agent builds and runs the repository's programs here. It lives and dies with the VM; nothing outlives the job. The path is /work (RUNNER_IMPLEMENTER_WORK_DIR).
 */
export interface WorkVolume {
  path: "/work";
  options: ["rw", "nosuid", "nodev"];
  /**
   * A Docker named volume, created per job. Never a path of the host and never an existing volume.
   */
  source: "named-volume";
}
/**
 * The profile of the container for the Implementer (#760): the hardening floor of WorkerContainerSpec, value for value, plus one work volume and the room to build and test a repository. It differs from the default spec in exactly these fields: `workVolume` (new), `memory` (sized from the VM), `pids.limit` (2048) and `allowedEnvironment` (the three names of the Implementer added). The root filesystem stays read-only and every tmpfs stays noexec: the work volume is the only writable path where a program may run. A bind, a host path or an arbitrary volume has no key to live in. The Sandbox-Launcher chooses the profile by the job kind (implementer); Diff and Dynamic keep WorkerContainerSpec. examples/worker-container/ImplementerContainerSpec.json is the spec (the Dispatcher's copy and its test keep them equal).
 */
export interface ImplementerContainerSpec {
  version: 1;
  /**
   * The container starts as root: the job process of a Dynamic job is the supervisor that owns every credential and starts the engine as another user. Root holds exactly the capabilities of capAdd and no-new-privileges means nothing can regain more.
   */
  user: "0:0";
  capDrop: ["ALL"];
  /**
   * @minItems 1
   * @maxItems 8
   */
  capAdd:
    | [CapabilityGrant]
    | [CapabilityGrant, CapabilityGrant]
    | [CapabilityGrant, CapabilityGrant, CapabilityGrant]
    | [CapabilityGrant, CapabilityGrant, CapabilityGrant, CapabilityGrant]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ]
    | [
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
        CapabilityGrant,
      ];
  /**
   * @maxItems 2
   */
  securityOpt: [] | [SecurityOption] | [SecurityOption, SecurityOption];
  readOnly: true;
  /**
   * @minItems 3
   * @maxItems 3
   */
  tmpfs: [TmpfsMount, TmpfsMount, TmpfsMount];
  workVolume: WorkVolume;
  memory: MemoryLimits;
  pids: {
    limit: 2048;
  };
  stopTimeoutSeconds: number;
  /**
   * The default bridge. Never the host's network and never none (the Worker must reach the app).
   */
  network: {
    mode: "bridge";
  };
  allowedEnvironment: EnvironmentName[];
  /**
   * Documentation that a tool can check: the keys that no spec has. The schema is closed, so none of them can be added.
   */
  forbiddenKeys: ForbiddenKey[];
  /**
   * The only values a launcher may change per Worker kind (WorkerContainerOverrides).
   */
  overridable: ("memory.limit" | "memory.reservation" | "memory.swap")[];
}
/**
 * What a launcher may change per Worker kind (ADR of the hosted deployment, #325): the memory limit, because the spec's default is not the size of a Sandbox VM. Nothing else.
 */
export interface WorkerContainerOverrides {
  memory?: {
    limit?: MemorySize;
    reservation?: MemorySize;
    swap?: MemorySize;
  };
}
/**
 * What one launcher variant adds to the spec (#325, #345): the two switches that turn IPv6 off in the container's network namespace. Needed where the kernel has only the nf_tables `ip` family, such as the Sandbox VM: the Dynamic-Worker then installs its egress rules as a fallback `ip` table, which does not see IPv6, so IPv6 has to be off and proven off, and the container's /proc/sys is read-only (docker `--sysctl`). The Sandbox-Launcher always adds them; the spec itself has no sysctls key (a test fails on one). Exactly these two names with the value 1, both together; no other sysctl can be added.
 */
export interface WorkerContainerLauncherAdditions {
  sysctls?: {
    "net.ipv6.conf.all.disable_ipv6": "1";
    "net.ipv6.conf.default.disable_ipv6": "1";
  };
}
